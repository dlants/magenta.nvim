# Objective and Context

> we now have several similar context trackers - files, comments and git status. I want them all to attach to a thread via hooks.

Supersedes `plans/2026-08-16-context-git-hooks.md`, which only covered files + git. Comments landed since, in the same hard-wired style, which makes the shape of the abstraction much clearer: there are now three collaborators that do the identical thing.

## The three trackers today

- `ContextManager` (`context/context-manager.ts`) — owns tracked files + polling; contributes `getContextUpdate()` → `contextUpdatesToContent()` (text/image/document); committing agent views is a _side effect of_ `getContextUpdate()`; reports via `onContextUpdatesSent`.
- `GitTracker` (`context/git-tracker.ts`) — owns the git agent view; contributes `getUpdate()` → `gitUpdateToText()`; commit is a side effect of `getUpdate()`; reports via `onGitContextUpdateSent`.
- `CommentStore` (`context/comment-store.ts`) — owns comments + delivered counts; contributes `getPendingUpdate()` (pure); commits explicitly via `commitPending()`; reports via `onCommentUpdatesSent`.

All three are consulted from exactly one place — `Agent.submit`, via `getAndPrepareContextUpdates()` (agent.ts:1256-1300) and `appendCommentUpdates()`/`commitCommentUpdates()` (1303-1317) — and all three report through `ContextUpdateSink` (agent.ts:152), which is folded into `ThreadCallbacks` and passed down from `node/chat/thread.ts`.

Beyond contributing content, each has _one_ extra obligation, and they are not the same obligation:

- files: a synchronous read of `contextTracker.files` from inside tool execution (`get_files`) and from `getActiveReminders()` (agent.ts:1320-1333); plus `toolApplied()` notification when `edl`/`get_files` touch a file.
- comments: the `reply` tool needs the live `CommentStore` (`create-tool.ts:175`); plus, in the root layer, `CommentController.refresh()` must run before a request so extmark positions are current (`node/chat/thread.ts:790-795`).
- git: nothing.

## Entities involved

- `ThreadSupervisor` / `composeSupervisors` / `mergeRequestActions` (`node/core/src/thread-supervisor.ts`) — the owner-side arbitration that produces an `AgentHooks`. `onBeforeRequest` is currently sync and `inject` carries a bare `text: string`.
- `AgentHooks` (`node/core/src/thread-api.ts:86`).
- `ContextTracker` / `ToolApplied` / `OnToolApplied` (`node/core/src/capabilities/context-tracker.ts`).
- `ContextUpdateSink` (`agent.ts:152`), `AgentDeps.getCommentStore` (`agent.ts:264`).
- `node/core/src/thread.ts` — constructs `ContextManager` (150), `GitTracker` (152), `CommentStore` for root/docker_root threads (123); subscribes to context-manager events (378-384); clones file + git state (210-216); destroys the context manager (710).

# Design

## One shape, three implementations

Every tracker becomes a `ThreadSupervisor` that implements `onBeforeRequest`. Nothing else about them is shared — deliberately: there is no `ContextProvider` base class or registry, because the only thing the three have in common is the hook signature, and a base class would have to launder three different lifecycles and three different capability obligations through it.

Two changes to the hook protocol make this work.

**Injections carry structured content.** File updates can be images or documents, so `inject` cannot keep carrying a bare string.

```ts
export type InjectedContent =
  | { type: "text"; text: string }
  | (ProviderMessageContent & { type: "image" | "document" });

export type RequestAction =
  | { type: "compact"; nextPrompt: string | undefined }
  | { type: "inject"; content: InjectedContent[] }
  | { type: "none" };
```

**`onBeforeRequest` returns `RequestAction[]`, not a merged action.** `composeSupervisors` stops arbitrating: it collects each supervisor's action in supervisor order and hands the list to the agent. `mergeRequestActions`, `requestedCompaction`, and the nested `andThen` variant all disappear — `andThen` only ever existed as a merge artifact (nothing in the codebase constructs it directly), to keep a compaction from being lost when another supervisor also injected.

Ordering is by supervisor array position, and **the compaction supervisor goes last**. The agent applies the list in order: accumulate injected content, and if a `compact` follows, the compaction wins the request. Because compaction is last, everything before it is injection, and the agent never has to reason about an injection that arrives after a compact.

## Injections are applied immediately

Processing an `inject` action means one thing: append the content to the agent's native message array, right there in the hook-consultation loop. Both runners already have the primitive — `appendUserMessage(content)`, called from `runTurn` (anthropic-runner.ts:442) — so this is a matter of promoting it to the `Runner` interface. One adjustment: it currently pushes a new message unconditionally, and Anthropic requires alternating roles, so it must coalesce into a trailing user message when one is already there.

With that, an inject is unconditionally successful and nothing downstream can undo it:

- the request goes out and carries it;
- the request fails, is aborted, or is retried — the content is still in the log and rides whatever request goes out next;
- the action list ends in `compact` — the content is already in the snapshot `CompactionManager.start` is handed (compaction-manager.ts:138,231), so it is part of the context the summarizer sees;
- the agent is disposed entirely — nothing was owed to it anyway.

This is the one real bug in today's code: `handleStopped` (agent.ts:694-711) stuffs the injection into agent-local `prependToNextTurn` state and then immediately `settle`s for compaction, throwing that agent — and the injection — away. `andThen` was invented to preserve exactly this case and then failed to.

Because application is immediate and unconditional, supervisors commit their side effects eagerly inside `onBeforeRequest` and fire their own display callbacks there.

## Capabilities stay capabilities

Two obligations are _not_ hooks, and forcing them through the hook channel would only obfuscate them:

- `contextTracker: ContextTracker` on `AgentContext` — a synchronous, read-only `files` view. Read from inside tool execution and from the markdown-reminder scan. A hook cannot serve a synchronous read.
- `commentStore: CommentStore | undefined` on `AgentContext` — needed by the `reply` tool.

Both are supplied by the owner alongside the supervisors, and are the _same objects_ the corresponding supervisor owns. `AgentDeps.getCommentStore` (the lazy getter that exists only so compaction can swap the store) collapses to a plain field: the supervisor is durable across an agent swap, so the store is too.

## Layering

All three supervisors live in core (`node/core/src/context/`), since `CommentStore`, `ContextManager` and `GitTracker` are all core classes and docker threads need them too.

`CommentSupervisor` takes a `beforeRead: () => Promise<void>` that the root supplies as `() => commentController.refresh()`. This is a strict improvement over today: the refresh currently only happens on the root's `send` path (`node/chat/thread.ts:790`), so a continuation request picks up stale extmark positions. Moving it into `onBeforeRequest` covers every request.

## Consequences

- **`onBeforeRequest` becomes async.** All three trackers await.
- **`onBeforeRequest` must fire on the opening request of a submission**, not just on continuations. Its doc comment already claims it does; the code only consults it at `handleStopped` (agent.ts:693) and `executeTools` (896). Making the claim true is what lets context updates ride the first request at all. `RequestContext` gains `kind: "submission" | "continuation"` and `stopReason` becomes optional.
- **`ContextUpdateSink` disappears.** Each supervisor takes its own display callback in its constructor.
- **Core `Thread` stops constructing all three managers.** `node/chat/thread.ts` — the sole constructor and cloner of core threads — builds them, wraps each in a supervisor, pushes the supervisors, and passes the two capabilities.
- Compaction swaps the agent but not the thread, so all three supervisors are durable, as `ContextManager` and `CommentStore` are today.

## Interfaces

`node/core/src/thread-supervisor.ts`:

```ts
export type RequestContext = {
  /** "submission": the opening request of a send. "continuation": a request
   * carrying tool results or a supervisor nudge. */
  kind: "submission" | "continuation";
  inputTokenCount: number | undefined;
  stopReason: StreamStopReason | undefined;
};

export interface ThreadSupervisor {
  onEndTurnWithoutYield?(context: EndTurnContext): EndTurnAction;
  onYield?(result: string): Promise<YieldAction>;
  onBeforeRequest?(context: RequestContext): Promise<RequestAction>;
  onToolApplied?(
    absFilePath: AbsFilePath,
    tool: ToolApplied,
    fileTypeInfo: FileTypeInfo,
  ): void;
}

export function injectText(text: string): RequestAction; // for the text-only supervisors
```

`node/core/src/thread-api.ts`:

```ts
export type AgentHooks = {
  onEndTurn?: (ctx: EndTurnContext) => EndTurnAction;
  onYield?: (value: YieldValue) => Promise<YieldAction>;
  /** In supervisor order; the agent applies them in that order. */
  onBeforeRequest?: (ctx: RequestContext) => Promise<RequestAction[]>;
  /** A file-touching tool (edl, get_files) finished. Fire-and-forget. */
  onToolApplied?: OnToolApplied;
};
```

New files under `node/core/src/context/`:

```ts
export class GitSupervisor implements ThreadSupervisor {
  constructor(args: { gitTracker: GitTracker; onSent?: (u: GitContextUpdate) => void });
  onBeforeRequest(ctx: RequestContext): Promise<RequestAction>;
}

export class FileContextSupervisor implements ThreadSupervisor {
  readonly contextManager: ContextManager;      // also the AgentContext.contextTracker
  constructor(args: { contextManager: ContextManager; onSent?: (u: FileUpdates) => void });
  onBeforeRequest(ctx: RequestContext): Promise<RequestAction>;
  onToolApplied: OnToolApplied;                 // → contextManager.toolApplied
  destroy(): void;
  static async clone(source: FileContextSupervisor, ...): Promise<FileContextSupervisor>;
}

export class CommentSupervisor implements ThreadSupervisor {
  readonly store: CommentStore;                 // also the AgentContext.commentStore
  constructor(args: {
    store: CommentStore;
    beforeRead: () => Promise<void>;           // root: commentController.refresh()
    onSent?: (entries: CommentUpdateEntry[]) => void;
  });
  onBeforeRequest(ctx: RequestContext): Promise<RequestAction>;
}
```

Supervisor array order, fixed by the owner: `[GitSupervisor, FileContextSupervisor, CommentSupervisor, ...behavioral supervisors, AutoCompactSupervisor]`.

`AgentContext` / `AgentDeps`:

- `AgentContext` drops `initialFiles` / `initialGitState`; gains `contextTracker: ContextTracker` and `commentStore: CommentStore | undefined`.
- `AgentDeps` drops `contextManager`, `gitTracker`, `getCommentStore`, `contextUpdateSink`.
- `Thread` drops the `contextManager` / `gitTracker` / `commentStore` fields, the context-manager event subscription, and `buildClonedFiles`.
- `CompactionManagerContext.contextManager: ContextManager` becomes `contextTracker: ContextTracker` + an `onToolApplied: OnToolApplied` routed through hooks, same as the agent.

## Invariants

- Applying an inject is unconditional and cannot be undone by anything the agent does next; it never depends on a request being issued.
- Coalescing keeps today's message shape: injections and the user's own content land in a single user message, in the order git, files, comments, user content.
- `AutoCompactSupervisor` is last in the supervisor array, so no injection can follow a compaction in the action list.
- The three display callbacks fire exactly when their tracker produces content, which is exactly when that content is guaranteed delivery.
- The `AgentContext.contextTracker` / `commentStore` capabilities are the identical objects their supervisors own; there is no second copy to fall out of sync.
- All supervisors survive compaction's agent swap.
- `Thread.clone` still yields independent tracked-file state (re-read text, copied binary agent views) and the source's git agent view. Comments are root-thread-only and are not cloned (matching today).
- `onToolApplied` stays synchronous and must not call back into the agent.
- `AutoCompactSupervisor` now also gets consulted at submission start; verify no double-compaction for a single submission.

# Stages

## 1. Action lists and structured injections — DONE

- Goal: `onBeforeRequest` returns `RequestAction[]`; `inject` carries `InjectedContent[]`; `andThen`, `mergeRequestActions` and `requestedCompaction` are deleted; `composeSupervisors` just collects; existing supervisors use `injectText`; the hook is async. `Runner.appendUserMessage` is promoted to the interface and coalesces into a trailing user message. The agent applies each `inject` by appending immediately, and applies a trailing `compact`.
- Tests: `thread-supervisor.test.ts` rewritten (collection order, `[inject, compact]`, `none` dropped); runner-parity coalescing test for both runners; agent-level injection tests rewritten.

Decisions / deviations:

- `appendUserMessage(content, opts?: { coalesce: boolean })`. Unconditional coalescing changed the message shape at the existing call sites (`runTurn`'s opening input, the abort marker), merging user text into tool-result messages and breaking eight display/behaviour tests. Coalescing is therefore opt-in and used only by the injection path; the existing call sites keep push semantics. Consecutive user messages are already normal in this codebase (abort markers) and both providers accept them.
- When several supervisors ask to compact, the **first** wins (prompts are no longer joined) — merging is gone, and `AutoCompactSupervisor` is meant to be the only compaction voice anyway.
- `composeSupervisors` drops `{type: "none"}` actions rather than passing them through, so the returned list is exactly the actions that do something.
- `AnthropicRunner.convertInputToNative` now returns `ContentBlockParam[]` (was `MessageParam["content"]`, i.e. also `string`) so coalescing type-checks.

Review follow-ups (stage 1 code review):

- The composed hook no longer returns `RequestAction[]`. It returns a `BeforeRequestPlan` (`{ injections: InjectedContent[]; compaction: {nextPrompt} | undefined }`), so a contradictory list (several compactions, a stray `none`) is not representable and the agent has no dead `case "none"`. `RequestAction` (with `none`) stays as the *per-supervisor* return type; `composeSupervisors` collapses.
- `injectText` returns `Extract<RequestAction, {type:"inject"}>`; `InjectedContent` uses `Extract<ProviderMessageContent, ...>` rather than an intersection.
- `appendUserMessage(content, opts?: { coalesce?: true })` — the `false` state is no longer representable.
- `AnthropicRunner.messages` is now typed `NativeMessage[]` (content always a block array), which removes the unreachable string-content branch in `appendUserMessage`.
- Named `Compaction` alias (`{ nextPrompt: string | undefined }`) used by `AgentSendOutcome`, the suspend reason and `applyBeforeRequestActions`.
- **Deviation from "injections are applied immediately":** on the tool_use continuation path the injection cannot be appended at hook time, because at that moment the tool results have not been written yet and Anthropic requires the `tool_result` blocks to immediately follow the `tool_use` they answer. Injections from that path are held in `Agent.pendingInjections` and emitted from `buildToolResponseExtras`, i.e. in the very next message after the tool results, on the same request. If the plan also asks for a compaction, they are appended to the log immediately instead, so the agent swap cannot discard them. All other paths append immediately, as designed.
- New tests: runner-parity push-when-nothing-to-fold-into case (both runners); agent-level image injection on the tool_use continuation asserting it lands after the tool_result message; `composeSupervisors` first-compaction-wins.

## 2. Injections survive the compaction handoff — DONE

- Goal: fix agent.ts:694-711. Injections are appended to the message array as they are processed, so by the time a trailing `compact` is applied the content is already in the snapshot handed to `CompactionManager.start` — nothing is held in agent-local `prependToNextTurn` state that the swap can discard.
- Tests: a supervisor injecting while `AutoCompactSupervisor` is over threshold — the injected text appears exactly once in the message array the compaction manager is started with. A supervisor injecting on a request that then fails or is aborted — the text is still in the log and appears in the next request. `node/chat/thread-compact.test.ts` still passes.

Decisions / deviations:

- The production change landed in stage 1: `applyBeforeRequestActions` already appends injections to the runner log immediately, and forces the append (rather than deferring) on the tool_use path when the plan also asks for a compaction. `handleStopped` no longer routes injections through `prependToNextTurn`. Stage 2 was therefore verification + the tests the plan calls for; no further production edits were needed.
- `Thread.startCompaction` hands `manager.start(this.getProviderMessages(), ...)`, i.e. the agent's live log, so "in the log" and "in the compaction snapshot" are the same assertion.
- New tests in `node/core/src/agent.test.ts`: exactly-once injection when a compaction follows (end_turn path); the same for the tool_use path (`deferInjections` + compaction); injection survives a failed next request and rides the retry; injection survives an aborted next request.

## 3. `onBeforeRequest` at submission start

- Goal: agent consults `onBeforeRequest` with `kind: "submission"` before the opening request and merges its content ahead of user content.
- Tests: a supervisor injecting on `kind: "submission"` appears in the first provider request, before the user message. `AutoCompactSupervisor` over threshold compacts from a plain `send`, exactly once.

## 4. `onToolApplied` hook

- Goal: `AgentHooks.onToolApplied` exists; `createToolContext().onToolApplied` (agent.ts:761) fires it alongside `editedFilesThisTurn` bookkeeping; `composeSupervisors` fans out to all supervisors. `ContextManager` still wired directly, so no subscriber yet.
- Tests: after an `edl` edit and a `get_files` read, a test supervisor receives the expected `AbsFilePath` + `ToolApplied` variant. `editedFilesThisTurn` still populated.

## 5. The three supervisors

- Goal: `GitSupervisor`, `FileContextSupervisor`, `CommentSupervisor` exist and are unit-tested. Not attached yet — the agent's own path is still live, so this is pure addition.
- Tests (unit, per supervisor):
  - git: a branch change yields the `gitUpdateToText` line once; a second call with unchanged git yields nothing.
  - files: a dirty tracked file yields content matching `contextUpdatesToContent`; a second call with no further edits yields nothing; image/document updates survive as non-text `InjectedContent`.
  - comments: `beforeRead` runs before `getPendingUpdate`; entries reach the display callback and are marked delivered.

## 6. Cut over the agent

- Goal: delete `getAndPrepareContextUpdates`, `appendCommentUpdates`, `commitCommentUpdates`, `ContextUpdateSink`, `getCommentStore`, and the `contextManager`/`gitTracker`/`commentStore` fields on `Agent` and `Thread`. `AgentContext` carries `contextTracker` + `commentStore`. `node/chat/thread.ts` constructs the three managers and supervisors, pushes them in order (auto-compact last), passes the capabilities, subscribes to context-manager and comment-store events for re-render, exposes the `contextManager` getter for the views/commands, supplies `beforeRead`, and destroys them with the thread. `NvimThread` clones the file supervisor. `CompactionManager` takes `contextTracker` + `onToolApplied`. Drop the ad-hoc `commentController.refresh()` from the root's send path.
- Tests: full suite (`npx vitest run`), especially `node/chat/thread.test.ts`, `thread-compact.test.ts`, `node/core/src/agent.test.ts`, `node/context/context-manager.test.ts`, `node/tools/getFile.test.ts`, and the comment tests. Integration: `@file` then send shows content in the request and the context-files section in the view; an out-of-band edit between turns injects on the next request; a comment added mid-turn is delivered on the next continuation request with fresh positions; after compaction tracked files and comments still update; forking gives the fork independent file state. `npx tsc -b` and `npx biome check .`.
