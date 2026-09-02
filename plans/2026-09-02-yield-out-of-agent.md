# Objective and Context

> I changed my mind about how the agent should interact with yield. I think the agent shouldn't know anything about the tools that it runs. From its POV, it should just execute a tool, and get a result back, along with a suspend. The yield handling moves entirely into thread. The yielded AgentPhase goes away.

Today `Agent` special-cases one tool by name. `runLoop` (agent.ts, the `yieldRequest` block) scans the requested tools for `yield_to_parent`, never executes it, answers it and every sibling itself, and returns `TurnResult { type: "yielded" }`. It also owns the post-yield state: `AgentPhase { type: "yielded"; response; value; tornDown }`, `markYieldAccepted`, the `tornDown` guard in `send`, and the `yielded` early-return in `abort`. `Thread` then re-reads that phase in `lastResult()`, and several view sites read it directly.

The structured-result split (58f7d98b1) already did half the work: `ToolStructuredResult` never reaches the agent. `Thread.invokeTool` runs the tool, records `structuredResult` into `Thread.structuredToolResults`, and hands the agent a wire-only `ToolInvocation`. So the thread already has a per-tool observation point that the agent cannot see — which is exactly where yield detection belongs.

Key entities:

- `Agent` (`node/core/src/agent.ts`) — turn loop, `AgentPhase`, `TurnResult` handling, `markYieldAccepted`.
- `Thread` (`node/core/src/thread.ts`) — `invokeTool` (tool construction + structured-result stripping), `agentHooks()`, `runToRest`, `resolveYield`, `settleResult`/`ThreadResult`.
- `yield_to_parent` (`node/core/src/tools/yield-to-parent.ts`) — already has a real `execute` that resolves immediately with the result text and `structuredResult: { toolName: "yield_to_parent" }`. Currently dead code on the agent path.
- `tool-types.ts` — `ExecutedToolResult` (thread-side, carries `structuredResult`), `ToolInvocation` (agent-side, wire only), `structuredResultFor` narrowing helper.
- `SuspendReason` (`node/core/src/thread-supervisor.ts`) — closed union, `CompactSuspendReason | PlainStopSuspendReason`; `Agent` treats it as opaque.
- `YieldValue`, `renderYieldValue`, `SendResult`, `ThreadResult`, `YieldHook`, `AgentHooks`/`ThreadHooks` (`node/core/src/thread-api.ts`).
- `TurnResult` (`node/core/src/providers/provider-types.ts`).
- Consumers of the yielded phase: `node/chat/thread-view.ts` (`renderStatus`, `renderTurnResult`), `node/chat/chat.ts` (child-abort fan-out ~264, `threadNeedsAttention` ~967, `getThreadSummary` ~1549).

# Design

`yield_to_parent` becomes an ordinary tool: it executes like any other, its result is written to the log like any other, and its siblings in the same request run normally instead of being force-failed. What the agent learns is not "a tool called yield" but "my owner wants this turn to stop, and here is an opaque reason" — the same currency auto-compaction already stops a turn in.

The agent's tool step gains that as its return: `executeTools` can come back `{ type: "suspend", results, reason }`. `runLoop` writes the results as it always does — the log stays well-formed, every `tool_use` answered — and then returns `TurnResult { type: "suspended", reason }` instead of looping into a continuation. The reason is opaque to the agent, exactly as it is on the `onBeforeRequest` path.

The reason is composed by `Thread`, in its `onToolResults` hook — the point the agent already consults once every tool has settled, now with a return value: a `SuspendReason` or nothing. The hook walks the ids in `results`, looks each one up in `structuredToolResults` (which `invokeTool` has already populated), and when `structuredResultFor(structured, "yield_to_parent")` matches, builds the `YieldValue` from the input the structured result carries — `structured` when the thread has a `context.yieldSchema`, `text` otherwise — and returns `{ kind: "yield", value }`.

Nothing is stashed. The yield value travels inside the reason, through the agent's opaque suspend channel, and comes back out at the end of the turn; there is no thread-side field to keep in step with the turn, and no window for an abort or a failure to land in. Narrowing on the structured result rather than on `request.toolName` also means the hook only fires for a call that actually succeeded, and keeps the "tools publish thread-visible facts through `structuredResult`" convention.

So the suspend travels with the tool results, in the same step that produced it. That surfaces as `SendResult { type: "suspended" }` in `Thread.runToRest`, which narrows on `reason.kind === "yield"` and runs the existing `resolveYield` unchanged.

The post-yield state moves off `AgentPhase` onto `Thread` as `yieldState: { value; response; tornDown } | undefined`. The yield already settles in `Thread` (`settleResult`/`ThreadResult`); this puts the same fact in one place instead of two.

**Alternatives considered.** Deferring the suspension to the *next* `onBeforeRequest` hook, so no agent signature changes at all: rejected — that hook belongs to a request that is never issued, and getting the reason there would mean parking it on the thread across a loop iteration, which is the state machine this design exists to avoid.

## Interfaces

`node/core/src/thread-supervisor.ts`:

```ts
export type SuspendReason =
  | CompactSuspendReason
  | PlainStopSuspendReason
  | YieldSuspendReason;

/** The model called yield_to_parent and its result is in the log. Produced
 * only by Thread's own yield gate and consumed only by Thread's turn loop —
 * it never escapes to an owner. */
export type YieldSuspendReason = { kind: "yield"; value: YieldValue };
```

`node/core/src/thread-api.ts` — `ToolResultsHook` stops being fire-and-forget:

```ts
/** Every requested tool has settled and its results are about to be written.
 * The results are already final — a hook cannot change them — but it may stop
 * the turn here, over a well-formed log. The first `suspend` wins. */
export type ToolResultsHook = (results: ToolResults) => SuspendReason | undefined;
```

`node/core/src/agent.ts` — `ToolOutcome` gains a variant, and `executeTools` produces it from the hook results:

```ts
export type ToolOutcome =
  | { type: "continue"; results: ToolResults }
  | { type: "suspend"; results: ToolResults; reason: SuspendReason }
  | { type: "aborted"; results: ToolResults };
```
`node/core/src/providers/provider-types.ts` — `TurnResult` loses `| { type: "yielded"; value: YieldValue }`.

`node/core/src/agent.ts` — `AgentPhase` loses the `yielded` variant; `markYieldAccepted`, the `yieldRequest` block in `runLoop`, and the `yielded`/`tornDown` guards in `send` and `abort` are all deleted.

`node/core/src/thread.ts`:

```ts
type YieldState = { value: YieldValue; response: string; tornDown: boolean };
private yieldState: YieldState | undefined;
get yielded(): YieldState | undefined;
```

`Thread.send` rejects when `this.yieldState?.tornDown` (guard moved off `Agent.send`). `Thread.abort` returns early when `this.yieldState` is set. `lastResult()` reads `this.yieldState` instead of `phase.type === "yielded"`. `resolveYield`'s accept branch sets `yieldState` instead of calling `agent.markYieldAccepted`.

`node/chat/thread-view.ts` — `renderStatus` takes an extra `yielded: YieldState | undefined` parameter instead of reading it off `AgentPhase`; `renderTurnResult` drops its `yielded` case.

`node/core/src/tools/yield-to-parent.ts` — its wire result becomes a bare acknowledgement (`"Yield acknowledged."`) rather than an echo of the yielded text: the model just wrote that text, and sending it back only spends tokens. The value the thread needs travels thread-side, on the structured result, which the model never sees:

```ts
export type StructuredResult = { toolName: "yield_to_parent"; input: Input };
```

## Invariants

- The log must never carry an unanswered `tool_use`. Now trivially satisfied: every requested tool, `yield_to_parent` included, actually runs and gets a result.
- `SendResult { type: "yielded" }` is still what `Thread.send` hands back and what `settleResult` resolves `ThreadResult` with. The public surface does not change.
- A `{ kind: "yield" }` suspension must never leave `Thread.runToRest`. `runSubmission` (`compaction/index.ts`) converts unrecognised suspensions to `{ type: "completed" }`, which would silently swallow a yield.
- The hook only inspects the ids present in the `results` it is handed, so the `structuredToolResults` a cloned thread inherits — which includes an earlier yield's entry — can never re-fire it.
- An abort wins over a suspension raised in the same tool step: `executeTools` already returns `aborted` when `abortRequested` is set, and that check stays ahead of the suspend.

## Behaviour changes to accept

- Sibling tools requested alongside `yield_to_parent` now execute instead of receiving `"The thread yielded so this tool was skipped."`.
- The yield tool's own result in the log is a bare `"Yield acknowledged."` rather than `"Yield accepted. Your result has been sent to the parent thread."` — and, unlike the tool's current (unreachable) `execute`, it does not echo the yielded text back.
- A **rejected** yield (`YieldHook` returning `reject`) now arrives as a follow-up system message after the tool result, rather than replacing that result. The `YieldHook` comment in `thread-api.ts` claims the opposite today and must be updated.

# Stages

## Open the suspend reason

- Goal: `SuspendReason` has a `yield` kind carrying a `YieldValue`, and `yield_to_parent`'s `StructuredResult` carries the call's input. Nothing consumes either yet; the agent's special case is still in place.
- Tests:
  - `yield-to-parent.test.ts`: executing the tool publishes a structured result carrying the input verbatim — for both the plain `{ result }` shape and an arbitrary schema'd object — while its wire result contains only the acknowledgement, not the yielded text.
  - `npx tsc -b` passes — the new kind must be handled, or explicitly ignored, at every existing narrowing site, which is how we find them all. `compaction/index.ts`'s `runSubmission` and `node/chat/thread.ts`'s suspension display are the two that matter.

## Suspend from the tool step

- Goal: the yield flows tool execution -> `onToolResults` returning a `{ kind: "yield" }` reason -> `ToolOutcome.suspend` -> `TurnResult.suspended` -> `runToRest.resolveYield`. `Agent.runLoop`'s `yieldRequest` block and `TurnResult.yielded` are gone. `AgentPhase.yielded` still exists, set by `Thread` through a temporary shim, so the view layer stays untouched this stage.
- Tests:
  - A subagent calling `yield_to_parent` still resolves `send()` with `{ type: "yielded", value: { type: "text", ... } }`, and with a `structured` value when the thread has a `yieldSchema` (the existing `agent.test.ts` yield tests, with only their phase assertions adjusted).
  - After a yield the log contains a real tool result for `yield_to_parent` and **no further provider request is issued** — assert on `mockClient` stream count, since "did the loop actually stop" is the real risk of routing through `suspend`.
  - A request containing `yield_to_parent` alongside another tool: the other tool runs to completion and its real result is in the log.
  - An `onYield` hook returning `reject` goes back in as a follow-up submission and the loop continues — `thread.test.ts`'s async-queue-protection test must keep passing unchanged, since it is what actually constrains this ordering.
  - An `AutoCompactSupervisor` over threshold on the same turn as a yield: the yield wins, since the compaction gate belongs to a request that is never issued.
  - A `yield_to_parent` call that fails (invalid input) publishes no structured result, so no suspension is raised and the turn continues with the error result.

## Delete the yielded phase

- Goal: `AgentPhase.yielded`, `markYieldAccepted`, and the agent's yield guards are gone; `Thread.yieldState` is the single home, read by `lastResult()`, `Thread.send`, and `Thread.abort`.
- Tests:
  - `abort` after a yield is a no-op and leaves the yielded result in place (the existing `agent.test.ts` abort-on-yielded tests, relocated to the thread level).
  - `send` after an accepted (torn-down) yield rejects.
  - `lastResult()` reports `yielded` once the thread has settled.

## View layer

- Goal: `renderStatus`, `getThreadSummary`, `threadNeedsAttention`, and `chat.ts`'s child-abort fan-out read the thread's yield state.
- Tests:
  - The existing spawn-subagents UI test (`toggles yielded text with = key on multi-agent result`) passes unchanged — it exercises the whole path from a subagent's yield to the parent's rendered tool result.
  - A yielded thread's status line still renders `↗️ yielded to parent: ...` and its summary still shows `✅ yielded`.
  - `threadNeedsAttention` is false for a yielded thread.
