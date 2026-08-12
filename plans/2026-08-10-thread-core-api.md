# Objective and Context

> We reworked the `Agent` <-> `ThreadCore` boundary into an explicit state machine (`plans/2026-08-08-agent-state-machine.md`). The `ThreadCore` <-> consumer boundary has the same defects, one layer up: state that isn't in types, transitions that are implicit, and several channels carrying the same fact.

Scope: the interface `ThreadCore` presents to everything outside `node/core/src/thread-core.ts` — the root `Thread`/`Chat` controllers, the views, `spawn-subagents`, the script manager, and the tests. The internals (compaction, supervisors, context/git tracking) are only in scope where they leak through that interface.

The design below also concludes that `ThreadCore` is two objects fused into one — an ephemeral `Agent` and a durable `Thread` — so the scope grows to include that split and the renames it forces. See "The missing layer, and the names".

## Entities

- `ThreadCore` — owns an `Agent`, the tool executor, context/git managers, supervisors, compaction, and the archive logger. Extends `Emitter` with **nine** events and exposes a **public mutable `state` bag** plus a `update(action)` reducer that outside code calls directly. Becomes two objects: `Agent` (ephemeral, one message list) and `Thread` (durable id, queue, compaction, logger, context managers).
- `Agent` (current) — the provider-specific turn loop, implemented by `providers/anthropic-agent.ts` and `providers/openai-agent.ts`. Renamed `Runner`, since it varies along a provider axis, not a nativeness one.
- `ThreadMode` — `normal | tool_use | compacting | yielded`. The only typed state, and it conflates three different time-scales: `tool_use` is a phase _within_ a turn, `compacting` is a whole-thread activity that spans turns, and `yielded` is a terminal lifecycle state.
- `Thread` (`node/chat/thread.ts`) — the neovim wrapper. Subscribes to all nine events in its constructor and unsubscribes all nine in `destroy()`. Renamed `NvimThread` to free the name for the new durable layer.
- `Chat` (`node/chat/chat.ts`) — owns the thread pool, and implements the `ThreadManager` capability (`getThreadResult` / `onThreadYielded`) by reading `thread.core.state.mode.type === "yielded"`.

## Relevant files

- `node/core/src/thread-core.ts` — `ThreadCoreEvents`, `ThreadMode`, `ThreadCoreAction`, `state`, `sendMessage`, `handleSendMessageRequest`, `sendRawMessage`, `abort`/`abortAndWait`, `startCompaction`, `discardFailedSubmit`, `prependToNextTurn`, `setTitle`, `destroy`.
- `node/core/src/providers/anthropic-agent.ts`, `openai-agent.ts` — the `Agent` implementations that become `Runner`s.
- `node/core/src/context/`, `node/core/src/thread-logger.ts`, `node/core/src/compaction-manager.ts` — the collaborators that move from `Agent` up to `Thread`.
- `node/chat/thread.ts` — event subscriptions (ctor), `destroy` unsubscribe block, `rebuildToolResultMap`, `myUpdate` call sites.
- `node/chat/thread-view.ts` — `renderStatus`, `shouldShowContextFiles`, pending-message views, active-tool lookup; reads ~12 `state` fields.
- `node/chat/chat.ts` — `getThreadResult`, `onThreadYielded`, `fireThreadYieldCallbacks`, thread summary rendering, teardown message.
- `node/core/src/capabilities/thread-manager.ts` — the polling/callback interface subagents use.
- `node/core/src/tools/spawn-subagents.ts` — polls `getThreadResult` and registers `onThreadYielded`.
- `node/magenta.ts` — `discardFailedSubmit`, `lastTurnResult` for the sidebar icon.
- Tests: `thread.test.ts`, `thread-abort.test.ts`, `thread-compact.test.ts`, `fork-thread.test.ts`, `spawn-subagents.test.ts`, `script-manager.test.ts` — many of which poll `state.mode.type` or `state.lastTurnResult?.type` in a loop.

# Current API surface

Everything reachable from outside `thread-core.ts` today, grouped by the _kind_ of surface it is. The count per group is the point: there are eight distinct mechanisms by which a consumer can observe or mutate a thread.

## 1. Construction and lifecycle

- `new ThreadCore(id, context: ThreadCoreContext, clonedAgent?, forkProvenance?, initialState?)` — 5 positional params, the last three only used by the clone path.
- `static clone({sourceCore, newId, nativeMessageIdx, context})` → `ThreadCore`.
- `destroy(): Promise<void>`.
- `ThreadCoreContext` — 30-field bag of capabilities, config and callbacks (`getProvider`, `getAgents`, `getScriptRunner`, `yieldSchema`, ...).

## 2. Events (`Emitter<ThreadCoreEvents>`, 9)

Three sub-kinds that happen to share a mechanism:

- _Re-render pings_ — `update`, `pendingUpdatesChanged`. Thread's handlers are the same dispatch.
- _Host commands, one implementor_ — `playChime`, `scrollToLastMessage`, `setupResubmit(threadId, lastUserMessage)`, `recoverPendingMessages(threadId, text)`, `aborting`. Note the `threadId` args: a broadcast has to say which thread it is about.
- _Data hand-offs_ — `turnEnded({reason: TurnEndReason})`, `contextUpdatesSent(updates)`, `gitContextUpdateSent(update)`.

`ThreadCore` also subscribes to _itself_ (`this.on("update", ...)`, `this.on("turnEnded", ...)` in the ctor) to drive the archive logger — a consumer it constructs, owns, and then talks to through its own broadcast channel.

## 3. The public mutable `state` bag (18 fields)

`public state: {...}` — no `readonly`, no accessor. Consumers read `title`, `threadType`, `systemPrompt`, `systemInfo`, `toolSpecs`, `mode`, `pendingMessages`, `pendingNextMessages`, `compactionHistory`, `editedFilesThisTurn`, `failedSubmit`, `lastTurnResult`. The rest (`edlRegisters`, `scratchpad`, `outputTokensSinceLastReminder`, `pendingBashReminder`, `bashTokensSinceLastReminder`, `firstBashReminderPending`, `activeReminders`, `preSubmitNativeIdx`) is internal bookkeeping that is nonetheless public and writable.

`ThreadCore` writes some of these directly rather than through the reducer (`state.editedFilesThisTurn = []`, `state.scratchpad = scratchpad`, `state.lastTurnResult = result`), so the reducer is not even internally authoritative.

## 4. The reducer

`update(action: ThreadCoreAction, {silent}?)` — 17 action variants, public. Outside callers use two of them (`activate-reminder` from `thread.ts`, `set-teardown-message` from `chat.ts`); the other 15 are internal but exposed. The `{silent}` flag is a caller-visible knob on whether a re-render fires.

## 5. Public sub-objects (reach-through)

- `agent: Agent` — read for `.phase`, `.log.latestUsage`, `.log.inputTokenCount` by views; also the target of `truncateMessages`.
- `contextManager: ContextManager` — read by views for context files and pending updates.
- `gitTracker: GitTracker`.
- `compactionController: CompactionManager | undefined` — tests read `.nextPrompt` and `.chunks.length`.
- `supervisors: ThreadSupervisor[]` — mutable array, assigned from outside.
- `structuredToolResults: ReadonlyMap`-ish `Map` — read by `rebuildToolResultMap`, written by clone.

Each of these is a second, unversioned API surface transitively exposed through `ThreadCore`.

## 6. Imperative methods

- Submission: `sendMessage(inputMessages?)`, `handleSendMessageRequest(messages, queue?)`. (`sendRawMessage` is private but reachable via `handleSendMessageRequest` when `threadType === "compact"`.) Both return `Promise<void>` — the promise means "the submission was accepted", not "the turn finished".
- Control: `abort()`, `startCompaction(nextPrompt?)`, `discardFailedSubmit()`, `prependToNextTurn(content)`.
- Metadata: `setTitle(title)`, `setThreadTitle(userMessage)` (two similarly named methods: one sets, one asks the fast model and then sets), `refreshToolSpecs()`, `getToolSpecs()`.

## 7. Getters / projections

`getProviderStatus(): AgentPhase`, `getProviderMessages()`, `getMessages()` (a mutable copy of the former), `getLastStopTokenCount()`, `get pendingTurnContent()`, `awaitArchiveFlush()` (test-only).

## 8. Indirect surfaces

- **`ThreadManager` capability** — `getThreadResult(threadId)` / `onThreadYielded(threadId, cb)`, implemented by `Chat` by reading `core.state.mode`. Tools address threads through this, so it is part of `ThreadCore`'s effective API even though it is declared elsewhere.
- **Hooks installed on the agent** — `executeTools` and `onBeforeToolResponse` are `ThreadCore` methods handed to the agent; `bindAgent`/`createFreshAgent` must keep them in sync across compaction, and `bindHooks` leaves a window in which a cloned agent still points at its source thread.
- **Tests as consumers** — several poll `state.mode.type` or `state.lastTurnResult?.type` in loops, which means those fields are load- bearing API and not merely render state.

## Where it lands in the new shape

- events (9) → one `onUpdate()` collaborator; the rest are derivable from `send`'s result, `abort`'s return value, or `phase`
- self-owned `ThreadLogger` + `awaitArchiveFlush` → an ordinary view the owner constructs and drives from `onUpdate`
- `state` (18 public fields) → `phase` + 6 readonly projections
- `update(action)` (17 variants, public) → private; 1 named method (`activateReminder`; `set-teardown-message` moves out with the supervisors)
- `supervisors: ThreadSupervisor[]` + 3 `consult*` merge methods → 3 optional hooks; the supervisors and their arbitration become a core _library_ that `thread-core.ts` does not import
- `sendMessage`/`handleSendMessageRequest`/`sendRawMessage` → `send`
- `getThreadResult`/`onThreadYielded`/callback registry → `result` promise
- `agent` reach-through → `phase.activity`, `usage`, `currentMessageIdx()`; `compactionController` → folded into `phase`

# Problem statement

Five leaks, each traceable to specific code:

1. **"Is this thread busy" is derived, not stated.** `handleSendMessageRequest` computes it as `this.currentTurn !== undefined || this.state.mode.type === "tool_use"` — two sources for one fact, and neither is exposed. Outside code that needs the same answer re-derives it from a _third_ combination: `thread-view.ts:shouldShowContextFiles` uses `agent.phase.type === "idle" && mode.type === "normal"`, and the sidebar icon uses `state.lastTurnResult?.type`.

2. **The rendered status has four inputs.** `renderStatus` reads `state.mode`, `agent.phase`, `state.lastTurnResult` and `state.failedSubmit` and reconstructs a single line from them. There is no type whose inhabitants are "the states a thread can be in", so every consumer invents its own projection — and `chat.ts:1536-1548` invents a _different_ one for the thread-overview list.

3. **Completion is polled.** A subagent's result is discovered by `chat.ts:getThreadResult` reading `mode.type === "yielded"`, plus a parallel `threadYieldCallbacks` registry in `Chat` that `fireThreadYieldCallbacks` drives from two call sites, plus `spawn-subagents.ts` polling once immediately "in case it already yielded". This is exactly the defect the agent redesign removed: a terminal fact delivered through an observational channel, so every consumer must guard against having missed it.

4. **Outsiders drive the reducer.** `thread.ts:723` calls `core.update({type: "activate-reminder"})` and `chat.ts:784` calls `core.update({type: "set-teardown-message"})`. `ThreadCoreAction` is an internal mutation language; making it public means every internal bookkeeping action is now API, and preconditions (`set-teardown-message` silently no-ops unless the mode is `yielded`) live nowhere.

5. **Nine events for two kinds of thing.** `update`, `pendingUpdatesChanged` and `turnEnded` are "re-render" (Thread's handlers for the first two are literally the same dispatch). `setupResubmit`, `recoverPendingMessages`, `scrollToLastMessage`, `playChime` and `aborting` are _commands to the host_ with exactly one implementor, mis-modelled as broadcasts — `setupResubmit` even needs a `setTimeout(..., 1)` to sequence correctly. `contextUpdatesSent`/`gitContextUpdateSent` are neither: they carry data that the receiver files under `getProviderMessages().length` at the moment of receipt, i.e. an index race dressed up as an event.

   And `turnEnded`'s `TurnEndReason` (`"end_turn" | "aborted" | "error"`) is a lossy hand-rolled `TurnResult` — the same information `state.lastTurnResult` already holds, in a second channel.

# Design

Mirror the agent design, one layer up. Three channels, each with one job:

- **`phase`** — where the thread is right now. Observational, for rendering.
- **the promise returned by `send`** — how that submission ended. Control flow.
- **`onUpdate`** — the one constructor-supplied collaborator: "re-render". Every other effect the core emits today is derivable from the first two channels.

Plus one lifecycle promise, `result`, for "this thread is finished".

## The missing layer, and the names

Everything below describes a boundary between two objects, but there are really *four* layers, and today two of them are fused. Naming them apart is what makes the rest of this document coherent.

- **`Runner`** (`AnthropicRunner`, `OpenAIRunner`) — what `providers/anthropic-agent.ts` and `providers/openai-agent.ts` implement today under the name `Agent`. Provider-specific, sits on the raw client, exposes `runTurn`. Renamed because the innermost layer varies along a *provider* axis, and a name like `NativeAgent` would read as a subtype of `Agent` rather than a component of one.
- **`Agent`** — what is called `ThreadCore` today. Provider-agnostic, owns one message list and one system prompt, holds the tool executor, and offers the three hooks. It is **ephemeral**: compaction does not mutate it, compaction *replaces* it. It therefore has no stable id.
- **`Thread`** — new. Owns the stable `ThreadId`, the queued-message list, compaction, the archive logger, and the context/git managers. It holds a current `Agent` and swaps it on compaction. This is the layer that matches the user's meaning of "thread": thread 3 is still thread 3 after a compaction, which is exactly why the archive keys by thread id and why the logger lives here.
- **`NvimThread`** — the plugin wrapper, currently `node/chat/thread.ts`. Attaches views and the view-only state that powers them.

There is no collision with `node/core/src/agents/` — those are persona/prompt profiles (`explore`, `fast-edit`, `think`), and an `Agent` is *configured with* one. The vocabulary lines up.

The evidence that this layer is missing rather than invented: `thread-core.ts:1575-1584` destroys the `ContextManager` and constructs a fresh one as part of compaction. There is no reason a compaction should forget which files you are watching. That is pure layering damage from the context manager living inside the thing compaction replaces. In the split it is a `Thread` field that simply outlives the swap, and `ContextTracker` no longer needs to be injected — `Thread` wires the `Agent`'s edit signal into its own manager.

The hooks in this document (`onEndTurn`, `onYield`, `onBeforeRequest`) are the `Agent` → `Thread` boundary. `Thread` implements them; `NvimThread` and scripts do not see them. What `Thread` exposes upward is `onUpdate` plus the supervisor arbitration it chooses to delegate.

**Naming note for the rest of this document:** the sections below were written against the current names. Read `ThreadCore`/`core` as the new `Agent`, except where a responsibility is explicitly said to move out to the owner — those move to `Thread`.

## Phase

`ThreadMode` is replaced by a phase whose variants are the states a _thread_ passes through, with the intra-turn detail delegated rather than duplicated:

```ts
export type ThreadPhase =
  | { type: "idle"; lastResult: SendResult | undefined }
  | { type: "running"; activity: TurnActivity }
  | { type: "compacting"; chunkIndex: number; totalChunks: number }
  | { type: "aborting" };

/** The intra-turn detail, surfaced here so consumers never read
 * `core.agent.phase` themselves. */
export type TurnActivity =
  | {
      type: "streaming";
      block: StreamingBlock | undefined;
      retry: RetryStatus | undefined;
    }
  | {
      type: "running_tools";
      activeTools: ReadonlyMap<ToolRequestId, ActiveToolEntry>;
    };
```

`idle.lastResult` replaces `state.lastTurnResult` _and_ `state.failedSubmit`: a failed submission is `{type: "idle", lastResult: {type: "failed", ...}}`, which is one thing to render rather than two fields to correlate. This is the one place the agent doc's rule ("`idle` carries no `lastStop`") is deliberately inverted: the agent hands its outcome to a caller who is waiting on it, whereas a thread's last outcome must stay renderable indefinitely after the caller has moved on.

### There is no `yielded` phase

Which settles the question the agent doc raised one layer down. `phase` is _where the thread is right now_; every outcome — including the terminal one — travels by promise. A yielded thread is `{type: "idle", lastResult: {type: "yielded", value}}`: at rest, with a record of how it got there. Adding a `yielded` variant would make the same fact readable from `phase`, from `send`'s result, and from `result` — three channels, which is exactly the defect being removed.

The three channels each answer a different question, and none of them overlaps:

- `phase` — "what is this thread doing?" Never carries an outcome except as the deliberate `idle.lastResult` copy, which is render-only.
- `send` — "how did _my_ submission end?" Private to the submitter.
- `result` — "is this thread finished, and with what?" For actors who never submitted: the subagent tool, the script runner.

What made `mode: "yielded"` feel like a state today is that it is _absorbing_: `sendMessage` refuses when `tornDown`, `abort` no-ops, `Chat` stops counting it as needing attention. But with teardown moved out to the shell (see the supervisor section), the core has no opinion left — "this thread is finished" is the shell's conclusion from a settled `result`, and it is the shell that owns the container, the overview entry, and the decision to refuse further input. A core whose last submission yielded is simply idle; nothing stops it from taking another `send`, and `spawn-subagents`' resume path already relies on that being possible.

### A yield is not necessarily a string

A thread constructed with a `yieldSchema` yields structured data — the `yield_to_parent` spec is replaced by the caller's schema, and the model's tool input _is_ the result. `ThreadCore` currently flattens that to a string:

```ts
yieldResult =
  this.context.yieldSchema !== undefined
    ? JSON.stringify(entry.request.input)
    : (entry.request.input as { result: string }).result;
```

and `script-manager.ts:469` un-flattens it with a `JSON.parse` in a `try` whose `catch` falls back to the raw string. That fallback is the whole problem: the receiver cannot tell a structured yield from a text yield that happens to be valid JSON, so it guesses. A thread that returns the literal text `null` or `42` is silently reinterpreted.

The type should say which:

```ts
export type YieldValue =
  | { type: "text"; text: string }
  /** conforms to the `yieldSchema` this thread was constructed with */
  | { type: "structured"; value: unknown };
```

Which variant a thread produces is fixed at construction — a thread either has a schema or does not — so this is not a per-yield branch the model can influence. `SendResult.yielded` and `ThreadResult` both carry a `YieldValue`, and `onYield` receives one.

Two consequences:

- **Stringification becomes a display decision.** `spawn-subagents` renders a child's result into a tool result and `chat.ts` renders it into the thread overview; both are free to `JSON.stringify` for that purpose. What changes is that the _transport_ stops doing it, so the script SDK gets its object back without a parse-and-hope.
- **`YieldAction.accept.resultPrefix` is only meaningful for text.** `DockerSupervisor` returns `resultPrefix: "[Changes synced to ...]"`, which today is string-concatenated onto whatever the yield was — including a JSON blob, producing a value that is neither text nor parseable. With the union, prefixing a `structured` yield is a type error, which is the right outcome: a supervisor that wants to annotate a structured result needs a different mechanism, and the docker case only ever runs on text-yielding threads.

### The yield tool result is where the hook's answer goes

The agent's invariant is that every `tool_use` is answered by exactly one result before the next assistant turn, and `suspend` carries results just like `continue` does — so the yield call gets a result either way. Today `ThreadCore` writes a fixed one ("Yield accepted. Your result has been sent to the parent thread.") and the agent doc notes that nothing reads it, keeping it only so history stays well-formed.

But with `onYield` able to say _no_, that result is a lie in the reject case. Today's sequence is: executor returns `suspend` with "Yield accepted…" → `runTurn` resolves `suspended` → `handleSuspend` → `handleYield` → the supervisor rejects → `sendMessage` starts a _new_ turn with a system message saying the yield was refused. The transcript reads "you yielded successfully" immediately followed by a fresh user turn contradicting it, and the thread visibly stops and restarts.

The fix is to consult the hook **inside `executeTools`, before choosing the outcome** — which is possible precisely because the executor is already async and the agent is already awaiting it:

- _accepted_ → the yield's tool result says so; return `{type: "suspend"}`. The agent parks, `runTurn` resolves `suspended`, `send` resolves `{type: "yielded", value}`.
- _not accepted_ → the yield's tool result carries the pushback text; return `{type: "continue"}`. The agent issues its normal continuation request carrying that result, and the turn never ends. No second submission, no contradicting message, and the refusal arrives in the position the model expects an answer — as the result of the call it made.

This also collapses `YieldAction` from four variants to two. `reject` and `send-message` differ only in wording, and `none` is `accept` with nothing added:

```ts
export type YieldAction =
  /** the thread is finished; optionally amend what it yields */
  | { type: "accept"; value?: YieldValue }
  /** refuse, and tell the model why, as the yield tool's result */
  | { type: "continue"; toolResult: string };
```

`accept.value` replaces `resultPrefix`: a supervisor that wants to annotate the result returns the amended value, which works for `structured` yields too instead of string-concatenating onto a JSON blob.

Note what this does to the timing of docker teardown: it now runs while the thread is still `running`, before `send` resolves, rather than after the turn has already unwound. That is more honest — the thread genuinely is still working — and it means a `send` that resolves `yielded` guarantees teardown already finished, which today is only true by luck of ordering.

The one thing to preserve: the executor must still return a result for the yield call before suspending, so the archived and forkable history is well-formed. That was the original justification for the synthetic result, and it survives — the result just stops being write-only.

### Contrast with the agent layer

The same shape, with one deliberate difference. `TurnResult.suspended` carries no reason, because the agent cannot know one — `ThreadCore` stashes it in a private `suspendReason` and reads it back when the turn resolves. `SendResult.yielded` _does_ carry the value, because the thread genuinely owns `yield_to_parent`'s meaning: it is the thread's tool executor that recognises the call and produces the value. The information reappears at exactly the layer that can name it, and the private `suspendReason` field is the seam where it crosses over.

`running.activity` is a projection of `agent.phase` — the same fact in two places, which the agent doc forbids. It is worth it here because the alternative is every view importing the agent to render a thread, and it is safe because the projection is total and read-only. It should be a **read-through getter**, not a stored mirror: the view wants the agent's live streaming internals (`retry.nextRetryAt`, `startedAt`, `lastEventTime` — see below), all of which move between renders, so a copy would be a copy of everything and stale by construction. The cost is that `phase` is not plain data; that is the right trade for a field whose whole job is to be current.

`compacting` becomes a phase rather than a mode plus a live `compactionController` field that tests reach into (`thread-compact.test.ts` reads `compactionController?.chunks.length`). Anything the view needs during compaction goes in the phase.

## `send` returns how it went

`sendMessage` / `handleSendMessageRequest` / `sendRawMessage` collapse into one:

```ts
export type SendOptions = {
  /** async: run after the current turn. next: run at the next stop.
   * undefined: abort whatever is running and send now. */
  queue?: "async" | "next";
};

export type SendResult =
  | { type: "completed" }                       // agent reached end_turn
  | { type: "yielded"; value: YieldValue }      // the thread is done
  | { type: "aborted" }
  | { type: "failed"; error: Error; resubmit: string | undefined };

send(messages: InputMessage[], opts?: SendOptions): Promise<SendResult>;
```

`send` resolves when the thread comes to rest — after auto-respond loops, supervisor nudges, the max_tokens continue-prompt and compaction handoffs, all of which are internal continuations, not separate submissions. A queued send resolves when _its_ submission comes to rest, not the current one.

This deletes `turnEnded` and `TurnEndReason`, and it deletes the poll-for-`lastTurnResult?.type === "failed"` loops in `spawn-subagents.test.ts` and `script-manager.test.ts`.

### `turnEnded` becomes the awaited result

The whole of `Thread`'s `turnEnded` handler — dispatch a local `turn-ended` message, then notify the user unless the reason was `aborted` — is a `switch` on a value it was handed:

```ts
// before: subscribe in the ctor, filter, dispatch
core.on("turnEnded", ({reason}) => { ... });

// after: at the call site that caused it
const result = await core.send(messages);
if (result.type !== "aborted") notify(result);
```

Two things this forces us to be precise about, both of which the event blurs:

- **A turn without an outer caller.** The auto-resubmit timer in `maybeAutoResubmitAfterError` and the post-compaction continuation in `handleCompactComplete` both call `sendMessage` with nobody awaiting. These are continuations of the original submission, so they attach to the _same_ deferred; the outer `send` resolves when the thread finally comes to rest, which is the answer its caller actually wanted. Nothing in the system creates a turn that no promise is attached to.
- **A caller who is not the submitter.** `abort` and the yield path are observed by actors who never called `send`. Those read `phase` (for live state) or `result` (for the lifecycle) — the `send` promise is private to its submitter and is not a general turn-end broadcast. This is the one substantive thing the event provided that a promise does not, and the answer is that nobody needed it: today's only `turnEnded` subscribers are the archive logger — which is exactly such a non-submitter,   the archive logger — which is exactly such a non-submitter, and which turns out to need only `phase`, not the outcome (see the archiving section) — — and the notification, which belongs to the submitter. `failed.resubmit` carries the rolled-back user text. `discardFailedSubmit` stays, because deciding whether to roll back is the caller's policy — but it becomes reachable only while `phase` is `idle` with a `failed` result, which is checkable instead of being a silent no-op on a missing `preSubmitNativeIdx`.

## `result` for the lifecycle

```ts
/** Resolves when the thread yields (or is torn down without yielding).
 * Settles at most once. */
readonly result: Promise<ThreadResult>;
```

This replaces `ThreadManager.getThreadResult` + `onThreadYielded` + `Chat.threadYieldCallbacks` + `fireThreadYieldCallbacks` + the "poll once in case it already yielded" line in `spawn-subagents.ts`. A promise is immune to the missed-edge problem those exist to paper over.

`ThreadManager` keeps a method — subagent tools address threads by id and must not hold thread objects — but it becomes `awaitThreadResult(id): Promise<ThreadResult>`, a lookup plus a `.result`.

## The effect events don't become hooks — they disappear

`ThreadCore` has no business knowing about chimes, cursor scrolling, or input buffers. Renaming a broadcast to a callback keeps the coupling and only changes its delivery mechanism.

Working through each one, every effect is already recoverable from the two channels we have — an outcome the caller is holding, or a phase the caller can see:

- **`playChime`** fires at turn end and when tools start executing. Turn end is `send`'s resolution — the caller is holding that promise. Tool start is `phase.activity.type === "running_tools"`, which the caller is already re-rendering on. Whether either deserves a bell is a UI policy that belongs in the sidebar, not in the thread.
- **`scrollToLastMessage`** fires 100ms after a submission the caller itself made. The caller can scroll when it calls `send`; the `setTimeout` exists only because the emit had to outrun the render.
- **`setupResubmit`** hands back the rolled-back user text after a failure. That is `SendResult.failed.resubmit`, delivered to exactly the actor that submitted. Its `setTimeout(..., 1)` disappears with it.
- **`recoverPendingMessages`** hands back queued text that will never be sent because of an abort. So `abort()` returns it: `abort(): Promise<{unsent: ReadonlyArray<QueuedMessage>}>`. The caller aborted; the caller gets the debris.
- **`aborting`** exists so `Thread` can reject pending sandbox violations before teardown. Aborts are always caller-initiated — either directly, or via a `send` with no `queue` option, which the caller also issues — so the caller can do that work around its own call.

What is left is one thing that genuinely cannot be derived, because it is the signal that derived things need recomputing:

```ts
export interface ThreadCoreOptions {
  // ...existing ThreadCoreContext fields
  /** "Something visible moved." No payload: read `phase`. Called at
   * streaming rates and not throttled; the recipient coalesces. Guaranteed
   * to fire once more after the thread comes to rest, before any outcome is
   * delivered. */
  onUpdate(): void;
}
```

**The core does not throttle it.** `scheduleUpdate` / `flushUpdate` / `flushUpdateNow` and the 32ms timer move out to the view layer.

Two obligations come with moving it:

- **The core must emit a final `onUpdate` once the thread is at rest, before resolving `send`.** This is what `flushUpdateNow` was really for — not the throttle, but the ordering guarantee that the last visible state is announced before the outcome is. That guarantee is cheap to keep without a timer.
- **The recipient's debounce must be trailing-edge**, or that final call gets dropped and the view keeps a stale streaming block forever. Leading-edge- only throttling is the one implementation that breaks here, so it is worth saying out loud rather than discovering.

The same argument applies to the ~1s dead-air ticker that currently lives in the agent and exists solely so the "waiting Ns" counter advances while nothing happens. That is a re-render schedule for a clock, not a fact about the conversation, and the view can run it off `phase.activity.lastEventTime`. It is a separate change in a separate file, so it is noted here rather than folded in.

It is a constructor dependency rather than an event for the same reason as the agent's: one subscriber for the object's whole lifetime, and a subscription that outlives its target is invisible until it fires. It subsumes both `update` and `pendingUpdatesChanged` — `Thread`'s handlers for the two are the identical dispatch — and carries no payload, so nobody can start diffing instead of reading `phase`.

## Archiving is a view, not a channel

`ThreadCore` constructs a `ThreadLogger`, hands it two pull-callbacks, then subscribes to its own emitter to drive it — and separately calls `recordTitle`, `recordCompaction` and `resetCursor` from three other places, plus re-exports `flushed()` as `awaitArchiveFlush()` for tests. Five call paths and a self-subscription for a component whose entire job is to watch.

The self-subscription is the tell. An object routing notifications to a collaborator it owns through a public broadcast channel is admitting the channel exists for someone else, and then free-riding on it.

The first instinct is to give the archive its own `ThreadObserver` interface — `onMessagesAppended` / `onTurnEnd` / `onTitle` / `onCompaction`. But look at what `ThreadLogger` actually is:

```ts
onUpdate()    { flush(messages, messageCount - 1); }  // all but the streaming one
onTurnEnded() { flush(messages, messageCount); }      // including the last
```

It is a **cursor-differ over `messages`, driven by "something changed"** — which is to say, it is already a view. It renders to a file instead of a buffer, and its `persistedCount` is the same bookkeeping every incremental renderer keeps. Handing it a push-based observer interface would mean the core recomputing a delta the archiver is perfectly capable of computing, through a channel invented for one consumer.

So there is no `ThreadObserver`. The archive attaches through `onUpdate` and the readonly projections, like any other view:

- **Messages** — diff the current agent's `messages` against its own cursor. Unchanged from today, minus the two injected pull-callbacks.
- **"Withhold the streaming message"** — today's `onUpdate`/`onTurnEnded` split exists only to answer "is the last message final yet". That is `core.phase.type === "idle"`, and the guaranteed final `onUpdate` at rest is exactly the edge `onTurnEnded` was firing on. Two entry points collapse into one, and the archiver reads the answer instead of being told it.
- **Title** — `core.title` is a readonly projection; diff it.
- **Compaction** — with the `Agent`/`Thread` split, compaction *is* the `Agent` being replaced, so the archiver does not need `compactionHistory` to notice it: the identity of `thread.agent` changed. Its rule is simply "log any messages not yet logged", and on seeing a new `Agent` it resets its cursor to 0 and logs that agent's messages from the start — which is correct, because a post-compaction agent starts with a fresh, summarized message list. `resetCursor` stops being a method anyone calls; it is the archiver's own reaction to an identity change, and the cursor is its state, not the thread's.
- **Flushing** — `awaitArchiveFlush()` disappears; the owner holds the logger and awaits `logger.flushed()`. Tests construct the logger they want, or none.

This is a better answer than the observer for the reason this document keeps arriving at: it adds no channel. The core already has to say "something moved" and already has to expose the conversation for rendering; an archive needs nothing beyond those two, so a third mechanism would only be carrying information that was already crossing the boundary.

It also settles the non-submitter problem raised in the `turnEnded` discussion. The archive must see turn ends nobody awaited — but it does not need the *outcome*, only the fact that the thread is at rest, which `phase` states plainly. `SendResult` stays private to submitters, and nothing needs a broadcast copy of it.

Two consequences for construction:

- **No construction-order puzzle.** The archiver needs the core to read from, so the owner builds the core first and the logger second, wiring its own `onUpdate` to fan out to renderer and archiver. The `observer?: (id) => Observer` factory a push interface would have needed is unnecessary.
- **`ThreadCoreContext` loses `conversationLogBaseDir` and `scriptName`, and the constructor loses its `forkProvenance` parameter** — all three exist solely to configure the logger, which the owner now configures directly. Three fewer fields in a bag that has 30.

## Hooks are constructed with, not registered on

Three questions, one answer:

**One hook or a list?** One. The moment there are N, something must decide what happens when two disagree — and that merge rule is exactly what we just moved out of the core. A `registerHook` API would not merely reintroduce it, it would freeze it: the core would impose one arbitration policy on every consumer, where `composeSupervisors` lets each thread type choose. Going 1 → N later is a local change at the single assignment site; going N → 1 is not, so singular is the conservative direction.

**Register/unregister?** No. Supervisors are assigned once at thread init and never touched again; there is no caller for `unregister`, and it is the half that carries the bug, since a forgotten unsubscribe is invisible until it fires. That is the hazard `on`/`off` was deleted from the agent to remove, and re-adding it for a use case nobody has would be a poor trade.

**Constructor or assignable property?** Constructor. The apparent obstacle is a cycle — `DockerSupervisor`'s `onProgress` looks like it needs the thread — but it only needs `thread.id` to dispatch, and the id is generated before construction. Once teardown progress lives in `Chat`'s state rather than `ThreadPhase`, no hook closes over the core. So hooks become `readonly`, and "hooks are set before the first `send`" stops being a rule to remember or an assertion to write; it is true by construction.

### Amendment: `onBeforeToolResponse` should be a constructor option too

The agent doc made it an assignable property "precisely because it is optional". That reasoning conflated two things. The real force behind it was _lifetime_: compaction discards the agent and `createFreshAgent` must reinstall the hook, and cloning produces an agent before its new owner exists — which is why `bindAgent` exists and calls `agent.bindHooks({executeTools, onUpdate})` after the fact.

But post-construction binding is what makes that dangerous, not what makes it work. Between `agent.clone()` and `bindHooks`, a cloned agent exists whose `executeTools` still points at the _source_ thread; nothing prevents a `runTurn` in that window, and nothing type-checks that `bindHooks` was ever called. The fix is to hand the collaborators to the operation that creates the agent:

```ts
clone(hooks: AgentHooks): Agent;   // was: clone(): Agent
```

Then `AgentOptions` carries `executeTools`, `onUpdate` _and_ `onBeforeToolResponse`; `bindHooks` and `bindAgent` are deleted; and there is no moment at which an agent exists with the wrong owner's hooks, or none. The rule generalizes to: **a collaborator is supplied wherever the object is created — construction, clone, or recreation-after-compaction — and never afterwards.** Optionality determines whether the field can be omitted, not when it can be set.

This is a small change to already-shipped code rather than part of the ThreadCore cut-over, but it belongs in the same stage: `ThreadCore.clone` (static) is the only caller of `agent.clone()`, and it is being rewritten anyway.

## What `core.agent` is actually used for

`agent` is public, so in principle the whole `Agent` interface is `ThreadCore` API. In practice the outside world uses four things, and only three of them are real:

1. **Streaming detail for the status line.** `thread-view.ts:433,1155` read `agent.phase` and `renderStatus` switches on it: `retry.nextRetryAt` / `retry.attempt` / `retry.error` for the backoff countdown, `startedAt` for the spinner frame, `lastEventTime` for the dead-air "waiting Ns". This is the reach-through that `phase.activity` is for. Note how specific the dependency is — the view wants the agent's _streaming_ internals, not the agent — which is the argument for `activity` being a read-through getter rather than a mirrored copy: there is nothing to mirror that the view would not immediately want in full.

2. **Token counts.** `agent.log.latestUsage` (thread-view.ts:459) and `agent.log.inputTokenCount`. Already half-wrapped by `getLastStopTokenCount()`; finish the job with a `readonly usage` projection so no view imports `Agent`.

3. **A message address for forking.** `chat.ts:1376` calls `sourceThread.agent.getNativeMessageIdx()` to pick a fork point, and passes it to `ThreadCore.clone`. This is the one place the outside world legitimately needs the agent's history addressing scheme, and the agent doc deliberately left `NativeMessageIdx` alone. Wrap it as `core.currentMessageIdx(): NativeMessageIdx` — same value, but the branded type stays the vocabulary and the agent stops being the way to get one. The `nativeMessageIdx` stamped on each `ProviderMessageContent` remains how the view names an _earlier_ point, unchanged.

4. **Quiescence polling in tests.** `if (core.agent.phase.type !== "idle") throw new Error("waiting")` appears ~10 times in `thread-core.test.ts` alone, plus `thread-compact.test.ts` and `thread-abort.test.ts`. These are asking "is the thread at rest", and they ask the agent because the thread could not answer. Most become `await send(...)`; the ones that genuinely need to poll (a turn started by something other than the test) poll `core.phase.type === "idle"`. `thread-abort.test.ts:37,142` assert `streaming` / `running_tools` specifically — those become assertions on `phase.activity`.

And one that is simply dead: `Chat.getContextAgent()` (chat.ts:576) has no callers. Delete it.

Nothing outside `ThreadCore` calls a _mutating_ agent method. `runTurn`, `abort`, `truncateMessages` and `clone` are all invoked from inside the core (`clone` from the static `ThreadCore.clone`). So making `agent` private costs nothing but the three projections above — the exposure is accidental, not load-bearing.

### Constraint: the agent is a private implementation detail

`agent` becomes `private`, and `Thread`'s pass-through getter (`thread.ts:228`) is deleted. Which agent a thread is driving, when it swaps one for another, and how it is fed are internal — the same relationship `ThreadCore` has with `ContextManager` or `CompactionManager`, none of which anyone should be reaching through either.

This is stronger than "nobody currently mutates it", and it is what keeps the two redesigns from re-coupling. The agent doc gave the agent a tightly controlled turn-taking protocol; if `ThreadCore` hands the agent out, every consumer can start a turn behind the thread's back, and "is a `runTurn` in flight" stops being answerable by `ThreadCore.phase`. The thread's whole claim — that `phase.type !== "idle"` is exactly "busy" — depends on it being the only caller of `runTurn`.

The line to hold is **data out, object in**. Provider _values_ — `ProviderMessage`, `StreamingBlock`, `RetryStatus`, `Usage`, `NativeMessageIdx` — remain part of `ThreadCore`'s vocabulary, because the conversation is what a thread is about and re-wrapping them would buy nothing. The `Agent` _object_ does not escape.

Two places this bites beyond the four uses above:

- **Compaction's agent swap** is invisible from outside once `agent` is private, which it should be: today anyone holding `core.agent` across a compaction is holding a discarded object, and nothing says so. This is the same hazard the agent doc removed by deleting `on`/`off` — a reference that outlives its target.
- **`prependToNextTurn(content: AgentInput[])`** takes the agent's input type, so the vocabulary leaks even with the object hidden. Its two callers pass a fork notification and a compaction summary — both plain text — so it becomes `prependToNextTurn(text: string)`, or takes the same `InputMessage` shape `send` does. Likewise `pendingTurnContent` returns text, not `AgentInput`.

## Supervisors move out; the core exposes hooks

`ThreadCore` today owns `public supervisors: ThreadSupervisor[]`, assigned from `chat.ts:777-801`, and three private `consult*` methods that fan out over the array and merge the answers. Three things are tangled there:

- _The decision points_ — "the agent stopped without yielding", "a yield arrived", "should we compact before continuing". These are genuinely the core's: only it knows when they occur.
- _The policies_ — restart-with-a-nudge, reject-XML-yield-tags, compact-above-N-tokens, teardown-the-container-on-yield. None of these are the core's; `DockerSupervisor` lives in the root project already, and `AutoCompactSupervisor`'s threshold comes from plugin options.
- _The composition_ — `consultEndTurnSupervisors` joins every `send-message` text with `\n\n`; `consultYieldSupervisors` returns the first `accept` or `reject` and otherwise joins texts; `consultHandoffSupervisors` ORs the `compact` flags and joins the prompts. This is arbitration policy over a plural collaborator, and it is the part with actual semantics in it — yet it is buried in the core, where nothing motivates it.

So: keep the decision points, delete the array and the arbitration. The core asks _one_ question of _one_ optional hook, exactly as the agent asks `onBeforeToolResponse`:

```ts
export interface AgentHooks {
  /** The agent stopped without yielding. Return text to continue with, or
   * nothing to let the thread come to rest. */
  onEndTurn?: (ctx: EndTurnContext) => EndTurnAction;

  /** The agent called yield_to_parent. Accept (the thread is finished),
   * reject, or push back with a message. Awaited: container teardown
   * happens here. */
  onYield?: (result: string) => Promise<YieldAction>;

  /** About to issue a provider request — the opening one of a submission, or
   * a continuation carrying tool results. Return `compact` to hand off
   * instead, or `inject` to interject text. */
  onBeforeRequest?: (ctx: RequestContext) => RequestAction;
}
```

The `ThreadSupervisor` interface, the three built-in supervisors and a `composeSupervisors(...)` helper that implements today's merge semantics stay in `@magenta/core` as a **library** — they are genuinely reusable, and scripts and the root project both want them. The point is that `thread-core.ts` imports none of it. `Chat` builds its supervisor list exactly as it does now, composes it once, and assigns the three hooks. If nobody ever composes more than one supervisor again, the helper dies quietly and nothing in the core changes.

Points worth being explicit about:

- **Constructor options, not assignable properties** — see below; this amends the rule the agent doc set. A thread with no hooks still runs fine; optional means the field may be omitted, not that it may be installed late.
- **Hooks are questions; `onUpdate` is a signal.** Two channels that both look like callbacks but differ in who needs the answer. A hook's return value changes what the core does next — that is what makes it not an event, and what makes "just emit and let someone call back in" the wrong shape for it.
- **Hooks fire inside a submission, so they do not resolve `send`.** An `onEndTurn` that returns `send-message`, an `onYield` that returns `reject`, and an `onHandoff` that returns `compact` are all continuations — the same rule as auto-resubmit and post-compaction. The submitter's promise resolves only when the thread actually comes to rest. This is the crux of why the hooks cannot be replaced by the caller awaiting `send` and deciding for itself: by then the thread has already stopped, and "stopped, then poked again" is a different conversation shape from "never stopped".
- **Re-entrancy**, same rule as the agent's executor: a hook must not call back into the core. It returns an action; the core performs it.
- **`onBeforeRequest` is the mid-turn interjection point, and that is why it cannot be `await core.send(...)`.** The obvious objection to this hook is that auto-compaction is a decision the caller could make for itself after awaiting a submission. But `consultHandoffSupervisors` is called from _two_ places, and only one of them is a turn end: the other is inside `executeTools`, after a round of tools has finished and before the agent issues the continuation request carrying their results. No `send` is resolving there — the thread is mid-turn and, in a long tool-using run, may not stop for many rounds. Since the thing this hook exists to prevent is running out of context window, waiting for a stop is exactly the wrong time to ask.

  The name should therefore be about the thing being gated, and the unit it gates is a **provider request** — the same vocabulary the agent doc uses for `onBeforeToolResponse` ("the continuation request that carries tool results"). "Handoff" names one possible answer rather than the occasion, and "turn" is already spoken for: a turn is what `runTurn` runs, and there are many requests inside one. `onBeforeRequest` fires once per request the agent is about to issue, including the opening request of a submission — uniform, and the cheapest place to notice that the context window is nearly full before paying for another round.

  It does _not_ re-fire on a retry of a failed request, matching the rule the agent doc set for `onBeforeToolResponse`: retries are one request, not several.

  This is not the general `onBeforeRequest` the agent doc rejected. That one was proposed at the agent layer and would have supplied request _content_, where it would have added no capability over `runTurn`'s argument while forcing every implementation to branch on first-vs-continuation. This one lives a layer up, sees no content, and answers a control question — proceed or hand off — which nothing else can answer at that moment.

  It is also the natural place for future interjections that are not compaction — forcing a pause, budget enforcement, injecting a reminder. `RequestAction` is `compact | none` today because that is all anyone needs; the shape admits more without a new hook.

- **Docker teardown progress stops being core state.** `DockerSupervisor`'s `onProgress` currently calls `core.update({type: "set-teardown-message"})`, which is one of the two outside uses of the public reducer. With the yield hook owned by the shell, the shell also owns the progress message: it lives in `Chat`'s thread-summary state, not in `ThreadPhase`. So `phase.yielded.teardownMessage` and the proposed `setTeardownMessage()` method both disappear, and `tornDown` — which the core only knows because a supervisor told it — becomes the shell's business too. `phase.yielded` is no longer part of the core's vocabulary at all.

That leaves `activateReminder` as the sole survivor of the public reducer's two outside callers, which is a much easier thing to justify or delete.

## Context updates ride on the message, not on an event

`contextUpdatesSent` / `gitContextUpdateSent` exist so `Thread` can stash the update under `messageViewState[getProviderMessages().length]`. That index is computed by the _receiver_ at delivery time, which is only correct because the emit happens to precede the message append.

There is a duality here that the current code handles badly. A context update has two forms: the **plaintext**, which is injected into the conversation and round-trips through the inference API, and the **structured record**, which the view needs in order to render it as a collapsed section rather than a wall of file contents. Historically the structured form was re-derived from the plaintext by parsing; that is brittle.

Instead, mint both at the same moment, on the owner's side. `Thread` produces the plaintext and the structured record together, hands the plaintext to the `Agent` for injection, and the structured record is attached to the message the injection produced. The view suppresses the plaintext rendering by observing the record. Nothing is ever parsed back out. The events disappear, the index race disappears, and the record survives a fork/clone (today it does not — `messageViewState` is root-side).

The injection point is `onBeforeRequest`, for all three of the current emit sites — the ordinary submission at `thread-core.ts:1171` and the two continuations at ~1395 and ~1438. This is the general shape: **any outside process that wants to interject text into the conversation does it by answering `onBeforeRequest`.** The context manager watching the filesystem is the first such process; reminders and budget notices are the same shape. Because the hook fires on the opening request of a submission as well as on continuations, `Thread` never concatenates context text into `send()`'s argument — it answers the hook the same way in both cases, and the asymmetry that made the index a guess is gone.

`RequestAction` therefore grows an injection variant carrying an opaque annotation the `Agent` parks on the message it constructs:

```ts
type RequestAction =
  | {type: "none"}
  | {type: "compact"}
  | {type: "inject"; text: string; annotation?: unknown; alsoCompact?: boolean};
```

The `Agent` stays ignorant of what a context update is. `activateReminder` collapses into the same mechanism — a reminder is an injection with no annotation — which removes the public reducer's last outside caller.

## `state` becomes readonly, `update` becomes private

`ThreadCoreAction` stops being public. The two outside callers get methods:

- `core.update({type: "activate-reminder", text})` → `core.activateReminder(text)`
- `core.update({type: "set-teardown-message", message})` — deleted; teardown progress moves out with the supervisors.

The remaining reads (`title`, `systemPrompt`, `toolSpecs`, `compactionHistory`, `editedFilesThisTurn`, `pendingMessages`, `pendingNextMessages`) become a `readonly` view. `pendingMessages` and `pendingNextMessages` merge into one `readonly queued: ReadonlyArray<QueuedMessage>` where `QueuedMessage` carries `{when: "async" | "next"}` — the view already renders them as two labelled sections of one list, and `handleStopped` already concatenates them.

## Interfaces

```ts
/** Ephemeral. One message list, one system prompt. Replaced, not mutated, at
 * compaction. Has no stable id. */
export interface Agent {
  readonly phase: AgentPhase; // idle | running | aborting
  readonly messages: ReadonlyArray<ProviderMessage>;
  readonly editedFilesThisTurn: ReadonlyArray<EditedFile>;
  readonly usage: {
    latest: Usage | undefined;
    inputTokenCount: number | undefined;
  };

  /** Address of the current end of history, for forking. */
  currentMessageIdx(): NativeMessageIdx;

  send(messages: InputMessage[], opts?: SendOptions): Promise<SendResult>;
  abort(): Promise<void>;
  prependToNextTurn(content: AgentInput[]): void;
  destroy(): Promise<void>;
}

/** Stable identity. Owns the queue, compaction, the archive logger and the
 * context/git managers. Holds a current `Agent` and swaps it on compaction. */
export interface Thread {
  readonly id: ThreadId;
  readonly agent: Agent; // identity changes at a compaction boundary
  readonly phase: ThreadPhase; // idle | running | compacting | aborting
  readonly result: Promise<ThreadResult>;

  readonly title: string | undefined;
  readonly queued: ReadonlyArray<QueuedMessage>;
  readonly compactionHistory: ReadonlyArray<CompactionRecord>;

  send(messages: InputMessage[], opts?: SendOptions): Promise<SendResult>;
  /** Returns the queued messages that will now never be sent. */
  abort(): Promise<{ unsent: ReadonlyArray<QueuedMessage> }>;
  compact(nextPrompt?: string): Promise<void>;
  discardFailedSubmit(): void;
  setTitle(title: string): void;
  destroy(): Promise<void>;
}
```

Notes on the shape:

- Neither `Agent` nor `Thread` names a UI concept. If a reviewer finds "chime", "scroll", "buffer" or "notification" in either after this, the split has regressed.
- **Two `send`s, deliberately.** `Agent.send` starts a submission now or throws if one is running; `Thread.send` queues. `SendResult` is the same type for both, and a queued `Thread.send` resolves with the outcome of its own submission — the queue is the only reason `Thread.send` can be called while busy.
- **`Agent.abort()` returns no unsent list** — there is no queue at that layer. `Thread.abort()` aborts the agent and returns the messages the queue will now never deliver.
- **`compact()` is `Thread`-only**, and is the operation that replaces `thread.agent`. `AgentPhase` has no `compacting` variant; a `Thread` is `compacting` while it holds an agent that is winding down and builds the next one.
- `abort()` returns a promise rather than relying on the caller's own: `send`'s promise belongs to whoever submitted, which may be a different actor than whoever aborts.
- `compact()` returns a promise so the handoff is awaitable; today it is fire-and-forget through an event on `CompactionManager` whose completion is only observable as a mode change.
- `getProviderStatus()`, `getMessages()`, `getProviderMessages()` and the `state` bag are deleted in favour of the readonly projections. `getLastStopTokenCount()` stays.
- `clone` (static) lives on `Thread`; it must supply a fresh `ThreadHost` and a fresh id, and must not carry the source's `result` promise across.
- `thread.agent` is a readonly projection, not a handle to act through. `Thread` is the only caller of `Agent.send` / `Agent.abort`. Exposing it is what lets the archive and the views diff messages without a second copy of the conversation; the invariant below is what keeps that from becoming a back door.

# Invariants

- Neither `Agent` nor `Thread` contains a timer whose period is a rendering decision. `32` does not appear in either.
- **The layer rule.** `Agent` knows nothing of `ThreadId`, compaction, the queue, the archive, or the context manager. `Thread` never calls a `Runner` directly. The names are load-bearing: if `Agent` grows a stable id, or `Thread` grows a message list of its own, the split has collapsed back.
- `thread.agent` is only ever *read* from outside `Thread`. No consumer calls `agent.send`, `agent.abort` or `agent.prependToNextTurn`; a grep for those outside `thread.ts` returns nothing.
- The context manager survives a compaction. Nothing destroys or reconstructs it as part of the handoff.
- A final `onUpdate` fires after the thread reaches rest and before `send` resolves, so a trailing-edge debouncer always paints the terminal state.- Exactly one `SendResult` per `send` call, and no fact in it is also discoverable through `phase`. The exception is deliberate and one-way: `idle.lastResult` is a _copy_ of the most recent `SendResult`, for rendering only; nothing may branch on it for control flow.
- "Is the thread busy" is exactly `phase.type !== "idle"`. No consumer computes it any other way.
- `result` settles at most once, and only from an accepted yield or from `destroy()`. A destroyed thread that never yielded settles with an error result rather than hanging.
- Queued messages preserve submission order, and a queued `send` resolves with the outcome of its own submission.
- Internal continuations — auto-respond, supervisor nudges, the max_tokens continue-prompt, compaction handoff — do not resolve the outer `send`. This is the behavioural crux: today `turnEnded` fires on each of them and consumers filter.
- Neither `Agent` nor `Thread` has an emitter or subscribers; `NvimThread.destroy()` has no unsubscribe block, so a leaked subscription to a discarded agent is unrepresentable.
- No effect is delivered to anyone other than the actor that caused it. Concretely: the resubmit text goes to whoever called `send`, and the unsent queue goes to whoever called `abort`.
- The `Runner` is private to `Agent`. No `Runner` crosses the `Agent` boundary in either direction, and `Agent` is the only caller of `runTurn` — which is what makes `phase.type !== "idle"` a trustworthy answer to "is this busy". Provider _values_ still cross freely; the object does not.
- `Agent` imports nothing from `thread-supervisor.ts`, and no policy decision (how many restarts, what token threshold, whether to tear down a container) is expressed inside it.
- Every interjection of text into a conversation goes through `onBeforeRequest`. There is no second path, and no structured record is ever recovered by parsing injected plaintext.
- A hook's answer is acted on within the submission that asked the question; no hook return value can resolve or reject a `send`.
- No type in `Thread`'s signature is a runner-only vocabulary word. `AgentInput` in particular does not appear.

# Stages

Two mechanical stages first, each independently green, then a single semantic cut-over. The renames are separated from the split because a rename is verifiable by the compiler alone, and mixing it into the behavioural change makes the diff unreadable.

1. **[DONE] Rename, no behaviour change.** `Agent` → `Runner` (`AnthropicAgent` → `AnthropicRunner`, `OpenAIAgent` → `OpenAIRunner`, files alongside); `ThreadCore` → `Agent` (`thread-core.ts` → `agent.ts`); `node/chat/thread.ts`'s `Thread` → `NvimThread`. The name `Thread` is left unused, ready for stage 2. `npx tsc -b` clean and suite green at the end of this stage.

   Stage 1 notes:
   - Files renamed: `node/core/src/thread-core.ts` → `agent.ts` (+ its test), `providers/anthropic-agent*.ts` → `anthropic-runner*.ts`, `providers/openai-agent*.ts` → `openai-runner*.ts`, `providers/agent-parity.test.ts` → `runner-parity.test.ts`, `node/providers/anthropic-agent*.ts` → `anthropic-runner*.ts`. `node/chat/thread.ts` keeps its filename (only the class was renamed).
   - Companion renames forced by the collision: `ThreadCoreContext` → `AgentContext`, `ThreadCoreEvents` → `AgentEvents`, `ThreadCoreAction` → `AgentAction`, and the test helper `createThreadCoreWithMock` → `createAgentWithMock`. `AnthropicAgentOptions`/`OpenAIAgentOptions` → `AnthropicRunnerOptions`/`OpenAIRunnerOptions`.
   - Deliberately **not** renamed in this stage: `AgentPhase`, `AgentInput`, `AgentOptions`, `AgentHooks`, `AgentLog`, `Provider.createAgent`, and the `Agent.agent: Runner` field (plus `bindAgent`/`createFreshAgent`). The plan's own stage-3 snippets keep those spellings, and stages 3/4 rewrite or delete most of them, so churning them here would be noise. `class Agent { public agent: Runner }` reads oddly in the interim; the field becomes `runner`-shaped when stage 2 splits ownership.
   - Persona/prompt-profile vocabulary (`node/core/src/agents/`, `AgentsMap`, `loadAgents`, ...) was left untouched, as were unrelated `Agent` strings (`User-Agent` in `copilot.ts`, agent-file fixtures).
   - `context.md` updated to the new names.

   Stage 1 review follow-ups (addressed):
   - `node/magenta.ts` now uses a static `import type { NvimThread } from "./chat/thread.ts"` instead of an inline `import()` type expression.
   - Reverted the accidental user-facing string change in `node/chat/chat.ts`: the missing-persona error reads `Agent "..." not found` again (it refers to a persona/prompt profile, not a `Runner`).
   - Deleted 182 lines of obsolete snapshots in `node/chat/__snapshots__/thread.test.ts.snap` recorded under `processes @diag keyword ...` (duplicates of the fork test's snapshots); the fork snapshots are now the only `fork-cloned-messages` / `forked-thread-messages` entries.
   - Note: the full suite exhibits pre-existing load-related flakiness when many nvim-backed test files run in parallel (a different subset fails each run, including on the un-modified HEAD). Individually each affected file passes.
2. **[DONE] Extract `Thread`.** Move the queue (`pendingMessages`/`pendingNextMessages`), `CompactionManager`, `ThreadLogger`, `ContextManager` and the git manager out of `Agent` into a new `Thread` that holds one. `ThreadId` moves with it; `Agent` loses its id. Compaction stops destroying the context manager and instead constructs a replacement `Agent`; the logger resets its cursor when it sees a new agent identity. Still event-based, still the old `state` bag — this stage is about ownership only. Suite green.

   Stage 2 notes (**[DONE]**):
   - New `node/core/src/thread.ts` holds `Thread`: `id`, `contextManager`, `gitTracker`, `threadLogger`, `compactionController`, `supervisors`, `structuredToolResults`, the message queue plumbing (`handleSendMessageRequest`), `setTitle`/`setThreadTitle`, `startCompaction`/`handleCompactComplete`, `awaitArchiveFlush`, `destroy` and the static `clone`. `Agent` keeps the turn loop, the tool executor, reminders and the runner.
   - `Agent`'s constructor is now `(context, deps)`; `AgentDeps` carries the collaborators the thread owns (`state`, `contextManager`, `gitTracker`, `structuredToolResults`, `getSupervisors`, `requestCompaction`, optional `clonedRunner`) plus a `threadId` used only to stamp tool contexts and outgoing events. `Agent.id` is gone.
   - Deviation, deliberate: the old `state` bag is a **single object owned by `Thread` and shared by reference with its `Agent`**, rather than being split in two. The plan says "still the old state bag" for this stage, and sharing keeps the ~180 `core.state.X` read sites (views, chat, tests) working untouched. Stage 3 replaces it with `phase` + readonly projections, at which point the split falls out naturally.
   - `Agent.agent: Runner` renamed to `Agent.runner` (the stage-1 note anticipated this); `bindAgent`/`createFreshAgent` → `bindRunner`/`createRunner`. `Thread.runner` is a pass-through getter, and `NvimThread.agent` reads it.
   - `Agent` still emits the same nine events; `Thread` pipes all of them via `AGENT_EVENT_NAMES` and re-attaches on an agent swap, so no consumer changed. The archive's self-subscription moved onto the agent (`Thread` drives `ThreadLogger` from the agent's `update`/`turnEnded`); it becomes a pure cursor-differ in stage 4.
   - `Agent.destroy` → `Agent.dispose` (aborts + clears its own timers, touches none of the thread's collaborators). `Thread.destroy` disposes the agent and then tears down the context manager.
   - Compaction now builds a **replacement `Agent`** and disposes the old one; the `ContextManager` and `GitTracker` instances survive. `ThreadLogger.resetCursor()` is still called explicitly at the swap — deriving it from an agent-identity change belongs with stage 4's cursor-differ rewrite.
   - Behaviour change forced by the surviving context manager, and three tests in `node/chat/thread-compact.test.ts` updated for it: context files (and the reminders derived from files still tracked, including ones a `get_files` read pulled in) now survive a compaction. The transient `activeReminders` set is still cleared by `reset-after-compaction`.
   - `node/core/src/agent.test.ts` and `providers/openai-wiring.test.ts` construct a `Thread` now; the file name was left alone (it exercises the whole thread, and stage 3/4 rewrite it anyway).
   - Full suite green when files are run individually; the pre-existing parallel-load flakiness noted in stage 1 (nvim socket ENOENT / missing mock streams under load) still shows up in whole-suite runs. `node/render-tools/docker-sync.test.ts` times out on this machine at HEAD as well, i.e. before any stage-2 change.

   Stage 2 review follow-ups (addressed):
   - `AGENT_EVENT_NAMES` is now `as const satisfies readonly (keyof AgentEvents)[]` plus an `_AgentEventNamesAreExhaustive` guard, so adding an event to `AgentEvents` without adding it to the list is a compile error in both directions.
   - `Thread`'s three all-or-nothing optional constructor params collapsed into a single discriminated `ThreadInit` (`{type: "fresh"} | {type: "clone"; runner; provenance; scratchpad; edlRegisters}`), and `AgentDeps.clonedRunner?` became `runnerInit: {type: "new"} | {type: "cloned"; runner}`. The conditional-spread workarounds are gone.
   - `NvimThread`'s mutually exclusive `clonedAgent?: Runner` / `preBuiltCore?: Thread` tail params: `clonedAgent` had no callers (the fork path always supplies a pre-built `Thread`), so it was deleted outright rather than folded into a discriminated init — one optional param, no invalid combination left to represent.
   - The `as ThreadTitle.Input` casts in `Thread.setThreadTitle` and `Chat`'s script-title helper now run `ThreadTitle.validateInput` instead. Deviation from the review's suggestion: `forceToolUse` was *not* made generic in the spec's input type — `ProviderToolSpec` carries no input type parameter, so threading one through would need a phantom field on every spec and a signature change in four provider implementations. Runtime validation removes the unsound cast at both call sites for a fraction of the churn.
   - `ThreadState.title` is `string | undefined` rather than optional, matching the record's other absent-capable fields.
   - `contextManagerListeners` is an unsubscribe array like `agentListeners`, so "not subscribed" is the empty array rather than `undefined`.
   - New tests in `node/core/src/agent.test.ts`: `structuredToolResults` survive the compaction agent swap (same map instance, entries intact); events forward from the replacement agent and no longer from the detached one; the post-compaction prefix holds the summary alone — content queued on the pre-compaction agent via `prependToNextTurn` is deliberately discarded with the message list it belonged to; and `Thread.destroy()` stops the context manager's poll timer and detaches its listeners.
3. **Change the interfaces.** `AgentPhase`, `ThreadPhase`, `TurnActivity`, `SendResult`, `ThreadResult`, `QueuedMessage`, `onUpdate`, and the `AgentHooks` trio. Delete `ThreadMode`, `ThreadCoreEvents`, `TurnEndReason`, `ThreadCoreAction` and the public `state` bag. Fold `onBeforeToolResponse` into the runner's options, give `Runner.clone` a hooks argument, delete `bindHooks`. Extend `RequestAction` with `inject`. Decide the `phase.activity` stored-vs-getter question. `npx tsc -b` is the work queue, not a gate, from here until stage 6.
4. **Rewrite `Agent` and `Thread`.** `sendMessage`/`handleSendMessageRequest`/`sendRawMessage` collapse into `Agent.send` with a deferred per-submission promise; `handleStopped`/`handleSuspend`/`finishAbort` resolve it. `Thread.send` wraps it with the queue. `startCompaction` becomes `Thread.compact`. The emitters go away, and with them the self-subscription: `ThreadLogger` becomes a pure cursor-differ driven by `onUpdate` and gated on `phase`, and `conversationLogBaseDir` / `scriptName` / `forkProvenance` leave the context bag. `activateReminder` and the context-update emits become `onBeforeRequest` injections, with the structured record minted by `Thread` and parked on the message.
5. **Rewrite the consumers.** `NvimThread` loses its subscribe/unsubscribe blocks and moves chime/scroll/resubmit to its own `send`/`abort` call sites. `Chat` composes its supervisor list into the three hooks, takes over docker teardown progress and `tornDown`, and loses `threadYieldCallbacks`/`fireThreadYieldCallbacks`. `ThreadManager.getThreadResult`/`onThreadYielded` become `awaitThreadResult`; `spawn-subagents.ts` awaits. `magenta.ts` reads `phase`. The 32ms throttle moves to the view layer as a trailing-edge debounce.
6. **Fix the views.** `renderStatus` takes a `ThreadPhase` and nothing else. `NvimThread`'s `get agent()` is deleted; `chat.ts:1376` uses `currentMessageIdx()`; `Chat.getContextAgent()` is deleted outright. `shouldShowContextFiles` becomes `phase.type === "idle"`. Context updates render off the message annotation instead of `messageViewState`. `npx tsc -b` clean.
7. **Green the suite.** Tests change only where the mechanism changed — construction now takes an `onUpdate`, and every `while (state.mode.type !== "yielded")` poll becomes an `await result`. Check specifically:
   - A submission that triggers auto-respond, a supervisor nudge, or the max_tokens continue prompt resolves _once_, at the end.
   - A compaction handoff mid-turn: `send` resolves after the post-compaction continuation completes, not at the handoff.
   - Abort resolves `{type: "aborted"}` exactly once for the in-flight send, and queued sends resolve `aborted` too rather than hanging.
   - `result` resolves for a thread that yielded before anyone awaited it.
   - A rejected yield produces _one_ continuous turn: the refusal appears as the yield tool's result, there is no synthetic user/system message, and the thread never leaves `running`.
   - An accepted yield's tool result is still recorded, so the history forks and archives cleanly.
   - Docker teardown completes before the `send` that yielded resolves.
   - A schema-less thread yields `{type: "text"}` and a schema-bearing one yields `{type: "structured"}`, and the script SDK receives the object without a `JSON.parse` anywhere on the path — including for a thread whose text result happens to be valid JSON.
   - A thread whose last submission yielded is `idle`, and accepts a further `send` — nothing treats yield as absorbing.
   - A failed submit leaves `idle.lastResult.failed` with the resubmit text, and the caller populates the input buffer from it without any timer.
   - Aborting with queued messages returns them via `abort()`, and only user-facing callers surface them.
   - A thread keeps its id and its context files across a compaction, and the context manager instance is the same object before and after.
   - Context updates are attached to the right message, render collapsed off the annotation rather than a parse, and survive a fork.
   - `onBeforeRequest` fires before every provider request, not only at stops, so a thread that never stops still auto-compacts — and does not fire again when a request is retried.
   - An `inject` from `onBeforeRequest` lands in the request it gated, on both the opening request of a submission and a tool-result continuation.
   - Multiple supervisors compose with today's exact merge semantics — joined `send-message` texts, first-`accept`/`reject` wins on yield, OR-ed `compact` with joined prompts — but now in the composer, and its tests move there.
   - A hook that returns a continuation does not resolve the outer `send`.
   - A cloned runner never runs a turn against its source's `executeTools` — there is no longer a window in which it could.
   - `UnsupervisedSupervisor`'s restart budget still does not reset across turns now that it is held outside.
   - The archive persists the final message of every turn, including auto-resubmit and post-compaction turns that no caller awaited, and logs a post-compaction agent's messages from index 0 without re-logging the pre-compaction ones.
   - `destroy()` on a running thread settles both `send` and `result`.
