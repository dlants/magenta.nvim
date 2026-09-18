# Objective and Context

> Critique this thread class, particularly how it communicates to its members and children (like thread core) and also how it communicates with its parents and owners (like session and, I think, compaction manager). I'm looking for ways to reduce and deduplicate. If there are multiple fields that track similar states that can be consolidated, there are multiple pathways for doing similar things (like things that are expressed through custom callbacks or custom functions) that could be consolidated into other notification methods like hooks or supervisors or other existing concepts.

`Thread` (`node/server/src/thread.ts`) is the stable server handle over a replaceable `ThreadCore`. Today it talks to its collaborators through four unrelated mechanisms:

- `ThreadCoreCallbacks` (`thread-core.ts`) — `onUpdate`, `onBeforeRequest`, `onToolResults`, `onToolApplied`. Three of the four are pure fan-out from Thread to its supervisors.
- `ThreadSupervisor` (`thread-supervisor.ts`) — the real hook interface: `onAgentLoopStart/Stop`, `onBeforeRequest`, `hasPendingContent`, `onToolResults`, `onToolApplied`, `onEndTurnWithoutYield`, `onYield`, plus the `requestPreflightTokenCount` flag.
- `ThreadCallbacks` (`onUpdate`, `onSubmission`) — the owner-facing constructor callbacks. `onSubmission` exists only so `thread-assembly.ts` can schedule title generation.
- Direct fields/methods — `context.compactor`, `prependToNextTurn`/`pendingSeed`, `activateReminder`, and ten pass-through getters onto `core`.

Key entities:

- `ThreadCore` (`thread-core.ts`) — replaceable conversation unit: manager, tool execution, context supervisors, `contextDeliveries`, `isActive`/`dispose`.
- `Mailbox` (`submission/mailbox.ts`) — `enqueue`/`takeBatch`/`prepend`/`drain` over `async` and `next` queues of `QueueEntry`.
- `SendResult` / `RestResult` / `ThreadSendResult` / `ThreadResult` (`thread-api.ts`) — the four outcome types.
- `SuspendReason` = `CompactSuspendReason | PlainStopSuspendReason | YieldSuspendReason`.
- `assembleThread` (`thread-assembly.ts`) — builds chat supervisors, the compactor, and the title scheduler.
- `Session` (`session.ts`) — owner; uses `thread.prependToNextTurn` for the fork notification and `thread.yielded` for liveness.

Relevant files:

- `node/server/src/thread.ts` — the class under revision.
- `node/server/src/thread-core.ts` — callbacks interface to shrink.
- `node/server/src/thread-supervisor.ts` — the hook interface all fan-out should route through.
- `node/server/src/thread-api.ts` — result types.
- `node/server/src/submission/mailbox.ts` — queue storage to absorb batch checkout.
- `node/server/src/thread-assembly.ts` — title scheduler and supervisor construction.
- `node/server/src/session.ts` — owner-side callers.
- `node/server/src/thread.test.ts`, `agent.test.ts`, `thread-assembly.test.ts`, `thread-core-context.test.ts` — existing coverage that pins the current contract.

# Design

The refactor is behaviour-preserving. Six independent consolidations, each removing one redundant pathway:

1. **One staleness notion.** Replace `interruption`, `submission`, `resetting`, `resetPromise`, and the four bespoke `isCurrent` closures with a single `Generation` record captured at the start of each submission. Every guard becomes "am I still the live generation".
2. **One fan-out.** A `SupervisorChain` that itself implements `ThreadSupervisor` and composes `chatSupervisors + contextSupervisors + queueFlush`, applying the combination rules (first suspend wins, injections concatenate, end-turn texts join, first accept/reject wins) in one place. Thread hands that single object to core; `ThreadCoreCallbacks` shrinks to `onUpdate`.
3. **One status.** Replace `lastSubmissionResult`, `yieldState`, `resultSettled`, `destroyed` with a `ThreadStatus` union; `isBusy`, `loopState`, `lastResult()`, `yielded`, `isDestroyed` become derived getters with unchanged public shapes.
4. **One suspension dispatcher.** A per-`kind` handler table replaces the inline compaction block in `startSubmission` and the `switch` in `carryOntoSuspension`.
5. **One queue flush.** `Mailbox` gains batch checkout; `flushAtStop`/`flushMidTurn` collapse into `flush(delivery, compactPolicy)`; `pendingSeed` becomes a resolved `next`-queue prepend.
6. **One owner callback.** `onSubmission` becomes a chat supervisor hook; `ThreadCallbacks` reduces to `onUpdate`. Core pass-through getters collapse into a single republished view.

## Interfaces

```ts
// thread.ts — stage 1
type Generation = {
  readonly core: ThreadCore;
  readonly submission: AbortController;
  /** Cancelled by abort/destroy/new submission; passed to the compactor. */
  readonly signal: AbortSignal;
};
// Thread keeps `#generation: Generation | undefined` (undefined = idle) and
// `isCurrent(gen)` is the only guard: gen === this.#generation
//   && gen.core.isActive && !gen.submission.signal.aborted
//   && status.type !== "destroyed".

// thread-supervisor.ts — stage 2
export class SupervisorChain implements ThreadSupervisor {
  constructor(members: () => readonly ThreadSupervisor[], deps: {
    logger: Logger;
    isCurrent: () => boolean;
    /** Supplied lazily because only a declaring member forces the count. */
    countTokens: () => Promise<number | undefined>;
  });
  // all ThreadSupervisor hooks, each iterating members, guarding with
  // isCurrent, catching + logging throws.
}

// thread-core.ts — stage 2
export interface ThreadCoreCallbacks {
  onUpdate: () => void;
  supervisor: ThreadSupervisor; // replaces onBeforeRequest/onToolResults/onToolApplied
}

// thread-api.ts — stage 3
export type ThreadStatus =
  | { type: "idle"; lastResult?: RestResult }
  | { type: "running"; generation: Generation }
  | { type: "yielded"; value: YieldValue; resultPrefix?: string; tornDown: boolean }
  | { type: "destroyed" };

// thread-api.ts — stage 3: unclaimed suspensions stop pretending to be `empty`
export type RestResult =
  | Exclude<SendResult, { type: "suspended" }>
  | { type: "stopped"; reason: PlainStopSuspendReason | CompactSuspendReason };

// thread.ts — stage 4
type SuspensionHandler = (reason, gen: Generation) => Promise<
  | { type: "continue"; messages: AgentInput[] }
  | { type: "settle"; result: RestResult }
>;
// Table keyed by SuspendReason["kind"]; `carry` policy declared per entry as
// `carry: "prompt" | "in-log"`.

// mailbox.ts — stage 5
export type Batch = {
  readonly delivery: DeferredDelivery;
  next(): QueueEntry | undefined;
  /** Put the untaken remainder back at the head (of `delivery` or another queue). */
  restore(to?: DeferredDelivery): void;
  commit(): void;
};
export class Mailbox {
  checkout(delivery: DeferredDelivery): Batch; // replaces takeBatch + Thread's detachedBatch
  drain(): QueuedMessage[]; // now restores any live checkout first
}

// thread-assembly.ts — stage 6
class TitleSupervisor implements ThreadSupervisor {
  onSubmission(messages: readonly AgentInput[]): void;
}
// ThreadSupervisor gains `onSubmission?(messages): void`.
// ThreadCallbacks becomes `{ readonly onUpdate: OnUpdate }`.
```

## Invariants

- Public API shapes that views and tests read stay identical: `loopState`, `lastResult()`, `yielded`, `isBusy`, `isDestroyed`, `result`, `submit`, `retry`, `abort`, `queued`, `pendingTurnContent`.
- Ordering is unchanged: chat supervisors are consulted before context supervisors, and `queueFlush` is always last so user content lands last in the message.
- Suspension precedence is unchanged: the first supervisor to suspend wins; later hooks still run but see `status: "suspended"` and must not commit agent-visible state.
- `requestPreflightTokenCount` still causes the count to happen at most once per request, only when a declaring supervisor is reached and nothing has suspended yet, and `core.preflightTokenCount` is only written after the chat supervisors have run.
- A `yield` suspension never escapes to an owner; it is resolved inside the turn loop.
- Resolved queue content is spent: if the request it was flushed for suspends, it must travel on the handoff (compaction) or already be in the log (stop/yield), never be resolved twice.
- A `@compact` entry cannot ride a mid-turn request: it and everything behind it move to `next`.
- Disposal is irreversible: a cancelled reset must not leave Thread pointing at a disposed core.
- `resultDefer` settles at most once; destroy settles it as `aborted` if nothing yielded.
- Forking still snapshots supervisor history at one effective native index.

# Stages

## generation guard — DONE

- Goal: `interruption`, `submission`, `resetting`, `resetPromise` and the four `isCurrent` closures are replaced by one `Generation` + `isCurrent(gen)`. No behaviour change.
- Tests:
  - [x] Existing `thread.test.ts` abort/preemption suites pass untouched.
  - [x] `submission generations > preempts a submission still resolving its own input`.
  - [x] `submission generations > ignores a before-request hook that outlives its core`.
  - [x] `submission generations > settles the lifecycle result when destroy lands mid-turn`.

Decisions / deviations:

- `Generation` is just `{ readonly controller: AbortController }`. It carries no `core`: a submission legitimately outlives its core across compaction, so core identity is a *turn*-level fact. `turnGuard(core = this.core)` captures the generation plus the core the caller runs against, and is the single replacement for `currentLoopGuard` and the bespoke closures in `beforeRequest`/`flushAtStop`/`flushMidTurn`/`hasPendingContent`/`continuation`.
- The separate `interruption` controller is gone: one controller per generation is both the preemption signal and the signal handed to the compactor. `destroy()` now cancels the live generation instead of interrupting, preserving compaction cancellation on destroy.
- `resetting` + `resetPromise` collapse into one `reset: Promise<ThreadCore> | undefined`, which is both the re-entrancy guard and what a preempting submission awaits.
- `test-helpers.resetThread` no longer calls `interrupt()`; it cancels the generation and clears it.
- Review follow-ups: `replaceCore` now performs the re-entrancy check synchronously before creating the reset promise, so a rejected second call can no longer displace the live one (`resetCore` lost its own check); `Generation` carries a branded `id` minted only by `Thread.mintGeneration`; `turnGuard` no longer returns a permanently-false guard when there is no live generation — with no submission to be stale relative to it falls back to core liveness (some tests drive `core.runTurn` directly, outside any submission).
- Deferred: modelling `generation` + aborted as a discriminated submission state (`idle`/`running`/`aborting`) is stage 3's `ThreadStatus` work, so `loopState` keeps decoding the pair for now.
- Added coverage: `thread.test.ts > submission generations > rejects a second core replacement while one is in flight`; `compaction/index.test.ts > submission-owned compaction signal` (abort cancels the signal handed to `compactor.run`; a reset during compaction cancels it and leaves the thread at rest).
- `compaction/index.test.ts` drove the compactor directly with `thread["interruption"].signal`, which no longer exists while idle. Those tests now own an `AbortController` and abort it alongside the thread action they exercise; the real abort/destroy→compaction linkage stays covered by the submission-driven compaction tests.

## supervisor chain — DONE

- Goal: `SupervisorChain` owns all fan-out; `ThreadCoreCallbacks` is `{ onUpdate, supervisor }`; Thread's six hand-rolled loops are gone.
- Tests:
  - [x] A supervisor that throws in each hook is logged and does not wedge the turn (`thread-supervisor.test.ts > logs a supervisor that throws in every hook without wedging the turn`).
  - [x] Two supervisors both suspending: the first reason wins and the second still sees `status: "suspended"` (`lets the first before-request suspension win, with later hooks told it suspended`).
  - [x] Injections concatenate in supervisor order with queued user content last, asserted against the native request body (`keeps injections in supervisor order with the user's own content last`).
  - [x] `requestPreflightTokenCount`: covered by the existing `agent.test.ts > Thread preflight token count` suite, which now drives through the chain unchanged.

Decisions / deviations:

- `SupervisorChain` lives in `thread-supervisor.ts` and is constructed one-per-core by `Thread.chainFor` (a `WeakMap<ThreadCore, SupervisorChain>`), because its members include that core's context supervisors. `ThreadCoreCallbacks` is `{ onUpdate, supervisor }` with `supervisor` a lazy getter: the core is still being constructed when the callbacks are handed to it.
- The chain's before-request hook is `beforeRequest(facts): CombinedRequestAction`, not `onBeforeRequest`: the combined decision carries injections *and* a suspension, which no single supervisor's `SupervisorAction` can express. `CombinedRequestAction` is structurally `BeforeRequestDecision`, so `ThreadCore` passes it straight to the agent loop without importing anything from `agent.ts` into `thread-supervisor.ts`.
- `ThreadCore` now supplies the `RequestFacts` (output token count, pending user message idx) it is the natural owner of; the chain fills in `inputTokenCount` since only it knows whether a member declared `requestPreflightTokenCount`. Those facts are computed once per request rather than per member — no supervisor appends to the log during the hook, so this is observationally identical.
- Two guards, not one: `guard` (submission-scoped, from `turnGuard`) for `onBeforeRequest`/`hasPendingContent`, and `coreIsCurrent` (core liveness) for `onAgentLoopStart/Stop`, `onToolApplied` and `onToolResults`. Those three record what a turn already did and must still run while a preempted turn unwinds — using the submission guard broke abort-time tool-result reporting.
- The two thread-owned ordering facts that used to sit between the chat and context supervisor loops (publishing `core.preflightTokenCount`, and raising the `yield` suspension for a completed `yield_to_parent`) are now an explicit `gate` pseudo-supervisor inserted at that position in `orderedSupervisors(core)`.
- `onYield` is not guarded inside the chain (matching the previous loop); `resolveYield` checks the guard once after the chain returns. A throwing `onYield` is now logged and treated as `none` rather than failing the submission — the plan's centralized error logging applied to a hook that previously had none.

Review follow-ups (stage 2):

- One declaration for the combined before-request shape: `CombinedRequestAction` (thread-supervisor.ts) is canonical and `agent.ts`'s `BeforeRequestDecision` is an alias of it, so the runner's input and the chain's output cannot drift.
- `SupervisorChain` no longer claims `implements ThreadSupervisor` (a vacuous claim, since every member is optional, and misleading because the chain is not nestable as a member). It implements a new `SupervisorFanOut` interface describing the combined surface, and `ThreadCoreCallbacks.supervisor` is `Pick<SupervisorFanOut, "onToolApplied" | "onToolResults" | "beforeRequest">` — exactly what core drives.
- The two liveness predicates are branded: `SubmissionGuard` (per-hook, submission-scoped) and `CoreLivenessCheck` (core liveness, for hooks recording what a turn already did), minted by `submissionGuard`/`coreLivenessCheck`, so `forEach` call sites cannot silently swap them.
- Added coverage in `thread-supervisor.test.ts`: a throwing `onYield` is skipped and a later `reject` still wins; a lone throwing `onYield` degrades to accept rather than wedging the turn; a chat supervisor's `onToolResults` stop beats the yield gate (the ordering invariant that moved from a hard-coded step into a chain member); a throwing `hasPendingContent` is skipped and a later member's `true` still issues the request.
- `onEndTurnWithoutYield` being guarded by the submission guard is intentional: a preempting submission should truncate the remaining end-turn nudges, since any suspension or nudge they produce belongs to a turn that is no longer live. Left uncovered by a dedicated test; the abort/preemption suites in `thread.test.ts` pin the surrounding behaviour.

## thread status

- Goal: one `ThreadStatus` union; `lastSubmissionResult`, `yieldState`, `resultSettled`, `destroyed` removed; `finish()` loses its `displayResult` parameter and unclaimed suspensions surface as `{type:"stopped"}`.
- Tests:
  - `lastResult()` after a `MaxTokensSupervisor` stop reports `stopped` with the reason, and the thread-view renders it (update `thread-view.ts` / `chat.ts` call sites).
  - Yield: `yielded` is set, `result` settles once, a second submission after a torn-down yield throws.
  - `loopState` transitions idle → running → idle across a compaction, with `lastResult` cleared at replacement as it is today.

## suspension dispatch

- Goal: `startSubmission`'s `while (suspended)` block becomes a handler table; `carryOntoSuspension` folds into the table's carry policy.
- Tests:
  - Auto-compaction at rest still compacts and continues with the configured prompt.
  - Queue content flushed for a request that then suspends on `compact` appears exactly once, in the post-compaction request.
  - The same content suspending on `stop` is in the log and is not re-sent on `retry()`.
  - Compaction failure and abort mid-compaction settle `failed` / `aborted`.

## mailbox batches

- Goal: `detachedBatch`/`restoreDetachedBatch` move into `Mailbox.checkout`; `flushAtStop` and `flushMidTurn` become one `flush`; `pendingSeed` becomes a resolved prepend to `next` and `prependToNextTurn`/`pendingTurnContent` are implemented over the mailbox.
- Tests:
  - `abort()` mid-resolution reports the untouched remainder of the batch ahead of messages enqueued during resolution (existing test).
  - `@compact` mid-turn moves itself and everything behind it to `next`, in order.
  - An entry whose resolution throws is dropped and logged; the rest of the batch still delivers.
  - Session's fork notification still lands at the head of the fork's first turn (`fork-keybinding.test.ts`).

## owner contract

- Goal: `onSubmission` becomes `ThreadSupervisor.onSubmission` with a `TitleSupervisor` built in `assembleThread`; `ThreadCallbacks` is `{ onUpdate }`; the ten core pass-throughs collapse into a republished readonly view.
- Tests:
  - Title is requested once, from the first text-bearing submission, never for a compact thread, and a late response cannot overwrite an explicit label (port `thread-assembly.test.ts`, which currently pokes `thread.callbacks.onSubmission` directly — it should drive a real submission instead).
  - A fork inherits the title supervisor without re-requesting a title for content before the fork point.
