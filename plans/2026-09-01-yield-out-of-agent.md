# Objective and Context

> I changed my mind about how the agent should interact with yield. I think the agent shouldn't know anything about the tools that it runs. From its POV, it should just execute a tool, and get a result back, along with a suspend. The yield handling moves entirely into thread. The yielded AgentPhase goes away.

Today `Agent` special-cases one tool by name. `runLoop` (agent.ts, the `yieldRequest` block) scans the requested tools for `yield_to_parent`, never executes it, answers it and every sibling itself, and returns `TurnResult { type: "yielded" }`. It also owns the post-yield state: `AgentPhase { type: "yielded"; response; value; tornDown }`, `markYieldAccepted`, the `tornDown` guard in `send`, and the `yielded` early-return in `abort`. `Thread` then re-reads that phase in `lastResult()`, and three view sites read it directly.

Key entities:

- `Agent` (`node/core/src/agent.ts`) — turn loop, `AgentPhase`, `TurnResult` handling, `markYieldAccepted`.
- `Thread` (`node/core/src/thread.ts`) — owns tool construction (`invokeTool`), the hook arrays (`agentHooks()`), `runToRest`, `resolveYield`, `structuredToolResults`, `settleResult`/`ThreadResult`.
- `yield_to_parent` tool (`node/core/src/tools/yield-to-parent.ts`) — already has a real `execute` that resolves immediately with the result text and `structuredResult: { toolName: "yield_to_parent" }`. It is currently dead code on the agent path.
- `SuspendReason` (`node/core/src/thread-supervisor.ts`) — closed union, `CompactSuspendReason | PlainStopSuspendReason`; `Agent` treats it as opaque.
- `YieldValue`, `renderYieldValue`, `SendResult`, `ThreadResult`, `YieldHook`, `AgentHooks`/`ThreadHooks` (`node/core/src/thread-api.ts`).
- `TurnResult` (`node/core/src/providers/provider-types.ts`).
- Consumers of the yielded phase: `node/chat/thread-view.ts` (`renderStatus`), `node/chat/chat.ts` (child-abort fan-out, `threadNeedsAttention`, `getThreadSummary`), `node/render-tools/spawn-subagents.ts` (renders `ThreadResult`, unaffected).

# Design

The agent already has a generic way for its owner to stop a turn before the next request: an `onBeforeRequest` hook returning `{ type: "suspend", reason }`. And it already has a generic way for the owner to observe what the tools produced: `onToolResults`. Yield is expressible as exactly that pair, so no new agent machinery is needed — only deletion.

`yield_to_parent` becomes an ordinary tool. It executes like any other, its result is written to the log like any other, and its siblings in the same request execute normally instead of being force-failed. Its `structuredResult` carries the raw input, so the owner can reconstruct the `YieldValue`.

`Thread` installs a **yield gate** — one `onToolResults` entry and one `onBeforeRequest` entry, prepended in `agentHooks()`:

- `onToolResults`: scan for a result whose `structuredResult.toolName === "yield_to_parent"`; convert its input to a `YieldValue` using the thread's own `context.yieldSchema` (structured when a schema exists, text otherwise); stash it in `pendingYield`.
- `onBeforeRequest` (first in the array, so its suspension is the one that wins): if `pendingYield` is set, consume it and suspend with `{ kind: "yield", value }`.

The agent therefore does what it does for compaction: writes the tool results, comes back around the loop, gets suspended at the gate, and returns `TurnResult { type: "suspended" }` with a log that is coherent and resumable. `SendResult { type: "suspended" }` reaches `Thread.runToRest`, which narrows on `reason.kind === "yield"` and runs the existing `resolveYield` unchanged.

The post-yield state moves off `AgentPhase` and onto `Thread` as `yieldState: { value; response; tornDown } | undefined`. `Thread` is where the yield already settles (`settleResult`, `ThreadResult`), so this is the same information in one place rather than two.

**Alternative considered:** giving `ToolOutcome` a third variant so an executor can tell the loop "stop here". Rejected: the agent's executor is `Thread`'s (`createTool`/`invokeTool`), but the *decision* would still have to be expressed to the loop as a new agent-level concept, when `suspend` already is that concept. Reusing `suspend` also means the yield gets the same coherent-log guarantees compaction already relies on, for free.

## Interfaces

`node/core/src/tools/yield-to-parent.ts`:

```ts
export type StructuredResult = { toolName: "yield_to_parent"; input: Input };
```

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

`node/core/src/providers/provider-types.ts` — `TurnResult` loses `| { type: "yielded"; value: YieldValue }`.

`node/core/src/agent.ts` — `AgentPhase` loses the `yielded` variant; `markYieldAccepted` is deleted; the `yieldRequest` block in `runLoop` is deleted; the `yielded` guards in `send` and `abort` are deleted.

`node/core/src/thread.ts`:

```ts
type YieldState = { value: YieldValue; response: string; tornDown: boolean };
get yielded(): YieldState | undefined;
```

`Thread.send` rejects when `this.yieldState?.tornDown` (the guard moved off `Agent.send`). `Thread.abort` returns early when `this.yieldState` is set. `lastResult()` reads `this.yieldState` instead of `phase.type === "yielded"`.

`node/chat/thread-view.ts` — `renderStatus` takes an extra `yielded: YieldState | undefined` parameter instead of reading it off `AgentPhase`. `renderTurnResult` drops its `yielded` case.

## Invariants

- The log must never carry an unanswered `tool_use`. Now trivially satisfied: every requested tool, including `yield_to_parent`, actually runs and gets a result.
- `SendResult { type: "yielded" }` is still what `Thread.send` hands back to a caller and what `settleResult` resolves `ThreadResult` with — the public surface is unchanged.
- A `{ kind: "yield" }` suspension must never leave `Thread.runToRest`. `runSubmission` (`compaction/index.ts`) turns unknown suspensions into `{ type: "completed" }`, which would silently swallow a yield.
- `pendingYield` must be cleared when consumed, on `reset()` (compaction), and at the start of each `send`, so a yield can never be replayed onto a later request.
- The gate's `onBeforeRequest` entry must come before the supervisors' in `agentHooks()`: first suspension wins, and a yield must beat an auto-compaction that happens to trip on the same request.
- A yield reached through the abort path (abort landing between the tool results and the gate) must not resurrect: `abort` wins, `pendingYield` is dropped.
- `structuredToolResults` still records the yield tool's structured payload for rendering; the gate reads the results map, not that cache, so a cloned thread does not re-fire it.

## Behaviour changes to accept

- Sibling tools requested alongside `yield_to_parent` now execute instead of getting `"The thread yielded so this tool was skipped."`.
- The yield tool's own result in the log is its result text, not `"Yield accepted. Your result has been sent to the parent thread."`.
- A **rejected** yield (`YieldHook` returning `reject`) now arrives as a follow-up system message after the tool result, rather than replacing that result. The comment on `YieldHook` in `thread-api.ts` says the opposite today and must be updated.

# Stages

## Plumbing: carry the yield input and open the suspend reason

- Goal: `yield_to_parent`'s `StructuredResult` carries its `input`, and `SuspendReason` has a `yield` kind. Nothing consumes either yet; the agent's special case is still in place.
- Tests:
  - `yield-to-parent.test.ts`: executing the tool produces a result whose `structuredResult` carries the input verbatim, for both the plain `{ result }` shape and an arbitrary schema'd object.
  - `npx tsc -b` passes — the new `SuspendReason` kind must be handled (or explicitly ignored) at every existing narrowing site, which is how we find them all.

## Move the decision: Thread's yield gate

- Goal: the yield flows tool result -> `onToolResults` -> `onBeforeRequest` suspend -> `runToRest`. `Agent.runLoop`'s `yieldRequest` block and `TurnResult.yielded` are gone. `AgentPhase.yielded` still exists, set by `Thread` via a temporary shim, so the view layer is untouched in this stage.
- Tests:
  - A subagent that calls `yield_to_parent` still resolves `send()` with `{ type: "yielded", value: { type: "text", ... } }`, and with a `structured` value when the thread has a `yieldSchema` (the existing `agent.test.ts` yield tests, which should keep passing with only their phase assertions adjusted).
  - The log after a yield contains the tool result for `yield_to_parent`, and no further provider request is issued — assert on `mockClient` stream count, since "did the loop stop" is the real risk.
  - A request containing `yield_to_parent` *and* another tool: the other tool runs to completion and its real result is in the log.
  - An `onYield` hook returning `reject` puts the rejection in as a follow-up submission and the loop continues — `thread.test.ts`'s async-queue-protection test must still pass unchanged, since that is the integration that actually constrains ordering.
  - An `AutoCompactSupervisor` over threshold on the same request as a yield: the yield wins.

## Delete the yielded phase

- Goal: `AgentPhase.yielded`, `markYieldAccepted`, and the agent's `tornDown`/`yielded` guards are gone; `Thread.yieldState` is the single home, and `lastResult()`, `Thread.send`, `Thread.abort` read it.
- Tests:
  - `abort` after a yield is a no-op and leaves the yielded result in place (the existing `agent.test.ts` abort-on-yielded tests, relocated to the thread level).
  - `send` after an accepted (torn-down) yield rejects.
  - `lastResult()` reports `yielded` after the thread settles.

## View layer

- Goal: `renderStatus`, `getThreadSummary`, `threadNeedsAttention`, and the child-abort fan-out in `chat.ts` read the thread's yield state.
- Tests:
  - The existing spawn-subagents UI test (`toggles yielded text with = key on multi-agent result`) passes unchanged — it exercises the whole path from a subagent's yield to the parent's rendered tool result.
  - A yielded thread's status line still renders `↗️ yielded to parent: ...` and its summary still shows `✅ yielded`.
  - `threadNeedsAttention` is false for a yielded thread.
