# Objective and Context

The follow-on to `plans/2026-08-29-agent-failure-simplification.md`, which named the target and then deferred it:

> `Agent` still reaches into `state.nextRequestQueue` / `nextStopQueue` in `nextContinuation`, `handleStopped`, `flushQueue`/`resolveQueued`/`requeue`, `drainQueueOnAbort`, and `buildToolResponseExtras`, and owns `DEFERRED_QUEUES` and `ResolveSubmission`.

The user's framing, verbatim:

> I think the agent just runs until it stops. It exposes a before-request hook, which gives the thread an opportunity to drain its async queue. When the turn stops, it yields back to the thread, which can then drain its async and next queues. For max_tokens, we should move this out, even out of the thread - to a new supervisor. We'll need a new hook for the thread - onError. So only the thread has access to the queues. The agent no longer has any concept of a queue.

Two departures from that framing, both established below: `max_tokens` needs no new hook (it is already a `StopReason` on `EndTurnContext`, so a supervisor implementing the existing `onEndTurnWithoutYield` covers it), and `onError` is **not built here**. `onError` would be the re-entry point for the cross-turn resubmit that `plans/2026-08-29-agent-failure-simplification.md` just deleted, and that plan's reason for deleting it — it duplicates the runner's own retry policy at a coarser grain — has not changed. The loop makes the hook cheap to add later; nothing currently wants it.

The load-bearing move is not "extract the queues" — it is **the turn loop moves up a layer**. Today `Agent.send` stays pending across an unbounded number of requests, because the agent decides for itself whether a stop is really the end (queued content? a supervisor nudge? `max_tokens`?). Once `Agent.send` resolves at every stop, all three of those questions belong to whoever is driving the agent, and the queues stop being special: at a stop they are just "the messages `Thread` passes to the next `send`". No delivery hook, no boundary enum, no laziness contract.

## Entities

- `Agent` (`node/core/src/agent.ts`) — the turn loop today. `nextContinuation` (`agent.ts:708`), `handleStopped` (`agent.ts:743`), `flushQueue`/`resolveQueued`/`requeue` (`agent.ts:646-702`), `DEFERRED_QUEUES` (`agent.ts:187`), the mid-turn flush and `deferredCompact` in `buildToolResponseExtras` (`agent.ts:1241-1246`), `drainQueueOnAbort` (`agent.ts:1028`), `deps.resolve: ResolveSubmission`, and the `Continuation` / `FlushedQueue` / `DeferredDelivery` types.
- `Thread` (`node/core/src/thread.ts`) — durable owner; already holds `hooks`, `callbacks.resolve`, `submit`, `enqueue`, `prependToNextTurn`, and the queue carry-across in `reset` (`thread.ts:452-462`).
- `ThreadState.nextRequestQueue` / `nextStopQueue` (`agent.ts:215-217`) — moving to `Thread`.
- `composeSupervisors` / `ThreadSupervisor` (`node/core/src/thread-supervisor.ts`) — `onEndTurnWithoutYield` already receives `stopReason`.
- `UnsupervisedSupervisor`, `SubagentSupervisor` — the existing `onEndTurnWithoutYield` implementors, which currently never see a `max_tokens` stop because the agent short-circuits it.
- `runSubmission` (`node/core/src/compaction/index.ts`) — the outer loop that already exists _above_ `Thread.send`, driving compaction handoffs. The new `Thread` loop sits directly beneath it and should not duplicate it.
- Readers of the queues outside core: `node/chat/thread-view.ts:531-548`, `node/chat/thread.ts:1194` and `1242-1252`.

## Files touched

- `node/core/src/agent.ts` — the bulk of the deletion.
- `node/core/src/thread.ts` — gains the queues and the turn loop.
- `node/core/src/thread-api.ts` — `AgentHooks` loses `onEndTurn`; `ComposedRequestActions` gains `submissions`.
- `node/core/src/thread-supervisor.ts` — new `MaxTokensSupervisor`; stop-reason guards on the existing end-turn supervisors.
- `node/core/src/index.ts` — dropped exports.
- `node/chat/thread-view.ts`, `node/chat/thread.ts` — read the queues through `Thread`.
- `node/core/src/agent.test.ts` → new `node/core/src/thread.test.ts` for the queue and end-turn describes.

# Design

## The new division

- **`Agent.send(messages)` runs until the agent stops, and resolves.** A stop is `end_turn`, `max_tokens`, a yield, a suspension, an abort, or a failure. The agent still owns everything _inside_ a turn — the tool_use loop, reminders, token accounting, the yield negotiation — and nothing about what comes after one.
- **`Thread` owns the loop over turns.** It decides whether a stop is really the end by asking, in this order: is there queued content eligible at this stop, and if not, do the end-turn supervisors want to say something. If either produces messages it calls `agent.send` again; otherwise it resolves the submission.
- **`Thread` owns both queues outright.** They leave `ThreadState`; the four enqueue/drain `AgentAction` variants, `DEFERRED_QUEUES`, and `DeferredDelivery` are deleted.

`Thread.send`'s public contract (`ThreadSendResult`) does not change — it still resolves once, when the thread comes to rest. What changes is that the pending-across-continuations behavior is now an explicit loop in `Thread` rather than an emergent property of `settle` being skipped on some paths in the agent.

The loop dispatches on _how_ the agent stopped. A failed stop comes straight back out — the previous plan deleted the agent's cross-turn resubmit and its objection stands, so nothing intercepts a failure. The `onError` hook the user's framing calls for is where that interception _would_ go, and the loop is what would make it cheap; it is deliberately not built here, since it has no implementor. What the loop must preserve either way is that the pathways stay exclusive: a failure never drains a queue and never reaches `onEndTurn`, because a request that failed did not end a turn.

```ts
// node/core/src/thread.ts, sketch
private async runToRest(initial: InputMessage[]): Promise<SendResult> {
  let messages = initial;
  for (;;) {
    const result = await this.agent.send(messages);
    switch (result.type) {
      case "failed":
        // Nothing intercepts a failure: the runner already exhausted its
        // retries, and the agent has rolled the log back.
        return result;
      case "completed": {
        const next = await this.continuation(stopReason);   // queues, then onEndTurn
        if (!next) return result;
        messages = next;
        continue;
      }
      case "yielded":
      case "aborted":
      case "suspended":
        return result;
      default:
        assertUnreachable(result);
    }
  }
}
```

## The two drain points

**At a stop** there is no hook at all: `Thread` is holding the agent's resolved promise, drains async-then-next, and passes the result to the next `send`. This is the piece that makes the whole thing cheap — the previous draft needed a lazy `hasPending`/`deliver` pair purely because the agent had to know _before_ running its hooks whether a request would follow. With the loop in `Thread`, the decision and the delivery are the same statement.

**Mid-turn**, on the request that carries tool results, the async queue drains through the existing `onBeforeRequest` hook. The only gap is that `ComposedRequestActions.injections` is supervisor annotation, whereas a queued entry is _the user speaking_, and the agent treats those differently: user content resets `outputTokensSinceLastReminder`, gets its own `<system-reminder>` block, suppresses the periodic reminders for that request, and must be ordered last (`agent.ts:1252-1260`, `prepareUserContent`). So:

```ts
// node/core/src/thread-supervisor.ts
export type ComposedRequestActions = {
  injections: InjectedContent[];
  /** The user's own content, delivered at this request. Distinct from
   * `injections` because the agent orders it last and applies the
   * reminder/token-reset rules to it. */
  submissions: InputMessage[];
  suspend: { reason: SuspendReason } | undefined;
};
```

`Thread` supplies `submissions` from its async queue; supervisors keep supplying `injections`. The agent's `buildToolResponseExtras` keeps exactly the logic it has, reading `submissions` where it reads `queuedForThisRequest` today, and loses the `flushQueue` call and `deferredCompact`.

**`@compact` mid-turn stops being the agent's problem.** Today the agent holds the compaction in `deferredCompact` until the next stop. With `Thread` draining, an entry that resolves to a `@compact` is simply _not delivered_ — it goes onto the `next` queue instead, which is what `agent.ts:1238-1240`'s comment already says the intent is ("it moves to the `next` queue and takes effect at the earliest point where it can"). At the following stop the drain hits it and `Thread` returns `{type:"suspended", reason:{kind:"compact"}}` out of the loop, where `runSubmission` handles it as it does now. `deferredCompact` is deleted with no replacement.

## max_tokens as a supervisor

`max_tokens` arrives as a `StopReason` on the ordinary stopped path and `EndTurnContext.stopReason` already carries it, so this needs **no new hook** — a `MaxTokensSupervisor implementing onEndTurnWithoutYield` that returns the continue-prompt when `stopReason === "max_tokens"` is a drop-in for `agent.ts:709-719`. Two consequences that have to be handled deliberately:

- `UnsupervisedSupervisor` and `SubagentSupervisor` currently never see a `max_tokens` stop, because the agent short-circuits it before consulting them. Under a supervisor they would both fire on it — `UnsupervisedSupervisor` would append a spurious "you stopped without yielding" and burn a restart. Both need an explicit `if (stopReason !== "end_turn") return {type:"none"}` guard. This is a real behavior difference, not a refactor detail.
- Ordering: today queued content is only ever flushed on `end_turn`, and `max_tokens` wins over everything. Preserved by the loop's rule — drain the queues only when `stopReason === "end_turn"`, then consult supervisors — so a queued message can never preempt a truncated response's continuation.

`onEndTurn` moves off `AgentHooks` entirely; `Thread` consults `this.hooks.onEndTurn` in its loop. The agent keeps `onYield` (it is consulted before the yield tool's result is written, so it is genuinely intra-turn) and `onBeforeRequest`.

## The turn-end `onBeforeRequest` consultation

`RequestContextKind` has a `turn-end` variant for "a stop that issues no request, consulted anyway so `AutoCompactSupervisor` can suspend" (`thread-supervisor.ts:126-135`), with the agent queueing any injections as the next turn's prefix (`agent.ts:1391-1398`, mode `"prefix"`). That consultation is about the _next_ request, so it moves into the `Thread` loop, which already has `prependToNextTurn` for the prefix half. The `"prefix"` mode and the `pendingTurnPrefix` plumbing can then be reconsidered — flagged, not assumed, since compaction also seeds through `prependToNextTurn`.

## Abort

`Agent.abort()` / `abortAndWait()` return `void`; `Thread.abort()` awaits the agent, drains its own queues, and returns `{unsent}`. Two things the loop makes newly explicit:

- An abort that lands _between_ turns must stop the loop, not just the in-flight turn. A `Thread`-level guard, checked at the top of each iteration.
- `Thread.send`'s abort-then-send-now path drains and discards the queues — which is what happens today (the agent drains, `send` ignores the return value), but it becomes a visible decision rather than a dropped value.

## Rendering

`Thread` exposes `get queued(): ReadonlyArray<QueuedMessage>`. `thread-view.ts` partitions on `when` to keep its two labelled sections and its continuous index; `thread.ts:1194` becomes `this.core.queued.length === 0`.

## Invariants

- Delivery order is unchanged: async before next at a stop, insertion order within a queue, and anything enqueued during a drain lands in the following one.
- Entries resolve exactly once, at delivery. A suspension raised before the request that would have carried them leaves the queues intact and unresolved — now trivially true, since `Thread` does not drain until it has decided to send.
- An entry whose resolution throws is dropped with a logged error and does not wedge the loop.
- A `@compact` ends the drain: entries resolved ahead of it fold into the compaction's follow-up prompt, entries behind it return to the front of their queue in order.
- Queues drain only on `end_turn`. `max_tokens` continues with the continue-prompt alone.
- Exactly one `SendResult` per `Thread.send`, and the loop is the only thing that can iterate — the agent settles every stop.
- A stop takes exactly one pathway. A failed stop drains no queue and never reaches `onEndTurn`; it leaves the loop immediately.
- An abort between turns stops the loop.
- `agent.ts` imports nothing from `submission/index.ts`; `ThreadState` has no queue fields; `AgentHooks` has no `onEndTurn`.

# Stages

> Status: all stages are **done** and committed. Stage 3 absorbed the parts of stages 4 and 5 that it forced; stage 4 finished with the between-turns abort guard.

## hoist the loop

- Goal: `Agent.send` resolves at every stop. `Thread.runToRest` drives continuations, consulting `onEndTurn` itself. `nextContinuation` / `handleStopped`'s continuation half / `Continuation` are gone from the agent; `onEndTurn` moves off `AgentHooks`. Queues are untouched in this stage — `Thread` still reaches into `state.nextRequestQueue` to build its continuation, which is ugly and temporary.
- The agent must expose the stop reason of the turn it just finished for the loop to branch on; `state.lastTurnResult` already carries it, so this may need nothing new.
- Tests: `Thread.send result` and the auto-respond/supervisor describes in `agent.test.ts` should pass unchanged — the acceptance criterion for the hoist is that no externally visible sequencing moved.

Done. What was actually built:

- `Agent.handleStopped` is now four lines: set mode normal, honour a `deferredCompact`, record the stop reason, `settle({type:"completed"})`. `nextContinuation` and the `Continuation` type are gone.
- `Thread.runToRest` is the loop; `Thread.continuation` / `Thread.plannedContinuation` hold what `nextContinuation` + the tail of `handleStopped` used to. `Thread.send` (including the `compact` thread-type bypass) goes through it.
- Deviations from the sketch:
  - `AgentHooks` did lose `onEndTurn`, but `Thread.hooks` needs it, so a **`ThreadHooks = AgentHooks & { onEndTurn? }`** was added in `thread-api.ts`; `composeSupervisors` now returns `ThreadHooks`. `AgentDeps.getHooks` still returns `AgentHooks`, so the agent structurally cannot see the hook.
  - The agent grew three temporary public surfaces for the loop to drive it: `get stopReason()`, `applyStopHooks(kind, stopReason)` (wrapping `applyBeforeRequestActions(..., "prefix")`, so the `continuation` / `turn-end` kind is now chosen by `Thread`), and `get lastAssistantMessage()`. `flushQueue` was also made public; it goes away in stage 3.
  - `lastStopReason` is cleared at the top of `submit`, so a `send` that settles `completed` without running a turn (empty content) reports `undefined` and the loop rests rather than re-consulting supervisors against a stale stop.
  - **`Thread.isBusy` is new** (`looping || agent.isBusy`) and replaces the two `this.agent.isBusy` reads in `Thread`. Necessary, not cosmetic: `Agent.isBusy` is false between turns now, so queued delivery would have raced the loop.
- Full suite green (`npx tsc -b`, `npx biome check .`, `npx vitest run`). The one failure seen, in `node/comments/comment-input.test.ts`, reproduces on a clean `git stash` and is a pre-existing flake in that file.
### Review follow-ups (stage 1)

- **The stop reason is part of the outcome, not a side channel.** `SendResult`'s `completed` variant is now `{ type: "completed"; stopReason: StopReason | undefined }`; `Agent.lastStopReason`, the `stopReason` getter and the reset in `submit` are gone. `undefined` still means "settled without ever issuing a request", which the loop reads straight off `result`. The two-variant `completed-without-request` shape the review suggested was passed over — a nullable field carries the same information for a fraction of the assertion churn — but the field is documented so the absent case is explicit.
- **`FlushedQueue` is a discriminated union**: `{type:"messages"; messages} | {type:"compact"; nextPrompt}`. The "never both" comment is now enforced by the type. `Agent.deferredCompact` holds a bare `{nextPrompt}` rather than the removed `QueuedCompaction` alias.
- **`failed` carries `discardedSubmission: boolean`.** A failure on a *continuation* rolls back only that request, so the originally submitted content is still in the log; restoring it into the input buffer would duplicate it. `Thread.runToRest` sets the flag false for continuation failures, and `NvimThread.handleSendResult` only renders the failed block / dispatches `setup-resubmit` when it is true. This is a real bug fix, not just representation.
- **`NvimThread.lastSubmittedText` + `failedSubmit` collapsed into one `submission` field**: `{type:"in-flight"|"failed"; text; error?}`. The view reads a single discriminant, and the truthiness test on the text (which conflated an empty submission with no submission) is gone.
- New tests:
  - `Thread turn loop > stays busy while a continuation is being prepared` — holds the loop inside `flushQueue` via a gated `resolve`, asserts `core.isBusy`, that a `send` arriving in that window queues, and that no extra stream is opened.
  - `Thread turn loop > does not offer the submitted text back when a continuation fails` — max_tokens stop, continuation stream errors; asserts `discardedSubmission === false` and that the original user message survives in the log.
  - `node/chat/thread.test.ts` — the failure test now also asserts the error block clears only when the next submission starts.

## max_tokens as a supervisor

- Goal: `MaxTokensSupervisor` in `thread-supervisor.ts`, wired wherever the standard supervisor list is built. `agent.ts`'s max_tokens branch deleted.
- Work: add the `stopReason !== "end_turn"` guard to `UnsupervisedSupervisor` and `SubagentSupervisor`.
- Tests: the existing `Agent.handleProviderStopped` max_tokens cases (`agent.test.ts:747`) move to supervisor-level tests. Add: an unsupervised thread that hits `max_tokens` gets the continue-prompt and _only_ the continue-prompt, and its restart budget is untouched. That is the regression this stage risks.

Done. What was actually built:

- `MaxTokensSupervisor` (`thread-supervisor.ts`) returns the continue-prompt verbatim from the deleted branch when `stopReason === "max_tokens"`, and `{type:"none"}` otherwise. `Thread.plannedContinuation`'s max_tokens branch is gone; the prompt now reaches the agent as a `system` message via the composed `onEndTurn`, exactly as before.
- Guards added: `SubagentSupervisor` and `UnsupervisedSupervisor` both bail on `stopReason !== "end_turn"`. For `UnsupervisedSupervisor` this replaces the narrower `=== "aborted"` check, so a truncated stop no longer burns a restart.
- Wiring: `new MaxTokensSupervisor()` is prepended to the `composeSupervisors` list in `NvimThread`'s constructor (`node/chat/thread.ts`), which is the only place root threads' hooks are built — so every thread type gets it, matching the agent-level behavior it replaces. It is deliberately *not* in `contextSupervisors()` (those are trackers) nor in `Chat`'s per-thread-type `supervisors` (which would have needed the same entry in three branches). Exported from `@magenta/core`.
- Tests: the text-only max_tokens case moved out of `Agent.handleProviderStopped` into a new `describe("MaxTokensSupervisor")` in `agent.test.ts`, joined by the new regression test — a max_tokens stop under `[MaxTokensSupervisor, UnsupervisedSupervisor]` produces the continue-prompt alone, and the following `end_turn` still reports `auto-restart 1/5`. The two tool_use-path max_tokens cases stay in `Agent.handleProviderStopped`: they never involved the continue-prompt. Three existing tests that relied on the agent's implicit max_tokens continuation now install `MaxTokensSupervisor` explicitly.
- Full suite green (`npx tsc -b`, `npx biome check .`, `npx vitest run`) apart from `node/comments/comment-input.test.ts > comments on a visual selection`, re-confirmed as a pre-existing flake: it fails roughly half the time on a clean `git stash` as well.

Review follow-ups (stage 2):

- `EndTurnContext.stopReason` narrowed from `string` to `StopReason`, so the three literal guards are compiler-checked. This immediately caught dead code: `UnsupervisedSupervisor`'s pre-existing `stopReason === "aborted"` check compared against a value that is not a member of `StopReason` and could never fire — a real behavior change, since a genuinely aborted turn now falls through the `!== "end_turn"` guard as intended rather than by accident. The stale `DockerSupervisor` test asserting on `"aborted"` now uses `"max_tokens"`.
- Wiring coverage: `node/chat/supervisor-wiring.test.ts` gains a `withDriver` case that finishes a response with `max_tokens` and asserts the next request carries the continuation prompt. This is the only test that fails if the `new MaxTokensSupervisor()` line in `NvimThread`'s constructor is dropped.
- `SubagentSupervisor`'s new guard is covered: a subagent that writes a `<yield>` tag and then hits `max_tokens` gets the continuation prompt alone, not the yield nudge (`agent.test.ts`, `MaxTokensSupervisor` describe).

## queues move to Thread

- Goal: `nextRequestQueue` / `nextStopQueue` are private on `Thread`; `DEFERRED_QUEUES`, `DeferredDelivery`, `FlushedQueue`, `flushQueue`, `resolveQueued`, `requeue`, `deferredCompact` and `deps.resolve` are gone from the agent. `ComposedRequestActions.submissions` carries the mid-turn drain. `Thread.reset` loses the carry-across. `Thread.queued` exists.
- Tests: the `deferred submissions` describe (`agent.test.ts:1033-1246`) moves to `node/core/src/thread.test.ts` **unchanged in behavior** — that is the acceptance criterion. The two assertions that read `core.state.nextRequestQueue` become `core.queued`.
- Add: a `@compact` submitted with `@async` mid-turn is not delivered on the tool-result request, is still queued after it, and suspends at the following stop. That is the `deferredCompact` deletion, tested directly.

Done. What was actually built:

- Both queues are private fields on `Thread` (`nextRequestQueue` / `nextStopQueue`), with `queue()`, `enqueue()`, `enqueueFront()`, `drainQueues()`, `flushQueue(delivery, "stop" | "mid-turn")` and the public `get queued(): ReadonlyArray<QueuedMessage>`. `ThreadState` has no queue fields, the four enqueue/drain `AgentAction` variants, `DEFERRED_QUEUES`, `DeferredDelivery`, `FlushedQueue`, `flushQueue`, `resolveQueued`, `requeue`, `drainQueueOnAbort`, `deferredCompact` and `deps.resolve` are gone from the agent, and `agent.ts` imports nothing from `submission/index.ts`. `DeferredDelivery` / `FlushedQueue` survive as private aliases in `thread.ts`.
- **Mid-turn drain**: `ComposedRequestActions` gained `submissions: InputMessage[]` (always `[]` out of `composeSupervisors` — it is the owner's field). `Thread.agentHooks()` now wraps the owner's hooks before handing them to the agent, and `Thread.beforeRequest` drains the async queue into `submissions` on a `{kind:"continuation", stopReason:"tool_use"}` consultation, but only after the composed `suspend` came back empty — that is what keeps the "a suspension leaves the queues intact and unresolved" invariant. The agent holds them in `pendingSubmissions` next to `pendingInjections` and `buildToolResponseExtras` reads them where it read `flushQueue("async")` before, so the reminder/ordering logic is untouched.
  - Consequence worth naming: `getHooks` is now a wrapper, so `onYield` / `onBeforeRequest` are always defined from the agent's point of view. Both no-op when the owner supplied nothing.
- **`@compact` mid-turn** is detected with the pure-text `parseCompact` *before* resolving, so it is genuinely not delivered rather than resolved-and-held: it and everything behind it move to the front of the `next` queue, and the following stop's drain picks them up and suspends. This is why `deferredCompact` could be deleted outright.
- Deviations, both forced by the queues leaving `ThreadState`:
  - **Stage 4's abort ownership landed here.** `Agent.abort` / `abortAndWait` return `void`; `Thread.abort` awaits the agent, calls `drainQueues()` and returns `{unsent}`; `Thread.send`'s abort-then-send-now path drains and discards, which is what happened before by accident. The remaining stage-4 work is the between-turns abort guard on the loop and its test.
  - **Stage 5's root reads landed here.** `thread-view.ts` partitions `core.queued` on `when` (keeping the continuous index) and `thread.ts` tests `core.queued.length === 0`.
- Test layout: `createAgentWithMock` and friends moved out of `agent.test.ts` into a new **`node/core/src/test-helpers.ts`** (with `userTexts`, `awaitNextStream`, `uniqueThreadId`, `cleanupArchive`), since two test files now need them. `deferred submissions` and `Thread.abort returns the unsent queue` moved to **`node/core/src/thread.test.ts`** behaviorally unchanged; the queue assertions read `core.queued`, and the abort tests enqueue via `core.submit(pendingMessage(...), "async")` against a busy thread.
- New test: `deferred submissions > defers an @async @compact past the request it cannot ride on` — gates a `get_files` tool on a blocked `stat`, queues `@compact wrap it up` while in tool_use, and asserts the tool-result request does not carry it, that it is sitting on the `next` queue afterwards, and that the following `end_turn` resolves `{suspended, reason:{kind:"compact", nextPrompt:"wrap it up"}}`.
- Full suite green: `npx tsc -b`, `npx biome check .`, `npx vitest run` (1579 passed) — including `node/comments/comment-input.test.ts`, which was the known flake.

### Review follow-ups (stage 3)

- **The two flush modes are two methods.** `flushQueue(delivery, when)` is split into `flushAtStop(delivery): Promise<FlushedQueue>` and `flushMidTurn(): Promise<InputMessage[]>`. The mid-turn path could never return a `compact`, so its caller was forced into a dead `flushed.type === "messages" ? ... : []` branch that would have silently dropped messages; that branch is gone, along with the never-valid `("next", "mid-turn")` combination. Per-entry resolution (reminders + the drop-on-throw guard) is shared in a new private `resolveQueued`.
- **`ComposedRequestActions` is a discriminated union**, and the supervisor result is a separate type:
  - `ComposedSupervisorActions = {type:"suspend"; reason; injections} | {type:"proceed"; injections}` — what `composeSupervisors` returns and what `ThreadHooks.onBeforeRequest` answers.
  - `ComposedRequestActions` adds `submissions` to the **proceed** variant only, so "suspended *and* carrying user content" is unrepresentable rather than avoided by an early return. Injections deliberately survive a suspension (the agent appends them into the handed-over snapshot), so the suspend variant keeps them.
  - `ThreadHooks` is now `Omit<AgentHooks, "onBeforeRequest"> & {onEndTurn?; onBeforeRequest?}` rather than a plain superset, since the two layers answer different shapes.
- **`Thread.queued` is grouped**: `{ async: ReadonlyArray<PendingMessage>; next: ReadonlyArray<PendingMessage> }`, plus `queuedCount`. The `.filter((q) => q.when === ...)` string-tag re-derivation is gone from `thread-view.ts` and from ~40 test assertions. The flat `QueuedMessage[]` shape survives only where it is actually plural-with-provenance: `Thread.abort`'s `unsent` debris.
- `test-helpers.ts`: `awaitNextStream`'s `prev` is typed `MockStream | undefined`, and the `as unknown as` context stubs go through a `stub<T>(partial: Partial<T>): T` helper so field names and types are checked against the real interface. This immediately caught two dead mocks — `threadManager.getThread`/`getThreads` and `shell.exec` are not members of `ThreadManager`/`Shell` — which are now empty stubs.
- New tests in `thread.test.ts`:
  - `Thread.send while busy > discards the queues when the caller sends now instead` — the previously untested load-bearing `drainQueues()` on the abort-then-send-now path.
  - `deferred submissions > folds entries ahead of a stop-time @compact in, and re-queues the rest` — `["first", "@compact wrap up", "third"]` on the `next` queue suspends with `nextPrompt: "first\nwrap up"` and leaves `"third"` queued.
- Full suite green: `npx tsc -b`, `npx biome check .`, `npx vitest run` (1581 passed).

## abort ownership

- Goal: `Agent.abort`/`abortAndWait` return `void`; `Thread.abort` drains and returns `{unsent}`; the loop honours an abort between turns.
- Tests: `Thread.abort returns the unsent queue` (`agent.test.ts:1255-1313`) moves to `thread.test.ts`; its cases enqueue via `core.submit(pendingMessage(...), "async")` against a busy thread instead of `core.update({type:"enqueue-next-request"})`, which no longer exists.
- Add: abort delivered while the loop is between turns settles `aborted` and issues no further request.

Done. The signature change, `Thread.abort`'s drain and the test move landed in stage 3; this stage added the between-turns guard:

- `Thread.abortRequested` is set by `abort()` and cleared at the top of `runToRest`. The loop checks it in two places: at the top of each iteration (an abort that arrived while the agent was settling) and immediately after `continuation()` returns (an abort that arrived while the continuation was being prepared). Either way the loop returns `{type:"aborted"}` and issues no further request.
- Decision: an abort landing *during* a continuation drain discards the entries that drain resolved, rather than re-queueing them. That matches the existing abort-then-send-now path, which also drains and discards, and keeps the guard a single check rather than a rollback.
- No agent change was needed — `Agent.abort`/`abortAndWait` already return `void` as of stage 3.
- New test: `Thread.abort between turns > stops the loop instead of issuing the continuation` (`node/core/src/thread.test.ts`) gates the queued entry's resolution, aborts while the loop sits in the flush, and asserts the original `send` resolves `{type:"aborted"}` with no new stream opened. Verified to time out when the guard is removed.

### Review follow-ups (stage 4)

- **One loop lifecycle field, not two booleans.** `looping` and `abortRequested` are replaced by `private loopState: {type:"idle"} | {type:"running"} | {type:"aborting"}`. `isBusy` reads `type !== "idle"`, and `abort()` only transitions `running → aborting`, so "an abort is pending but no loop is running" is now unrepresentable and `runToRest` no longer has to clear a stale flag on entry — which also closes the nit about an `abort()` landing between loops being silently swallowed. (`isAborting()` exists purely to defeat TS's assignment-narrowing of the field inside `runToRest`.)
- **The top-of-loop guard is deleted as unreachable.** Investigating the reviewer's "second branch is uncovered" note showed it cannot be reached: an abort that arrives while a turn is in flight is handled by the agent, which settles `{type:"aborted"}`, so the loop leaves through `result.type !== "completed"`. The only window the loop itself owns is the continuation, and the guard after `continuation()` covers it — verified by deleting that guard and watching the abort test hang. A comment at the top of the loop records why there is nothing to check there.
- **The abort test asserts the discard decision**: `expect((await aborting).unsent).toEqual([])` plus a `resolved` log showing the drain did resolve the entry — so a regression that starts re-queueing or handing back drained entries fails.
- **New test `issues no continuation when the abort races the stop`**: an abort delivered from the update callback at the stop asserts `{type:"aborted"}`, no new stream, and that the before-request supervisors were never consulted about the stop. This is the case that turned out to be handled by the agent rather than by a loop guard.
- `createAgentWithMock` gained an optional `onUpdate` callback (4th param) so a test can act at a thread notification; the gated abort test now uses `Defer<void>` from `utils/async.ts` instead of hand-rolled promise executors with optional `resolve`s.
- Suite state: `npx tsc -b` and `npx biome check .` clean; `npx vitest run` is green apart from `node/comments/comment-input.test.ts > follows up on an existing comment`, which fails identically on a clean `git stash` — the known flake in that file.

## root layer + cleanup

- Goal: `thread-view.ts` and `thread.ts` read `core.queued`. `npx tsc -b`, `npx vitest run`, `npx biome check .` clean. Grep for `nextRequestQueue|nextStopQueue|DEFERRED_QUEUES` returns nothing outside `node/core/dist`.

Done in stage 3, which forced it: both root readers go through `core.queued`, the three commands are clean, and `nextRequestQueue` / `nextStopQueue` survive only as private fields of `Thread`.
