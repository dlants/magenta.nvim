# Objective and Context

> let's look at the way compaction works. Can we instead set it up via hooks? I don't think the thread needs to really know that it's being compacted... it's something external that's happening, so I think the thread view knows and manages the display... but the thread doesn't need to know...
>
> And also, as much as possible I'd like to make the compaction threads just normal threads, so I can see inside of them, see progress, see failures, recover, etc...
>
> Can you come up with a plan for that? Start by trying to split out the compaction from the thread / make these more separate.

## How it works today

- `AutoCompactSupervisor` (`node/core/src/thread-supervisor.ts:217`) returns `RequestAction { type: "compact", nextPrompt }`; `composeSupervisors` folds it into `BeforeRequestPlan.compaction`.
- `Agent.applyBeforeRequestActions` (`node/core/src/agent.ts:1415`) turns that into `AgentSendOutcome { type: "compact", nextPrompt }`, settling the in-flight submission. Trigger points: `runTurn` (1153), `handleStopped` (725), `buildToolResponseExtras` (903).
- `Thread.followSubmission` sees the `compact` outcome and calls `Thread.compact()` (`node/core/src/thread.ts`), which constructs a `CompactionManager` and keeps the caller's `send` promise pending via `compactionDone`.
- `CompactionManager` (`node/core/src/compaction-manager.ts`) is a hand-rolled state machine that chunks the rendered transcript (`compact-renderer.ts`, 25k-token target), creates a bare `Runner` per chunk via `provider.createAgent`, runs tools itself (`executeTools` duplicating the agent's tool loop), and accumulates `/summary.md` in an `InMemoryFileIO`.
- The thread mirrors that machine: `state.mode = { type: "compacting", chunkIndex, totalChunks }`, `ThreadPhase` variant `compacting`, `state.compactionHistory: CompactionRecord[]`, `push-compaction-record` / `reset-after-compaction` updates, and `Thread.compactionController`.
- The view renders `thread.core.state.compactionHistory` in `renderCompactionHistory` (`node/chat/thread-view.ts:266`), with per-record / per-step expansion state in `NvimThread.state.compactionViewState`.
- `@compact` dispatches `start-compaction` (`node/chat/thread.ts:917`) straight into `core.compact()`.

So the core `Thread` knows: that it is compacting, how many chunks there are, which chunk it is on, and the full transcript of each compaction sub-run. None of that is thread business.

## Key entities

- `AgentHooks` (`node/core/src/thread-api.ts`) — the existing "Agent asks its owner a question" seam (`onEndTurn`, `onYield`, `onBeforeRequest`, `onToolApplied`). The natural home for compaction.
- `ThreadManager` (`node/core/src/capabilities/thread-manager.ts`) — `spawnThread` / `awaitThreadResult`; already used by `spawn-subagents`.
- `Chat.createThreadWithContext` (`node/chat/chat.ts:614`) — already accepts `threadType: "compact"`, an optional `fileIO` override (`chat.ts:701`), and already skips `AutoCompactSupervisor` for compact threads (`chat.ts:762`).
- `getToolSpecs` (`node/core/src/tools/toolManager.ts:102`) — `COMPACT_STATIC_TOOL_NAMES = ["get_files", "edl"]`; no `yield_to_parent`.
- `buildSystemReminder` returns `undefined` for compact threads (already).
- `compact-renderer.ts` — `renderThreadToMarkdown` + `chunkMessages`; pure, stays in core.

# Design

Three separations, in order.

**1. The thread suspends; it never compacts.**

Compaction is not a thing a thread does — it is a thing done _to_ a thread, by whoever owns it. The core `Thread`'s entire contribution is: stop cleanly before a request it cannot afford, and be resettable.

- `RequestAction`'s `{ type: "compact"; nextPrompt }` becomes the generic `{ type: "suspend"; reason: unknown }`. A supervisor says "stop before issuing this request and hand back to my owner"; it does not say why in any vocabulary core understands. (The same seam serves budget caps, approval gates, etc.)
- `BeforeRequestPlan.compaction` becomes `suspension: { reason: unknown } | undefined`. `AgentSendOutcome`'s `{ type: "compact" }` variant is deleted; `SendResult` gains `{ type: "suspended"; reason: unknown }`. The agent's existing suspend machinery (`agent.ts:594-661`, `TurnResult { type: "suspended" }`) already leaves the log coherent and resumable, which is exactly the postcondition needed.
- `Thread.compact`, `compactionDone`, and the compact branch of `followSubmission` are deleted. `Thread.send` resolves `suspended` and stops. The "keep the caller's promise pending across a compaction" contract disappears from core and reappears one layer up, where the policy already lives.
- `Thread` gains one general primitive in its place: `reset(seed: AgentInput[]): Promise<void>` — dispose the current agent, create a fresh one, prepend `seed` to its next turn, reset the archive cursor. Thread id, context manager, `structuredToolResults` and `edlRegisters` survive, as they do today.

`Thread` itself no longer contains the word "compact". Compaction as a feature stays in core — none of it is neovim-specific — it just lives beside `Thread` instead of inside it.

**2. A core submission loop drives it — not a new layer.**

Nothing sits between `NvimThread` and `Thread` today, and nothing should: the loop is a free function in core, not a class to own.

`node/core/src/compaction/run-submission.ts`:

```
runSubmission(thread, messages, compactor):
  result = await thread.send(messages)
  while result is suspended with reason { kind: "compact", nextPrompt }:
    summary = await compactor.run(thread.getProviderMessages(), nextPrompt)
    await thread.reset([summaryText])
    result = await thread.send([nextPrompt ?? "Please continue from where you left off."])
  return result
```

This is the entirety of what used to be `Thread.compact` + `handleCompactionResult` + `handleCompactComplete`, and it is where the caller-visible promise is held pending across the handoff.

A compact thread that goes wrong needs no special machinery, because it is a normal thread: the user navigates into it, sees the error or the half-written `/summary.md`, and sends it a message like any other thread. `compactor.run` is just `awaitThreadResult` on that thread, so when the user gets it to yield, the parked submission continues by itself. There is no "retry chunk" action, no resume action, and no failed state to model.

The only two ways a run ends other than success:

- the user deletes the compact thread, or the parent thread is destroyed — the run aborts and the parked submission resolves `aborted`;
- the user sends a fresh `@compact` — the in-flight run is discarded (its child threads deleted) and a new one starts.

So the parent thread sits idle with a visible in-progress compaction pointing at a child thread that is stuck; fixing it is the same act as fixing any other stuck thread.

The `@compact` / `@async` / `@next` prefix parsing moves into core beside it (`node/core/src/submission/`), since deciding _what a submission is_ — compact, send now, queue for the next request, queue for the next stop — is not neovim-specific. Only the command expansion behind it (`@file:`, `@diff`, `@diagnostics`, `@quickfix`, `@buffers`) needs nvim, and that stays root-side as an injected callback. Crucially, expansion is _deferred_: parsing produces a list of effects as data, which the owner's resolver turns into content at the moment the message is actually sent, so a `@next` message queued behind a ten-minute turn picks up the file and the diff as they are at delivery time, not as they were when it was typed:

```ts
/** When a parsed submission is delivered. */
export type Delivery =
  /** abort whatever is running and send now */
  | "now"
  /** inject into the current turn at the earliest opportunity (@async) */
  | "async"
  /** wait until the agent next stops (@next) */
  | "next";

export type SubmissionIntent =
  | { type: "compact"; nextPrompt: PendingMessage | undefined }
  | { type: "send"; delivery: Delivery; message: PendingMessage };

/** A submission that has been *parsed* but not *resolved*: a list of effects
 * as data, never a thunk. Core can inspect, render, serialize and test it, and
 * the owner resolves it at delivery — a message queued with `@next` behind a
 * long turn must see the file and the diff as they are then, not as they were
 * when it was typed. */
export type PendingMessagePart =
  | { type: "text"; text: string }
  /** @file: — add to the thread's context at delivery */
  | { type: "file"; path: UnresolvedFilePath }
  /** @diff / @staged */
  | { type: "diff"; staged: boolean }
  /** @diag / @diagnostics */
  | { type: "diagnostics" }
  /** @qf / @quickfix */
  | { type: "quickfix" }
  /** @buf / @buffers */
  | { type: "buffers" }
  /** user-configured commands, which cannot be enumerated at compile time */
  | { type: "custom"; name: string };

export type PendingMessage = {
  /** the raw user text, for rendering the queued entry */
  text: string;
  parts: PendingMessagePart[];
};

export function parseSubmission(text: string): SubmissionIntent;

/** Turn parts into content, running their effects. Nvim-specific (the
 * quickfix list, the buffer list, the context manager), so it is injected —
 * but it takes data, not closures, so core can drive it in tests with a stub. */
export type ResolveParts = (
  parts: ReadonlyArray<PendingMessagePart>,
) => Promise<{ messages: InputMessage[]; reminders: string[] }>;

/** The one entry point for user text: parse, then either compact or send with
 * the right delivery. */
export function submitUserText(args: {
  thread: Thread;
  /** absent for compact threads; without one, a `@compact` intent degrades to
   * plain text rather than erroring or recursing */
  compactor: Compactor | undefined;
  text: string;
  resolve: ResolveParts;
}): Promise<SendResult | { type: "queued" }>;
```

`Thread`'s queue stops holding resolved `InputMessage[]` and holds `PendingMessage`s instead, resolving one only as it dequeues it — via a `ResolveParts` it was constructed with, so the queue is plain data end to end.

Two queues, matching the two delivery points, replacing today's `pendingMessages` / `pendingNextMessages` pair:

```ts
// Thread
/** flushed in full when the next provider request is issued (@async) */
nextRequestQueue: PendingMessage[];
/** flushed in full the next time the agent comes to rest (@next) */
nextStopQueue: PendingMessage[];

send(message: PendingMessage, opts?: { queue?: "async" | "next" }): Promise<ThreadSendResult>;
// resolve: ResolveParts is supplied once, at Thread construction
```

Each queue is flushed entirely at its opportunity — every entry is resolved in order and the results concatenated into one delivery — so several `@async` messages typed during a long turn all arrive at the next request rather than trickling in one per request.

So `preprocessAndSend` (`node/magenta.ts:1617`) shrinks to: hand the raw text plus the `ResolveParts` implementation to `submitUserText`. `start-compaction`, the `@async`/`@next` prefix stripping in `CommandRegistry.processMessage`, and the manual/automatic compaction split all disappear — a `@compact` intent and a threshold suspension converge on the same `compactor.run` + `thread.reset` + resend.

None of this is neovim-specific, so it all stays in core: the intent parsing, the loop, the `Compactor`, the chunker (`compact-renderer.ts`) and the prompt asset. Root-side keeps only what is genuinely nvim: resolving parts into content, the `AutoCompactSupervisor` wiring (`chat.ts:762`), and the rendering.

Subagent and script threads get this for free: they go through the same loop.

**3. The compaction runs as ordinary child threads.**

`Compactor` (`node/core/src/compaction/compactor.ts`), one per thread, constructed with the thread's `ThreadManager` capability and held by `NvimThread` only so the view can read its state:

- Render + chunk the transcript with the existing core helpers.
- For each chunk, in sequence: `chat.spawnThread({ parentThreadId, threadType: "compact", fileIO: <InMemoryFileIO seeded with /summary.md and /chunk.md>, prompt: <existing COMPACT_PROMPT_TEMPLATE + context block> })`, then `await chat.awaitThreadResult(id)`.
- On yield, read `/summary.md` out of that chunk's `InMemoryFileIO` and carry it into the next chunk's seed.
- A chunk thread that errors or stops without yielding is left alone: it is a normal thread the user can open, inspect and message until it yields. Only deletion aborts the run.

One thread _per chunk_ rather than one thread with N turns: a single thread would accumulate every chunk in its message list (12 chunks x 25k tokens on the last request), which is exactly the problem compaction exists to solve. Per-chunk threads are each ~1 chunk + running summary, and they give per-chunk visibility, per-chunk failure, and a natural retry unit.

Because these are real threads they come with: the sidebar tree entry under the parent, `<CR>` to open them, streaming/tool rendering, abort, permissions, and archive logging — all for free, and all of it deleted from `CompactionManager`.

## Interfaces

Core (`node/core/src/thread-supervisor.ts`, `thread-api.ts`):

```ts
/** What one supervisor wants done about the request that is about to be
 * issued. Renamed from `RequestAction`. */
export type SupervisorAction =
  | { type: "suspend"; reason: unknown }   // unknown because the thread itself doesn't need to know the reason - it's just something we need to opaquely pass through to the outside when we handle the suspend
  | { type: "inject"; content: InjectedContent[] }
  | { type: "none" };

/** `onBeforeRequest` keeps returning the supervisors' actions in order;
 * `BeforeRequestPlan` goes away. The agent applies the injections and honours
 * the first `suspend` it scans, which is the arbitration compaction already
 * has today. */
onBeforeRequest?: (ctx: RequestContext) => Promise<SupervisorAction[]>;

export type SendResult =
  // ...existing completed / yielded / aborted / failed
  /** A supervisor stopped the submission before a request. The log is coherent
   * and resumable; what to do about it is the owner's business. */
  | { type: "suspended"; reason: unknown };
```

`Thread` (`node/core/src/thread.ts`): `compact()` / `compactionController` / `compactionDone` deleted, replaced by

```ts
/** Swap in a fresh agent seeded with `seed`. The thread id, context manager,
 * structured tool results and edl registers survive. */
async reset(seed: AgentInput[]): Promise<void>;
```

Core (`node/core/src/compaction/`):

````ts
export type CompactSuspendReason = { kind: "compact"; nextPrompt: PendingMessage | undefined };

`AutoCompactSupervisor` returns `{ type: "suspend", reason: { kind: "compact", nextPrompt } satisfies CompactSuspendReason }`; `runSubmission` narrows on `kind` and treats any unrecognized reason as a plain stop.

`ThreadManager.spawnThread` gains two optional fields, both already supported by `createThreadWithContext`:

```ts
fileIO?: FileIO;
label?: string;   // e.g. "compact 2/3", for the thread-tree row
````

Core (`node/core/src/compaction/`):

```ts
export type CompactionRunState =
  | {
      type: "running";
      chunkIndex: number;
      totalChunks: number;
      threadIds: ThreadId[];
    }
  | { type: "done"; threadIds: ThreadId[]; summary: string }
  /** the chunk thread was deleted, or the parent was destroyed */
  | { type: "aborted"; threadIds: ThreadId[] };

export class Compactor extends Emitter<{ transition: [CompactionRunState] }> {
  /** the current run, then the history of past ones */
  runs: CompactionRunState[];
  /** Resolves once every chunk thread has yielded. A chunk thread that errors
   * simply has not yielded yet — the user can drive it to completion by hand. */
  run(
    messages: ReadonlyArray<ProviderMessage>,
    nextPrompt: PendingMessage | undefined,
  ): Promise<string>;
  /** delete the in-flight child threads and abort the parked submission */
  discard(): void;
}
```

`Compactor.runs` replaces `core.state.compactionHistory` and the `compacting` mode: both the history section at the top of the thread view and the live `📦 Compacting…` status line at the bottom render from it. `NvimThread` subscribes to `transition` and dispatches a re-render — the same core-emits / root-subscribes-at-one-point pattern already used for `Agent` events. Only the expansion state (`compactionViewState`) is root-side.

## Invariants

- `runSubmission`'s promise stays pending across the compaction and across the continuation turn that follows it — the contract moves out of `Thread` into the loop, but callers (`handleSendResult`, the subagent tool, the script runner) see no change. A `suspended` result never escapes the loop.
- A queued message's commands run exactly once, at delivery, and its context effects (`@file:`) land on the thread that ultimately sends it — including after a compaction swapped the agent.
- Each queue is flushed entirely, in insertion order, at its delivery point; a message enqueued _while_ a flush is resolving lands in the next flush, not the current one.
- If resolution throws at delivery, the queue entry is dropped with a visible error rather than wedging the turn loop.
- A suspension leaves the log coherent and resumable: user content already appended stays appended, and a `reset` that never happens must leave the thread usable (the user can simply send again).
- Every submission path goes through `runSubmission` — there is no `core.send` call site left in the root that bypasses it, or auto-compaction silently stops working for that path.
- The context manager, `structuredToolResults`, `edlRegisters`, thread id and archive logger survive the agent swap.
- Compact threads never auto-compact and never receive system reminders (both already true via `threadType === "compact"`).
- Compact threads must not be able to spawn compactions of their own, and must not appear as root rows in the thread overview (they are children of the parent thread).
- A compact thread writes its result to `/summary.md` in its own in-memory FileIO; nothing about the real filesystem is touched, and its `edl`/`get_files` are sandboxed to that FileIO (already how `fileIO` override behaves — `chat.ts:701` also clears `sandboxViolationHandler`).
- If the parent thread is destroyed mid-compaction, its in-flight compact children are destroyed too and the parked submission resolves `aborted`.
- Exactly one run per thread is live at a time — a fresh `@compact` discards the previous one (deleting its child threads) before starting.
- A compact child thread is fully interactive: opening it, sending it a message, and having it yield resumes the parked submission with no additional plumbing. It has no `Compactor` and no `AutoCompactSupervisor`, so it can never compact: `@compact` typed into a compact thread is delivered as ordinary text.

# Stages

## Deferred submissions

- Goal: parsing user text into a delivery + a `PendingMessage` moves into core (`node/core/src/submission/`), command expansion becomes a `PendingMessagePart[]` resolved at delivery, and `Thread`'s queues hold `PendingMessage`s. Root-side keeps only `CommandRegistry`, reshaped into a `ResolveParts` implementation. Independent of compaction, so it lands first.
- Tests:
  - `parseSubmission` unit tests: `@compact`, `@compact <prompt>`, `@async`, `@next`, bare text, `@compact @async`.
  - `@compact` sent to a compact thread (no `Compactor`) is delivered as plain text and spawns nothing.
  - Deferral: a `@next` message queued behind a running turn, whose `@file:` target is modified while the turn runs, is delivered with the file's _later_ contents; the resolver runs once, after the turn ends, not at queue time.
  - The queued-message section of the thread view still renders the raw text of unresolved entries, in both queues.
  - Three `@async` messages typed during one turn are all delivered together at the next request, in order; three `@next` messages likewise at the next stop.
  - A resolver that rejects surfaces an error and leaves the thread able to accept the next submission.

**Status: done** (see commit "Stage 1: Deferred submissions").

Deviations, decided while implementing:

- `PendingMessagePart` is only `{ type: "text"; text }`. The enumerated command parts (`file` / `diff` / `diagnostics` / `quickfix` / `buffers` / `custom`) were not built: the command set includes user-configured custom commands whose patterns core cannot know, and the patterns live with the nvim-side implementations. A text part therefore still carries un-expanded command syntax and `ResolveParts` (the root's `CommandRegistry`) performs the expansion — but it does so at *delivery*, which is the property the stage exists for. Enumerating parts remains possible later without touching any caller.
- No `submitUserText`: it takes a `Compactor`, which does not exist until stage 3. Its job is split for now between `parseSubmission` (core) and `Magenta.preprocessAndSend`, which routes a `compact` intent to the existing `start-compaction` message and a `send` intent to a new `submit-message` thread message. The "`@compact` in a compact thread degrades to text" case therefore arrives with the compactor, in stage 3.
- `Thread.send(InputMessage[])` is unchanged, for callers that compose content programmatically (subagents, scripts, the comment path's empty turn). The new `Thread.submit(PendingMessage, Delivery)` is the user-text entry point; the root's `send-message` message keeps its resolved-messages shape and `submit-message` carries the unresolved one.
- Queue entries lost their `user`/`system` distinction — every queued entry is user text — so `QueuedMessage` is now `{ when, message: PendingMessage }`. Agent state fields are `nextRequestQueue` / `nextStopQueue` per the plan, with actions `enqueue-next-request` / `drain-next-request-queue` (and the `next-stop` pair).
- `handleStopped` resolves the queues *after* the before-request hooks, so a compaction handoff leaves them intact — resolution runs effects, so it must not happen for a request that is never issued.

Tests: `parseSubmission` unit tests live in `node/core/src/submission/submission.test.ts`; the delivery-time behaviours (resolution deferred to delivery, whole-queue in-order flush, a rejecting resolver dropping just its entry) are in `node/core/src/agent.test.ts` under "deferred submissions". `node/comments/comment-input.test.ts` is flaky on `main` independently of this change (verified by stashing).

Follow-up from code review (same stage):

- `PendingMessage` lost its `text` field: `parts` is the single source of truth and the display string is derived with `renderPending(message)` (exported from core). `text` and `parts` could otherwise drift, and consumers were picking arbitrarily.
- `send-message` no longer carries `queue` / `reminders`. It is now strictly "content composed programmatically, delivered now" (the comment path's empty turn, the thread-bootstrap prompt); every deferred or user-text path goes through `submit-message`. Both delivery-now paths share `NvimThread.rejectPendingSandboxApprovals`.
- `ThreadCallbacks.resolve` is required; callers that compose content programmatically pass `resolvePartsAsText` explicitly, so there is no second, implicit default.
- The queue selector is a single table, `DEFERRED_QUEUES` in `agent.ts`, keyed on the `Delivery` values `async` / `next` and holding the state field plus the enqueue/drain action names, so the two ends cannot be spelled differently.
- **Bug found by the missing test**: a compaction handoff *did not* leave the queues intact. `handleCompactComplete` disposes the previous agent, and `Agent.dispose` aborts, which drains both queues into `unsentOnAbort` — silently dropping them. The queues belong to the thread, not to an agent, so `handleCompactComplete` now snapshots them before the dispose and re-enqueues them (still unresolved) on the replacement agent.

Additional tests:

- `node/core/src/agent.test.ts` — a `@next` submission queued before a compaction handoff is neither drained nor resolved at the handoff, and resolves exactly once when the post-compaction turn comes to rest; a deferred submission sent while the agent is idle goes out immediately rather than queueing; reminders returned by a queued entry are activated at delivery; a flush in which every entry fails to resolve settles the submission as `completed` instead of issuing an empty request.
- `node/chat/thread.test.ts` — end-to-end through the real `CommandRegistry`: `@next summarize @file:poem.txt` queued behind a running turn does not touch the context manager until the turn stops, and the file's contents as of *delivery* (mutated while queued) are what reach the provider.

## Suspend seam in core

- Goal: core thread stops compacting. `SupervisorAction` carries a generic `suspend` with an opaque reason and `BeforeRequestPlan` collapses into a plain array, `SendResult` gains `suspended`, `Thread.reset(seed)` replaces `Thread.compact` + `handleCompactionResult` + `handleCompactComplete`, and `mode: "compacting"` / `ThreadPhase.compacting` / `compactionHistory` / `Thread.compactionController` are deleted. `CompactionManager` moves out of `Thread` and is driven by the new `runSubmission` loop, so behaviour is unchanged.
- Tests:
  - Core-only: a thread whose supervisor suspends resolves `send` as `suspended` with the reason intact, issues no provider request, and leaves the log resumable — a subsequent `send` continues normally without a reset.
  - Core-only: `reset(seed)` yields a fresh agent whose first request contains `seed` and none of the prior messages, while `structuredToolResults`, `edlRegisters` and the context files survive.
  - Loop-level: `@compact` and a threshold breach both drive the same loop; the submitter's promise resolves only after the post-compaction continuation turn comes to rest.
  - Existing `node/chat/thread-compact.test.ts` passes, with assertions on `core.state.compactionHistory` / `mode.type === "compacting"` moved to driver-side state.

**Status: done** (see commit "Stage 2: Suspend seam in core").

Deviations, decided while implementing:

- `RequestAction` was renamed to `SupervisorAction`; the pre-existing `SupervisorAction` union (`EndTurnAction | YieldAction | RequestAction`) was unused outside the re-export and was deleted rather than renamed.
- `BeforeRequestPlan` is gone: `AgentHooks.onBeforeRequest` returns `SupervisorAction[]` and `Agent.applyBeforeRequestActions` scans it, applying every injection and honouring the first `suspend`. Arbitration therefore moved from `composeSupervisors` into the agent, which is where the plan puts it.
- `runSubmission` takes `{ thread, compactor, start }` rather than `(thread, messages, compactor)`. There are two ways to open a submission (`Thread.send` with composed content, `Thread.submit` with user text) plus the manual `@compact` (which opens *already suspended*), so the loop takes a thunk for the first step instead of re-deriving it.
- `Thread.reset(seed, archiveCompaction?)` carries an optional archive note. The archive's entry schema has a `compaction` variant, and `ThreadLogger` is private to `Thread`; rather than expose the logger, `reset` forwards the note. This is the only compaction-shaped thing left in `thread.ts`.
- `Thread.context` became public readonly, so the compactor can build agents against the same environment without a duplicate copy of the wiring.
- `reset-after-compaction` is now the generic `reset-agent-state`. Its behaviour is unchanged, which means `edlRegisters` are **cleared** by a reset — the plan text says they survive, but they never have, and a saved register refers to text the fresh agent has never seen. `structuredToolResults`, the context manager, the thread id and the archive logger do survive.
- Stage 4's display work is not done, but the state it renders had to move somewhere: `ManagedCompactor` (`node/core/src/compaction/index.ts`) wraps the existing `CompactionManager`, holds `history: CompactionRecord[]` and `progress: CompactionProgress | undefined`, and emits `progress`. `NvimThread` owns one and subscribes; `thread-view.ts` reads `thread.compactor.history` / `thread.compactor.progress` in place of `core.state.compactionHistory` / `mode.type === "compacting"`. Stage 3 replaces `ManagedCompactor`'s innards with child threads; stage 4 reshapes `history`/`progress` into `Compactor.runs`.
- `NvimThread.runSubmission` is the single root-side entry point: `send-message`, `submit-message` and `start-compaction` all go through it, so no path reaches `core.send` directly.
- `ThreadPhase.compacting`, `ThreadMode.compacting`, `ThreadState.compactionHistory`, `Thread.compact`, `Thread.compactionDone` and `Thread.compactionController` are deleted. `CompactionManager` and `compaction-controller.ts` survive to stage 3/5.
- An unclaimed suspension (a reason the loop does not recognize, or no compactor) resolves the submission as `completed` and leaves the log resumable, per the plan. A `reset` that throws rejects `runSubmission`'s promise rather than resolving `failed`; the old "resolves failed when the agent swap itself throws" test was dropped in favour of the unclaimed-suspension test.

Tests: `node/core/src/agent.test.ts` gained `describe("runSubmission across a compaction handoff")` (pending across the continuation turn, `failed` on a summarizing error, unclaimed suspension resolves `completed` and stays resumable) and `describe("Thread.reset")`. The `Thread survives the compaction agent swap` and archive-marker tests now drive the real loop with a stub `Compactor`. `thread-supervisor.test.ts` asserts the action array. `thread-compact.test.ts` and `supervisor-wiring.test.ts` were mechanically retargeted at driver-side state.

Follow-up from code review (same stage):

- The suspension reason is typed, not `unknown`. `SuspendReason = CompactSuspendReason | PlainStopSuspendReason` (the latter is `{ kind: "stop"; message }`, the "just stop, here's why" case the seam was always meant to serve). `SupervisorAction`, `SendResult["suspended"]` and the agent's internal suspend plumbing all carry it, so `asCompactReason` and its two unchecked casts are deleted — `runSubmission` narrows on `reason.kind === "compact"`.
- `composeSupervisors` arbitrates again, returning `ComposedRequestActions = { injections: InjectedContent[]; suspend: { reason } | undefined }` instead of a `SupervisorAction[]` the agent scanned. Individual supervisors still return a per-supervisor `SupervisorAction`; only the composed result is unambiguous, so "several suspends plus some `none`s" is no longer representable at the point where it is consumed.
- `ManagedCompactor` holds one field, `state: { type: "idle" } | { type: "running"; manager; progress }`, replacing the independently-optional `manager` / `progress` pair; the view and tests use `state.type === "running"` as the "is compacting" predicate rather than `progress !== undefined`.
- `Thread.reset` takes an options object with an explicit `archive: { type: "compaction"; ... } | { type: "none" }`, so the caller states its intent instead of omitting an argument.
- `renderStatus`'s compaction argument is a required positional parameter.
- `AgentSendOutcome` (a pure alias of `SendResult`) is deleted in favour of `SendResult`.

Additional tests:

- `node/core/src/agent.test.ts` — `runSubmission` across *two* consecutive handoffs (the caller's promise stays pending throughout, each pass reseeds with the newest summary and its own next prompt, and earlier generations' content is gone); `Thread.reset` with an empty seed and `archive: { type: "none" }` writes no compaction entry to the archive and starts an empty agent.
- `node/chat/thread-compact.test.ts` — a compact chunk request that errors out pushes a history record with no `finalSummary` and returns `compactor.state` to `idle` (the `ManagedCompactor.finish` error path the history view renders).

`node/comments/comment-input.test.ts` remains flaky on `main`, verified again by stashing.

## Compact threads are real threads

- Goal: `Compactor` replaces `CompactionManager`. Chunks are compacted by sequentially spawned `threadType: "compact"` child threads with an `InMemoryFileIO`, awaited via `awaitThreadResult`. `compaction-manager.ts` and `compaction-controller.ts` are deleted.
- Requires: `yield_to_parent` added to `COMPACT_STATIC_TOOL_NAMES`; `SubagentSupervisor` (or a compact-specific equivalent) wired for compact threads so a stop without a yield nudges rather than hangs; `ThreadManager.spawnThread` accepting `fileIO` and `label`. Compact threads go through `runSubmission` too, but with no auto-compact supervisor, so they can never suspend for compaction themselves.
- Tests:
  - Single-chunk: `@compact` spawns exactly one child thread of type `compact` under the parent; it receives the rendered transcript; after it writes `/summary.md` and yields, the parent continues with the summary and a reduced message list.
  - Multi-chunk: three chunks spawn three sequential compact threads; chunk 2's prompt contains chunk 1's summary; chunk 3's prompt does _not_ contain chunk 1's raw text.
  - Recovery: a compact child thread whose turn fails leaves the parked submission unresolved; sending that child a message from its own view and letting it yield completes the compaction and the parent continues.
  - Abort: deleting the compact child resolves the parked submission as aborted; a fresh `@compact` discards the in-flight run and starts a new one.
  - Regression: `node/comments/comment-delivery.test.ts` "keeps delivering after a compaction swaps the agent" still passes.

**Status: done** (see commit "Stage 3: Compact threads are real threads").

Deviations, decided while implementing:

- The class is `ThreadCompactor` (`node/core/src/compaction/compactor.ts`), implementing the existing `Compactor` interface; `ManagedCompactor` and `compaction-manager.ts` / `compaction-controller.ts` are deleted. `CompactionOutcome` lost `steps` (there are no steps any more, only child threads) and gained `chunkCount`, a `message` on the error variant, and an `aborted` variant — `runSubmission` maps `aborted` to a `SendResult` of `aborted` rather than `failed`.
- `CompactionRunState` has four variants, not three: `error` joins `running` / `done` / `aborted`, so "the chunk threads all yielded but `/summary.md` came back empty" is distinguishable from "the user deleted a chunk thread". `ThreadCompactor.runs` holds the current run last; `current` is the accessor the status line uses.
- `ThreadManager` gained `deleteThread(threadId)` alongside `fileIO` and `label` on `spawnThread`. `discard()` needs it, and deletion is already the thing that settles `awaitThreadResult` as `aborted`, so no second abort channel was needed. `Chat.deleteThread` is a public wrapper over the existing `deleteThreadSubtree`.
- `label` is implemented as the child thread's title (`core.setTitle`), which is what the thread tree already renders. No new field on `ThreadWrapper`.
- Chunk threads are spawned with `subagentConfig: { fastModel: true }`, preserving the fast-model behaviour `CompactionManager` had.
- The chunk prompt now fills in the template's `{{summary}}` and `{{chunk}}` placeholders (which `CompactionManager` left literally unsubstituted, duplicating them in a hand-built context block). `/summary.md` and `/chunk.md` are still present in the child's `InMemoryFileIO`.
- `NvimThread.compactor` is `undefined` on compact threads rather than a live-but-idle compactor, so a compact thread cannot compact even if a supervisor were misconfigured. `Magenta.preprocessAndSend` uses that to deliver `@compact` typed into a compact thread as ordinary text.
- Compact threads are wired with `SubagentSupervisor` (the same branch as `subagent` / `docker_root`), so a chunk thread that stops without yielding gets nudged.
- Stage 4's display work is still outstanding, but `thread-view.ts` had to move off the deleted `CompactionRecord`: the history section now renders one row per settled run, listing its chunk threads with `<CR>` to select, and the status line reads `compactor.current`. The per-step transcript dump is gone — the transcript is the child thread.

Tests (`node/chat/thread-compact.test.ts`, 15 tests): the chunk threads now yield via `yield_to_parent` (helper `yieldChunk`). The old "records a summary-less history entry when the compaction errors out" test became **"lets the user rescue a chunk thread whose turn failed"** — a failing chunk thread no longer settles the run; the test asserts the run stays in flight, then messages the child thread directly and watches the parked submission continue when it yields. The multi-chunk test is now "spawns one compact child thread per chunk, carrying the summary forward" and asserts one `compact` child per chunk parented to the thread, chunk 2's prompt carrying chunk 1's summary. Added "deleting the compact child thread aborts the parked submission".

`node/comments/comment-input.test.ts` remains flaky on `main` (verified again by stashing: 1–2 failures per run either way).

Follow-up from code review (same stage):

- `CompactionRunState` gained an `id: CompactionRunId` and its `threadIds` are `ReadonlyArray<ThreadId>`, always stored as a copy — the first push no longer aliased the live array the loop mutates. The view keys `compactionViewState` on `run.id` rather than the position in the *filtered* history array, which shifted whenever a run was in flight (`toggle-compaction-record` now carries `runId`).
- `ThreadCompactor.discarded` is gone. Cancellation is encoded in the run itself: `run()` captures its id and every write goes through `update(id, ...)`, which no-ops unless that id is still the last run, and `isCurrent(id)` (last run, still `running`) is what a resumed `awaitThreadResult` checks. A stale run parked on `awaitThreadResult` can therefore no longer resurrect itself once a fresh run starts.
- `NvimThread.state.compactionViewState.expandedSteps` and the `toggle-compaction-step` Msg variant are deleted — there are no steps any more, only chunk threads.
- `parseSubmission(text, { compactionAvailable })` decides whether `@compact` is significant, so `Magenta.preprocessAndSend` no longer rebuilds a fallback `message`/`delivery` by hand for the compact-thread case.
- `node/comments/comment-delivery.test.ts` "keeps delivering after a compaction swaps the agent" was broken by stage 3 (its chunk thread ended its turn instead of yielding); it now yields.

Additional tests (`node/chat/thread-compact.test.ts`):

- a chunk thread that yields with an empty `/summary.md` settles the run as `error` and fails the parked submission rather than hanging;
- a second `@compact` while the first run's chunk thread is pending deletes that thread, records the first run `aborted`, and starts a fresh run;
- `@compact foo` typed into a compact child thread is delivered as raw text and spawns no nested compaction.

## Display and navigation

`NvimThread` keeps both existing render sites; they just read `Compactor.runs` instead of `core.state.compactionHistory` / `core.state.mode`.

- Goal:
  - **History, at the top of the thread view** — `renderCompactionHistory` (`thread-view.ts:266`) still renders one expandable row per past run, with the same `=` bindings and `compactionViewState`. Instead of dumping each step's messages inline, an expanded run lists its per-chunk threads, and `<CR>` on one selects that thread — the transcript is now a real thread the user can open.
  - **Live status, at the bottom** — the `📦 Compacting thread... (chunk i / n)` line (`thread-view.ts:99`) is driven by the `running` run state rather than `mode.type === "compacting"`, so the status line survives the removal of the `compacting` mode. It also becomes a target: `<CR>` opens the chunk thread currently running.
  - Compact children render in the thread tree under their parent (labelled `compact i/n`, excluded from the root list) with normal streaming/tool display.
- Tests:
  - While compacting, the thread view's status line shows the chunk counter, sourced from `Compactor`; when the run finishes it disappears and a history row appears.
  - The history rows survive the agent swap and a thread switch, and expand/collapse as before.
  - The thread overview lists a running compaction's child threads nested under the parent and not as roots.
  - Pressing `<CR>` on a history row's chunk entry, or on the live status line, selects the corresponding compact thread; that thread's own view renders its edl tool calls.
  - A compact child thread in an error state renders like any other errored thread, and can be messaged from its own view.

## Cleanup

- Goal: dead code and dead state removed — `CompactionStep`/`CompactionRecord` from core, `compaction-controller.ts`, `CompactionManager.executeTools` (the duplicated tool loop), and the `start-compaction` thread message.
- Tests: `npx tsc -b`, `npx vitest run`, `npx biome check .` all clean; no remaining references to the deleted symbols.
