# Objective and Context

> I do still find the passing of signals around kind of confusing; with on/off as nodes enter or leave... that feels brittle. I know at the leaf nodes (inference, etc...) we can't really avoid passing AbortSignals / controllers. However, in our own layers I think we can do better. I think instead of accepting a signal in the constructor, we should return an `abort` method along with the promise instead. That way we know we get a dedicated abort per node, and the lifecycle of the abort method is clear.

Today, our own layers take an `AbortSignal` from their parent. Each one adds its own listener and has to remove it when it leaves (`withAbort`, `executeToolBatch`, `runToolLoop`'s `onAbort`, the compactor's `onAbort`, `untilAborted`), or it reads a signal that someone else created (`Thread.submissionSignal`, `IDLE_SIGNAL`, `SupervisorChainDeps.abortSignal`). Tools already use the shape we want: `ToolInvocation` is `{ promise, abort }` (`tool-types.ts`).

Relevant files:

- `node/server/src/thread-api.ts`: `ActiveSubmission` (the controller, `step`, `settled`, `abort`), `ABORTED`.
- `node/server/src/thread.ts`: the submission body. It has `submissionSignal`, `toolLoopSubmission` and `IDLE_SIGNAL`, and the queue flushes take a signal.
- `node/server/src/thread-core.ts`: `ThreadCore.runToolLoop(messages, abortSignal)`, `checkBudget(abortSignal)` and `executeTools(..., abortSignal)`.
- `node/server/src/tool-loop.ts`: `runToolLoop(deps, input, abortSignal)`. `ToolLoopDeps.executeTools`, `onBeforeRequest` and `checkBudget` all take a signal.
- `node/server/src/tool-executor.ts`: `executeToolBatch(requests, { ..., abortSignal })`.
- `node/server/src/providers/provider-types.ts`: `NativeInferenceManager.sendRequest(onEvent, abortSignal)` and `countTokens?(abortSignal)`.
- `node/server/src/providers/{anthropic,openai}-inference.ts`: the managers. Each already has an `abort()` and owns a `requestAbortController`.
- `node/server/src/providers/inference-shared.ts`: `withAbort`, which ties a parent signal to `manager.abort`, and `wrapStreamAbortSignalWithTimeout`, a leaf helper that stays.
- `node/server/src/thread-supervisor.ts`: `SupervisorChainDeps.abortSignal: () => AbortSignal`, which the chains check between members.
- `node/server/src/compaction/index.ts`: `Compactor.run(messages, next, abortSignal)`.
- `node/server/src/compaction/compactor.ts`: `ThreadCompactor.run`, which registers an abort listener that deletes the active child.
- `node/server/src/session.ts`: `SessionHost.prepareThread(request, session, abortSignal)` and `Session.pending: Map<ThreadId, AbortController>`.
- `node/server/src/test/harness.ts` and `node/nvimclient/chat/session-host.ts`: the `prepareThread` implementations.
- `node/server/src/utils/async.ts`: `untilAborted` and `abortableDelay`.
- `node/server/src/test-helpers.ts`: `TestAgent`, which builds a controller around `runToolLoop`.
- `node/server/src/context.md`: the cancellation invariants.

# Design

Every cancellable node in our layers returns a handle, `{ promise, abort() }`, and does not accept a signal. A parent keeps the handle of the child it currently has in flight. Its own `abort()` sets a flag and calls the current child's `abort()`. The parent then learns how the child ended from its result value, the same way it does now. We don't register any listeners, so there is nothing to remove.

`AbortController`/`AbortSignal` remain only where an external API needs them:

- the Anthropic/OpenAI SDK calls (`requestAbortController`, `stream.controller`)
- `abortableDelay` retry waits inside the managers
- `countTokens`'s SDK `signal` option
- `codex-auth` login and `fetch` `init.signal`

A node that wraps one of these leaves creates its controller itself and aborts it from its own `abort()`.

Each node stores its current child in a single mutable field. The node sets the field synchronously when it starts the child, before any `await`, and clears it after the child settles. If an abort arrives when there is no child in flight, it only sets the flag. The node then sees the flag in the next gap between children, as the "check only in the gaps" rule in `context.md` already requires.

Handles for work we abandon on abort (`step`: resolving a message, deciding a yield, probing `hasPendingContent`) stay as they are: the work keeps running and its result is dropped. These don't need an `abort()` from the work itself. `ActiveSubmission.step` races the work against an internal `Defer` that its own `abort()` resolves.

Supervisor chains stop taking a signal getter. They receive `isAborted: () => boolean` instead, which the thread wires to the live submission. This is a plain read, not a signal.

## Interfaces

```ts
// utils/async.ts
/** A cancellable unit of our own work. `abort` only interrupts; the result,
 * including its aborted variant, arrives on `promise`. */
export type Task<T> = { readonly promise: Promise<T>; abort(): void };
```

The `untilAborted(promise, signal)` helper is deleted. `abortableDelay` stays because it is a leaf.

```ts
// provider-types.ts
interface NativeInferenceManager {
  countTokens?(): Task<number | { type: "aborted" }>;
  sendRequest(onEvent: OnStreamEvent): Task<RequestResult>;
  // the public abort() is removed; abort goes through the request's Task
}
```

`withAbort` is deleted. The managers return `{ promise: this.runRequest(onEvent), abort: () => this.abort() }`, where `abort` becomes private.

```ts
// tool-executor.ts
export type ToolExecutorDeps = {
  createTool; completedTools; publishTools; onUpdate; // no abortSignal
};
export function executeToolBatch(
  requests: NonEmptyRequestedTools,
  deps: ToolExecutorDeps,
): Task<ToolOutcome>;
```

`abort()` sets `aborted` and aborts the live entries. If invocations are created after the abort, they are aborted as they are created. The outcome is `aborted` if the flag was set.

```ts
// tool-loop.ts
export type ToolExecutor = (
  requests: NonEmptyRequestedTools,
  publishTools: (tools: ToolInvocationState) => void,
) => Task<ToolOutcome>;

export type ToolLoopDeps = {
  logger; manager; onUpdate?;
  executeTools: ToolExecutor;
  onBeforeRequest: () => Promise<AgentInput[]>;
  checkBudget: () => Task<BudgetDecision | { type: "aborted" }>;
  onToolResults: ToolResultsHook;
};

export type ToolLoop = Task<ToolLoopResult> & {
  readonly activity: ToolLoopActivity;
  readonly aborting: boolean;
};
export function runToolLoop(deps: ToolLoopDeps, input: AgentInput[]): ToolLoop;
```

Inside the loop, `let current: Task<unknown> | undefined`. `abort()` sets `aborted`, calls `current?.abort()` and then `deps.onUpdate?.()`. This replaces the `onAbort` listener that only triggered a repaint. Before each child, the loop checks `aborted`. `onBeforeRequest` is not cancellable: supervisors already bail out between members through the chain's `isAborted`.

```ts
// thread-core.ts
checkBudget(): Task<BudgetDecision | { type: "aborted" }>; // wraps manager.countTokens()
runToolLoop(messages: AgentInput[]): ToolLoop;
```

The abort marker, the `failed` logging and `this.toolLoop` bookkeeping move into a wrapper promise on the returned handle.

```ts
// compaction/index.ts
export interface Compactor {
  run(messages: ReadonlyArray<ProviderMessage>, next: ReadonlyArray<AgentInput>):
    Task<CompactionOutcome>;
}
```

In `ThreadCompactor.run`, `abort()` sets `aborted` and deletes `activeChild`, which is exactly the body of today's `onAbort`. `addEventListener` and `removeEventListener` go away.

```ts
// thread-api.ts
export class ActiveSubmission {
  get aborted(): boolean;
  abort(): Promise<void>;           // flag, current?.abort(), stopWork(), await unwind
  /** Abandoned on abort (effects applied by caller). */
  step<T>(work: () => Promise<T>): Promise<T | Aborted>;
  /** Joined: installed as `current` until it settles. */
  settled<T>(start: () => Task<T>): Promise<T | Aborted>;
  /** Join a plain promise with no abort of its own (preempted submission, reset). */
  joined<T>(work: () => Promise<T>): Promise<T | Aborted>;
  settle(): void;
}
```

There is no `abortSignal` getter. `step` races the work against `this.abandoned`, a `Defer<Aborted>` that `abort()` resolves.

```ts
// thread-supervisor.ts
export type SupervisorChainDeps = { logger: Logger; isAborted: () => boolean };
```

`Thread` wires `isAborted` to `() => (this.toolLoopSubmission ?? this.inFlight)?.aborted ?? false`. `submissionSignal` and `IDLE_SIGNAL` are deleted.

`Thread` itself:

- `flushAsyncIntoRequest`, `flushQueuesForNextRequest`, `promptFlush`, `resolveQueued` and `continuation` take the `ActiveSubmission`, or read `isAborted`, in place of a signal. `resolveQueued` uses `submission.step(() => resolve(...))`.
- `queueFlushAction` reads the live submission through the same getter as `isAborted`.
- `runLoop` calls `submission.settled(() => core.runToolLoop(input))`.
- `compactAndContinue` calls `submission.settled(() => compactor.run(...))`.
- The joins on the preempted submission and on the reset use `joined`.

```ts
// session.ts
export interface SessionHost {
  prepareThread(request: ThreadPreparation, session: Session): Task<PreparedThread | Aborted>;
}
private pending = new Map<ThreadId, { abort(): void; aborted: boolean }>();
```

`create` sets up a pending entry with an `aborted` flag and a `current` preparation handle. `abortPending` and `deleteThread` call its `abort()`. The `cancelled()` and `current()` checks read the flag. `NvimSessionHost` and `TestSessionHost` return a `Task`: `abort()` sets a local flag, and the preparation body returns `ABORTED` in the gap after each of its awaits.

## Invariants

- No module outside the leaf wrappers calls `addEventListener("abort", …)` or takes an `AbortSignal` parameter. Grepping `node/server/src` for `AbortSignal` should only find the managers, `abortableDelay`, `inference-shared.ts`, `openai.ts`/`codex-auth.ts` auth, and `countTokens`'s SDK option.
- `abort()` only interrupts: it sets a flag and forwards the abort to the current child. Cleanup still happens in the node body after the child settles.
- A child handle is installed synchronously when the child is created. An abort that lands before a child exists is seen at the next gap, before the next child starts.
- `abort()` is idempotent and safe to call after the task has settled.
- Abort is still a value: every handle's promise resolves with an aborted variant and never rejects on abort.
- `ActiveSubmission.abort()` still waits for the body to unwind, and `settled` still joins work that has its own effects: tool loops, compaction runs, core replacement and a preempted submission.
- When a tool loop ends because of an abort, the abort marker is still appended, and tool results for the aborted batch are still written, including `ABORT_TOOL_RESULT_TEXT` fills.
- `Thread.state.aborting` still reports `true` immediately after `thread.abort()` is called. It is derived from `submission.aborted`.
- Preemption behaves the same: a new submission aborts the previous one synchronously and then joins it.

# Stages

## Task type and leaves

- Goal:
  - Add `Task<T>`.
  - `NativeInferenceManager.sendRequest` and `countTokens` return `Task`s, and `withAbort` is deleted.
  - `executeToolBatch` returns a `Task`.
  - `runToolLoop` returns `ToolLoop` with `abort()` and no longer takes a signal.
  - `ThreadCore.runToolLoop` and `checkBudget` return handles.
  - `Thread.runLoop` adapts to the new signatures through a temporary shim: `submission.abortSignal` listens once and calls the loop's `abort()`. The shim lives only in `Thread` and is removed in the next stage.
  - `TestAgent` uses the loop's own `abort()`.
- Tests:
  - Existing agent, tool-loop and provider suites pass unchanged (behaviour must not move). This includes the anthropic/openai inference tests for aborts during a stream, during a retry wait, and before the first chunk.
  - New: aborting a loop while `checkBudget` is in flight resolves `aborted`, and no request is ever issued.
  - New: aborting during tool execution aborts every live tool invocation, writes abort results, and resolves `aborted`. This also covers an abort that lands between `createTool` calls within one batch.
  - New: calling `abort()` on a settled loop is a no-op.

- Status: done.
  - [x] `Task<T>` in `utils/async.ts`.
  - [x] Managers: `sendRequest` returns a `Task`, `abort()` is private, `withAbort` deleted. Only `AnthropicInferenceManager` implements `countTokens`; it returns `Task<number | aborted>` and still rejects on real failures (ThreadCore's `decideBudget` logs and proceeds).
  - [x] `executeToolBatch` returns a `Task`. Deviation: the batch body now starts in a microtask (`Promise.resolve().then(runBatch)`) so the handle exists before any `createTool` runs; invocations join `live` as they are created and are aborted on creation if the flag is set.
  - [x] `runToolLoop` returns `ToolLoop` (`Task` + `activity` + `aborting`); `abort()` after settle is a no-op (does not flip `aborting`).
  - [x] `ThreadCore.runToolLoop`/`checkBudget`/`executeTools` return handles.
  - [x] Temporary shim in `Thread.runLoop` forwards `submission.abortSignal` to the loop's `abort()`.
  - [x] `TestAgent.send` returns the loop itself. Added `uninterruptible(value)` in `test-helpers.ts` for test executors/budget checks without an abort.
  - [x] New tests: `tool-loop.test.ts` (abort during checkBudget, abort during tool execution, abort after settle), `tool-executor.test.ts` (abort landing between `createTool` calls).
  - [x] Review follow-ups: `countTokens` now returns `Task<TokenCount>` (`{type:"counted"; tokens} | {type:"aborted"}`, exported from `provider-types.ts`). The mock client's `countTokens` honors the SDK `signal` while gated. Added tests: anthropic `countTokens` abort/counted/real-failure branches; ThreadCore aborted preflight skips `budget.check` without warning; tool-loop abort while `onBeforeRequest` is pending and abort mid-stream (`aborting` flips before settle). The shim's already-aborted branch is left untested since the shim is removed in stage 2.

## Submission handle

- Goal:
  - `ActiveSubmission` drops `AbortController` and gains `current`, `settled(start: () => Task)`, `joined(...)` and a `step` that doesn't use a signal.
  - Remove `submissionSignal`, `IDLE_SIGNAL` and the shim.
  - Supervisor chains take `isAborted`.
  - The queue flushes and resolution take the submission.
  - `untilAborted` is deleted.
- Tests:
  - Existing `thread`, `compaction/index.test.ts` and `mailbox` suites pass.
  - Preemption ordering: a submission that preempts a running tool loop sees the previous submission settle `aborted`, and only then does its own request go out.
  - An abort during queued-message resolution drops the resolution and leaves the unsent entries in `unsent`.
  - An abort during a supervisor's `onBeforeRequest` fan-out stops the remaining members.

- Status: done.
  - [x] `ActiveSubmission`: `aborted` flag, `current` child, `step` races an internal `abandoned` Defer, `settled(start: () => Task)`, `joined(work)`. No `AbortController`.
  - [x] `submissionSignal`/`IDLE_SIGNAL`/runLoop shim removed; `liveSubmission` getter feeds `isAborted` and `queueFlushAction`.
  - [x] Supervisor chains take `isAborted`; `forEach` takes a `gated` boolean instead of a signal.
  - [x] Queue flushes/`continuation` take the submission; `flushAsyncIntoRequest`/`resolveQueued` take `ActiveSubmission | undefined` (the async flush can run with no live submission) and resolve through `submission.step`.
  - [x] `untilAborted` deleted.
  - Deviation: `compactAndContinue` wraps `compactor.run` in a temporary Task shim (local `AbortController`) until stage 3 changes `Compactor.run`.
  - Note: an abort during queued resolution drops the entry being resolved (as before); only entries behind it come back in `unsent`.
  - [x] Review follow-ups: `step` narrows on `ABORTED` without a cast; `IDLE_SUBMISSION` (never aborted, exported from `thread-api.ts`) replaces the `ActiveSubmission | undefined` parameters on the queue flushes/`resolveQueued`; `forEach` takes `"gated" | "ungated"`. `thread-api.test.ts` covers `settled` after an abort, `step` abandonment, and the idle submission delivering work. The compaction abort test goes through `Thread.abort`, so it covers the stage-2 compactor shim. Abort during an async flush into the next request is covered by the existing "abort reports untouched async leftovers" test.
  - [x] Tests in `thread.test.ts` ("submission handle aborts"): preemption ordering, abort during queued resolution, abort during `onBeforeRequest` fan-out.

## Compactor and session creation

- Goal:
  - `Compactor.run` returns a `Task`, and `ThreadCompactor` stops listening on signals.
  - `SessionHost.prepareThread` returns a `Task`, and `Session.pending` holds handles.
  - Update `context.md` to describe handles instead of signals.
- Tests:
  - The existing `ThreadCompactor cancellation` tests, rewritten to call `run(...).abort()` in place of `cancellation.abort()`, still delete the late child exactly once and leave `compactor.current` undefined.
  - The parked-run tests (destroy/abort/reset) still settle `aborted`.
  - Session: deleting a thread whose preparation is in flight resolves creation to `ABORTED` and calls `release` exactly once. The existing session tests cover this through `TestSessionHost.intercept` and should be ported to the new signature.
  - A grep test or lint check that `node/server/src` contains no `addEventListener("abort"` outside the allowed leaf files.
