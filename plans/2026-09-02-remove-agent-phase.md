# Objective and Context

> let's get rid of AgentPhase. Instead, the thread should just keep track of agent state via the status of the SendResult.
>
> abort state can be internal - we don't need to know if we're aborting outside the agent.
>
> inline the action state updates, and just dispatch this.deps.onUpdate directly.
>
> title can move out of the agent and into the thread.
>
> most of these [ThreadState fields] aren't actually used internally to the agent, so we can get rid of this type, or lift it to thread (the pieces that are still needed).

Entities involved:

- `AgentPhase` (`node/core/src/agent.ts`) — `{idle} | {running, activity: TurnActivity} | {aborting}`, plus the helpers `phaseLabel`, `phaseStreamingBlock`, `phaseActiveTools`.
- `TurnActivity` / `ToolInvocationState` (`node/core/src/thread-api.ts`) — the intra-turn detail: `streaming` (block, retry, dead-air timestamps) and `running_tools` (requested + invocation state).
- `AgentAction` / `Agent.update` — two actions: `set-title` and `set-active-tool-result`.
- `ThreadState` — 8 fields; only `systemPrompt`, `toolSpecs`, `lastTurnResult` are touched inside `Agent`.
- `SendResult` / `TurnResult` (`thread-api.ts`, `providers/provider-types.ts`) — how a submission and a turn end.
- `Thread.lastResult()` (`node/core/src/thread.ts`) — render-only view of the last submission, currently derived from `state.lastTurnResult`.

Relevant files:

- `node/core/src/agent.ts` — owns the phase, the actions, and `ThreadState`.
- `node/core/src/thread.ts` — owns `state`, the turn loop (`runToRest`, `loopState`), `setTitle`, `lastResult`.
- `node/core/src/thread-api.ts` — `TurnActivity`, `ToolInvocationState`, `SendResult`.
- `node/core/src/index.ts` — core re-exports (`ActiveToolEntry`, `AgentAction`, `ThreadState`).
- `node/chat/thread.ts` — `NvimThread`: `get phase()`, `commentActivity()`, `rebuildToolResultMap()`, title read.
- `node/chat/thread-view.ts` — `renderStatus`, streaming block rendering, active-tool lookup, title/threadType/toolSpecs/editedFiles rendering.
- `node/chat/chat.ts`, `node/magenta.ts` — phase checks for the sidebar icon, comment gating, notification visibility.
- `node/core/src/test-helpers.ts` — `waitForTurnResult`, test `ThreadState` construction.

# Design

`AgentPhase` is three things wearing one hat: (a) "is a turn in flight", (b) the intra-turn detail, (c) an abort marker. The thread already knows (a) and (c) — it starts the send, holds the promise, and is the one that decides to abort — and it already half-encodes them in `loopState`. And (b) is not the agent's either: the tool executor and the request-progress callback are both things the thread hands to the agent, so the thread sees those edges too.

So: **delete `AgentPhase`, and lift the state machine to the thread as `ThreadLoopState`.** The thread does not need the agent to tell it anything: it already holds every edge of the machine.

- The turn boundary is the `agent.send(...)` promise, which is folded *into* the state rather than kept beside it: the promise lives on the sub-states that have one (`streaming`, `running_tools`), so "there is a send in flight" and "what it is doing" cannot disagree.
- The request/tools alternation is the tool executor, which becomes the thread's. `executeTools` moves out of the agent onto `AgentDeps.executeTools(requests): Promise<ToolOutcome>` — the thread already owns tool construction (`invokeTool`), the `onToolResults` hooks, and abort, so it owns the `activeTools` map and the `ToolInvocationState` transitions too. The agent keeps only `completeToolResults` and the appending of results. Being called *is* the "tools started" edge; returning is "tools settled", and the loop is streaming again.
- The streaming detail is the manager's progress callback, plumbed to its owner: `AgentDeps.onRequestUpdate(update: RequestUpdate)`. The agent's `handleRequestUpdate` disappears — it passes `deps.onRequestUpdate` straight through to `manager.sendRequest`, and the thread folds `streaming-block` / `block-finished` / `retry-scheduled` / `attempt-started` into its `streaming` state. `startedAt` and `lastEventTime` become the thread's clocks, which is where they are read anyway.
- Abort is the thread's already (`abort()` sets the `aborting` flag; the agent's internal `abortRequested` stays private and unobservable). Tool aborts move with the `activeTools` map.
- `AgentDeps.onUpdate` goes with the phase. Every call site it had is now either an edge the thread sees itself (the request-update callback, the executor being called and returning, the `send` promise resolving) or a log append sandwiched between two such edges in the same tick — and `NvimThread` coalesces renders on a 50ms trailing window, so no frame can be stale. The thread renders from its own state machine.
`Agent` is then left with no state machine at all: a turn loop that sends requests, calls out for tool execution, and resolves.

`Thread.loopState` is the single answer to "what is this thread doing". Top level there are two states: `idle` (optionally carrying how the last submission ended) and `running` (the loop owns the thread). Aborting is a flag on `running`, not a third state: an aborting thread is still streaming or still running tools, the view still has to render that, and as a flag it cannot be clobbered by an activity transition — which is exactly the stickiness the old `aborting` phase had to assert by hand. The intra-turn detail is a sub-state of `running`: `preparing` when the loop owns the thread but no send is in flight (probing for pending content, deciding a continuation, the gap between turns), `streaming` from `send`/tool-return until the executor is called or the promise resolves, `running_tools` for the duration of the executor call. `Thread.isBusy` is `loopState.type !== "idle"`; the agent keeps a private busy flag only for its `send` reentrancy guard.
Helpers become loop-state-shaped, in `thread.ts`: `loopStreamingBlock(state)` and `loopActiveTools(state)` replace `phaseStreamingBlock` / `phaseActiveTools`; `phaseLabel` becomes `loopState.type`. Callers that asked "is it idle" read `!thread.isBusy`; callers that asked "is it streaming" read `loopState.type === "streaming"`.

"How did the last submission end" folds in as well: `idle.lastResult`, set from the `SendResult` that `runToRest` returns, replacing `state.lastTurnResult` and the `lastResult` derivation. It only exists on `idle`, which is the only state in which it means anything — a running thread's last result is not a thing anyone should render. The `yieldState` special case stays (a yielded thread reports `{type: "yielded"}`), and `suspended` results keep mapping to `undefined` so rendering is unchanged in this pass.

`Agent.update`/`AgentAction` go away:

- `set-active-tool-result` is inlined in the thread's executor — the entry is already in hand there; assign `entry.result` and render. The try/catch around "one tool's bookkeeping must not tear down the others'" is no longer needed, since an assignment cannot throw.
- `set-title` moves to `Thread`: `title` becomes a `Thread` field, `Thread.setTitle` sets it and records it on the logger, then `handleUpdate()`.

`ThreadState` is dissolved:

- `AgentDeps` takes only what the agent needs: `systemPrompt`, `toolSpecs`, `createTool`, `getHooks`, `onUpdate`, `runnerInit`.
- `lastTurnResult` stops living on shared state. The agent keeps it as a private field feeding nothing external; the thread records `SendResult` itself (above). Tests that read `state.lastTurnResult?.type` move to `thread.lastResult()?.type`.
- `title`, `threadType`, `systemInfo`, `edlRegisters`, `editedFilesThisTurn`, `toolSpecs` become plain `Thread` fields. The external read sites (`thread.state.X` in chat.ts / thread-view.ts / thread.ts / tests) become `thread.X`.

## Interfaces

```ts
// agent.ts
export type ActiveToolEntry = { /* unchanged */ };
export function loopStreamingBlock(s: ThreadLoopState): StreamingBlock | undefined;
export function loopActiveTools(s: ThreadLoopState): ReadonlyMap<ToolRequestId, ActiveToolEntry> | undefined;
export interface AgentDeps {
  systemPrompt: SystemPrompt;
  toolSpecs: ProviderToolSpec[];
  createTool: (request: ToolRequest) => ToolInvocation;
  getHooks: () => AgentHooks;
  /** The manager's progress callback, handed to its owner. The agent stores
   * nothing from it. */
  onRequestUpdate: (update: RequestUpdate) => void;
  /** Tool execution is the thread's: it owns construction, the active-tool
   * map, the onToolResults hooks, and aborting them. The agent only appends
   * what comes back. */
  executeTools: (requests: ReadonlyArray<RequestedTool>) => Promise<ToolOutcome>;
  runnerInit: { type: "new" } | { type: "cloned"; cloneFrom: NativeInferenceManager; truncateTo: NativeMessageIdx };
}
class Agent {
  // removed: phase, update(), AgentAction, state, executeTools, handleRequestUpdate, deps.onUpdate
  // isBusy stays, private-by-convention: only the send reentrancy guard uses it
}
/** `epoch` is today's, unchanged. */
type ThreadLoopState =
  | { type: "idle"; lastResult?: SendResult }
  | {
      type: "running";
      epoch: number;
      activity: LoopActivity;
      /** Winding down: the loop stops at the next boundary. Not a state of its
       * own — a thread that is aborting is still streaming or still running
       * tools, and the view still has to show that. */
      aborting: boolean;
    };
/** The promise is part of the state: it exists exactly in the sub-states that
 * have a send in flight. */
type LoopActivity =
  /** the loop owns the thread but no send is in flight: probing for pending
   * content, between turns, deciding a continuation */
  | { type: "preparing" }
  | {
      type: "streaming";
      send: Promise<SendResult>;
      startedAt: Date;
      lastEventTime: Date;
      block: StreamingBlock | undefined;
      retry: RetryStatus | undefined;
    }
  | {
      type: "running_tools";
      send: Promise<SendResult>;
      requested: ReadonlyArray<RequestedTool>;
      tools: ToolInvocationState;
    };
// thread.ts
class Thread {
  title: string | undefined;
  readonly threadType: ThreadType;
  readonly systemPrompt: SystemPrompt;
  readonly systemInfo: SystemInfo;
  edlRegisters: EdlRegisters;
  editedFilesThisTurn: { path: AbsFilePath; snapshot: string }[];
  toolSpecs: ProviderToolSpec[];
  readonly loopState: ThreadLoopState;
  // removed: lastResult() — it is loopState.lastResult on idle
}
```

## Invariants

- Abort still leaves the message log well-formed: `finishTurnAbort` writes the abort marker and finalizes the manager exactly as today; only the published phase disappears.
- Every `tool_use` still gets a result (`completeToolResults`) even if result bookkeeping is skipped.
- `lastResult` remains render-only; no control flow may branch on it. It exists only on `idle`, so a view cannot show a stale result next to a live turn.
- `loopState` is the only account of what a thread is doing; the agent has no state machine to read.
- `loopState` is non-idle from the moment `runToRest` takes over until it settles, including the gaps between turns — so replacing `phase.type === "idle"` with `!isBusy` must not regress the sidebar/comment gating.
- The `aborting` flag survives every activity transition within its epoch and is cleared only by reaching `idle`; a callback from a superseded epoch is ignored.
- The executor is called exactly once per tool batch and always returns (the agent already treats a rejection as an empty result set), so `running_tools` can never be stranded.

- A `send` promise always settles, so `idle` is always reached — the `finally` in `runToRest` is the single place that guarantees it.
- Every `tool_use` still gets a result: `completeToolResults` stays in the agent, so a thread-side executor that skips or aborts an id cannot leave a dangling block.

# Stages

## move tool execution to the thread — DONE

- Goal: `Agent.executeTools` moves onto `AgentDeps` and is implemented by `Thread` — the active-tool map, the `onToolResults` hooks, and tool aborts go with it. The agent keeps `completeToolResults` and the appending of results. No behaviour change yet; the phase still exists, now fed by the thread.
- Tests:
  - Existing tool-execution cases (malformed requests, tool-creation failure, a rejecting invocation, abort landing while invocations are being created) still pass unchanged — they are the specification of the code being moved.
  - A rejecting executor still leaves every `tool_use` answered.

Notes:

- The batch executor lives in a new `node/core/src/tool-executor.ts` as
  `ToolExecutorHost`, rather than as a method on `Thread`. `Thread` constructs
  one and hands `deps.executeTools = (r) => host.execute(r)` to every agent it
  builds; the bare-agent test harness (`buildTestAgent`) constructs its own,
  so the loop under test still sees production wiring instead of a stub.
  Later stages can fold the host's callbacks inward as the phase disappears.
- `AgentDeps.createTool` is gone (it moved into the host's deps); `AgentDeps`
  gained `executeTools`.
- Stage-1-only seams, to be removed in stage 2/3:
  - `Agent.isAbortRequested` (public getter) — the host decides a batch's
    outcome by it, exactly as the agent's own flag used to.
  - `Agent.setToolInvocationState` is now public — the host publishes
    `pending`/`running`/`settled` into the phase, which still exists.
- Tool aborts are the thread's: `Thread.abort`, the `abortAndWait` path in
  `Thread.send`, `Thread.reset` and `Thread.destroy` all call
  `toolExecutor.abortAll()`. `Agent.abortAndWait` no longer touches
  invocations, so the bare-agent test "aborts the live invocations when the
  abort lands while tools run" now calls `toolExecutor.abortAll()` itself.
- The executor assigns `entry.result` directly instead of going through
  `Agent.update({type: "set-active-tool-result"})`; the action still exists
  (removed in stage 4) but has no internal caller. The phase renders the same
  map object the host owns, so `phaseActiveTools` is unchanged for callers.
- `createTestAgent` / `createTestOpenAIAgent` now also return `toolExecutor`.
- Review follow-ups (same stage):
  - `ToolExecutorHost.live` is always a `Map` (empty between batches); the
    unused public `activeTools` getter is gone, so there is one representation
    of "no batch running".
  - `execute` collects results from the `Promise.all` return value instead of
    re-reading `entry.result` afterwards, so a missing result is impossible
    rather than silently filtered. `ActiveToolEntry.result` stays an optional
    field because the view reads it mid-batch.
  - `test-helpers.buildTestAgent` no longer uses `let agent!: Agent`; the
    host's `isAborting`/`publishTools` closures go through a `requireAgent()`
    guard that throws if they run before construction.
  - New coverage: `thread.test.ts` "Thread aborts the tools it owns" (abort and
    destroy each abort a live invocation — verified to fail when the
    `toolExecutor.abortAll()` call is removed), and `tool-executor.test.ts`
    pinning the abort-lands-before-publish window. The agent-level test that
    called `abortAll()` itself was rescoped/renamed to what it actually
    asserts: the turn settles as `aborted`.
- Full suite, `npx tsc -b` and `npx biome check .` are green (one unrelated
  flake in `spawn-subagents.test.ts` under full-suite load; passes in
  isolation and on a rerun of the file).

## agent: phase out — DONE

- Goal: `AgentPhase`, `phaseLabel`, `phaseStreamingBlock`, `phaseActiveTools`, and `handleRequestUpdate` are gone; `deps.onRequestUpdate` is passed straight to `manager.sendRequest`; `abortRequested` is private and unobservable; `deps.onUpdate` is deleted.
- Tests:
  - Abort during streaming and abort during tool execution: the abort marker is in the log and every requested tool has a result.
  - Core tests that polled `phase` are repointed at `thread.loopState` — the real check that transitions happen at the same moments as before.

Notes:

- The state machine had to land somewhere the moment the phase left the agent,
  so `ThreadLoopState` arrives here rather than in the next stage — but only
  its *shape*: `{idle} | {running, epoch, activity, aborting?}` with the
  `preparing`/`streaming`/`running_tools` activities, plus `loopLabel`,
  `loopStreamingBlock`, `loopActiveTools`. What the next stage still owes:
  folding the `send` promise into the sub-states, `idle.lastResult` (replacing
  `state.lastTurnResult` / `Thread.lastResult()`), and `isBusy` becoming
  `loopState.type !== "idle"` (it is still `|| agent.isBusy` today).
- The transitions live in `LoopStateMachine` (`node/core/src/loop-state.ts`)
  rather than as fields on `Thread`, because the bare-agent test harness needs
  the same machine: a test that observes the loop must observe the production
  one. `Thread` holds one and exposes `get loopState()`.
- The edges the owner drives, all of them thread-side:
  - `runToRest` → `start()` / `finish(epoch)`; `preparing` is the default
    activity, so the gaps between turns are already accounted for.
  - `Thread.runTurn` wraps each `agent.send`: `streaming()` before,
    `preparing()` in the `finally`.
  - `Thread.executeTools` wraps the host: `runningTools(requests)` on the way
    in, `streaming()` on the way out.
  - `AgentDeps.onRequestUpdate` → `applyRequestUpdate`, which stamps
    `lastEventTime` and folds the block/retry in.
- `aborting` is a flag on `running` (not the old third state) already in this
  stage: an activity transition would otherwise clobber it. Both places that
  used to rely on `agent.isAbortRequested` now call `loop.markAborting()` —
  `Thread.abort` and the supersede path in `Thread.send` — and the tool
  executor's `isAborting` reads the flag.
- Stage-1 seams removed: `Agent.isAbortRequested` and
  `Agent.setToolInvocationState` are gone; `abortRequested` is private.
  `AgentDeps.onUpdate` is gone, and with it every agent-side notification.
- `AgentAction.set-active-tool-result` went with the phase (it read
  `activeTools` and had no caller left after stage 1); `set-title` remains
  until stage 4, and `Thread.setTitle` now issues the render itself.
  `TurnActivity` is deleted from `thread-api.ts`, superseded by `LoopActivity`.
- Test harness: `createTestAgent` / `createTestOpenAIAgent` return a
  `TestAgent` (a subclass) that owns a `LoopStateMachine` — `send` starts and
  finishes the loop, `abortAndWait` marks aborting and stops the live
  invocations, exactly as `Thread` does. `flatPhase(agent)` became
  `flatLoop(owner)` over anything with a `loopState`, so `flatLoop(core)` reads
  the thread's own loop rather than the agent's.
- Root layer: mechanically repointed (`thread.loopState`, `loopLabel`,
  `loopStreamingBlock`, `loopActiveTools`); `renderStatus` and the sidebar
  status gained a `preparing` case and render `Aborting...` off the flag. The
  rest of the root work (`isBusy`, `title`, `lastResult`) is still stage 5's.
- Two tests changed meaning rather than shape: the compaction test that
  asserted an update from `agent.update({set-title})` now calls
  `thread.setTitle`, and "issues no continuation when the abort races the
  stop" now waits for `running`/`preparing` — the window where the agent has
  settled and the loop is deciding — since the thread's loop is never idle
  mid-submission.
- `npx tsc -b`, `npx biome check .` and the full suite are green.

Review follow-ups (stage 2):

- `aborting` is now `aborting: boolean` (not `aborting?: true`), so every
  construction of `running` must state it and "forgot to set" is not
  indistinguishable from "never aborted".
- `isAborting(epoch?)` split into `isAborting()` ("is the current loop winding
  down", used by the tool executor) and `isEpochAborting(epoch)` ("is the loop
  I own winding down", used by the turn loop).
- `epoch` is a branded `LoopEpoch` (exported from `@magenta/core`), so an
  unrelated number cannot be passed to the ownership guards.
- `LoopActivity`'s `streaming`/`running_tools` fields are `readonly`;
  `applyRequestUpdate` rebuilds the activity through `setActivity` instead of
  mutating it in place, keeping identity-based change detection meaningful.
- `Thread.executeTools` declares `requests: ReadonlyArray<RequestedTool>`
  instead of indexing a `Parameters<ToolExecutorHost["execute"]>` tuple.
- New tests: `node/core/src/loop-state.test.ts` (the aborting flag survives
  activity transitions and is cleared at idle; a superseded epoch cannot write
  or report aborting; a fresh loop starts unaborted; request updates arriving
  during `running_tools` are dropped by design), `thread.test.ts` "does not
  carry the aborting flag into the superseding turn", and two `renderStatus`
  cases (`preparing`, and `aborting` winning over the activity).

## thread: ThreadLoopState — DONE

- Goal: `loopState` gains the `running` activity sub-states and the `aborting` flag, driven by the `send` promise (held on the sub-state), the executor call, and `onRequestUpdate`; `idle` carries `lastResult`, replacing `state.lastTurnResult` and `lastResult()`; `isBusy` is `loopState.type !== "idle"`; `loopStreamingBlock` / `loopActiveTools` replace the phase helpers.
- Tests:
  - `loopState` is `running` (not `idle`) between turns of a multi-turn loop — the gap that motivates the lift.
  - A turn's observed sequence is `preparing` → `streaming` → `running_tools` → `streaming` → `idle`, with the block visible during streaming and the active tools during `running_tools`.
  - `lastResult` is present on `idle` and absent everywhere else, after: a completed turn, a failed turn (with `discardedSubmission`), an abort, and a yield.
  - An abort mid-stream sets `aborting` while the activity stays `streaming`, and a subsequent request update leaves the flag set.
  - A callback
 from a superseded epoch is ignored.
  - `thread-abort.test.ts` assertions on phase become assertions on `loopState` / `lastResult`.

Notes:

- The `send` promise lives on the `streaming` / `running_tools` activities.
  Only the turn edge supplies it (`Thread.runTurn` calls `agent.send` first and
  hands the promise to `loop.streaming(send)`); the tool edges happen *inside*
  a send the loop already tracks, so `runningTools` carries it forward from
  the current activity and the return edge is a new `toolsSettled()` rather
  than a second `streaming()` with nothing to pass. A transition that finds no
  send in flight is a no-op, so the invariant "streaming ⇒ there is a send" is
  structural.
- `idle` gained `lastResult?: SendResult`, written by `LoopStateMachine.finish(epoch, result)`.
  `runToRest` is now a thin wrapper that owns `start`/`finish` and records the
  result; the body moved to `runLoop(messages, epoch)`, which is the old try
  block dedented (no logic change).
- `Thread.lastResult()` stays as the render-only accessor, but derives from
  `loopState`: yield first, then `idle.lastResult`, with `suspended` mapped to
  `undefined` as before. It is *not* deleted in this stage — the root layer
  and several tests still read `state.lastTurnResult` (the agent keeps writing
  it), and repointing those is stage 5's ("dissolve ThreadState") explicit
  scope. So `lastTurnResult` is briefly duplicated by design.
- `Thread.isBusy` is now exactly `loopState.type !== "idle"`; the `|| agent.isBusy`
  disjunct is gone. `Agent.isBusy` survives only as the send reentrancy guard.
- `flatLoop` drops `lastResult` (it answers "what is the loop doing"), so the
  many `expect(flatLoop(x)).toEqual({type: "idle"})` assertions keep their
  meaning.
- New tests: `thread.test.ts` "Thread loop activity" (the
  `preparing → streaming → running_tools → streaming → idle` walk, with the
  streaming block visible and `lastResult` absent mid-loop; and the loop
  staying `running`/`preparing` between the turns of a multi-turn loop —
  the gap that motivated the lift), plus "keeps the activity while the abort
  winds the loop down" (aborting flag set, activity still `running_tools`,
  `lastResult` = `aborted`). `agent.test.ts`'s `Thread.loopState` block already
  covered `lastResult` after completed / failed / aborted / yielded, and
  `loop-state.test.ts` already covers the superseded epoch.
- `npx tsc -b`, `npx biome check .` and the full suite are green.

Review follow-ups (stage 3):

- `idle.lastResult` is `SendResult | undefined` (a stated field, not an
  optional one), and `finish(epoch, lastResult)` requires a result. It is
  `undefined` only before the first submission ever runs. Splitting `idle` into
  `idle`/`settled` was considered and rejected: every "is this thread doing
  anything" check reads `type !== "idle"`, and a second at-rest variant would
  make each of them a two-way check for no gain.
- A throw out of `runLoop` is now an outcome rather than an absent result:
  `runToRest` catches, finishes the loop with
  `{type: "failed", discardedSubmission: false}`, and rethrows. The test
  harness's `TestAgent.send` does the same on its rejection path.
- `Thread.lastResult()` returns
  `Exclude<SendResult, {type: "suspended"}> | undefined`, so "the render layer
  never sees a suspension" is in the signature.
- New/extended tests: `loop-state.test.ts` pins the untested no-op branches —
  `runningTools` from `idle` and from `preparing`, and `toolsSettled` with no
  send in flight (plus the normal `running_tools → streaming` return keeping
  the same `send`) — and the superseded-epoch case now calls
  `finish(first, {aborted})` so a stale epoch is shown unable to write
  `lastResult`. `thread.test.ts` asserts `core.lastResult()` is `undefined`
  after a submission rests suspended.

## agent: drop update()/AgentAction — DONE

- Goal: `Agent.update` and `AgentAction` deleted. Tool results assigned inline in `executeTools`; `set-title` handled by `Thread`. `title` lives on `Thread`.
- Tests:
  - A tool completing mid-turn still surfaces its result to the view before the results are appended (the `rebuildToolResultMap` path in `node/chat` that reads active-tool results).
  - Title generation (`setThreadTitle`) sets `thread.title` and records it to the thread logger; `chat.ts` display name and archive summary still show it.

Notes:

- `AgentAction` and `Agent.update` are deleted, along with the pass-through
  `Thread.update(...args: Parameters<Agent["update"]>)` (it had no caller —
  the `thread.update(...)` sites in `node/chat/chat.ts` are `NvimThread`'s
  `RootMsg` update, a different class).
- `title` moved off `ThreadState` onto `Thread` as a public field.
  `Thread.setTitle` assigns it, records it on the logger and renders.
  Read sites repointed: `thread.core.state.title` → `thread.core.title`
  (`node/chat/chat.ts` display name + archive summary, `node/chat/thread-view.ts`
  header, `node/chat/thread.ts`), and `this.state.title` → `this.title` in
  `node/core/src/thread.ts`'s title-generation gate.
- The inline tool-result assignment was already in place from stage 1
  (`ToolExecutorHost` assigns `entry.result` directly), so no work was needed
  there; `set-active-tool-result` had already gone in stage 2.
- Review follow-ups (stage 4): `title` is a private `#title` with a public
  getter, so `setTitle` (which also records to the thread logger and renders)
  is the only write path; the title-generation gate compares
  `this.title === undefined` rather than testing truthiness.
- Existing coverage was sufficient: `thread-title.test.ts`, `chat.test.ts`
  title cases and the archive/summary tests exercise the moved field. Full
  suite, `npx tsc -b` and `npx biome check .` are green.

## dissolve ThreadState — DONE

- Goal: `ThreadState` type removed; `AgentDeps` narrowed to `systemPrompt` + `toolSpecs` (+ existing callbacks); the other fields are `Thread` fields.
- Tests:
  - Fork/clone (`fork-thread.test.ts`) still carries `edlRegisters` and reports the source thread's last result correctly.
  - Compaction (`thread-compact.test.ts`) still resets registers and `editedFilesThisTurn`, and the compacted thread reports its own last result.
  - `editedFilesThisTurn` is cleared at the start of each loop and populated by `edl-edit` — the existing `agent.test.ts` cases, repointed at `thread`.

Notes:

- `ThreadState` is deleted from `agent.ts` and from the core re-exports.
  `AgentDeps` now takes `systemPrompt` + `toolSpecs` (plus the existing
  callbacks and `runnerInit`); `Agent` holds no shared state object.
- `lastTurnResult` is gone from the agent entirely rather than kept as a
  private field: after stage 3 the thread records the `SendResult` on
  `idle.lastResult`, so the agent's copy was written and never read, and a
  write-only field is worse than no field.
- `threadType` / `systemPrompt` / `systemInfo` are getters on `Thread`
  delegating to `this.context`, not duplicated fields — the context already
  owns them and a copy could drift. `edlRegisters`, `editedFilesThisTurn` and
  `toolSpecs` are plain mutable `Thread` fields.
- Every `X.state.<field>` read site was repointed mechanically to `X.<field>`
  (core, `node/chat`, `node/providers/skills.test.ts`, `node/scripts`,
  `node/tools`), and `X.state.lastTurnResult` to `X.lastResult()`.
- That last swap changes the *type* the root layer sees: `TurnResult`
  (`stopped` / `suspended` / …) becomes `SendResult` (`completed` / `yielded` /
  …). So `renderTurnResult` in `thread-view.ts` now takes a local
  `RenderedResult = Exclude<SendResult, {type: "suspended"}> | undefined` and
  handles `completed` (with `stopReason` optional, defaulting to `end_turn`)
  and `yielded`; `chat.ts`'s archive-summary status and
  `thread-compact.test.ts` compare against `"completed"` instead of
  `"stopped"`. This is the render half of stage 6 arriving early, forced by
  the type change — the rest of stage 6 (`loopState` / `isBusy` / `title`
  read sites) was already done in earlier stages.
- `test-helpers.buildTestAgent` builds the harness's `edlRegisters` directly
  instead of a `ThreadState`.
- No new tests: the existing fork/clone, compaction and `editedFilesThisTurn`
  cases are exactly the coverage this stage's field moves needed, and they
  were repointed rather than rewritten.
- `npx tsc -b`, `npx biome check .` and the full suite are green.

## root layer — DONE

- Goal: `node/chat` and `node/magenta.ts` compile against the new surface: `thread.loopState`, `!thread.isBusy`, `thread.title`, `thread.toolSpecs`, etc. `npx tsc -b` and `npx biome check .` clean.
- Tests:
  - `thread-view.test.ts`: streaming status, "Executing tools...", and the idle result line render from `loopState` + `lastResult`.
  - Sidebar icon and the comment gate in `magenta.ts` respond to `isBusy` — verify a comment submitted mid-turn is still deferred.
  - `bashCommand.test.ts` active-tool lookups work through `loopActiveTools`.

Notes:

- Most of the mechanical repointing had already landed in stages 2–5, so this
  stage was the residue: the remaining `loopState.type === "idle"` checks that
  are really "is this thread doing anything" became `core.isBusy` — the
  sidebar status icon (`node/magenta.ts`), the idle-thread comment gate
  (`node/magenta.ts`), `NvimThread.commentActivity` and
  `rejectPendingSandboxApprovals` (`node/chat/thread.ts`).
- `thread-view.ts`'s hand-rolled drill into
  `phase.activity.tools.activeTools` is now `loopActiveTools(thread.loopState)`,
  the one accessor for that map.
- Leftover `phase` / `agentPhase` identifiers in `node/chat` were renamed to
  `loopState`, so nothing in the root layer still speaks of a phase.
- Also finished the in-flight `SendResult` change that was sitting uncommitted
  in the tree: `{type: "completed", stopReason: undefined}` (a submission that
  never issued a request) became its own `{type: "empty"}` variant, so
  `completed.stopReason` is a stated `StopReason`. `runLoop`'s
  "no stop reason means no continuation" special case disappears — `empty` is
  simply not `completed`. `RestResult` (`Exclude<SendResult, {suspended}>`) is
  exported from core and used by `Thread.lastResult()` and `thread-view.ts`'s
  `RenderedResult`; `renderTurnResult` renders `empty` like `yielded`
  (`Stopped (end_turn)`). Tests asserting the old shape were repointed.
- No new tests: `thread-view.test.ts` (streaming / preparing / aborting /
  result line), `chat.test.ts`, `thread-abort.test.ts` and
  `bashCommand.test.ts`'s `loopActiveTools` lookups already cover this
  stage's surface, and all pass unchanged.

Review follow-ups (stage 6):

- `getThreadSummary`'s `stopped.reason` is now a literal union
  (`StoppedReason = StopReason | Exclude<RestResult["type"], "completed" |
  "failed">`) instead of `string`, so a new `SendResult` variant is a compile
  error rather than a new mystery string in the subagent status line.
- Dropped the now-dead `lastTurnResult.stopReason ?? "end_turn"` — after the
  `empty` split, `completed.stopReason` is a stated `StopReason`.
- Kept the behaviour change the `empty` variant introduced (an empty
  submission reports `reason: "empty"` rather than `"end_turn"`) and pinned it:
  `chat.test.ts` "summarizes a submission that never issued a request as
  empty". `thread-view.test.ts`'s `renderStatusToString` now takes an optional
  `lastTurnResult`, covering `renderTurnResult`'s `empty` branch
  (`Stopped (end_turn)`).
- `npx tsc -b`, `npx biome check .` and the full suite are green.
