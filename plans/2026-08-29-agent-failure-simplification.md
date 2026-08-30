# Objective and Context

The user's request, verbatim:

> I think the way that we're handling the failure states right now is kind of weird. We're bleeding a lot of context that the agent doesn't really need to know about into the agent here, like how to reconstruct a user message and things like that.
> I think there are two things that we're doing here:
> 1. Just trying to resend the request, and I'm not really sure why that's happening here. I think the runner can retry at the layer where the provider is returning errors and I think it already does.
> 2. For genuine failures where we prepare to resubmit, I think that can happen outside of the agent. The agent doesn't have any view into what messages are pending or what the input box contains or anything like that. The parent thread can hang on to the last input that it submitted, populate things, and resubmit.
> I think what the agent needs to do is this: inside the runner we will do the retry. If the runner gave up and returned an error, then the agent just needs to handle that as an error. There's no need to resubmit there. The agent just resets itself to the last state before the failed message went out and then tells its parent that it failed. The parent can hang on to the last sent message and all of that sort of stuff.
> The resetting of the last user's message is really just a UI tweak and really doesn't belong in here.

Follow-up: the agent should not know about `QueuedMessage` / queuing at all — that belongs to `Thread`.

## Entities

- `Agent` (`node/core/src/agent.ts`) — the turn loop. Owns `runTurn`, `handleTurnResult`, `handleErrorState`, `settle`. Ephemeral: compaction replaces it.
- `Thread` (`node/core/src/thread.ts`) — durable owner of the agent. Owns the deferred queues (via `ThreadState`), submission resolution, the archive, `ThreadResult`.
- `NvimThread` (`node/chat/thread.ts`) — the root-layer bridge. Owns the input buffer relationship and dispatches `RootMsg`.
- `Runner` (`node/core/src/providers/anthropic-runner.ts`, `openai-runner.ts`) — owns retry. `RETRY_DELAYS` / `MAX_RETRY_DURATION` (5 min) / `isRetryableError`, retry loop inside `streamOneResponse`. Resolves `{type:"failed", error, retryable}` only after the budget is exhausted or the error is classified non-retryable.
- `SendResult` (`node/core/src/thread-api.ts:81-89`) — how one submission ended.
- `ThreadState.failedSubmit` / `ThreadState.preSubmitNativeIdx` (`agent.ts:242-245`) — the state being removed.

## Files touched

- `node/core/src/agent.ts` — the bulk of the deletion.
- `node/core/src/thread-api.ts` — `SendResult.failed` shape.
- `node/core/src/thread.ts` — `lastSendResult`, the `discardFailedSubmit` delegate.
- `node/core/src/compaction/index.ts` — constructs a `failed` SendResult.
- `node/chat/thread.ts` — records the submitted text, owns the failure state.
- `node/chat/thread-view.ts` — renders the failed block.
- `node/magenta.ts` — the `setup-resubmit` sidebar handler.
- `node/core/src/agent.test.ts`, `node/chat/thread.test.ts`, `node/core/src/tools/spawn-subagents.test.ts`, `node/core/src/script/script-manager.test.ts` — existing coverage of the removed behavior.

# Design

Today a provider failure is handled in three layers at once, and the agent plays a part in all three:

1. The runner retries in-stream, then gives up.
2. `Agent.handleErrorState` reconstructs "what the user typed" by walking the provider log backwards for the last user message and concatenating the rendered pending queues, stores it in `state.failedSubmit`, and branches on `threadType` to decide whether a human will see it.
3. For non-user-facing threads it runs a *second* retry loop (`maybeAutoResubmitAfterError`), importing `isRetryableError` / `getRetryDelay` / `MAX_RETRY_DURATION` from the runner to duplicate the runner's own policy across turns.

The rollback is then deliberately deferred: `preSubmitNativeIdx` stays set so the transcript still shows the doomed user message, and `node/magenta.ts` calls `core.discardFailedSubmit()` from the sidebar handler at the moment it fills the input buffer. So a *buffer write in the nvim layer* is what finally makes the core message log coherent.

The new shape collapses this to one responsibility per layer:

- **Runner**: retries. Unchanged. It is already the only place that knows which errors are transient and how long to keep trying.
- **Agent**: on `{type:"failed"}` it truncates its runner back to the snapshot it took before the request, logs, and settles `{type:"failed", error}`. No thread-type branching, no text reconstruction, no queue access, no retry.
- **Thread (core)**: unchanged in behavior. The queues are *not* drained on failure — the entries were never delivered, they stay queued, they stay rendered in the pending-messages view, and they ride along with whatever is sent next.
- **NvimThread (root)**: remembers the text it last submitted, and on a `failed` result stores `{text, error}` in its own state, renders the error block from it, and populates the input buffer.

The key simplification is that *nobody* needs to reconstruct the submitted text: the root layer is the one that composed it in the first place (`send-message` carries `InputMessage[]`, `submit-message` carries a `PendingMessage`), so it just keeps a copy.

## Alternatives considered

- **Return the drained queue on failure** (`SendResult.failed.unsent: QueuedMessage[]`, mirroring `abort()`). Rejected: it puts `QueuedMessage` back into the agent's vocabulary for no gain, and merging queued text into the input buffer is worse UX than leaving it queued — the user loses the `@async`/`@next` delivery annotations that the queue preserves.
- **Keep the text in core `Thread` rather than `NvimThread`.** `Thread.submit`/`Thread.send` both have it. Rejected: "text to repopulate an editor buffer" is a UI concern, and core `Thread` is also driven by scripts and the subagent tool, which have no input buffer.
- **Keep cross-turn retry for subagents, moved into `Thread`.** Rejected for now: it is the same policy the runner already implements, just at a coarser grain. If unattended threads need a longer budget, widen `MAX_RETRY_DURATION` (or make it thread-type-aware) inside the runner, where the error classification lives. Noted as a follow-up, not part of this change.

## Interfaces

```ts
// node/core/src/thread-api.ts
export type SendResult =
  | { type: "completed" }
  | { type: "yielded"; value: YieldValue }
  | { type: "aborted" }
  /** The runner exhausted its retries. The agent has already rolled its
   * message log back to the state before the failed request, so the thread is
   * coherent and resumable. Any queued submissions are untouched. */
  | { type: "failed"; error: Error }
  | { type: "suspended"; reason: SuspendReason };
```

```ts
// node/core/src/agent.ts
// removed from ThreadState:      failedSubmit, preSubmitNativeIdx
// removed from AgentAction:      set-failed-submit, set-pre-submit-native-idx
// removed from Agent:            discardFailedSubmit, maybeAutoResubmitAfterError,
//                                errorRetry, clearErrorRetryTimer, resetErrorRetryState
// removed import:                getRetryDelay, isRetryableError, MAX_RETRY_DURATION

class Agent {
  /** Where the log stood before the in-flight request. Private: rollback is
   * the agent's own business and completes before the failure is reported. */
  private preSubmitNativeIdx: NativeMessageIdx | undefined;

  private handleErrorState(error: Error): void;  // truncate, log, settle
}
```

```ts
// node/chat/thread.ts
class NvimThread {
  /** The text of the most recent submission, kept so a failure can put it
   * back in the input buffer. */
  private lastSubmittedText: string | undefined;
  /** Set when a submission fails; cleared on the next submission. Rendered as
   * the trailing error block. */
  private failedSubmit: { text: string; error: Error } | undefined;
}
```

```ts
// node/root-msg.ts — unchanged shape, but the handler no longer rolls back
{ type: "setup-resubmit"; threadId: ThreadId; lastUserMessage: string }
```

## Invariants

- After a `failed` SendResult, `getProviderMessages()` must be a coherent, resumable log: no trailing user message whose request never completed, no orphan `tool_use` without a matching result. `Runner.truncateMessages` / `computeTruncateEndIdx` already enforces the orphan-tool_use half; the snapshot index supplies the rest.
- Rollback happens exactly once and before `settle`, so the owner never observes a half-rolled-back thread. `preSubmitNativeIdx` is cleared by the rollback so a second failure cannot truncate to a stale index.
- `preSubmitNativeIdx === undefined` (the very first request, or a continuation that took no snapshot) must be a no-op rollback, not a truncate-to-zero.
- Queued submissions survive a failure and remain in `nextRequestQueue`/`nextStopQueue`, still unresolved, so their `@compact`/`@file:` commands run when they are eventually delivered.
- The agent must not import from `anthropic-runner.ts` for retry policy at all after this change.
- A failure must still settle exactly one `SendResult` per `send` — the removed auto-resubmit path deliberately left the submission pending, so deleting it must not leave a path where `settle` is skipped.
- A subagent/compact thread that fails is parked, exactly as an aborted thread that is never resumed is parked. `ThreadResult` still never settles `failed`; the parent tool sees `aborted` on destroy. This is existing behavior and is preserved.

# Stages

## core failure path

- Goal: `Agent` handles a runner failure as: roll back, log, settle `{type:"failed", error}`. All resubmit/retry machinery is gone from `agent.ts`; `SendResult.failed` has no `resubmit`. `Thread.lastSendResult` reports failure from `lastTurnResult` alone. The root layer still compiles (temporarily reading nothing for the failed block).
- Tests (`node/core/src/agent.test.ts`, rewriting the `Agent non-retryable error resubmit flow` describe block):
  - A root thread whose stream errors resolves `{type:"failed"}` and its provider messages are back to where they were before the send — specifically, sending "find the bug", failing, then sending "try again" produces a log with exactly one user message, not two.
  - A failure on the *second* submission leaves the first completed exchange intact (rollback is to the snapshot, not to zero).
  - A subagent thread whose stream errors with a retryable error (e.g. a 429) settles `failed` once and issues no further requests — assert `mockClient` receives no additional stream after the error, and that advancing timers produces none either. This is the direct test that the second retry loop is gone.
  - A failure with entries in both the async and next queues leaves both queues populated and unresolved; a subsequent successful send delivers them at their proper boundaries.
  - A failure mid-tool_use (stream error after tool results were written) leaves no orphan `tool_use` block.

## root-layer resubmit ownership

- Goal: `NvimThread` records the submitted text, holds the failure state, renders the error block, and drives `setup-resubmit`. `node/magenta.ts` no longer calls `discardFailedSubmit` (the method is gone).
- Tests (`node/chat/thread.test.ts`, driver-based):
  - Submitting a message that fails leaves the input buffer repopulated with the original text and the chat buffer showing the `# user:` block plus the error line — i.e. the user-visible end state is unchanged from today.
  - Editing the repopulated text and resubmitting produces exactly one user message in the transcript (no duplicate from the rolled-back attempt).
  - A message submitted with `@next` that is still queued when a later submission fails remains rendered in the pending-messages section and is *not* merged into the input buffer. This is the intentional behavior change; assert it explicitly.
  - The failed block clears when the next submission starts.

## cleanup

- Goal: no dangling references; `npx tsc -b`, `npx vitest run`, `npx biome check .` all clean.
- Work: update `spawn-subagents.test.ts:793` and `script-manager.test.ts:203`, which call `discardFailedSubmit()` to simulate the auto-resubmit that no longer exists — these should instead assert the thread is parked after a failure, since that is now the real behavior. Fix `compaction/index.ts:66`. Delete the `failedSubmit` guard at `thread-view.ts:479`.

## (separable) take queuing out of the agent

Not required by the above, but it is the same complaint one layer over: `Agent` still reaches into `state.nextRequestQueue` / `nextStopQueue` in `nextContinuation`, `handleStopped`, `flushQueue`/`resolveQueued`/`requeue`, `drainQueueOnAbort`, and `buildToolResponseExtras` (the `@compact` deferral), and owns `DEFERRED_QUEUES` and `ResolveSubmission`.

- Goal: the agent asks its owner one question at each boundary — "anything to deliver here?" — and knows nothing about how many queues there are, what `@compact` means, or how a `PendingMessage` resolves.
- Sketch: a hook alongside `onBeforeRequest`/`onEndTurn`, e.g. `onDeliver(boundary: "request" | "stop"): Promise<{ messages: InputMessage[]; suspend?: SuspendReason }>`, with `Thread` owning both queues, `resolve`, the requeue-behind-a-compact rule, and the `{kind:"compact"}` suspension. `drainQueueOnAbort` becomes `Thread`'s, which also fixes the fact that `abort()`'s return type currently drags `QueuedMessage` into the agent's signature.
- Tests: the existing queue-ordering and `@compact`-deferral tests should move to `thread.test.ts` and pass unchanged in behavior — that is the acceptance criterion for the move.
