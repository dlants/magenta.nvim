# Objective and Context

> I want to reconsider the API between thread, core-thread, and the external consumer (magenta thread). Right now the shape feels really awkward / leaky
>
> Let's start with the agent /core thread interface. The turn taking interface feels disjointed. We have several channels that all communicate the chat state - event emitter, getState, getStreamingBlock, appendUserMessage / continueConversation / abort...
>
> None of the state is represented in types, and all the transitions / turn taking is implicit.
>
> I'd like to really model this more explicitly as a state machine, with the boundaries of what transitions and actions are allowed in what state being more explicit, and turn-taking being more obvious and tightly controlled.

Scope of this doc: the `Agent` <-> `ThreadCore` boundary only. The
`ThreadCore` <-> `Thread` (neovim) boundary is a follow-up; it is sketched at
the end but not designed here.

## Entities

- `Agent` (`node/core/src/providers/provider-types.ts`) — stateful conversation
  driver. Owns provider-native message history, streaming block accumulation,
  retry/backoff, and token counting. Emits `didUpdate` / `stopped` / `error`.
- `AgentStatus` — the only typed state today: `streaming | stopped | error`.
  Note `stopped` covers *nine* different `StopReason`s including `tool_use`,
  which is a fundamentally different situation from `end_turn`.
- `AgentState` — bag returned by `getState()`: `{status, messages,
  streamingBlock, latestUsage, inputTokenCount}`. Mixes machine state with
  render data.
- `NativeMessageIdx` — branded index into the agent's *native* message array,
  used as a fork point. `PLACEHOLDER_NATIVE_MESSAGE_IDX` is a sentinel callers
  must stamp into every content block they construct.
- `ThreadCore` (`node/core/src/thread-core.ts`) — the sole consumer of the
  mutating half of `Agent`. Owns tools, supervisors, compaction, context.

## Relevant files

- `node/core/src/providers/provider-types.ts` — `Agent`, `AgentState`,
  `AgentStatus`, `AgentEvents`, `NativeMessageIdx`.
- `node/core/src/providers/anthropic-agent.ts` — primary implementation
  (~1760 lines). Internal `update(action)` reducer at 214-390; `getState` 393;
  `appendUserMessage` 427; `toolResult` 436; `abort` 480; `abortToolUse` 492;
  `continueConversation` 527; `truncateMessages` 707; `clone` 811.
- `node/core/src/providers/openai-agent.ts` — second implementation, mirrors
  the same protocol.
- `node/core/src/thread-core.ts` — `listenToAgent` (3 handlers),
  `handleProviderStopped`, `handleProviderStoppedWithToolUse`,
  `abortAndWait`, `maybeAutoRespond`, `discardFailedSubmit`.
- `node/chat/thread-view.ts`, `node/chat/chat.ts` — read-only consumers
  (`getState().status`, `.streamingBlock`, `.latestUsage`,
  `getNativeMessageIdx()`).
- Tests: `anthropic-agent-retry.test.ts`, `anthropic-agent-ticker.test.ts`,
  `anthropic-agent-auth-refresh.test.ts`, `openai-agent.test.ts`,
  `openai-agent-retry.test.ts`, `agent-parity.test.ts`. All drive the agent
  through `MockStream` / `MockResponseStream`, which wrap *real* SDK stream
  objects, so the state machine can be exercised directly and precisely.

# Problem statement

Three concrete leaks, each traceable to a specific piece of code:

1. **A missing state.** "Stopped, but N tool_uses are outstanding" has no
   representation. `AnthropicAgent.toolResult` validates it by checking
   `status.stopReason === "tool_use" || "max_tokens"` and then re-scanning
   `messages[last].content` for a matching `tool_use` block.
   `ThreadCore.handleProviderStoppedWithToolUse` independently re-derives the
   same set by scanning the last assistant message, and the `max_tokens` branch
   of `handleProviderStopped` scans a *third* time to decide which path to
   take. `abortToolUse()` exists only to patch this hole.

2. **An unwritten protocol.** `appendUserMessage` / `toolResult` /
   `continueConversation` / `abort` / `abortToolUse` / `truncateMessages` are
   six independent mutators whose preconditions live in thrown-error strings.
   `ThreadCore.abortAndWait` therefore hand-executes the abort protocol:
   `agent.abort()` -> loop filling missing tool results -> `agent.abortToolUse()`
   -> `agent.appendUserMessage("[The user aborted...]")`. That sequence is the
   machine's business, and getting it wrong is silent.

3. **Three channels for one transition.** `didUpdate` / `stopped` / `error`
   each carry a slice. `ThreadCore.listenToAgent` duplicates
   throttle-flush logic across two handlers, and `handleProviderStopped` has to
   distinguish a genuine turn end from a synthetic one by sniffing
   `usage === undefined` (documented in a 6-line comment about
   `discardFailedSubmit` emitting a fake `stopped`/`end_turn`).

# Design

Model the agent as `runTurn` — "run until you stop" — with exactly three
channels between it and the thread, each with one job and no overlap:

- **`phase` + the `onUpdate` callback** — live progress, for rendering. Fires
  many times a second, carries no outcome and no payload.
- **the promise `runTurn` returns** — the outcome, delivered once. Control flow
  only.
- **`onBeforeToolResponse`** — the single interception point.

Today's leak is precisely that the `stopped` event, the `error` event, `status`
and message-array scanning each carry a piece of the same fact.

## Phases

Because outcomes are returned rather than observed, the phase union shrinks to
the states a turn passes *through*: `idle`, `streaming`, `running_tools`,
`aborting`. There is no `suspended` or `failed` phase — those are turn results.
`idle` no longer carries a `lastStop`, because the thread was handed one.

The loop between `streaming` and `running_tools` is driven *by the agent*, not
by `ThreadCore`. `aborting` is a real phase, not an ad-hoc promise: today
`abort()` returns `streamingEndPromise` and the caller must know to await it
before touching anything.

## Key decisions

**Phase carries its data.** `streaming` carries `startedAt`, `lastEventTime`,
`block`, `retry`. `running_tools` carries the requested tool calls. This
deletes
`getStreamingBlock()` (it is `phase.block`) and the `AgentState` bag.

**Tool execution is the agent asking its executor for help.** The agent does not
hand out a "tools are outstanding" state for the thread to notice and respond
to; it calls `executor.executeTools(requests)` and awaits the results, exactly
as it would await the provider. `ThreadCore` becomes the executor. This is the
single biggest simplification: `ThreadCore.maybeAutoRespond` — which today
tangles together tool completion checks, yield detection, pending-message
draining and end-of-turn auto-response, and which is called from *four* places
including a `.then()` on every individual tool promise — mostly evaporates.
"Have all the tools finished" stops being a repeatedly-recomputed predicate
over a mutable map and becomes `await Promise.all(...)` inside the executor.

**Turn end is a yield of control, not a callback.** When the provider stops
without tool_use, the agent lands in `idle` and `runTurn` resolves. There is no
`onTurnEnd` hook. If the thread has more to do — queued messages, a supervisor
nudge, the max_tokens continue-prompt — it decides that itself and calls
`runTurn` again. This keeps the "who is driving" question answerable at every
instant: inside `runTurn` the agent drives; once it resolves, the thread does.

**The tool outcome says whether the conversation proceeds.** The agent has no
idea which tools it just ran — it hands out requests and takes back results.
But some results mean the conversation is over, and only the executor can know
that. Working through what the executor can say when it finishes:

- *Resolve normally.* Unusable on its own: a plain resolve means "here are the
  results", and the agent — which cannot tell one tool from another — has no
  reason not to immediately issue the next request.
- *Reject.* Cleans up correctly and unwinds the loop, but lands the agent in
  `failed`. Nothing went wrong; using an error channel to express a normal
  outcome would then require the executor to distinguish its own synthetic
  rejections from genuine ones.
- *Resolve with a flag.* The results are delivered, the loop unwinds, and the
  agent stays coherent. This is the one we take.

So `executeTools` resolves with a `ToolOutcome` carrying the results plus
`continue`, `suspend` or `aborted`. `suspend` is generic — the agent never
learns why.
`ThreadCore` uses it today for two things: `yield_to_parent` (the model will
never read that result) and the compaction handoff (`handleCompactComplete`
discards the agent and builds a fresh one). Neither is visible in the
protocol.

The executor must still return results for every request before suspending, so
history stays well-formed for archiving, rendering and forking. The synthetic
"Yield accepted..." result `ThreadCore` produces today is write-only —
nothing in the codebase reads it — but it is worth keeping for those reasons.

The rejected fourth option was to simply never settle the promise. `runTurn`
would never resolve, so `ThreadCore` could not distinguish "suspended" from
"still working" without out-of-band state — the exact leak this redesign
removes — and `destroy()` would hang.

**Mid-turn amendments go through one hook.** The only point inside a turn where
the thread needs to *modify* the agent's behavior is the continuation request
carrying tool results — today `sendToolResultsAndContinue` splices in context
updates, git updates and system reminders there. That becomes
`agent.onBeforeToolResponse`, a hook installed on the agent by whoever owns it,
returning extra input to append. It lives on the agent rather than bundled with
the tool executor because it is an optional interception of the agent's own
request-building, not a capability the agent depends on: an agent with no hook
installed works fine, whereas one with no executor cannot run tools at all.
With
`suspend` carrying the "this conversation is over" cases, this hook is purely
additive and has no control-flow variant.

**Malformed tool requests are still handed to the executor.** They are passed as
`Result<ToolRequest, {rawRequest}>` so the executor can produce a proper error
result. If the returned map omits any id, the agent fills an error result
itself — "every tool_use is answered" is enforced by the machine, not by the
executor's diligence.
**Abort has two paths, one for each thing the agent can be waiting on.** They
are separate because the thing being cancelled is owned by a different object
in each case, and there is exactly one terminal transition either way:

- *Waiting on inference (`streaming`).* `agent.abort()` cancels the retry
  backoff and signals the in-flight request, then waits for the provider stream
  to terminate. This is the agent's own resource; `ThreadCore` cannot reach it.
- *Waiting on tools (`running_tools`).* `ThreadCore` holds the tool handles, so
  it aborts them itself; they settle with error/abort results and the executor
  returns those through the same pipe as `suspend`, as
  `{type: "aborted", results}`.

In both cases the agent then fills error results for any unanswered id, appends
the abort marker, and resolves the in-flight `runTurn` with
`{type: "aborted"}`.

Routing tool aborts through the outcome rather than through a second call into
the agent is what makes this safe: the executor remains the *only* thing that
ever answers a tool request, and it answers exactly once. There is no window in
which results arrive from two directions, so nothing has to be discarded or
de-duplicated.

It also gives `abort()` one meaning — cancel the in-flight inference request —
which makes it phase-selecting rather than phase-sniffing. `ThreadCore` can
call `agent.abort()` and tear down its own tool handles unconditionally;
exactly one of the two has an effect, chosen by where the agent actually is,
with no `if (mode.type === "tool_use")` branch like today's `abortAndWait`.

The boundary case is an abort that lands after the stream completed with
`tool_use` but before the agent called `executeTools`: no outcome is coming,
because the executor was never invoked. So the rule is that once the agent is
`aborting` it issues no new work and unwinds at the next boundary. Two entry
points, still exactly one terminal transition.

`abortToolUse()` is deleted, and so is the second thing to await: the turn
promise is the only join point. `ThreadCore.abortAndWait` shrinks to
`agent.abort()`, its own handle teardown, and pending-message recovery.

**The phase becomes almost purely observational.** With tools inverted, the
only caller-initiated mutations left are `runTurn`, `abort` and
`truncateMessages` — and `runTurn` is illegal while a turn is in flight. So
rather than
hanging closures off every phase variant, `phase` is plain data and `runTurn`
is a method that rejects when a turn is already in flight. Phase-scoped
closures (considered in the previous draft of this doc) buy much less once
`resolveTool`/`continueTurn` are gone, and cost the reader an unusual API
shape.

**No emitter at all.** The three events collapse to a single payload-free
`onUpdate()` supplied in `AgentOptions`, meaning only "something visible moved,
re-render". Since the terminal facts now arrive by promise, `ThreadCore` never
has to reconstruct intent from an event — which deletes the
`usage === undefined` sniff used today to tell a genuine turn end from the
synthetic `stopped` that `discardFailedSubmit` emits.

It carries no payload because nobody reads one: `ThreadCore`'s `didUpdate`
handler only calls `scheduleUpdate()`, which sets a flag and coalesces into a
32ms timer, and the views re-read `agent.phase` / `agent.log` at paint time.
Passing the phase would create a second way to obtain it and invite someone to
start diffing — the same defect as the `prev` argument. The ~1s dead-air ticker
fits this shape too: nothing changed, the elapsed-time display is merely stale.

And it is a constructor dependency rather than an event because it has exactly
one subscriber for the agent's whole lifetime — the object that constructed it.
Outside tests the only other subscriber today is `compaction-manager.ts:329`,
which listens to `stopped`/`error` only and so becomes a `runTurn` promise.
Dropping `on`/`off` also deletes `unlistenAgent` and the `agentListeners` field,
which exist solely because compaction swaps the agent: a leaked subscription to
a discarded agent is invisible until it fires, and a construct-time callback
makes that unrepresentable.

This also makes the grouping uniform. `executeTools` and `onUpdate` are both
required collaborators with exactly one implementor, so both live in
`AgentOptions`; `onBeforeToolResponse` is an assignable property precisely
because it is optional.

**`NativeMessageIdx` is unchanged.** `getNativeMessageIdx()` /
`truncateMessages()` / `clone()` keep their current shapes, as does the
`nativeMessageIdx` stamp on `ProviderMessageContent` and
`PLACEHOLDER_NATIVE_MESSAGE_IDX`. `ThreadCore.state.preSubmitNativeIdx` and
`discardFailedSubmit` also stay as they are — the `failed` turn result tells
the thread *that* the submit failed; rolling back to its own snapshot is still
the thread's business. This redesign is about turn-taking, not about the
history addressing scheme.

**Log split from machine.** `agent.log` is the append-only render view
(`messages`, `latestUsage`, `inputTokenCount`). `agent.phase` is the machine.
`getState()` is deleted.

## Interfaces

```ts
export type StreamingBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: ToolRequestId; name: ToolName; inputJson: string };

export type RequestedTool = {
  id: ToolRequestId;
  /** err when the model emitted unparseable input for this call */
  request: Result<ToolRequest, { rawRequest: unknown }>;
};

/** The states a turn passes through. Progress, not outcome. */
export type AgentPhase =
  | { type: "idle" }
  | {
      type: "streaming";
      startedAt: Date;
      /** advanced on every stream event; drives the dead-air timer */
      lastEventTime: Date;
      block: StreamingBlock | undefined;
      retry: RetryStatus | undefined;
    }
  | {
      type: "running_tools";
      requested: ReadonlyArray<RequestedTool>;
      /** the turn was cut short by the output token limit mid-tool-use */
      truncated: boolean;
    }
  | { type: "aborting" };

/** Narrowed to reasons the *provider* actually reports. `aborted` and
 * `tool_use` move out — see below. */
export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "pause_turn"
  | "content"
  | "refusal"
  | "model_context_window_exceeded"
  | "stop_sequence";

/** How a turn ended. Delivered once, by the promise. */
export type TurnResult =
  | { type: "stopped"; stopReason: StopReason }
  /** the executor returned suspend; history is coherent and resumable */
  | { type: "suspended" }
  | { type: "aborted" }
  | { type: "failed"; error: Error; retryable: boolean };
```

The tool executor is not an interface with two members — it is a single
function supplied at construction, alongside `model`, `systemPrompt` and
`tools`:

```ts
export type ToolResults = ReadonlyMap<ToolRequestId, ProviderToolResult["result"]>;

export type ToolOutcome =
  | { type: "continue"; results: ToolResults }
  /** record the results, then park the agent */
  | { type: "suspend"; results: ToolResults }
  /** the caller aborted its tool handles; unwind the turn */
  | { type: "aborted"; results: ToolResults };

/** "Please run these for me." Must settle; a rejection is converted into
 * error results for every requested id. No abort signal is passed in: the
 * caller owns the tool invocations, so on abort it cancels them itself and
 * settles with `{type: "aborted"}` carrying whatever results it has. */
export type ToolExecutor = (
  requests: ReadonlyArray<RequestedTool>,
) => Promise<ToolOutcome>;

export interface AgentOptions {
  // ...existing: model, systemPrompt, tools, thinking, reasoning
  executeTools: ToolExecutor;
  /** "Something visible moved, re-render." No payload: read `phase` / `log`.
   * Called at streaming rates; the owner is responsible for throttling. */
  onUpdate: () => void;
}
```

The agent itself:

```ts
export type AgentLog = {
  readonly messages: ReadonlyArray<ProviderMessage>;
  readonly latestUsage: Usage | undefined;
  readonly inputTokenCount: number | undefined;
};

export interface Agent {
  readonly phase: AgentPhase;
  readonly log: AgentLog;

  /** Optional interception point, installed by whoever owns the agent.
   * Called before the continuation request that carries tool results; the
   * returned content is appended to that request. Purely additive. */
  onBeforeToolResponse?: (args: {
    stopReason: StopReason;
    results: ToolResults;
  }) => Promise<AgentInput[]>;

  /** Run until stop. Resolves once, with why it stopped. Does not reject for
   * provider errors — those are `failed` results. Rejects only on misuse: a
   * turn is already in flight. */
  runTurn(input: AgentInput[]): Promise<TurnResult>;

  /** Cancels the in-flight inference request (and any retry backoff) and
   * unwinds the loop: fills results for any unanswered tool_use and appends
   * the abort marker. The in-flight `runTurn` resolves with
   * `{type: "aborted"}` — that promise is the join point, so this returns void
   * rather than offering a second one to await. A no-op when idle, and also
   * when in `running_tools`: there the caller aborts its own tool handles and
   * the executor reports it via `{type: "aborted"}`. */
  abort(): void;

  // unchanged from today
  getNativeMessageIdx(): NativeMessageIdx;
  truncateMessages(idx: NativeMessageIdx): void;
  clone(): Agent;
}
```

Notes on the shape:

- `ProviderToolResult["result"]` rather than the full `ProviderToolResult`: the
  `id`, `type`, and message index are the agent's to stamp.
- `runTurn` resolving at the turn boundary gives `ThreadCore` a natural place
  to emit `turnEnded` and `playChime` — today those are scattered across three
  branches of `handleProviderStopped`.
- `StopReason` is currently a mix of provider-reported reasons and
  magenta-internal ones: `"aborted"` is ours, and `"tool_use"` — while the
  provider's — becomes internal once the loop consumes it. Both move out, so
  `StopReason` means only "what the provider said" and `TurnResult` means
  "what happened". `ThreadCore.TurnEndReason`
  (`"end_turn" | "aborted" | "error"`) is a hand-rolled `TurnResult` one layer
  up and is subsumed.
- Open question this raises: `ProviderMessage.stopReason` is per-message
  history, and today an aborted turn stamps `"aborted"` into it. With the
  narrowed type, the honest encoding is that an aborted message simply has no
  `stopReason` — the provider never finished it. That reads better but touches
  `cleanup()` in both agents and the archive format, so it should be decided
  explicitly rather than fallen into.
- Why `onBeforeToolResponse` rather than a general `onBeforeRequest`: inside a
  turn there are exactly two kinds of request, the opening one and the
  tool-response continuations. The opening one's content is already the
  argument to `runTurn`, so a general hook would add no capability while
  forcing every implementation to branch on first-vs-continuation — which is
  precisely the `prepareUserContent` / `sendToolResultsAndContinue` split that
  exists today and that we are trying to stop duplicating. The specific name
  also settles a question the general one leaves open: retries of a failed
  request do not re-fire the hook, because the tool response was already
  assembled.
- `clone()` carries `executeTools` and any installed `onBeforeToolResponse`
  across, as it already does for `AgentOptions`. `ThreadCore.createFreshAgent`
  (used after compaction) must reinstall the hook, just as it must supply a
  fresh `onUpdate`.
- Reentrancy: the executor must not call back into the agent. The agent asserts
  this by rejecting `runTurn` while a turn is in flight; `abort()` is the one
  legal reentrant call.

## Invariants

- Every `tool_use` block emitted by the provider is answered by exactly one
  result block before the next assistant turn. Enforced by the agent, not the
  executor: missing ids, executor rejections, and aborts all produce error
  results.
- The agent never references a specific tool name. `suspend` is the only
  channel by which a tool's meaning reaches the loop, and it carries no reason
  code.
- Suspension is not a prohibition: a suspended agent's history is well-formed
  (every request answered), so `runTurn`, `truncateMessages` and `clone`
  all remain legal afterwards. Whether to resume is the thread's policy.
- Exactly one `TurnResult` per `runTurn` call, and no fact in it is also
  discoverable through `phase` or `onUpdate`. If a reviewer can find the
  outcome in two channels, the split has regressed.
- A tool request is answered by exactly one source: the executor. Aborting
  tools never calls into the agent to deliver results, so there is no window in
  which the agent must discard late ones or guard against appending twice.
- Once the agent is `aborting` it issues no further provider request and does
  not invoke the executor, so an abort landing between stream completion and
  the `executeTools` call still unwinds exactly once.
- The executor is never called concurrently with itself for the same agent, and
  never re-entered before its previous promise settles.
- `runTurn` is the only thing that drives the agent forward. Nothing outside it
  can cause a provider request, so "is the agent busy" is exactly "is a
  `runTurn` in flight".
- Abort from `streaming` (via `agent.abort()`) and abort from `running_tools`
  (via an `{type: "aborted"}` outcome) both produce exactly one terminal
  transition to `idle`, and the turn resolves `{type: "aborted"}` exactly once
  — never an abort result *and* a failure.
- `truncateMessages` never emits a transition that `ThreadCore` can mistake for a
  completed turn. Concretely: the retry-budget bookkeeping in
  `maybeAutoResubmitAfterError` must not reset on a rollback (this is what the
  `usage === undefined` sniff currently guards).
- Retry/backoff during a request stays *inside* `streaming` (with `retry`
  set) — not observable as a phase change. Preserves
  `anthropic-agent-retry.test.ts` behavior.
- `lastEventTime` advances on every stream event and the ~1s ticker keeps
  firing re-renders during dead air (`anthropic-agent-ticker.test.ts`).
- The Anthropic implementation currently pushes each tool result as its own
  user message. Whatever batching `runTurn` does must produce byte-identical
  native message arrays; snapshot before changing anything.
- Both `AnthropicAgent` and `OpenAIAgent` satisfy the same machine and the
  same executor protocol; `agent-parity.test.ts` is extended to assert
  phase-transition and executor-call parity, not just content parity.

# Stages

This is a single cut-over, not a gradual migration. Shims and derivation layers
would mean writing the old semantics twice — once to keep the shim honest, once
to delete it — and the intermediate states are not shapes anyone wants to
review. So: change the interface, then follow the type errors.

**Types and tests are expected to be red from stage 1 until stage 4.** The
existing suite is the specification for this work; `npx tsc -b` is the primary
work queue during that window, not a gate. The one thing that must hold
throughout is that the test *files* are not edited to accommodate the new
design — see stage 5.

## 1. Change the interface

- `provider-types.ts`: `AgentPhase`, `TurnResult`, `ToolOutcome`,
  `ToolExecutor`, `AgentLog`; `runTurn`, `abort(): void`; `executeTools` and
  `onUpdate` into `AgentOptions`; `onBeforeToolResponse` on `Agent`. Delete
  `AgentState`, `AgentStatus`, `AgentEvents`, `on`/`off`, `getState`,
  `getStreamingBlock`, `appendUserMessage`, `toolResult`,
  `continueConversation`, `abortToolUse`. Narrow `StopReason` and decide the
  `ProviderMessage.stopReason` encoding for aborted messages.
- `NativeMessageIdx`, `truncateMessages`, `getNativeMessageIdx`, `clone` and
  the `nativeMessageIdx` content stamp are untouched.

## 2. Rewrite the agents

- `anthropic-agent.ts` first, then `openai-agent.ts`. The `update(action)`
  reducer becomes the phase machine; `continueConversation`'s stream loop
  becomes the body of `runTurn`, wrapped in the tool loop that calls
  `options.executeTools` and `this.onBeforeToolResponse`. Retry/backoff stays
  inside `streaming`. `abort()` cancels the request and the backoff and lets
  the loop unwind.
- Do the two in sequence rather than in parallel: the second one is mostly a
  transcription once the first has settled the loop's shape, and
  `agent-parity.test.ts` is the check that they landed in the same place.

## 3. Rewrite ThreadCore's use of it

- `handleProviderStoppedWithToolUse`, `maybeAutoRespond` and
  `sendToolResultsAndContinue` collapse into an `executeTools` implementation
  plus an `onBeforeToolResponse`; `activeTools` moves inside the executor.
  `handleProviderStopped` / `handleErrorState` / `listenToAgent` /
  `unlistenAgent` are deleted, and everything they did moves to the
  `await runTurn(...)` site: turn-end decisions (queued messages, supervisor
  nudge, the max_tokens continue prompt), `turnEnded`, `playChime`, the
  failure paths. `abortAndWait` calls `agent.abort()`, tears down its tool
  handles, and awaits the turn promise. `compaction-manager.ts:329` reads the
  `runTurn` result rather than subscribing. `getProviderStatus` /
  `getProviderMessages` read `phase` / `log`.
- `TurnEndReason` is replaced by `TurnResult`. `preSubmitNativeIdx` and
  `discardFailedSubmit` stay as they are.

## 4. Fix the read side and the call sites

- `thread-view.ts` and `chat.ts` read `agent.phase` and `agent.log`;
  `AgentStatus` in view signatures becomes `AgentPhase`. `thread-view.ts:139`
  (aborted-status render) and `thread-supervisor.ts:87` (skips supervision on
  abort) keep their behavior against the new types.
- `npx tsc -b` clean.

## 5. Green the suite

Tests are edited only where the *mechanism* changed — construction now takes
`onUpdate` and `executeTools`, and subscriptions become awaited results. Any
place where an *assertion* has to change is a behavior change and needs to be
called out rather than absorbed.

Things to check specifically, since a type error will not catch them:

- Multi-round tool use is one `runTurn` that resolves once, at the end.
- `suspend` records results, issues no further request, resolves
  `{type: "suspended"}` — on both the yield and compaction-handoff paths, and
  identically for both, with nothing in the agent referencing
  `yield_to_parent`.
- Every abort path resolves `{type: "aborted"}` exactly once and leaves a
  well-formed message array: mid-stream, mid-tool, during retry backoff, and in
  the window between stream completion and the `executeTools` call. Today's two
  abort strings — `cleanup`'s "…before tool execution completed." and
  `abortAndWait`'s "Request was aborted by the user." — now come from one code
  path; keeping both or merging them is a deliberate call.
- Anthropic still emits one user message per tool result, as it does today —
  whatever batching `runTurn` does must not change the native array.
- An executor that rejects still yields error results for every requested id.
- `runTurn` while a turn is in flight rejects without perturbing state.
- Queued messages sent mid-turn go out immediately after the turn ends, in one
  message, in the same order.
- `onUpdate` carries no outcome: ThreadCore's implementation is a bare
  `scheduleUpdate()` and the suite still passes. No update storm beyond the
  32ms throttle; the ~1s dead-air ticker still fires.
- Compaction's agent swap leaves no callback aimed at the discarded agent.
- Retry-budget bookkeeping does not reset on a `truncateMessages` rollback —
  this is what the deleted `usage === undefined` sniff guarded.
- Subagent auto-resubmit stays bounded and does not reset per attempt; root
  threads still get `setupResubmit`.
- `agent-parity.test.ts` gains phase-transition and executor-call parity.
