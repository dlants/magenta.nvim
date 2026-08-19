# Objective and Context

> so right now we're inserting the contextManager and gitTracker into the core thread and agent. I think I'd like to expand the hooks API for runners, threads and agents in such a way that we can attach contextManager and gitTracker via hooks.
>
> I think for gitTracker we really just need to be able to attach a message on an onBeforeRequest, if the git state has changed.
>
> For contextManager, it's also an onBeforeRequest thing, but we also need to be notified of tool uses when they're done. So we'll need a new hook that the contextManager can listen to, to find out about when the agent interacts with files via edl and getFile.

## Entities involved

- `AgentHooks` (`node/core/src/thread-api.ts:115`) — `onEndTurn` / `onYield` / `onBeforeRequest`, each answered by at most one hook.
- `ThreadSupervisor` + `composeSupervisors` + `mergeRequestActions` (`node/core/src/thread-supervisor.ts`) — the owner-side arbitration that produces an `AgentHooks`.
- `RequestContext` / `RequestAction` (`thread-supervisor.ts:20-31,135-138`) — today `inject` carries a bare `text: string`.
- `ContextManager` (`node/core/src/context/context-manager.ts`) — tracked files, polling, `getContextUpdate()`, `contextUpdatesToContent()`, `toolApplied()`, events `fileAdded`/`fileRemoved`/`pendingUpdatesChanged`/`filesReset`.
- `ContextTracker` / `ToolApplied` / `OnToolApplied` (`node/core/src/capabilities/context-tracker.ts`) — the read-only `files` view tools get, and the shape of a file-touch notification.
- `GitTracker` (`node/core/src/context/git-tracker.ts`) — `getAgentView()`, `getUpdate()`, plus `gitUpdateToText()`.
- `ContextUpdateSink` (`agent.ts:148`) — `onContextUpdatesSent` / `onGitContextUpdateSent`, plumbed through `ThreadCallbacks`.

## Files

- `node/core/src/agent.ts` — owns `contextManager`/`gitTracker` today: `getAndPrepareContextUpdates()` (1232-1267), the sink calls (1145/1341/1384), `createToolContext().onToolApplied` (752-763), `getActiveReminders()` reading `.files` (1273-1281), hook consultation (1429-1450).
- `node/core/src/thread.ts` — constructs/starts/destroys both managers, subscribes to context-manager events for `onUpdate`, clones files in `Thread.clone`.
- `node/core/src/thread-supervisor.ts` — action types, merge, existing supervisors.
- `node/core/src/thread-api.ts` — `AgentHooks`.
- `node/core/src/compaction-manager.ts` — takes a `ContextManager`, uses it only as a `ContextTracker` + `toolApplied`.
- `node/chat/thread.ts` — the only place that constructs a core `Thread` (310) or clones one (564); exposes `contextManager` getter (232).
- `node/chat/chat.ts`, `node/chat/thread-view.ts`, `node/chat/commands/file.ts`, `node/magenta.ts`, `node/test/driver.ts` — root consumers of `thread.contextManager`.

# Design

Today the agent hard-codes two collaborators. Both only ever do three things:

1. contribute content to the request that is about to go out (`getContextUpdate` + `gitTracker.getUpdate`),
2. learn that a file-touching tool ran (`toolApplied`),
3. answer "what does the agent currently see?" (`contextTracker.files`, read synchronously by `get_files` and by the markdown system-reminder scan).

(1) and (2) become hooks. (3) stays a capability — it is a synchronous read from inside tool execution, and routing it through a hook would only obfuscate it. So the agent keeps a `contextTracker: ContextTracker` (read-only `files`), and loses all knowledge of `ContextManager` and `GitTracker`.

The owner side gets one new class, `ContextSupervisor`, that owns the two managers and implements the two hooks. Core `Thread` no longer constructs, starts, or destroys them; `node/chat/thread.ts` (the sole constructor of core threads) creates the supervisor, pushes it onto the supervisors array, and exposes `contextManager` from it so the root's views and commands are unchanged.

Three consequences worth calling out:

- **`onBeforeRequest` must fire on the opening request of a submission**, not just on continuations. Its doc comment already claims it does; the code only consults it at `handleStopped` (684) and `executeTools` (875). This stage makes the claim true, which is also what lets context updates ride the first request.
- **`onBeforeRequest` becomes async.** `getContextUpdate()` and `gitTracker.getUpdate()` both await.
- **Injections must carry non-text content and a commit signal.** File updates can be images/documents, and `getContextUpdate()` *commits* agent views as a side effect — so an injection that never gets sent (the `!hasContent && no content` early `settle`) would silently swallow a file update. The injection therefore carries an `onSent` callback that the agent calls exactly when the request is actually issued, and `ContextSupervisor` defers its commit until then.

`ContextUpdateSink` disappears from core `Thread`/`Agent`: the supervisor knows what it injected, so it fires `onContextUpdatesSent`/`onGitContextUpdateSent` itself from `onSent`. Root passes those two callbacks to the supervisor's constructor instead of into `ThreadCallbacks`.

## Interfaces

`node/core/src/thread-supervisor.ts`:

```ts
/** Content an injection can contribute. Same shape as AgentInput minus the
 * native index, which only the agent can assign. */
export type InjectedContent =
  | { type: "text"; text: string }
  | ProviderMessageContent & { type: "image" | "document" };

export type RequestAction =
  | { type: "compact"; nextPrompt: string | undefined }
  | {
      type: "inject";
      content: InjectedContent[];
      /** Called exactly once, iff the request carrying this content is
       * actually issued. Where a supervisor commits side effects. */
      onSent?: () => void;
      andThen:
        | { type: "compact"; nextPrompt: string | undefined }
        | { type: "none" };
    }
  | { type: "none" };

/** Convenience for the text-only supervisors. */
export function injectText(text: string): RequestAction;

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
```

`mergeRequestActions` concatenates `content` arrays in supervisor order and composes the `onSent` callbacks into one (all are called, in order).

`node/core/src/thread-api.ts`:

```ts
export type AgentHooks = {
  onEndTurn?: (ctx: EndTurnContext) => EndTurnAction;
  onYield?: (value: YieldValue) => Promise<YieldAction>;
  onBeforeRequest?: (ctx: RequestContext) => Promise<RequestAction>;
  /** A file-touching tool (edl, get_files) finished. Fire-and-forget. */
  onToolApplied?: OnToolApplied;
};
```

`node/core/src/context/context-supervisor.ts` (new):

```ts
export class ContextSupervisor implements ThreadSupervisor {
  readonly contextManager: ContextManager;
  readonly gitTracker: GitTracker;

  constructor(args: {
    contextManager: ContextManager;   // already constructed + started
    gitTracker: GitTracker;
    onContextUpdatesSent?: (updates: FileUpdates) => void;
    onGitContextUpdateSent?: (update: GitContextUpdate) => void;
  });

  onBeforeRequest(ctx: RequestContext): Promise<RequestAction>;
  onToolApplied: OnToolApplied;

  destroy(): void;                      // contextManager.destroy()
  static async clone(source: ContextSupervisor, ...): Promise<ContextSupervisor>;
}
```

`AgentContext` / `AgentDeps` changes:

- `AgentContext` drops `initialFiles` and `initialGitState`; gains `contextTracker: ContextTracker`.
- `AgentDeps` drops `contextManager`, `gitTracker`, `contextUpdateSink`.
- `Thread` drops the `contextManager` / `gitTracker` fields, the context-manager event subscription, and `ThreadCallbacks` shrinks to `{ onUpdate: OnUpdate }`.
- `Thread.clone` drops `buildClonedFiles`; the caller supplies an already-cloned `contextTracker` in the new `AgentContext`.
- `CompactionManagerContext.contextManager: ContextManager` becomes `contextTracker: ContextTracker` plus an `onToolApplied: OnToolApplied` supplied by the thread (which routes to hooks, same as the agent).

## Invariants

- A file update produced by `getContextUpdate()` is either sent to the provider or not committed. No update may be dropped by the `hasContent` early-settle path, and `onSent` fires at most once per action.
- Ordering of injected content within a request is preserved: git update, then file updates, then the user's own content (matching today's `contentToSend` order).
- `onContextUpdatesSent` / `onGitContextUpdateSent` still fire exactly when the corresponding content actually goes out — the root pins them onto the message being sent for rendering.
- Compaction swaps the agent but not the thread: the `ContextSupervisor` is durable and survives the swap, as `ContextManager` does today.
- `Thread.clone` still yields a thread with an independent copy of the tracked-file state (re-read text, copied binary agent views) and the source's git agent view; the source and clone share no mutable context state.
- `onToolApplied` must remain synchronous and must not call back into the agent.
- Auto-compaction now also gets consulted at submission start; `AutoCompactSupervisor` must behave sanely there (it keys off `inputTokenCount`, which is the runner's last-known count, so it should — verify no double-compaction loop).

# Stages

## Injection payloads and commit signal

- Goal: `RequestAction.inject` carries `InjectedContent[]` plus `onSent`, `mergeRequestActions` composes both, and existing supervisors are converted to `injectText`. `onBeforeRequest` becomes async throughout. No behavior change yet.
- Tests:
  - Existing `thread-supervisor` merge tests, updated: two supervisors both injecting produce concatenated content in order, and both `onSent` callbacks are invoked once by the merged action.
  - Agent-level: a supervisor whose injection is the only content on a submission still causes a request to be issued, and its `onSent` fires; a submission that is short-circuited (no user content, no injection) fires no `onSent`.

## onBeforeRequest at submission start

- Goal: the agent consults `onBeforeRequest` with `kind: "submission"` before the opening request of a send, merges the resulting content ahead of the user content, and calls `onSent` only once the request is actually issued.
- Tests:
  - A supervisor that injects on `kind: "submission"` sees its text in the first provider request of a fresh thread, before the user message.
  - `AutoCompactSupervisor` over the token threshold triggers compaction from a plain `send` (not just from a continuation) — and does not compact twice for one submission.
  - Existing compaction tests (`node/chat/thread-compact.test.ts`) still pass.

## onToolApplied hook

- Goal: `AgentHooks.onToolApplied` exists; the agent's `createToolContext().onToolApplied` fires the hook in addition to its own `editedFilesThisTurn` bookkeeping; `composeSupervisors` fans it out to every supervisor. `ContextManager` is still wired directly at this point, so the hook has no subscriber yet.
- Tests:
  - After an `edl` edit and after a `get_files` read, a test supervisor's `onToolApplied` receives the expected `AbsFilePath` and `ToolApplied` variant (`edl-edit` with `previousContent`, `get-file` with content).
  - `editedFilesThisTurn` is still populated (drives the turn's edit review).

## ContextSupervisor

- Goal: the new class exists and owns both managers; it implements `onBeforeRequest` (git text + file-update content, committed in `onSent` where it also fires the two sink callbacks) and `onToolApplied`. Still not attached — the agent's own path is still live — so this stage is pure addition.
- Tests:
  - Unit: with a dirty tracked file, `onBeforeRequest` returns an inject action whose content matches `contextUpdatesToContent`, and the file's agent view is *not* committed until `onSent` runs; a second `onBeforeRequest` before `onSent` does not double-report.
  - Unit: a git branch change produces the `gitUpdateToText` line once; a second call with unchanged git produces nothing.
  - Unit: image/document file updates survive as non-text `InjectedContent`.

## Cut over the agent

- Goal: delete `getAndPrepareContextUpdates`, the `contextManager`/`gitTracker` fields on `Agent` and `Thread`, and `ContextUpdateSink`. `AgentContext` carries `contextTracker`. `node/chat/thread.ts` constructs the `ContextManager`/`GitTracker`/`ContextSupervisor`, pushes the supervisor onto `supervisors`, passes `contextTracker`, subscribes to the context-manager events for re-render, exposes the `contextManager` getter, and destroys the supervisor with the thread. `Thread.clone` loses `buildClonedFiles`; `NvimThread` clones the supervisor instead. `CompactionManager` takes `contextTracker` + `onToolApplied`.
- Tests:
  - Full existing suite: `npx vitest run` — especially `node/chat/thread.test.ts`, `thread-compact.test.ts`, `node/core/src/agent.test.ts`, `node/context/context-manager.test.ts`, `node/tools/getFile.test.ts`.
  - Integration: adding a file to context via `@file` then sending shows the file content in the request and the context-files section in the view; editing a tracked file out-of-band between turns injects the update on the next request.
  - Integration: after a compaction, tracked files still update on the next request (supervisor survived the agent swap).
  - Integration: forking a thread mid-conversation gives the fork the same tracked files, and editing the fork's files does not affect the source.
  - `npx tsc -b` and `npx biome check .`.
