# Objective and Context

User request, verbatim:

> I think right now we don't do a great job of representing the prompt, the raw form, which might have some expansions, and when the expansions are processed. I think we should model these types explicitly and then I guess do the expansion before compaction so that the next prompt has the full context with all of the expansions applied. That way we don't have to do this weird conversion of reversing the representation out of history back into a string.

Follow-up constraint:

> we compute the tokenCount out of what's in the log, so we have to push it into the log to get an accurate token count, which then trips the [auto-compact supervisor]. So I want to keep the current "immediately append to log" thing, and then back that out during compaction.

So the submitted input keeps landing in the native log before compaction decides anything. What changes is how compaction gets it back out: as the structured, already-expanded `AgentInput[]` that went in, not by scraping text out of `ProviderMessage`s.

## Current state

- `PendingMessage` (`submission/index.ts`): the raw user text, with the delivery prefix stripped and commands not yet run.
- `ResolvedSubmission = { compact: boolean; messages: AgentInput[]; reminders: string[] }`: the expanded form. The resolver (`resolveSubmission` in `nvimclient/chat/session-host.ts`) strips `@compact`, then runs `commandRegistry.processMessage` over the rest.
- `compactPrompt(resolved)` flattens an expanded submission back into a string. That drops images, documents and any non-text expansion.
- `CompactSuspendReason = { kind: "compact"; nextPrompt: string | undefined }`. Produced by:
  - `@compact` in `Thread.startSubmission`, via `compactPrompt`
  - `AutoCompactSupervisor.onBeforeRequest`, with its configured handoff string
  - `promptFlush` / `flushQueuesForNextTurn` when a queued `@compact` is reached, via `joinText`, which flattens everything flushed ahead of it
- `Compactor.run(messages: ProviderMessage[], nextPrompt: string | undefined, signal)` (`compaction/index.ts`, `compaction/compactor.ts`). `nextPrompt` is only interpolated into `COMPACT_PROMPT_TEMPLATE` (`buildChunkPrompt`).
- `Thread.compactAndContinue`:
  - runs the compactor over `getProviderMessages()`
  - replaces the core
  - sends `nextPrompt` (or "Please continue…") as a single text message
- `splitPendingUserText` (`thread.ts`), the recent stopgap:
  - It finds a trailing user message in the provider log and drops it from the compactor input.
  - It scrapes that message's text blocks into `nextPrompt`, filtering out `ABORT_MARKER_TEXT`.
  - This is the "reverse the representation out of history" step we want to remove.
- `runToolLoop` (`tool-loop.ts`):
  - calls `onBeforeRequest` (the supervisor chain, including the preflight count and AutoCompact)
  - appends injections, then the loop's `input`
  - returns `suspended` if the decision was a suspend
  - Input is appended even on suspend, "so both are there for the resume".

## Relevant files

- `node/server/src/submission/index.ts`: raw/expanded submission types, `parseCompact`, `compactPrompt`, `resolveAsText`.
- `node/nvimclient/chat/session-host.ts`: the nvim resolver that performs expansions.
- `node/server/src/compaction/index.ts`: `CompactSuspendReason`, `Compactor` interface.
- `node/server/src/compaction/compactor.ts`: `ThreadCompactor.run`, `buildChunkPrompt`.
- `node/server/src/thread-supervisor.ts`: `AutoCompactSupervisor`, `SuspendReason`.
- `node/server/src/thread-assembly.ts`: builds AutoCompact from `autoCompactPrompt`.
- `node/server/src/thread.ts`: `startSubmission`, `compactAndContinue`, queue flushes, `splitPendingUserText`, `joinText`.

## Update after the token-budget plan landed

`plans/2026-09-23-token-budget-channel.md` has landed. It changes several things this plan refers to; where they conflict, this note wins:
- `CompactSuspendReason` no longer exists. Compaction now travels as Thread's internal `CompactRequest = { type: "compact"; nextPrompt: string | undefined }` (`thread.ts`), and `compactAndContinue(handoff, submission)` takes the handoff directly. Wherever this plan says `CompactSuspendReason.next`, read `CompactRequest.next: AgentInput[]` and `compactAndContinue(next, …)`.
- `AutoCompactSupervisor` no longer exists. Its handoff is `TokenBudget.handoff` (`compaction/token-budget.ts`), currently a `string`; this plan makes it `AgentInput[]` (assembly wraps `autoCompactPrompt` as one text item).
- Suspensions are gone: there is no `suspended` loop result and no supervisor suspend. Budget stops arrive as a `completed`/`context_budget` tool-loop result, which Thread turns into a `CompactRequest`. The loop appends injections and input before the budget check, so on a first-request budget stop the unanswered user turn is always the log's tail.
- `splitPendingUserText` is now exported from `thread.ts` and has a table test in `compaction/index.test.ts`. Stage 3 moves that logic privately into `ThreadCompactor.run` (as designed below), deletes the export, and retargets the table test to drive `ThreadCompactor.run`.
- Thread's compactor is at `context.compaction?.compactor` (grouped with `tokenBudget`); tests install one via `compactorSlot(thread).compactor = …` in `test-helpers.ts`.

# Design

There are three explicit stages of a prompt:

1. **Raw**: `PendingMessage`. Text as typed, possibly containing `@compact`, `@file:`, `@diff`, etc.
2. **Expanded**: `ExpandedPrompt`. The result of running every command: `AgentInput[]` content plus the reminders the commands asked for. Only the resolver produces one.
3. **Logged**: `ProviderMessage`s in the native log. The expanded content lands here, possibly alongside supervisor injections in neighbouring messages.

The directive "compact first" is not part of the prompt. It is a property of the resolved submission, so `ResolvedSubmission` becomes a union of "send this prompt" and "compact, then send this prompt".

Compaction always carries an `ExpandedPrompt`-shaped payload (`AgentInput[]`), never a string. The only place it becomes a string is inside the compactor, where it fills a slot in the chunk prompt template.

## Splitting the pending user turn out of the log

The loop keeps appending its input to the log before a suspend. The tool loop and its result types are unchanged. Thread never inspects log contents: it hands the compactor the whole log plus `reason.next`, and gets back a summary and the input to send next. How the compactor gets there is private to it. `ThreadCompactor` splits the log by introspecting the `ProviderMessage`s:

- **Pending tail:** the user messages after the last assistant message.
  - If any of them holds a `tool_result`, the tail is mid-loop and not a user turn: there is no pending tail, and the whole log is compacted as today.
- **Carried content:** the tail's `text`, `image` and `document` blocks, in order, with `nativeMessageIdx` stripped. `ProviderTextContent`, `ProviderImageContent` and `ProviderDocumentContent` are exactly `AgentInput` plus an index, so this is a structural projection, not a text scrape.
  - Every other block type is dropped: `context_update`, `system_reminder`, `system_info`. The fresh core's supervisors re-derive those.
  - The abort marker is appended by the core as a text block, so it has to be recognised: the split drops a text block equal to `ABORT_MARKER_TEXT`. If the marker ever becomes its own content type, this special case goes away.
- **Compactor input:** the messages before the pending tail.
- **Continuation:** `next` becomes `[...reason.next, ...carried]` and is sent verbatim on the fresh core.

The split is a private function of `ThreadCompactor.run`. If `history` is empty, the pending turn was all there was: the compactor spawns no children and returns `complete` with no summary and the combined `next`. Thread then replaces the core and sends `next`, the same as after any compaction, with no special case of its own. This replaces `splitPendingUserText`, and there is no text join anywhere.

## Queued `@compact`

- `promptFlush` / `flushQueuesForNextTurn` concatenate the `AgentInput[]` flushed ahead of the compaction with the compaction's own `next`, instead of `joinText`.
- `FlushedQueue`'s compact variant carries `next: AgentInput[]`.

## Interfaces

```ts
// submission/index.ts
export type PendingMessage = string & { __pendingMessage: true }; // unchanged: raw

/** Every command in a raw message has run. */
export type ExpandedPrompt = {
  content: AgentInput[];
  reminders: string[];
};

export type ResolvedSubmission =
  | { type: "send"; prompt: ExpandedPrompt }
  /** `@compact <rest>`: `prompt` is `<rest>` expanded; empty content means
   * "continue". */
  | { type: "compact"; prompt: ExpandedPrompt };

export type ResolveSubmission = (
  message: PendingMessage,
) => Promise<ResolvedSubmission>;

// compactPrompt: deleted

// compaction/index.ts
export type CompactSuspendReason = {
  kind: "compact";
  /** Sent on the fresh core after compaction; empty means "continue". */
  next: ReadonlyArray<AgentInput>;
};

export type CompactionOutcome =
  | {
      type: "complete";
      /** Absent when there was nothing to summarize. */
      summary: { text: string; chunkCount: number } | undefined;
      /** Sent verbatim on the fresh core: the handoff input followed by any
       * unanswered user turn carried out of the log. Empty means "continue". */
      next: AgentInput[];
    }
  | { type: "error"; message: string }
  | { type: "aborted" };

/** Thread hands over the whole log and the handoff input; everything about
 * how the log is summarized and what is carried past it is the compactor's. */export interface Compactor {
  run(
    messages: ReadonlyArray<ProviderMessage>,
    next: ReadonlyArray<AgentInput>,
    signal: AbortSignal,
  ): Promise<CompactionOutcome>;
}


The compactor renders `next` for its template:
- text items are joined
- images and documents become placeholders like `[image]` / `[document: <title>]`
- if nothing is left, it uses the existing "Continue from where you left off."

## Invariants

- The loop's input is in the native log before the request is issued (and before any post-append count), whether or not the request is suspended.
- Expansion happens exactly once per raw message, in the resolver. Nothing downstream re-parses, flattens or re-expands a prompt.
- Content carried across a compaction is sent on the fresh core exactly as it was expanded: same `AgentInput` items, same order. That includes images and documents.
- The compactor never sees the pending input that is being carried. It is not summarized and also sent.
- Supervisor-injected context (`context_update`, `system_reminder`, `system_info` blocks) in the pending tail is not carried. The fresh core's supervisors re-derive it.
- A tail containing a `tool_result` is never split: mid-loop compaction summarizes everything and continues with `reason.next`.
- The tool loop's contract (input appended before the request, even on suspend) is unchanged.
- `@compact` typed into a compact thread is still ordinary text. The resolver returns `send`.
- Reminders from a `compact` submission's `next` are activated against the fresh core's first user message, not the retired one.
- An empty compactor input (the pending message was all there was) does not fail the submission. The compactor returns `complete` with no summary, and Thread sends `next`.
- Thread depends only on the `Compactor` interface: it never reads or slices `ProviderMessage`s for compaction, and test compactors can return any `next` without imitating the split.

# Stages

## Explicit prompt types

Status: DONE.
- Both `ResolvedSubmission` variants carry the payload as `prompt` (review follow-up), so Thread reads `resolved.prompt` directly; no accessor. Stage 2 keeps this: the compact variant's `prompt` is what becomes `CompactRequest.next`.
- `@compact` in `startSubmission` and queue flushes still flatten via `joinText` into `CompactRequest.nextPrompt` (TODO stage 2).
- `resolveSubmission` in `session-host.ts` is exported for a unit test (`nvimclient/chat/resolve-submission.test.ts`).
- Test resolvers use `sendResolved(content, reminders?)` / `compactResolved(content)` from `test-helpers.ts`.

- Goal:
  - `ExpandedPrompt` and the `ResolvedSubmission` union exist.
  - The nvim resolver and `resolveAsText` produce them.
  - `Thread.startSubmission` and `resolveQueued` consume them.
  - `compactPrompt` is deleted.
  - `CompactSuspendReason` still carries a string for now: `@compact` converts via a local text join in one place, marked for removal in stage 2.
- Tests:
  - `@compact look at @file:foo.ts` resolves to `{ type: "compact", next }` whose content includes the file expansion.
  - In a compact thread, `@compact` resolves to `send`.
  - Existing submission/thread tests pass unchanged in behaviour.

## Structured compaction payload

Status: DONE.
- `CompactRequest.next`, `FlushedQueue`'s compact variant, `compactAndContinue(handoff: AgentInput[])` and `Compactor.run(messages, next, signal)` carry `AgentInput[]`; `joinText` is deleted. Queue flushes concatenate the flushed items ahead of the compaction's own `next`.
- `buildChunkPrompt` renders `next` via `renderNext` (text joined by newlines, `[image]`, `[document: <title>]`, else "Continue from where you left off.").
- After compaction, `next` is sent verbatim; empty sends "Please continue from where you left off.".
- Deviation: `TokenBudget.handoff` stays a `string` (it is plain config, cloned onto forks and asserted as a string in tests); Thread wraps it as one text item (or `[]` when blank) at the `context_budget` stop.
- Stage 3 interim: `splitPendingUserText` still returns text; `compactAndContinue` appends it to `next` as a single text item. Stage 3 replaces this.
- `CompactionOutcome` shape is unchanged (stage 3 adds `next`/optional summary).
- Review follow-up: `CompactRequest.next` and the flush compact variant are `ReadonlyArray<AgentInput>`; `renderNext` switches exhaustively (`assertUnreachable`). agent.test "sends $expected after a budget stop with a blank handoff" pins the whitespace-only handoff behaviour (pending user text sent alone; otherwise the "Please continue…" fallback). `nvimclient/bridge-guard.test.ts` covers the lua `M.bridge` live-channel guard (the `env.NVIM` override is untested: the start env isn't inspectable).
- Tests: agent.test "sends an @compact prompt's image verbatim after compaction"; compaction/index.test "ThreadCompactor chunk prompt" placeholder test; thread.test flush tests now assert `AgentInput[]` in order. Test compactors use a local `nextText` helper to keep string expectations.

- Goal:
  - `CompactSuspendReason.next: AgentInput[]`, and `Compactor.run` takes it.
  - `buildChunkPrompt` renders it.
  - `compactAndContinue` sends `next` verbatim on the fresh core.
  - AutoCompact carries `next`.
  - Queue flushes concatenate `AgentInput[]`.
  - `joinText` is deleted.
- Tests:
  - An explicit `@compact` whose rest expands to text plus an image leads to a post-compaction request that contains the image block, not a flattened string.
  - The compactor's chunk prompt shows a placeholder for it.
  - A queued `@next` message flushed ahead of a queued `@compact` arrives after compaction as its original `AgentInput`s, in order.

## Pending turn split out of the log

Status: DONE.
- `CompactionOutcome.complete` is `{ summary: { text, chunkCount } | undefined; next: AgentInput[] }`. `ThreadCompactor.run` splits via private `splitPendingTurn` (`compaction/compactor.ts`): trailing user messages after the last assistant; tool_result anywhere in the tail means no split; text (minus `ABORT_MARKER_TEXT`), image and document are carried, everything else dropped. Empty history → `complete` with no summary, no children.
- Thread's `compactAndContinue` passes the whole log and the handoff, archives as `compaction` only when there is a summary (else `none`), sets the opening only with a summary, and sends `outcome.next`.
- `splitPendingUserText` deleted; its table test replaced by "ThreadCompactor pending turn split" in `compaction/index.test.ts` (chunk content observed through the child's `/chunk.md`).
- Test compactors return `next: [...next]` (the handoff) and so no longer carry the pending tail. Tests that asserted Thread-side carrying were retargeted: thread.test "leaves %s content flushed…" now asserts the queued content is in the log handed to the compactor; agent.test parity/blank-handoff/injection tests expect only the handoff. The end-to-end AutoCompact+image and over-threshold-first-message cases are covered at the compactor level (split tests) rather than via a real compaction in Thread.
- Existing direct `ThreadCompactor.run` tests gained a trailing assistant message so their lone user message is still chunked.
- Review follow-up: "nothing to summarize" is its own `CompactionOutcome` variant, `{ type: "carried"; next }`, and `complete.summary` is required. Thread switches on `outcome.type` (archive `none`, no opening for `carried`). The duplicate `Compactor` JSDoc was merged. Tests added: agent.test "carries without a summary opening or compaction archive when nothing was summarized" (stub compactor returning `carried`), and compaction/index.test "carries consecutive trailing user messages in order".

- Goal:
  - `ThreadCompactor.run` splits the log privately and returns `{ summary, next }`.
  - Thread's `compactAndContinue` sends the returned `next` and puts the summary into the opening message only when there is one.
  - `splitPendingUserText` is deleted from `thread.ts`.
- Tests:
  - `ThreadCompactor.run` (driven through its public interface, with the thread manager's spawned children observed), on:
    - a log ending in assistant: everything is chunked, and `next` is just the handoff
    - a trailing user turn with text, image and context_update blocks: `next` ends with the text and image in order, the context_update is dropped, and the turn is absent from the chunks
    - a trailing tool_result message: no split
    - a trailing abort marker only: nothing carried
    - a log that is only the pending turn: no children spawned, no summary, and `next` carries the turn
  - With AutoCompact tripping on a request that carries a user message with an image: the compactor's input excludes that message, and the post-compaction request contains the handoff prompt followed by the user's original content, including the image.
  - A thread whose first message is already over the threshold does not fail. It sends the message on a fresh core without spawning compact children.
