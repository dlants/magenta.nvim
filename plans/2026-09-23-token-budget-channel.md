# Objective and Context

User request, verbatim:

> as far as the order, I think maybe shoving the auto-compactor into supervisors is Feeling like more trouble than it's worth because this is the only thing that does the preflight check and it's the only thing that suspends the thread and kind of takes over. Wondering if we should create a dedicated channel for this to special case it in the interaction between thread and thread core.
> Basically we still want to run it on `before_request` but what we should do is:
> 1. run all the injector supervisors
> 2. append the user input
> 3. always do the preflight check
> When we do the preflight check we call out to the outer compaction controller.
> I guess we just need to think through what should happen, like how that handoff should happen. I think maybe what we do is just have the core end its turn because we want to basically abort, right? We get rid of this idea of suspension and things like that and we just say, "Oh we're refusing to continue," right? That's a new stop reason because we're about to exceed our token budget and then the thread can transparently handle that stop reason by running a compaction and kicking things off. Let's sketch out this approach and the plan.

This plan comes before `plans/2026-09-23-expanded-prompts-and-compaction.md`. It removes the suspension machinery that plan was threading `next: AgentInput[]` through, so that plan's stages 2–3 get simpler once this lands. See "Relation to the expanded-prompts plan" below.

## Current state

- `AutoCompactSupervisor` (`thread-supervisor.ts`) is the only supervisor that:
  - declares `requestPreflightTokenCount`
  - suspends from `onBeforeRequest` (`{ type: "suspend", reason: { kind: "compact", nextPrompt } }`)
  - It sits first in `toolLoopSupervisors`, ahead of Thread's `gate` and the context supervisors.
- The whole `beforeRequest` protocol in `ToolLoopSupervisorChain` exists to serve AutoCompact:
  - it counts tokens lazily when a declaring member is reached
  - it combines suspensions ("first suspend wins")
  - it passes `status: "suspended"` to later members so they decline to commit state
  - `RequestContext.inputTokenCount`, `CombinedRequestAction`'s suspend variant, and the `status` checks in `FileSupervisor`, `GitSupervisor`, `SystemInfoSupervisor`, `SystemReminderSupervisor` and Thread's `queueFlushAction` exist for this too.
- `runToolLoop` (`tool-loop.ts`) order today:
  1. `onBeforeRequest` (count, then injectors)
  2. append injections
  3. append input
  4. if suspended, return `suspended`
  - So the count excludes the new input and the injections.
- Thread's `gate` publishes `ctx.inputTokenCount` into `core.preflightTokenCount`. The status line (`inputTokenCount`, `getLastStopTokenCount`) reads it.
- `CoreLoopResult` has a `suspended` variant with `SuspendReason = CompactSuspendReason | PlainSuspendReason | YieldSuspendReason`.
  - `compact` comes from AutoCompact, `@compact`, and queued `@compact`.
  - `yield` comes from `gate.onToolResults`.
  - `PlainSuspendReason` has no producer in non-test code.
- `Thread.startSubmission` loops on `suspended` results and calls `compactAndContinue` for `compact` reasons.
- `ThreadCoreCallbacks.supervisor` narrows the chain to `onToolApplied | onToolResults | beforeRequest`.

## Relevant files

- `node/server/src/tool-loop.ts`: per-request ordering, loop results.
- `node/server/src/thread-core.ts`: builds tool-loop deps, owns the manager (`countTokens`), `preflightTokenCount`.
- `node/server/src/thread-supervisor.ts`: `ToolLoopSupervisorChain.beforeRequest`, `RequestContext`, `SupervisorAction`, `AutoCompactSupervisor`.
- `node/server/src/thread.ts`: `gate`, `queueFlushAction`, `runLoop`, `startSubmission`, `compactAndContinue`.
- `node/server/src/thread-api.ts`: `CoreLoopResult`, `RestResult`.
- `node/server/src/thread-assembly.ts`: builds/inherits AutoCompact from policy or fork source.
- `node/server/src/supervisors/{file,git}-supervisor.ts`, `system-reminder-supervisor.ts`: `status === "suspended"` declines.
- `node/server/src/providers/provider-types.ts`: `StopReason`, `NativeInferenceManager.countTokens?`.

# Design

Token budget is its own channel between ThreadCore and Thread, not a supervisor. Tool-loop supervisors become pure injectors/observers again: they cannot suspend, and they never see a token count.

## Per-request order in the tool loop

1. `onBeforeRequest`: run the injector supervisors, collecting injections. Nothing can stop the request here.
2. Append the injections, then (on the first iteration) the loop's input. Same order as today, so queued user content still lands last.
3. `checkBudget()`: the core counts the log as it now stands and records `preflightTokenCount`. If a budget is installed, it asks it whether to proceed.
4. If the budget refuses, the loop ends without issuing the request, with `{ type: "completed", stopReason: "context_budget" }`. The log keeps everything appended in step 2.
5. Otherwise, issue the request as today.

The count happens on every request once a budget is installed. With no budget, or a manager without `countTokens` (OpenAI), there is no count and the check always proceeds. That is today's behaviour, since only AutoCompact asked for one.

## The stop reason

- `context_budget` is a tool-loop stop reason, not a provider one. `StopReason` stays the provider's vocabulary, and the loop's completion carries `LoopStopReason = StopReason | "context_budget"`.
- It is a normal completion: the loop came to rest cleanly, with the log coherent and nothing half-issued. It is not an abort (no abort marker, no aborted tool results) and not a suspension.

## Thread handling (transparent)

In `runLoop`, a `completed` result with `context_budget` is handled before anything else looks at the stop:
- It never reaches `plannedContinuation`, so turn supervisors (`onEndTurnWithoutYield`) never see it and queues are not flushed into it.
- Thread runs `compactAndContinue(next = budget.handoff)`:
  - the compactor splits the unanswered tail per the expanded-prompts plan
  - the core is replaced
  - the loop continues on the fresh core with the returned `next`
- The same path serves `@compact` and queued `@compact`. They call `compactAndContinue` directly with their expanded `next`, instead of fabricating a `suspended` result.

After this, compaction is no longer a `SuspendReason`:
- `CompactSuspendReason` is deleted.
- The `suspended` variant of `CoreLoopResult` is deleted. Yield gets its own loop outcome (below).
- `RestResult` loses `suspended` entirely. Its only other member, `PlainSuspendReason`, has no producer, so it goes too, along with `EndTurnAction`'s `suspend` variant.
- A thread without a compactor treats `context_budget` like `end_turn`: it comes to rest. Compact threads have no budget, so for them this is moot.

## Yield is a loop outcome the tool loop recognises

Today the loop treats yield as opaque. Thread's `gate.onToolResults` looks `yield_to_parent` up in the result archive and returns a `YieldSuspendReason`, which travels back through the tool loop as a `suspended` result. Instead, `runToolLoop` knows about the yield tool and checks inline:

1. The loop runs the batch, appends the results to the log, and calls `onToolResults` (observe-only), so the log is complete and every `tool_use` is answered.
2. If the batch was aborted, return `aborted` as today. An abort always wins.
3. Otherwise, scan the batch's `requested` tools. If one is `yield_to_parent` (request `ok`, `toolName === "yield_to_parent"`) and its entry in the batch's `results` has `status: "ok"`, return `{ type: "yield", value: request.input }`. Everything needed is already local to the loop: `requested` carries the parsed request and `results` carries the status.
4. Thread's `runLoop` handles `yield` exactly as it handles a yield suspension now: `resolveYield` consults the turn supervisors' `onYield` (accept / reject / send-message). Only an accepted (or unclaimed) yield becomes `RestResult.yielded`.

Consequences:
- Thread's `gate` disappears entirely: its before-request half went with the budget, and its tool-results half is now a few lines in the loop.
- `SuspendReason` and `YieldSuspendReason` are deleted. `onToolResults` (the loop dep, the chain, and `ToolLoopSupervisor`) returns `void`: nothing but the loop itself can end the loop after a batch.
- The loop's raw `yield` (a request to hand back) is a different type from `RestResult.yielded` (the accepted outcome, possibly with `resultPrefix`), so the two can't be confused.

## Where the budget lives

- `TokenBudget` replaces `AutoCompactSupervisor`. It is plain configuration: a threshold and a handoff, with no mutable state. Assembly builds it from `ChatThreadPolicy` (`autoCompactThreshold`, `autoCompactPrompt`) and puts it in `ThreadContext`. A fork inherits the source's.
- Core owns the check. `tokenBudget` is part of `ThreadCoreContext`, so every core Thread constructs, whether fresh, forked or post-compaction, receives it through `coreContext()`, and it survives replacement without any extra wiring. Core decides whether to stop on its own; Thread is not consulted and only learns the outcome from the `context_budget` stop.
- Thread still reads `tokenBudget.handoff` from its own context when it handles the stop.
- Thread's `gate.onBeforeRequest` (which only published the count) is deleted: core records `preflightTokenCount` itself.

## Interfaces

```ts
// tool-loop.ts
export type LoopStopReason = StopReason | "context_budget";
export type BudgetDecision = { type: "proceed" } | { type: "stop" };

export type ToolLoopDeps = AgentContext & {
  manager: NativeInferenceManager;
  onUpdate?: () => void;
  executeTools: ToolExecutor;
  /** Injector supervisors only; cannot stop the request. */
  onBeforeRequest: () => Promise<AgentInput[]>;
  /** After injections and input are in the log, before the request. */
  checkBudget: () => Promise<BudgetDecision>;
  /** After the batch's results are in the log. Observe only. */
  onToolResults: (
    results: ToolResults,
    nativeMessageIdx: NativeMessageIdx,
  ) => void;
};

export type ToolLoopResult =
  | { type: "completed"; stopReason: LoopStopReason }
  | { type: "yield"; value: YieldValue }
  | { type: "aborted" }
  | { type: "failed"; error: Error };

// thread-api.ts
// CoreLoopResult is replaced by ToolLoopResult (above) for core → Thread.
// ToolLoopSupervisor.onToolResults?(results, idx): void — observe only.

/** What owners see: no suspensions, and never `context_budget` — Thread
 * absorbs it. */
export type RestResult =
  | { type: "completed"; stopReason: StopReason }
  | { type: "empty" }
  | { type: "yielded"; value: YieldValue; resultPrefix?: string }
  | { type: "aborted" }
  | { type: "failed"; error: Error };

// thread-supervisor.ts
export type SupervisorAction =
  | { type: "inject"; content: InjectedContent[] }
  | { type: "none" };
export type RequestContext = {
  outputTokenCount: number;
  nativeMessageIdx: NativeMessageIdx;
};
// ToolLoopSupervisor loses requestPreflightTokenCount.
// ToolLoopSupervisorChain.beforeRequest(facts): Promise<AgentInput[]>;
//   no countTokens dep, no suspend combination.

// compaction/token-budget.ts
export class TokenBudget {
  static create(opts: { threshold?: number; handoff: string }): TokenBudget;
  static clone(args: { source: TokenBudget }): TokenBudget;
  check(inputTokenCount: number): BudgetDecision;
  /** What compaction continues with. */
  readonly handoff: AgentInput[];
}

// thread.ts
interface ThreadContextBase {
  tokenBudget?: TokenBudget;
  // AutoCompactSupervisor no longer appears in toolLoopSupervisors
}

// thread-core.ts
interface ThreadCoreContext {
  // ...existing fields
  /** Absent: never count, always proceed. */
  tokenBudget?: TokenBudget;
}
// ThreadCoreCallbacks is unchanged.
```

`ThreadCore.checkBudget()` (the tool-loop dep):
- if `context.tokenBudget` or `manager.countTokens` is missing: proceed
- otherwise count, set `preflightTokenCount`, and return `tokenBudget.check(count)`
- a failed count logs a warning and proceeds, which is today's behaviour

## Invariants

- A request is never issued unless the budget check ran against the log exactly as it will be sent: injections and input included.
- Tool-loop supervisors cannot stop a request. Their injections are always appended, and so always delivered or compacted. The `status: "suspended"` declines in the context supervisors and `queueFlushAction` are deleted, not relied on.
- `context_budget` never escapes Thread:
  - owners (`RestResult`, `lastResult`) never see it
  - turn supervisors never see it
  - queue continuation never runs on it
- A budget stop happens on the first request of a loop (after the user's input) or on a later one (after tool results). In both cases the log is coherent: every `tool_use` is answered, because the stop only occurs between requests.
- Aborting during the count aborts the loop as today (`loopState.aborting` is checked after `checkBudget`), and no request is issued.
- The loop yields only after the yield tool's result is in the log, and only if it is `ok` and the batch was not aborted. The loop decides this inline from the batch's `requested` and `results`; supervisors cannot yield or suspend.
- The yield decision (accept / reject / send-message) stays with Thread's turn supervisors. Core only reports that the model asked to yield.
- Compaction's handoff is the budget's `handoff` for budget stops, and the expanded `@compact` rest for explicit compaction. The compactor appends the unanswered tail in both cases.
- Forks inherit the source's budget settings; compact threads have none.
- `preflightTokenCount` is updated on every counted request, so the status display is at least as fresh as today.

## Relation to the expanded-prompts plan

- That plan's `CompactSuspendReason.next` becomes the `next` argument of `compactAndContinue`. There is no suspend reason to carry it.
- Its `AutoCompactSupervisor.create({ next })` becomes `TokenBudget.handoff`.
- Its stage 3 (compactor splits the unanswered tail) is unchanged and still needed. With input appended before the count, a budget stop on a first request always has the user's input as the log's tail.

## Out of scope

- Cheaper counting: local estimation instead of a `countTokens` API call per request. This plan counts every request once a budget exists. Today only the first request after each tool batch, and resting stops, triggered a count via AutoCompact; now it's every request. That adds one count-tokens round trip per request on Anthropic.

# Stages

## Budget channel beside the supervisors

Status: done.
- Decisions/deviations:
  - `TokenBudget.handoff` is a `string` for now (stage keeps the `nextPrompt: string` shape); it becomes `AgentInput[]` with the expanded-prompts plan.
  - `LoopStopReason` lives in `thread-api.ts`; `CoreLoopResult` gained a stop-reason type parameter so `RestResult` stays on `StopReason`.
  - Thread's `runLoop` turns a `context_budget` completion into a `compact` suspension carrying the handoff, so the existing `startSubmission` loop runs `compactAndContinue`. Without a compactor it rests as `end_turn`.
  - The chain's lazy-count machinery and `gate.onBeforeRequest` are untouched (now inert); stage 2 deletes them.
  - `MockAnthropicClient.countTokensRequests` records count params for the "count sees the input" test.
  - Tests: `agent.test.ts` "TokenBudget integration", `compaction/token-budget.test.ts`, retargeted assembly/session/parity/nvim wiring tests.
  - Full-suite nvimclient runs show load-dependent stream-timeout flakes in unrelated files (script-manager, spawn-subagents, thread-compact); each passes when run alone.
  - Review follow-up:
    - `ThreadContextBase` now groups `compaction?: { compactor; tokenBudget? }` (no top-level `compactor`/`tokenBudget`), so a budget without a compactor can't be expressed. Thread passes `compaction.tokenBudget` into `coreContext()`. A `context_budget` stop without a budget throws as an invariant violation, and the "rest as end_turn" fallback is gone. The no-compactor test was rewritten to compact and continue.
    - Tests install compactors via `compactorSlot(thread).compactor = …` (test-helpers), which keeps any configured budget.
    - `TokenBudget.create` rejects thresholds that are not positive integers.
    - `splitPendingUserText` is exported and covered by a table test in `compaction/index.test.ts`.
    - Abort during a pending `countTokens` (via the new `MockAnthropicClient.countTokensGate`) settles `aborted`, and no request is issued.
    - Removed the `restResult` stop-reason cast and the `turnSupervisors!` assertions.

- Goal:
  - `TokenBudget` exists, and assembly installs it (fresh from policy, cloned on fork) instead of `AutoCompactSupervisor`.
  - `ThreadCore` receives `tokenBudget` via `ThreadCoreContext` and runs `checkBudget` itself, after injections and input are appended.
  - `runToolLoop` returns `completed` / `context_budget` on refusal.
  - Thread handles `context_budget` by calling the existing `compactAndContinue` with the handoff string. The `nextPrompt: string` shape is unchanged for now.
  - `AutoCompactSupervisor` is deleted.
- Tests:
  - A thread over threshold on its first message:
    - the count sees the user's input (the mock client's `countTokens` receives a request whose last message holds it)
    - no inference request is issued
    - compaction runs and the fresh core continues
  - Over threshold after a tool batch: the tool results are in the compactor's input, and no request carrying them was issued.
  - A thread with no budget (compact thread) never calls `countTokens`.
  - `onEndTurnWithoutYield` spies never see `context_budget`, and `submit()` never resolves with it.
  - Fork inherits the threshold/handoff (the existing assembly/session fork tests, retargeted).

## Strip suspension from the tool-loop supervisor protocol

Status: done.
- Decisions/deviations:
  - `RequestFacts` is now an alias of `RequestContext`; `CombinedRequestAction` and `BeforeRequestDecision` are deleted. The loop dep `onBeforeRequest` returns `AgentInput[]`.
  - `gate()` no longer takes the core; it keeps only yield detection.
  - `ThreadCore.checkBudget` clears `preflightTokenCount` on a failed count (the deleted gate used to), so a stale count is never shown.
  - `createTestAgent` accepts `checkBudget`; the parity "stops without issuing the continuation" tests now stop via the budget and expect `completed`/`context_budget`.
  - `MockAnthropicClient.mockInputTokenCountOnce` answers one count, which replaced the supervisor-suspension triggers in compaction/thread/agent tests.
  - Deleted tests of the removed protocol: chain "first suspension wins", "Thread preflight token count" hook tests (kept the failed-count test, retargeted to a budget), "suspending at the gate", reminder/queue "suspended request" tests, system-reminder suspension decline, and "compact suspension without a compactor" (unreachable without supervisor suspension; stage 3 removes the path).
  - New tests: `thread.test.ts` "leaves next/async content flushed into a budget-stopped request to the compaction it fed"; `thread-core-context.test.ts` "context injected into a budget-stopped request is re-delivered by the fresh core".

- Goal:
  - `SupervisorAction` loses `suspend`.
  - `RequestContext` loses `status` and `inputTokenCount`.
  - `ToolLoopSupervisor` loses `requestPreflightTokenCount`.
  - The chain's `beforeRequest` returns `AgentInput[]` with no count dep.
  - Remove the `status === "suspended"` checks in the context supervisors and `queueFlushAction`.
  - Delete `gate.onBeforeRequest`; `gate` keeps only the yield detection in `onToolResults` until the last stage.
- Tests:
  - A queued `@async` message injected into a request that then hits the budget reaches the fresh core: it is in the unanswered tail the compactor carries.
  - File context injected into a budget-stopped request does not leave the file supervisor wedged: the fresh core re-delivers current file state on its first request.

## Compaction off the suspension path

- Goal:
  - `@compact` and queued `@compact` call `compactAndContinue` directly.
  - `CompactSuspendReason`, `PlainSuspendReason` and `EndTurnAction`'s `suspend` variant are deleted.
  - `CoreLoopResult.suspended` is narrowed to `YieldSuspendReason` for now, and `RestResult` has no `suspended` variant.
  - `startSubmission`'s suspension loop becomes: run, and if the result was `context_budget`, compact and run again.
- Tests:
  - An explicit `@compact` while idle, a queued `@compact` behind `@next` content, and a budget stop mid-submission all end in the same state: core replaced, summary in the opening, `next` sent. Assert through `submit()`'s result and the post-compaction request.
  - Aborting during compaction settles `aborted`, and a superseding submission after it runs on the replaced core (the existing compaction abort/supersede tests, retargeted).

## Yield recognised by core

- Goal:
  - `runToolLoop` detects an `ok` `yield_to_parent` result in the batch inline and ends the loop with `{ type: "yield", value }`.
  - `runToolLoop` returns `ToolLoopResult`.
  - Thread's `runLoop` resolves `yield` via `resolveYield`.
  - `gate`, `SuspendReason`, `YieldSuspendReason`, `CoreLoopResult` and the `suspended` variant are deleted.
  - `onToolResults` returns `void` everywhere (loop dep, chain, `ToolLoopSupervisor`).
- Tests:
  - A subagent that calls `yield_to_parent`:
    - its result is in the log before the loop ends
    - no further request is issued
    - `onYield` is consulted
    - an accepting supervisor settles `submit()` as `yielded`
  - A batch where `yield_to_parent` runs alongside another tool: both results are logged, then the loop yields.
  - A yield whose tool result is an error does not end the loop: the next request carries the error.
  - Aborting while the batch containing the yield runs settles `aborted`, not `yielded`.
  - A rejecting `onYield` resubmits the rejection text on the same core (existing tests, retargeted).
