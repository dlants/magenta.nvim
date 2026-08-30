# Objective and Context

> we should always trigger onBeforeRequest, even before the first request.
> Whatever special casing we did for triggering things elsewhere should be folded in.
> Each supervisor can maintain state to see if it's the first trigger or not
>
> [on `submit`'s empty-request short circuit] I think this should move up the stack.
> We are basically just gating what happens on a `CR` here. We can see if there are
> pending things that would go out by observing the state of the various supervisors

Today `onBeforeRequest` is consulted from three different places, each with its own
placement rule for what the supervisors produce. The goal is one call site — the top
of the runner's turn loop, immediately before every request — with the runner knowing
nothing about "submissions" versus "continuations".

## Entities

- `Runner` (`node/core/src/providers/provider-types.ts`) — the provider turn loop.
  `runTurn(input)` appends `input` as a user message, then `runLoop()` alternates
  `streamOneResponse()` / `executeTools()` until something ends the turn.
- `OnBeforeContinuation` / `ContinuationDecision` (same file) — the hook the runner
  currently fires *after* `appendToolResults`, answering `continue` | `suspend`.
- `Agent` (`node/core/src/agent.ts`) — owns the runner, implements `executeTools`,
  and translates `AgentHooks.onBeforeRequest` into log mutations.
  - `composeBeforeRequest(RequestContextKind)` — consults the hook, maps
    `InjectedContent` to `AgentInput`, and on suspend appends the injections itself.
  - `submit()` — composes for `kind: "submission"`, places injections *ahead of* the
    user content in one message, and short-circuits to `completed` when the request
    would carry nothing.
  - `applyStopHooks(stopReason)` — composes for a turn-end continuation and
    `prependToNextTurn`s the result onto the next `runTurn`.
  - `onBeforeContinuation(stopReason)` — composes for the tool-results continuation
    and appends directly (the log is already valid at that point).
- `Thread` (`node/core/src/thread.ts`) — owns the supervisors and the deferred
  queues. `beforeRequest(ctx)` wraps the composed supervisor actions to add the
  standing system reminder and, on a `tool_use` continuation only, flush the
  mid-turn queue into `submissions`. `openingSubmissionIsEmpty` suppresses the
  reminder so an empty send cannot manufacture a request.
- `ThreadSupervisor` (`node/core/src/thread-supervisor.ts`) — `onBeforeRequest`,
  `onEndTurnWithoutYield`, `onYield`, `onToolApplied`. `RequestContext` carries
  `kind`, `stopReason`, `inputTokenCount`, `outputTokenCount`, `isFirstMessage`.
- Supervisors that read `RequestContext.kind`/`isFirstMessage`:
  `SystemInfoSupervisor` (preamble on the first submission only) and, indirectly,
  `Thread.beforeRequest`. `AutoCompactSupervisor` is the only one that ever
  suspends from `onBeforeRequest`.
- Injecting supervisors, all side-effecting on read:
  `FileContextSupervisor` (`ContextManager.getContextUpdate()` + `onSent`),
  `GitSupervisor` (`GitTracker.getUpdate()` commits the agent view),
  `CommentSupervisor` (`store.getPendingUpdate()` then `commitPending()`),
  `SystemReminderSupervisor` (held by `Thread`, not in the supervisor list).

## Files

- `node/core/src/providers/provider-types.ts` — `Runner`, hook and `TurnResult` types.
- `node/core/src/providers/anthropic-runner.ts` / `openai-runner.ts` — the two turn loops.
- `node/core/src/agent.ts` — `submit`, `executeTools`, `composeBeforeRequest`.
- `node/core/src/thread.ts` — supervisor composition, queues, `runToRest`.
- `node/core/src/thread-supervisor.ts` — supervisor interface and `composeSupervisors`.
- `node/core/src/context/{file-context,git,comment}-supervisor.ts` — injecting supervisors.
- `node/core/src/context/{context-manager,git-tracker,comment-store}.ts` — the state
  behind them; the peek methods stage 1 needs.
- `node/core/src/agent.test.ts`, `thread.test.ts`, `thread-supervisor.test.ts` — coverage.

# Design

One hook, `onBeforeRequest`, fired by the runner at the top of every `runLoop`
iteration — including the first, so the opening request of a turn goes through the
same path as a continuation. The owner appends whatever it produces to the log
itself; the hook's return value is only a gate:

```ts
{ type: "proceed" } | { type: "suspend"; reason: SuspendReason }
```

For that to preserve today's ordering on the opening request, `runTurn`'s
`appendUserMessage(input)` has to move *past* the gate: the owner appends its
injections first, then the runner appends the caller's input. With `coalesce`
that reproduces the current single message with injections ahead of user content.
On the continuation path the tool results are already in the log, so appending is
unconditionally safe — which is what made the current `onBeforeContinuation`
placement necessary in the first place.

Consequences that fall out:

- `executeTools` suspends only for yield; `ToolOutcome`'s suspend variant carries
  no reason and `Agent.pendingYield` stays as the yield handoff.
- `Agent.applyStopHooks` and its `prependToNextTurn` at `Thread.continuation`
  disappear: the next `runTurn` fires the gate itself.
- `Agent.submit`'s composition disappears, and with it `SubmitOptions.requestKind`
  — there is no longer a "this request already had its hooks run" case.
- `RequestContextKind` (`kind` + `stopReason`) drops out of `RequestContext`. Every
  consumer of it becomes supervisor-local state, per the instruction that each
  supervisor tracks its own first-trigger.

The empty-send short circuit moves up to `Thread`. Rather than composing a request
and discarding it, `Thread.send` asks the supervisors whether anything is pending.
This needs a *non-committing* probe, because every injecting supervisor commits its
"sent" state on read.

## Interfaces

```ts
// provider-types.ts
export type BeforeRequestDecision =
  | { type: "proceed" }
  | { type: "suspend"; reason: SuspendReason };

export type OnBeforeRequest = () => Promise<BeforeRequestDecision>;

export type RunnerHooks = {
  executeTools: ToolExecutor;
  onUpdate: () => void;
  onBeforeRequest?: OnBeforeRequest | undefined;
};

// TurnResult keeps the reason it gained for onBeforeContinuation:
| { type: "suspended"; reason?: SuspendReason | undefined }
```

```ts
// anthropic-runner.ts / openai-runner.ts
async runTurn(input: AgentInput[]): Promise<TurnResult> {
  // ... guards, ticker ...
  return await this.runLoop(input);            // no longer appends here
}

private async runLoop(initialInput: AgentInput[]): Promise<TurnResult> {
  let pending: AgentInput[] | undefined = initialInput;
  while (true) {
    if (this.abortRequested) return this.finishAbort();
    const decision = (await this.options.onBeforeRequest?.()) ?? { type: "proceed" };
    if (pending) { this.appendUserMessage(pending); pending = undefined; }
    if (decision.type === "suspend") {
      return { type: "suspended", reason: decision.reason };
    }
    const outcome = await this.streamOneResponse();
    // ... unchanged ...
  }
}
```

Appending `pending` before checking the suspension keeps the user's content in the
log on the suspend path, which is what `submit` does today.

```ts
// thread-supervisor.ts
export interface ThreadSupervisor {
  onEndTurnWithoutYield?(context: EndTurnContext): EndTurnAction;
  onYield?(result: string): Promise<YieldAction>;
  onBeforeRequest?(context: RequestContext): Promise<SupervisorAction>;
  /** Would `onBeforeRequest` contribute anything right now? Must not commit
   * any "sent" state — it answers a question about a request that may never
   * be issued. */
  hasPendingContent?(): Promise<boolean>;
  onToolApplied?: OnToolApplied;
}

export type RequestContext = {
  inputTokenCount: number | undefined;
  outputTokenCount: number;
};  // kind / stopReason / isFirstMessage all gone
```

Probes available for `hasPendingContent`, all already non-committing:
`ContextManager.refreshPendingUpdates()` + `getPendingUpdates()`,
`CommentStore.hasPendingUpdates()`, and a new `GitTracker.hasUpdate()` peek
(`getUpdate()` commits, so it cannot be reused).

## Invariants

- A user message is never appended before the tool results that precede it: the
  gate fires after `appendToolResults`, never between it and the tool_use.
- The opening request of a submission carries injections ahead of the user's own
  content, in a single user message.
- A suspension leaves the log coherent and resumable: injections and the user's
  content are in the log, the deferred queues are untouched and unresolved.
- The hook fires exactly once per logical request. `streamOneResponse` retries
  internally, so a retry must not re-fire it.
- A send with no user content and nothing pending issues no request and settles
  `completed`; a send with no user content but a pending context update does
  issue one. The standing reminder alone never makes a request worth issuing.
- Injecting supervisors commit their "sent" state only when the injection has
  actually been placed in the log.
- Exactly one supervisor can suspend from `onBeforeRequest` today
  (`AutoCompactSupervisor`); the first suspension wins and every supervisor is
  still consulted.

# Stages

## Move the empty-send gate up to the thread — DONE

- Goal: `Thread.send([])` decides for itself whether a request is worth issuing,
  by probing the supervisors. `Agent.submit`'s `!hasContent && !injections &&
  !hasPrefix` short circuit and `Thread.openingSubmissionIsEmpty` are gone.
  Everything else still works as it does now.
- Notes: add `hasPendingContent?()` to `ThreadSupervisor`, implement on the three
  injecting supervisors, aggregate in `composeSupervisors` (or query the list
  directly from `Thread`). `SystemReminderSupervisor` answers `false` — that is
  what `openingSubmissionIsEmpty` encodes. Add `GitTracker.hasUpdate()`.
- Tests:
  - `send([])` with a dirty tracked file issues a request carrying the context
    update; the same send with nothing pending issues none and settles `completed`.
  - `send([])` with only a standing reminder active issues no request, and the
    reminder is still delivered on the next real submission.
  - The probe does not consume: a `send([])` that is gated off leaves the pending
    context update, git update and comment update intact for the next request.

### What was done

- `ThreadSupervisor.hasPendingContent?()` (`thread-supervisor.ts`), aggregated in
  `composeSupervisors` and surfaced on `ThreadHooks`. Implemented on
  `FileContextSupervisor` (`refreshPendingUpdates` + `getPendingUpdates`),
  `GitSupervisor` (new `GitTracker.hasUpdate()`) and `CommentSupervisor`
  (`CommentStore.hasPendingUpdates()`).
- The gate lives at the top of `Thread.runToRest`, not in `Thread.send`: it has
  to sit inside the window where the thread already reports itself busy.
- `Thread.openingSubmissionIsEmpty` is gone; the standing reminder is now
  injected unconditionally, because a request only gets composed at all once
  something else is pending.
- Tests: `thread.test.ts` "empty send gate" (4 cases) and
  `thread-supervisor.test.ts` "composeSupervisors hasPendingContent" (2 cases).

### Deviations

- `Agent.submit`'s `!hasContent && !injections && !hasPrefix` short circuit is
  kept, re-commented as a last-resort guard. It is no longer the policy — the
  thread decides — but a bare `Agent` (and the compact thread's raw send) still
  must not issue a contentless request. Two `agent.test.ts` cases cover it.
- `CommentSupervisor.hasPendingContent` deliberately skips `beforeRead`: extmark
  positions only matter for content that is actually going out, and the probe
  must stay cheap.
- The probe's await opened two races that the previously-synchronous send path
  hid. Both are fixed here:
  - `Thread.sendEpoch`: each `runToRest` claims the loop, and a loop that finds
    the epoch moved on while it was probing returns `aborted` without touching
    the agent. The `finally` only clears `loopState` for the current epoch.
  - `Agent.submit` re-checks `this.submission` after composing. An abort landing
    during composition settles the submission and hands the agent to the next
    sender; without the check both requests went out and the runner dropped one.
    (Pre-existing hazard; the extra await made it reproducible — it was breaking
    `comment-input.test.ts` "scopes comment controllers to the root thread".)

### Review follow-ups

- `loopState` now carries the generation (`{ idle } | { running; epoch } |
  { aborting; epoch }`), so "am I still the current loop" is a property of the
  state rather than a parallel `sendEpoch` comparison; `isAborting(epoch)` is
  epoch-scoped too.
- `ThreadHooks.hasPendingContent` is required (still optional per-supervisor);
  `Thread.hooks` defaults to a `false` probe, and the `?? false` fallback is gone.
- Added tests for the three previously-untested pieces: the supersession race
  (`thread.test.ts` "supersedes an empty send whose probe is still in flight",
  driving the probe with a `Defer`), the `Agent.submit` post-composition
  submission re-check (`agent.test.ts` "drops a submission aborted while its
  before-request hooks are in flight"), and `GitTracker.hasUpdate` (three cases
  in `git-tracker.test.ts`: non-committing peek, no-op change, throw path). Both
  race tests were verified to fail with their guard removed.

## Single gate at the top of the turn loop — DONE

- Goal: `onBeforeContinuation` becomes `onBeforeRequest`, fired at the top of every
  `runLoop` iteration; `runTurn`'s input append moves past it. `Agent.submit` no
  longer composes, `Agent.applyStopHooks` and the `prependToNextTurn` in
  `Thread.continuation` are gone, `SubmitOptions.requestKind` is gone.
  `executeTools` suspends only for yield.
- Tests:
  - The opening request of a submission carries the injection ahead of the user's
    text, in one user message (existing test, must keep passing).
  - The tool-results continuation carries the injection after the `tool_result`
    block in the same user message (existing test).
  - The hook fires exactly once per request across a turn with two tool rounds,
    and once across a compaction handoff (existing counting tests, now including
    the opening request).
  - A turn-end continuation (`max_tokens` nudge, queued message) fires the hook on
    the request it produces, not before it is known to be needed.
  - Auto-compact suspends at the opening request of a send when already over
    threshold, and at a continuation; in both cases the log is left resumable.
  - A retried request (`streamOneResponse` retry) does not re-fire the hook.

### What was done

- `OnBeforeContinuation` → `OnBeforeRequest` (`provider-types.ts`): no arguments,
  answers `BeforeRequestDecision` (`proceed` | `suspend`). Both runners fire it at
  the top of every `runLoop` iteration; `runTurn` no longer appends, `runLoop`
  takes the input as `pending` and appends it past the gate.
- `Agent.onBeforeRequest` composes and places everything: the turn's seeded
  prefix, the supervisors' injections, then the mid-turn submissions.
  `applyStopHooks`, `onBeforeContinuation` and `BeforeRequestResult` are gone,
  as is the `prependToNextTurn` in `Thread.continuation`.
- `executeTools` already suspended only for yield; only its comments changed.
- Tests: `runner-parity.test.ts`'s gate suite now covers the opening request,
  and `anthropic-runner-retry.test.ts` gained "does not re-fire the
  before-request gate on a retried request".

### Deviations

- `SubmitOptions.requestKind` did not simply disappear: it became
  `continuationOf?: StreamStopReason`. The gate takes no arguments, so the agent
  has to describe the request to the supervisors itself, and it cannot tell a
  turn-opening continuation (a `max_tokens` nudge, a queue flush) from a fresh
  submission. `Thread` states it; later gates in the same turn derive
  `{kind: "continuation", stopReason}` from the last assistant message. All of
  this dies with `RequestContextKind` in stage 3.
- Coalescing is chosen by the agent, not fixed: the opening request of a turn
  starts a new user message (otherwise the injections fold into whatever the log
  ended with — an abort marker, a suspended send), a continuation coalesces into
  the message carrying the tool results. The runner then coalesces the caller's
  input only if the gate actually appended something, so an opening request with
  no injections still pushes its own message.
- The seeded prefix (`prependToNextTurn`) is consumed by the gate rather than by
  `Agent.runTurn`, which is what keeps it ahead of the injections in one message
  (the compaction summary, then the system-info preamble, then the prompt).
- Queue content flushed for a request the gate then suspends is *not* left
  unresolved, contrary to the invariant as written: `flushAtStop` runs before the
  request exists, and resolution is not repeatable. Instead the flushed text is
  folded into the compaction's follow-up prompt, exactly as `flushAtStop` already
  does for a stop-time `@compact`, so it is resolved once and delivered once on
  the far side of the swap. `thread.test.ts`'s "carries a queue flushed for a
  suspended request onto the handoff" covers it.
- `Agent.submit`'s last-resort empty-request guard is gone: the agent can no
  longer know whether the request would carry injections, since they are composed
  inside the turn. `Thread.runToRest`'s probe (stage 1) is the only gate on an
  empty send.
- An abort now joins on an in-flight gate, since the gate runs inside the turn.
  The stage-1 race test was restructured to resolve its gate before awaiting the
  abort; the race it guarded against is now structurally impossible.

### Review follow-ups

- `SubmitOptions.continuationOf?: StreamStopReason` became
  `requestKind?: RequestContextKind`, so the two cases are the existing precise
  type rather than an optional field the callee reassembles.
- The gate's per-request state is now an explicit
  `pendingRequest: { type: "opening"; kind } | undefined`; the opening/continuation
  distinction (which kind, whether to coalesce, whether to take the turn prefix)
  reads off that variant instead of off the presence of one field. The seeded
  prefix is still *stored* on `pendingTurnPrefix` and taken by the gate rather
  than carried on `pendingRequest`: a turn that never reaches the gate (disposed,
  aborted at the guards) must leave it for the next one.
- `continuationKind()` no longer fabricates a `tool_use` stop reason. A mid-turn
  gate always follows a finished assistant message, so the absence of one throws.
  `ProviderMessage.stopReason` stays optional — an aborted assistant turn
  legitimately has none.
- `Thread.continuation`'s `carry` moved out of the `messages` variant into a
  `flushed` variant carrying a non-empty `carry`, so the empty string is not a
  second encoding of "nothing to carry" and the type predicate in the join is
  gone. `carryOntoSuspension` switches on the suspend reason.
- On a `stop` suspension there is nothing to carry after all: the runner appends
  a suspended request's input to the log, so the flushed content is already in
  place for whatever resumes the thread. Only a compaction, which throws the log
  away, needs the handoff. `thread.test.ts` "keeps a queue flushed for a
  stop-suspended request for the next request" pins that (delivered exactly once,
  queue emptied).
- `onBeforeRequest` reads the composed result inside a `switch` on its variant.

## Drop the request kind

- Goal: `RequestContext` carries only token counts. `SystemInfoSupervisor` tracks
  whether it has already injected the preamble. `Thread.beforeRequest`'s mid-turn
  queue flush no longer keys off `kind`/`stopReason`.
- Open question for this stage: the mid-turn queue currently flushes only on a
  `tool_use` continuation, while `flushAtStop` handles turn boundaries. With a
  uniform gate the thread has to express "this request is mid-turn" some other
  way — either thread-side state set around `runToRest`'s turn boundaries, or by
  flushing on every gate and confirming that `flushAtStop` cannot double-deliver.
  Decide against `thread.test.ts`'s deferred-submission tests.
- Tests:
  - The system-info preamble appears exactly once, on the first request of the
    thread, and again on the first request after a compaction reset.
  - A message queued while tools are running rides the next continuation request,
    exactly once, and is not re-delivered at the following stop.
  - `@async` / `@compact` deferred submissions behave as they do today
    (existing `thread.test.ts` coverage).
