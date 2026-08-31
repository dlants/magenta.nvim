# Objective and Context

> I'm thinking that runTurn / runLoop are extremely similar here, and are sort of provider agnostic logic. And putting these in the runner means that we have to pipe hooks into the runner.
>
> Instead, I think maybe we just pull that out?
>
> I think then the runner is no longer a "runner" per se... in particular, I think the idle/streaming/running_tools state leaves the runner, and the loop does too.
>
> What remains is an interface for dealing with the context - native messages, machinery to convert them to providerMessages, the log, and the ability to send a single request to the provider. The entire state is "is there a request in flight?". The rest moves up to the agent. So maybe `NativeContextManager`?
>
> [...] the streaming all stays in the context manager. I think when the agent triggers a provider request, it gets a promise for completion, but it should also pass along a streaming callback that the inference manager reports streaming results on.

## Entities

- `Runner` (`provider-types.ts:342`) — the interface implemented by both runners today: `phase`, `log`, `runTurn`, `appendUserMessage`, `abort`, `getNativeMessageIdx`, `truncateMessages`, `clone(hooks)`.
- `RunnerHooks` (`provider-types.ts:359`) — `{ executeTools, onUpdate, onBeforeRequest? }`. Piped into the runner today; this is what the refactor eliminates from the provider layer.
- `AgentOptions` (`provider-types.ts:365`) — inference config (`model`, `systemPrompt`, `tools`, `thinking`, `reasoning`, `skipPostFlightTokenCount`) _plus_ the three hooks, mixed into one bag.
- `AgentPhase` (`provider-types.ts:314`) — `idle | streaming | running_tools{requested, truncated} | aborting`. Owned by the runner today; moves up.
- `ThreadMode` (`agent.ts:93`) — `normal | tool_use{activeTools} | yielded{response, value, tornDown?}`, on `ThreadState.mode`. The agent's own state representation, and largely the same fact as `AgentPhase`. Not persisted; only ever constructed as `normal` in `thread.ts:134`.
- `StreamingBlock` (`provider-types.ts:297`) — the already-generalized `text | thinking | tool_use` union. `AnthropicStreamingBlock` / `OpenAIStreamingBlock` are the native counterparts and must not escape.
- `TurnResult`, `ToolOutcome`, `ToolResults`, `RequestedTool`, `BeforeRequestDecision`, `AgentLog` — unchanged.
- `Provider.createAgent(options: AgentOptions): Runner` (`provider-types.ts:229`) — the construction seam.

## Files

- `node/core/src/providers/provider-types.ts` — all the shared types above.
- `node/core/src/providers/anthropic-runner.ts` — `AnthropicRunner`; ~1380 lines, of which the loop/retry/phase machinery is the part being extracted.
- `node/core/src/providers/openai-runner.ts` — `OpenAIRunner`; same loop, near-verbatim.
- `node/core/src/agent.ts` — owns hooks, `executeTools`, `onBeforeRequest`, and consumes `runner.phase` / `runner.log`.
- `node/core/src/thread.ts` — constructs `Agent` with `runnerInit: {type:"new"} | {type:"cloned", cloneFrom, truncateTo}`.
- `node/core/src/providers/anthropic.ts` / `openai.ts` — providers; `forceToolUse` takes `contextAgent?: Runner` purely to read prior context — it issues one request and returns one tool invocation, never feeding results back. It only ever needed the conversation, so it becomes `context?: NativeInferenceManager`.
- `node/providers/mock.ts` — root-layer mock provider implementing `createAgent`.
- `node/chat/thread.ts`, `node/chat/thread-view.ts` — root layer; read `phase` for rendering.

# Design

Split each runner along the line the user drew:

- **`NativeInferenceManager`** (provider-specific) — owns the native message array, the native→`ProviderMessage` conversion, the `AgentLog`, and _one_ provider request at a time including all stream accumulation. Its entire externally-visible state is "is a request in flight". It reports streaming progress through a per-request callback, normalized to `StreamingBlock`.
- **`Agent`** — absorbs the loop: the before-request gate, placement of pending input, the abort checks at each boundary, `executeTools`, the 1s ticker, and `AgentPhase`.

The `Runner` interface and `RunnerHooks` are deleted. `Agent` holds a `NativeInferenceManager` instead of a `Runner` and calls it directly; there is no indirection and no hooks object, because the loop and the executor now live in the same class. This is the whole point: the hooks existed only to reach back from the provider layer into `Agent`.

## Why a per-request callback rather than an emitter

The callback's lifetime is exactly the request's, so `Agent` never subscribes/unsubscribes and `phase.streaming` cannot outlive or lag the request it describes. It fires on every content event; `Agent` stamps `lastEventTime` on each — the same three events that set `lastEventTime` today — and mirrors the block into `phase`, clearing it on `block-finished`.

This is the manager's only outbound channel: `onUpdate` disappears from `AgentOptions` and from provider code entirely. The other current `notify()` sites (`appendUserMessage`, `appendToolResults`, `truncateMessages`) are all called *by* `Agent`, which notifies at the call site instead; `countTokensPostFlight` resolves a promise rather than notifying.
## Division of the provider-specific residue

The loop's remaining provider-specific behaviour is small and becomes methods on the manager:

- retryability predicate and the backoff budget → stay inside `sendRequest`. Retrying is part of making one request happen, not part of the turn loop, so `RequestResult.error` means *permanently* failed. The shared `RETRY_DELAYS` / `MAX_RETRY_DURATION` / `getRetryDelay` helpers are used by both managers.
- unwinding a failed attempt (`{type:"reset-attempt"}` in both) → also internal to `sendRequest`, since nothing outside it can observe an attempt.
- leaving history well-formed after abort/error (anthropic `cleanup(reason)`, openai `commitAssistantMessage("aborted")` + `dropDanglingToolUses`) → `finalize(reason)`.
- the abort marker append → `Agent` calls `appendUserMessage([ABORT_MARKER_TEXT])`, which both already do identically.
- anthropic's `countTokensPostFlight` → becomes an optional `countTokens()` on the manager, issued *before* a request rather than after it (see below).
- `appendToolResults` stays on the manager: anthropic's one-message-per-result vs openai's coalescing is genuine wire shape.

## Interfaces

```ts
export type RequestResult =
  | {
      type: "completed";
      stopReason: StreamStopReason;
      /** tool_use blocks accumulated during this request. */
      requested: RequestedTool[];
    }
  | { type: "aborted" }
  | { type: "error"; error: Error };

/** What the manager reports while a request is in flight. Deliberately
 * narrow: the finished content is read off `log.messages`, so completion
 * only needs to say that it happened. */
export type RequestUpdate =
  | { type: "streaming-block"; streamingBlock: StreamingBlock }
  | { type: "block-finished" }
  /** A retryable failure; the manager is backing off and will try again.
   * `undefined` when a fresh attempt starts, which clears the countdown. */
  | { type: "retry"; retry: RetryStatus | undefined };

export type OnUpdate = (update: RequestUpdate) => void;

export interface NativeInferenceManager {
  readonly log: AgentLog;

  appendUserMessage(content: AgentInput[], opts?: { coalesce?: true }): void;
  appendToolResults(
    requested: ReadonlyArray<RequestedTool>,
    results: ToolResults,
  ): void;
  getNativeMessageIdx(): NativeMessageIdx;
  truncateMessages(messageIdx: NativeMessageIdx): void;
  clone(): NativeInferenceManager;

  /** Count the conversation as it would be sent right now. Only providers
   * that support it implement this. */
  countTokens?(): Promise<number>;
  sendRequest(onUpdate: OnUpdate): Promise<RequestResult>;
  abort(): void;

  // Leave the history in a shape the provider will accept: no dangling tool_ues or thinking blocks, etc...
  finalize(reason: { type: "aborted" } | { type: "error"; error: Error }): void;
}
```

`Agent` gains the loop's state and methods (all private except `phase`):

```ts
class Agent {
  private manager: NativeInferenceManager;
  phase: AgentPhase;                       // was runner.phase + state.mode
  private turnInFlight: boolean;
  private tickInterval: ReturnType<typeof setInterval> | undefined;

  private runLoop(input: AgentInput[]): Promise<TurnResult>;
  private streamOneResponse(): Promise<RequestResult>;
  private finishTurnAbort(): TurnResult;
}
```

`Agent.abortRequested` already exists and subsumes the runners' duplicate flag; `Agent.currentTurn` subsumes `turnInFlight`. `executeTools` is called directly rather than through a hook, and `onBeforeRequest`/`composeBeforeRequest` stay exactly where they are — the gate is simply called from `runLoop` now.

## Hooks become an array, and the preflight token count

`AgentHooks` becomes one array per hook point, each with its own type — there is no shared `Hook`, since the points answer different questions:

```ts
export type BeforeRequestHook = {
  /** Read without invoking, so `Agent` knows whether to count first. */
  requestPreflightTokenCount?: boolean;
  run(ctx: AgentRequestContext): Promise<RequestAction>;
};

export type AgentHooks = {
  onBeforeRequest: BeforeRequestHook[];
  onToolResults: ToolResultsHook[];
  onYield: YieldHook[];
};
```

`Agent` iterates each array and applies that point's composition rule — the rules `combineSupervisors` (`thread-supervisor.ts:110`) applies today, which differ per point: for `onBeforeRequest` every injection is applied and the first `suspend` wins; for `onYield` the first `accept`/`reject` wins and `send-message` texts concatenate.

`onToolApplied` is not among them. It is not a turn-loop question: it fires from inside a file-touching tool (`edl.ts:100`, `getFile.ts:301`), per file, and its only consumer is `file-context-supervisor`. The owner already supplies the rest of the tool-execution machinery on `AgentContext` (`fileIO`, `shell`, `contextTracker`), and owns the `ContextManager`, so it passes `onToolApplied` there and routes it itself. `Agent` still wraps it to keep its own `editedFilesThisTurn` bookkeeping (`agent.ts:491`); only the supervisor fan-out leaves.

`Agent` never learns what a `Supervisor` is. The owner flattens its supervisor list into these arrays at registration — one supervisor contributes an entry to each point it implements — and the two contributions `Thread.beforeRequest` (`thread.ts:532`) currently bolts on afterwards become entries in `onBeforeRequest` like any other:

- the system reminder, registered last so it still sits immediately before the user's own content;
- the mid-turn queue flush, which is the one that needs the before-request action type to carry `submissions`. It also wants `isOpeningRequest`, which is `Agent`'s own knowledge and is currently handed down to `Thread` solely so `Thread` can hand a decision back up.

The only consumer of `inputTokenCount` is the compaction supervisor, and it needs it at exactly one moment: when `onBeforeRequest` runs. With the array in `Agent`, the count can be issued lazily and exactly once, without any aggregation:

- walking `onBeforeRequest`, `Agent` awaits `manager.countTokens?.()` immediately before the first entry whose `requestPreflightTokenCount` is set, memoizes the result for the rest of the request, and puts the *number* on `AgentRequestContext`. Hooks stay synchronous in their use of it.

Consequences: no count when nobody asks; none for a turn that never reaches the gate; none when an earlier hook suspends first; and retries don't re-count, since the gate is not re-fired on retry.  `skipPostFlightTokenCount` becomes unnecessary — not declaring the flag is the opt-out.

`AgentLog.inputTokenCount` therefore stops being the manager's state: `Agent` keeps the most recent preflight count and serves `Agent.inputTokenCount` (read by the view) from there.

## Streaming pathway

The value is pulled, not pushed: only "something changed" travels, and the block itself is read off `phase` at render time. That stays true; only the top of the chain changes owner.

1. SSE event arrives in the manager. It accumulates into its *native* block, then constructs a `StreamingBlock` and reports `{type: "streaming-block", streamingBlock}`. When the block closes it reports `{type: "block-finished"}` and the finished content is available on `log.messages`.
2. `Agent`'s handler stamps `phase.lastEventTime`, sets or clears `phase.block`, and calls `scheduleUpdate()` (the existing 32ms throttle).3. `scheduleUpdate` → `deps.onUpdate` → core `Thread`'s update → `NvimThread`'s `core.on("update")` → `dispatch({type:"tool-progress"})` → root re-render.
4. The view reads `thread.core.phase`, which derives `ThreadPhase`/`TurnActivity` on read (`thread.ts:218`), and renders `activity.streaming.block`.

Step 4 is where the `ThreadMode` merge pays off a second time: `TurnActivity` currently has both `running_tools` and `awaiting_tools`, the latter existing only because "the runner has handed the turn off and is idle while the executor runs" — with one owner and `activeTools` on `running_tools`, those two variants collapse into one.

## Collapsing `ThreadMode` into `AgentPhase`

`mode: "tool_use"` and `phase: "running_tools"` are the same instant described twice: the runner sets `running_tools` immediately before calling `executeTools`, and `executeTools` sets `mode.tool_use` as its first act. They are kept in sync purely by convention, and `thread.ts`'s `get phase()` already has to read both to produce one `ThreadPhase`. Once the loop is inside `Agent`, keeping both is indefensible.

```ts
/** The intra-turn detail. Both variants describe a turn in progress; which
 * one it is says whether a request is in flight. */
export type TurnActivity =
  | {
      type: "streaming";
      /** Of this request, not of the turn: a retry restarts it. */
      startedAt: Date;
      /** Most recent sign of life from the server; drives the dead-air
       * "waiting Ns" counter. */
      lastEventTime: Date;
      block: StreamingBlock | undefined;
      /** Set while the manager is backing off between attempts. */
      retry: RetryStatus | undefined;
    }
  | {
      type: "running_tools";
      /** As the model asked for them, including malformed requests that never
       * became an `activeTools` entry. */
      requested: ReadonlyArray<RequestedTool>;
      /** the turn was cut short by the output token limit mid-tool-use */
      truncated: boolean;
      activeTools: Map<ToolRequestId, ActiveToolEntry>;
    }
  /** Unwinding: the tools have been told to stop and the history is being
   * left well-formed. Only reachable from a turn in flight. */
  | { type: "aborting" };

export type AgentPhase =
  | { type: "idle" }
  | { type: "running"; activity: TurnActivity }
  /** Terminal. The model called `yield_to_parent` and the supervisors
   * accepted; the thread never leaves this state. */
  | {
      type: "yielded";
      response: string;
      value: YieldValue;
      tornDown?: boolean;
    };
```

`running_tools` and `aborting` are details of a turn, not peers of `idle`: the top level answers "is this thread working", and `activity` answers "on what". This is `ThreadPhase`/`TurnActivity` (`thread-api.ts:36`) almost exactly, which is the point — `thread.ts`'s `get phase()` currently exists to reconcile two representations into that shape, and it collapses to adding `idle.lastResult`.

The merge:

- `running_tools` moves under a `running` variant and absorbs `activeTools: Map<ToolRequestId, ActiveToolEntry>` alongside `requested` and `truncated`. `set-active-tool-result` writes into it.
- `TurnActivity.awaiting_tools` disappears with it: it exists only because the runner goes idle while the executor runs, which is no longer true of a single owner.
- `mode: "normal"` disappears — it means "not executing tools", which is exactly `idle | streaming`.
- `yielded` becomes a phase variant. It is terminal: a yielded thread never leaves it, so `phase` being the only state is consistent. `isBusy` becomes "phase is not `idle` and not `yielded`".

This is a behaviour change in one place worth calling out: `shouldShowContextFiles` (`thread-view.ts:193`) tests `phase.idle && mode.normal`; after the merge a yielded thread is no longer `idle`, so context files stop showing for it. That looks like the intended behaviour rather than a regression, but it should be a deliberate choice.

`AgentOptions` loses its three hook fields and becomes `InferenceOptions` (model, systemPrompt, tools, thinking, reasoning, skipPostFlightTokenCount). `Provider.createAgent` becomes `createInferenceManager(options: InferenceOptions): NativeInferenceManager`.

## Invariants

- Nothing native escapes the manager. In particular `syncStreamingBlock` in the anthropic runner currently assigns the _native_ block object onto `phase.block` and relies on structural compatibility; the extracted version must construct a `StreamingBlock` explicitly, as the openai one does.
- Every `tool_use` is answered by exactly one result block, including ids the executor omitted and including the abort/error paths. Currently guaranteed by `appendToolResults` + `cleanup`; must remain guaranteed after the split.
- The token count is preflight and deterministic at the point of use. Today it is post-flight and fire-and-forget, so `composeBeforeRequest` can hand the auto-compact supervisor a count from the *previous* request, or none at all on the first. After the change, a supervisor that needs it always sees the count for the conversation it is actually deciding about.
- Retries are invisible to the loop: they stay inside one `sendRequest` and inside the `streaming` phase, and never surface as a phase transition or as a `TurnResult`. `Agent` learns about them only through `{type:"retry"}`, which it mirrors onto `phase.retry` for the countdown.
- `TurnResult.failed.retryable` loses its meaning once the budget is spent inside `sendRequest`, and has no production consumer today — only test assertions. Drop it.
- Auth refresh (anthropic) retries immediately and independently of the 429/529 budget. It lives inside `sendRequest`, so `Agent`'s retry loop never sees it.
- An abort landing between two awaits unwinds exactly once. The single `abortRequested` flag lives on `Agent`; the manager's `abort()` only cancels the in-flight request.
- A second turn cannot start while one is in flight; `abort()` before a turn starts is a no-op. `Agent.isBusy` / `Agent.currentTurn` are the existing witnesses and must keep their meaning.
- `openingRequestPending` / injection ordering in `Agent.onBeforeRequest` is unchanged — the gate is called at the same point in the loop, before pending input is appended.
- The ticker fires ~1/s only while a turn is in flight, and is cleared on every exit path.
- `clone()` drops `onBeforeRequest` and half-finished tool calls; the cloned conversation must still be well-formed.

# Stages

## Move the loop into Agent, against Anthropic — DONE

Implemented as described: `Agent` owns `phase`, the turn loop, the ticker and
the abort flag; `AnthropicRunner` is `AnthropicInferenceManager` (file rename
deferred to stage 5) with `sendRequest`/`finalize`/public `appendToolResults`
and no phase, loop or hooks. `Runner`/`RunnerHooks` are gone, `Provider.createAgent`
returns a `NativeInferenceManager`, and `TurnResult.failed.retryable` is dropped.

Deviations worth recording:

- `logExtent` is gone. The gate is now `Agent`'s own method, so it reports
  `appended` directly instead of the loop sniffing the log for a change.
- The post-flight token count stays inside `sendRequest` for now and still
  notifies through `AgentOptions.onUpdate`, which therefore survives this stage
  (as do `executeTools`/`onBeforeRequest`, now optional, read only by the
  OpenAI loop). Stage 3 makes the count preflight and stage 5 drops the rest.
- `OpenAIRunner` implements `NativeInferenceManager` (reporting streaming
  blocks and retries through the request callback) while keeping its own loop,
  phase and `runTurn` for its existing tests. `RunnerHooks` survives there as a
  local `LegacyRunnerHooks`; stage 2 deletes all of it.
- `Thread.runner` is `Thread.inferenceManager`; the root `NvimThread.agent`
  still returns the manager, and the root's `.phase` reads go through
  `getProviderStatus()`.
- Test seam: `createTestAgent`/`userInput` in `test-helpers.ts` build an `Agent`
  on a mock client, and the anthropic retry/ticker/auth-refresh suites plus the
  anthropic half of `runner-parity` now drive that. The root
  `node/providers/anthropic-runner.test.ts` keeps a small `TestAgent` harness in
  the file: those tests are about what the manager puts on the wire, and the
  harness stands in for the agent's loop rather than importing core's context.
  Loop policy is asserted against the real `Agent` in `agent.test.ts`.
- These suites need an explicit `await vi.advanceTimersByTimeAsync(0)` before
  polling for the first stream: the loop now reaches the request after a few
  awaits, and `pollUntil`'s retry runs on faked timers.
- `runTurnLoop` flushes the throttled update before its final notification, so
  a settled turn leaves nothing queued.

### Review follow-up (stage 1)

- The root `node/providers/anthropic-runner.test.ts` and its hand-written
  `TestAgent` loop are gone. The file moved to
  `node/core/src/providers/anthropic-manager.test.ts` and its `TestAgent` is now
  a thin adapter over the real `Agent` (`runTurnLoop`, `phase`, `manager.log`),
  so no test drives a second copy of the loop. It lives in core because that is
  where both the manager and `createTestAgent` are.
- `Agent.executeTools` is `protected`; `createTestAgent({ executeTools })`
  overrides it in a local subclass. That is the only test seam — production
  never replaces it, and no hook field returns to `AgentOptions`.
- `createTestAgent` also accepts `mockClient` (share a client across agents) and
  `cloneFrom` (build on a copy of an existing conversation).
- Moving to the real loop changed three things in those tests: the caller's
  content is appended *after* the gate, so a log read must first await the
  request; `onUpdate` is throttled at 32ms, so counting assertions need more
  than a microtask; and `mockClient.awaitStream()` returns the *last* stream, so
  the second request of a turn is polled by index.
- `Agent.abortAndWait` no longer calls `finishAbort()` when a turn is in flight
  without a `currentTurn` — a turn driven directly through `runTurnLoop` unwinds
  itself. Consequently `abort()` with nothing in flight still settles and
  notifies, which one test now asserts as "no request, empty log" instead of
  "no notifications".
- `agent.test.ts` covers the loop's tail directly: gate injections coalescing
  into the caller's message, a rejecting executor still answering every
  `tool_use`, an executor reporting `aborted` unwinding once, and a failed
  request finalizing then failing the turn.
- Type representation:
  - `AgentOptions` no longer carries `executeTools`/`onBeforeRequest`. The
    OpenAI legacy loop takes `LegacyRunnerHooks` as an argument to `runTurn`,
    so the runtime "legacy runLoop requires an executeTools hook" throw is gone
    and `clone()` matches the interface exactly.
  - `OpenAIRunner`'s `turnInFlight`/`requestInFlight` pair became one `activity`
    field (`idle | legacy-turn | request`).
  - `RequestUpdate`'s retry variant split into `retry-scheduled` and
    `attempt-started`; the `undefined` convention is gone.
  - `FinalizeReason` is named and exported; both managers use it.
  - `Agent.phase` is a getter over a private field.
  - The gate returns `{ decision, appended }` rather than bolting `appended`
    onto `BeforeRequestDecision`.
- `openai-runner-retry.test.ts` covers the new manager surface: a retry inside
  one `sendRequest` (with `retry-scheduled` / `attempt-started` reported), and
  an abort mid-request that leaves the runner reusable for a second request.
- `runner-parity.test.ts` documents that its two sides are driven differently
  until stage 2.


- Goal: the loop, retry budget, ticker and `AgentPhase` live in `Agent`. `AnthropicRunner` becomes `AnthropicInferenceManager` (no phase, no loop, no hooks). `Runner` / `RunnerHooks` are gone; `Agent` holds a manager. Because `Agent` changes in this stage, the openai runner has to keep working — during this stage `OpenAIRunner` is adapted to the `NativeInferenceManager` interface with its own loop code left dead/unreachable, and stage 2 deletes it.
- Tests:
  - The existing anthropic suites are the primary net: `anthropic-runner.test.ts`, `-retry`, `-ticker`, `-auth-refresh`, plus root `node/providers/anthropic-runner.test.ts`. These construct runners directly and will need to construct an `Agent` (or the manager, for the pure-context assertions) instead — splitting each file along the same seam as the code is the check that the seam is in the right place.
  - `agent.test.ts` grows the loop tests, since that is now where the loop lives: an abort arriving during `running_tools` produces exactly one `finalize({type:"aborted"})` and one abort marker; an executor that rejects still leaves every requested id answered; `suspend` from the gate returns without issuing a request.
  - The retry tests stay with the managers, where retry stays: `anthropic-runner-retry.test.ts` / `openai-runner-retry.test.ts` should need only mechanical changes, plus an assertion that a retried request emits `{type:"retry"}` and clears it on the next attempt, and that `Agent` never re-enters the gate across a retry.
  - Assert `phase.block` is not reference-identical to the manager's internal block (the aliasing invariant).

## Convert OpenAI — DONE

Done. `OpenAIRunner` is `OpenAIInferenceManager` (file rename still deferred to
stage 6): the loop, `runLoop`, `finishAbort`, `logExtent`, the ticker, the
`AgentPhase` field and `LegacyRunnerHooks` are all deleted, and `activity`
collapsed to a single `requestInFlight` boolean. Both providers are now driven
by `Agent`'s one loop.

Notes and deviations:

- `syncStreamingBlock` no longer writes a phase; it constructs a fresh
  `StreamingBlock` and reports it through the request callback, and returns
  early when no request is in flight. The retry loop reports only
  `attempt-started` / `retry-scheduled`.
- `notify()` (and therefore `AgentOptions.onUpdate`) survives in the manager
  alongside `Agent.scheduleUpdate`, exactly as it does in the anthropic
  manager. Stage 5 drops both together.
- Test seam: `test-helpers.ts` grew `createTestOpenAIAgent`, which builds a real
  `Agent` over an `OpenAIInferenceManager` on a `MockOpenAIClient`.
  `createTestAgent` and it now share a `buildTestAgent(provider, opts)` and a
  common `TestAgentOpts` (`onUpdate`, `getHooks`, `context`, `executeTools`,
  `cloneFrom`); the openai one additionally takes `openaiOptions` and `tools`.
- `openai-runner.test.ts` and `openai-runner-retry.test.ts` drive
  `agent.runTurnLoop` and read `agent.manager.log`. Three mechanical
  consequences: `startTurn` must await the stream *by index*
  (`awaitStream` hands back the previous, finished stream now that a turn is
  several awaits long); the retry suite's `start` awaits a tick before reading
  stream 0, since the request is no longer issued synchronously; and the system
  prompt in these tests is the shared test context's, not a per-test string.
- `runner-parity.test.ts` now drives both sides through `Agent.runTurnLoop`, so
  `executorCalls` is measured the same way on both, and gained an
  `abort parity` case: an abort landing mid-stream yields `{type:"aborted"}`,
  an idle phase and a trailing user-role abort marker on both providers.
- Clone tests build the clone through `createTestOpenAIAgent({ cloneFrom })`
  rather than calling `runner.clone()` and running a turn on the bare manager.

### Review follow-up (stage 2)

- `MockOpenAIClient implements OpenAIStreamingClient`, so the
  `as unknown as OpenAIStreamingClient` double-casts in `test-helpers.ts` and
  `node/providers/mock.ts` are gone and mock drift is now a compile error.
- The openai test context's profile uses `stub<ProviderProfile>(...)` rather
  than an `as` cast.
- `OpenAIInferenceManager`'s `requestInFlight` + `aborted` booleans collapsed
  into one field, `request: {type:"idle"} | {type:"running"; aborted: boolean}`,
  read through a private `isAborted` getter, so "aborted while idle" is
  unrepresentable.

- Goal: `OpenAIRunner` becomes `OpenAIInferenceManager`; the duplicated loop, retry, ticker and phase code is deleted. Both providers are now driven by `Agent`'s single loop.
- Tests:
  - `openai-runner.test.ts`, `openai-runner-retry.test.ts`, `openai-wiring.test.ts`, `openai.test.ts` pass untouched.
  - `runner-parity.test.ts` is the real integration check here — it already asserts identical provider content, identical phase sequences and identical executor calls across the two. It should now be _more_ likely to hold by construction; keep it and extend it with an abort case.

## Hooks array and preflight token count — DONE

Done. `AgentHooks` is `{ onBeforeRequest: BeforeRequestHook[]; onToolResults:
ToolResultsHook[]; onYield: YieldHook[] }`; `Agent` iterates each array and
applies that point's composition rule. `composeSupervisors` now flattens the
supervisor list into those arrays (as getters, so a supervisor registered later
still participates) and keeps only the thread-level points. `Thread.beforeRequest`
is gone: the system reminder and the mid-turn queue flush are two ordinary
entries appended to the array in `Thread.agentHooks()`. `countTokens()` is an
optional method on `NativeInferenceManager`, issued from the gate lazily and at
most once per request.

Notes and deviations:

- `AgentRequestContext` gained `suspended`. `Agent` consults *every* hook, as
  the supervisor composition did, but a hook whose contribution commits state
  (draining the queue, marking a reminder sent) must decline once an earlier
  hook has suspended — previously `Thread.beforeRequest` got this for free by
  returning early. The token count is likewise skipped after a suspension.
- `onToolApplied` stayed on `AgentHooks` as a single optional function rather
  than moving to `AgentContext`: the supervisors that consume it are registered
  on the `Thread` *after* its `AgentContext` is built, so the context has no way
  to reach them. It is documented as not being a turn-loop hook point.
- `ThreadSupervisor` gained `requestPreflightTokenCount?: boolean` (set by
  `AutoCompactSupervisor`) and `onToolResults?`, so a supervisor can contribute
  at every agent hook point.
- `AgentLog.inputTokenCount` and `AgentOptions.skipPostFlightTokenCount` are
  gone. `Agent.inputTokenCount` / `getLastStopTokenCount()` serve the most
  recent preflight count, falling back to `latestUsage` as before.
- Behaviour change worth recording: because the count is now fresh at every
  gate, `AutoCompactSupervisor.onEndTurnWithoutYield` can no longer fire — a
  thread that comes to rest over the threshold suspends at the *next* gate,
  before its request goes out, which is what the end-turn check existed to
  approximate. It is kept as a safety net for owners that supply a count some
  other way. The three "compacts on the X handoff" tests became "compacts at
  the gate of the request/continuation", and the `max_tokens` one now registers
  `MaxTokensSupervisor` so there is a continuation to gate.
- `MockAnthropicClient` grew `countTokensCalls` so tests can assert that no
  count is issued when nobody asks.
- `test-helpers.ts` grew `agentHooks(partial)`, which fills in the hook points a
  test does not care about.

- Goal: `AgentHooks` becomes one typed array per hook point; `Agent` iterates and composes. `combineSupervisors` and `Thread.beforeRequest`'s wrapping collapse into registration. `countTokens` is issued from the gate, lazily, at most once per request.
- Tests:
  - The compaction supervisor is the whole point, so test it end to end: a thread whose count crosses the threshold compacts on the *next* request rather than one request late, which is the bug the current post-flight count allows. `thread-compact.test.ts` and `2026-07-13-auto-compact-supervisor` behaviour.
  - No supervisor declares the flag → `countTokens` is never called (spy on the mock client).
  - A hook that suspends before the counting hook is reached → no count at all.
  - Composition parity: injections from several hooks arrive in registration order, the first `suspend` wins, and the system reminder is still last. `system-reminders.test.ts` and the supervisor tests cover this and should need no behavioural change.
  - Retries do not re-count.

### Review follow-up (stage 3)

- `ComposedBeforeRequest` is a discriminated union again:
  `{type:"suspend"; reason; content}` | `{type:"proceed"; injections; submissions}`.
  A suspended composition cannot carry submissions — content drained before a
  later hook suspended is folded into `content`, which the gate still records
  in the log (so nothing is lost) but never presents as "about to be sent".
- `AgentRequestContext.suspended: boolean` became
  `{status:"pending"} | {status:"suspended"; reason}`, so the rule "a hook that
  commits state must decline when suspended" is checkable, and the suspended
  variant carries the winning reason. `thread.ts`'s two guards read `status`.
- A failed `countTokens()` now clears `lastPreflightTokenCount` rather than
  leaving the previous request's number in place: a hook deciding about the
  wrong conversation is worse than one that sees no count and declines.
  `MockAnthropicClient.countTokensError` is the knob; covered in `agent.test.ts`
  ("clears the count when it fails rather than reporting a stale one").
- Not done, deliberately: making `BeforeRequestHook` generic over
  `requestPreflightTokenCount` so a declaring hook receives `number` rather than
  `number | undefined`. The count can legitimately be absent even for a
  declaring hook (provider has no `countTokens`, or the count failed), so the
  stronger type would be a lie; `AutoCompactSupervisor` has to handle
  `undefined` either way. Its `breached(undefined) === false` is the intended
  behaviour and is now pinned by tests.
- New coverage:
  - `runner-parity.test.ts` "preflight token count parity" documents that
    auto-compaction is anthropic-only: openai's manager has no `countTokens`,
    so `AutoCompactSupervisor` never fires there.
  - `thread.test.ts` "keeps a system reminder pending across a suspended
    request": a reminder consulted on a suspended request is neither placed in
    the log nor marked sent, and is delivered on the next issued request.
- Deleted the orphaned doc comment above `GateOutcome`.

## Collapse ThreadMode into AgentPhase — DONE

Done. `ThreadMode`, `ThreadState.mode` and the `set-mode` action are gone.
`AgentPhase` is `idle | running{activity} | yielded{response,value,tornDown?}`,
with `AgentActivity = TurnActivity | {type:"aborting"}`; `TurnActivity`
(`thread-api.ts`) lost `awaiting_tools` and its `running_tools` gained
`activeTools`. `AgentPhase` moved out of `provider-types.ts` into `agent.ts`,
next to `ActiveToolEntry` and the loop that owns it.

Notes and deviations:

- `ThreadPhase` keeps its top-level `aborting`: on the agent `aborting` is an
  activity (only reachable from a turn in flight), and `Thread.get phase()`
  lifts it. That getter is now four lines: `running` passes its activity
  through, and `idle`/`yielded` are both "at rest with a `lastResult`".
- Three small readers were added to `agent.ts` and exported from the package
  rather than making every consumer re-derive them: `phaseActiveTools`,
  `phaseStreamingBlock` and `phaseLabel` (a flat label, for logging and tests).
  The root layer's `state.mode` reads and its `phase.type === "streaming"`
  reads go through them.
- `renderStatus` lost its `mode` parameter and its streaming arm became
  `renderStreaming(activity)`; `shouldShowContextFiles` is now just
  `phase.type === "idle"`, so — as the plan flagged — a yielded thread no
  longer shows context files. `chat.ts`'s thread-summary status is one switch
  over the phase instead of three mode checks followed by a phase switch.
- Behaviour fix the merge forced: `activeTools` means *live* invocations. It
  used to be cleared by `set-mode normal` when the executor finished; with the
  map living on the phase it would otherwise survive until the next request,
  and `thread-view`'s `isActive` would keep rendering tool *progress* for a
  tool that already had a result. `executeTools` clears it (and notifies) when
  the last invocation settles, and the loop notifies unthrottled after
  `appendToolResults` — the progress-to-result switch is not a frame the view
  may miss. `spawn-subagents.test.ts`'s per-agent expansion tests caught this.
- Test seam: `test-helpers.ts` grew `flatPhase(agent)`, which unwraps `running`
  so the provider suites keep asserting `streaming` / `running_tools` at one
  level. The nesting itself is asserted directly in `agent.test.ts`
  (`Thread.phase`). The old "is running/awaiting_tools when tools run outside
  the runner's view" test is gone with the variant it described.
- `agent.test.ts`'s torn-down-thread test sets the terminal `yielded` phase
  through a cast rather than driving a whole yield plus teardown; it used to
  assign `state.mode` the same way.

### Review follow-up (stage 4)

- One phase union, not two. `ThreadPhase` is deleted: `Thread.phase` (and the
  root's `NvimThread.phase`) returns `AgentPhase` directly, and how the last
  submission ended moved to `Thread.lastResult()`. `getProviderStatus()` is gone
  from `Agent`, `Thread` and `NvimThread` — there is one accessor, so a caller
  can no longer check `"yielded"` against a type where it is unrepresentable.
- `aborting` is a peer of `running` on `AgentPhase` rather than an activity, so
  `AgentActivity` and the lift in `Thread.phase` are both gone. `AgentPhase.running`
  carries a plain `TurnActivity`.
- `TurnActivity.running_tools` no longer holds a map that is overloaded to mean
  three things. It carries `tools: ToolInvocationState`
  (`pending | running{activeTools} | settled`), so "not created yet" and "all
  settled" are distinct. `phaseActiveTools` returns the map only in `running`.
  `Agent.setToolInvocationState` replaces the phase through `setPhase` rather
  than mutating the activity in place, so `TurnActivity` stays a value.
- `AgentPhase.yielded.tornDown` is a required boolean.
- `Agent.executeTools` aborts the invocations it just created if an abort landed
  while it was creating them, rather than relying on the phase write to make
  them reachable.
- New tests in `agent.test.ts`: `abortAndWait` on a yielded agent leaves the
  yield in place (the `abort()` entry point short-circuits, so only this one
  reaches the guard); aborting while tools run calls `abort()` on every live
  handle; and no update frame ever shows live invocations *and* tool results
  together, which is the invariant the root's `activeToolResults` merge relies on.

- Goal: one state representation on `Agent`. `ThreadMode` is deleted; `running_tools` carries `activeTools`; `yielded` is a phase.
- Tests:
  - The complexity here is in the root layer's reads, so verify there: `thread-view.ts` renders active tools from `mode.activeTools` (`:944`) and `renderStatus` branches on both (`:96`); `chat.ts` gates on `mode.yielded` in three places (`:264`, `:966`, `:1533`).
  - `thread.ts`'s `get phase(): ThreadPhase` should get materially simpler — it currently reconciles the two. Existing `thread.test.ts` phase assertions cover it.
  - Subagent yield paths: `fork-thread.test.ts`, plus the `tornDown` guard in `send` (sending to a torn-down thread must still reject).

## Settle the construction seam — DONE

- Goal: `AgentOptions` drops its hook fields and becomes `InferenceOptions`; `Provider.createAgent` becomes `createInferenceManager`. No hook type appears in any provider file.
- Tests:
  - `agent.test.ts` and `thread.test.ts` cover construction and cloning; `fork-thread.test.ts` covers `clone` + `truncateMessages` at the root.
  - `forceToolUse`'s `contextAgent?: Runner` becomes `context?: NativeInferenceManager` — it is single-shot and never needed the loop. Verify the anthropic `instanceof` path still finds native messages (compaction / title generation paths in `thread.test.ts`).
  - `node/providers/mock.ts` must implement the new seam; `thread-abort.test.ts` and `thread-compact.test.ts` exercise it.

Done. `AgentOptions` is `InferenceOptions` and carries only inference config
(model, systemPrompt, tools, thinking, reasoning); `Provider.createAgent` is
`Provider.createInferenceManager`; `forceToolUse`'s `contextAgent` is `context`.
No hook type is left in any provider file.

Notes and deviations:

- `AgentOptions.onUpdate` — the last survivor of the hook fields — is gone, and
  with it both managers' `notify()`. The manager's only outbound channel is now
  the per-request `OnRequestUpdate` callback, as the design says. `Agent`
  notifies at the mutation call sites instead; two were missing and were added:
  after the gate's own `appendUserMessage` (previously only notified when the
  caller also had pending content) and after the abort marker in
  `finishTurnAbort`.
- `ToolExecutor` and `ToolOutcome` moved from `provider-types.ts` to `agent.ts`:
  they describe the loop's executor, which no provider file mentions.
  `BeforeRequestDecision` moved with them, and the unused `OnBeforeRequest`
  alias was deleted. `ToolResults` stays in `provider-types.ts` — it is
  `appendToolResults`'s parameter, so the manager genuinely needs it.
- `forceToolUse`'s `context` has no production caller today (compaction and
  title generation both pass plain `input`), so the anthropic `instanceof`
  path is exercised only by its type. Left as-is rather than inventing a
  caller.
- File renames (`anthropic-inference.ts` / `openai-inference.ts`) and moving
  `ABORT_MARKER_TEXT` out of `anthropic-runner.ts` remain stage 6.

### Review follow-up (stage 5)

- `forceToolUse`'s `context` parameter is gone rather than retyped. It had no
  production caller, and the two implementations disagreed about it in a way the
  type could not express (anthropic `instanceof`-narrowed to its own manager and
  silently dropped anything else; openai read `context.log.messages`). If a
  caller ever needs prior conversation, it should pass the messages it wants,
  not a manager.
- `InferenceOptions`' two mutually exclusive provider bags collapsed into one
  discriminated field: `config?: {type:"thinking"; thinking} | {type:"reasoning";
  reasoning}`, read through the exported `thinkingConfig(options)` /
  `reasoningConfig(options)` helpers. The discriminant is the config's own kind
  rather than the provider name, so `MockProvider` — which chooses its manager
  from its own `agentKind` — can pass whatever it was handed straight through.
  `Agent.inferenceConfig()` picks the one shape the profile's provider can act
  on; that branch used to live inline in `createManager`.
- `ThinkingConfig` is `{enabled:false} | {enabled:true; budgetTokens?;
  displayThinking?; effort?}`, so the disabled state carries no dead fields.
  `ProviderProfile.thinking` keeps its looser user-facing shape (it is parsed
  from lua options); `Agent.inferenceConfig()` is the conversion point.
- `agent.test.ts` gained "notifies with the abort marker already in the log",
  which snapshots `onUpdate` and asserts a frame fires with the marker already
  present — the re-render `finishTurnAbort` now owns after the managers' internal
  `notify()` was removed. The gate's own `scheduleUpdate` is left unobserved
  deliberately: it is throttled and immediately followed by streaming updates.

## Naming and cleanup

- Goal: settle the names (`NativeInferenceManager`, files `anthropic-inference.ts`, `openai-inference.ts`), move `ABORT_MARKER_TEXT` / `ABORT_TOOL_RESULT_TEXT` out of `anthropic-runner.ts` so openai no longer cross-imports from it, and update `context.md`'s architecture section, which currently documents `Runner` as "the provider-specific turn loop" and describes `Agent` as subscribing to runner events.
- Tests: `npx tsc -b`, `npx vitest run`, `npx biome check .`.
