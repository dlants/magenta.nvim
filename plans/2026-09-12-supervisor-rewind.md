# Objective and Context

> I want to modify the supervisor contract. Each supervisor should have a create/clone split like FileSupervisor. For clone, specifically, instead of "preserve" / "reseed", we should accept a nativeMessageIdx, and expect the supervisor's copy to "reset" the supervisor to that point in time.
>
> Note that we then need to accept a nativeMessageIdx for every supervisor hook, and keep the full history of operations.
>
> So for the file supervisor, it should keep track of "what did the agent think the state of the files was at nativeMessageIdx?". If I reset the thread, the next onBeforeRequest hook for that supervisor should send a diff from *that* snapshot to the current file state.

## Entities

- `ThreadSupervisor` (`node/server/src/thread-supervisor.ts`) — the hook interface: `onBeforeRequest(RequestContext)`, `onToolResults(ToolResults)`, `onToolApplied`, `onEndTurnWithoutYield(EndTurnContext)`, `onYield`, `onReset`, `hasPendingContent`.
- `composeSupervisors(getSupervisors)` — folds a supervisor list into the `ThreadHooks` the agent consults.
- `RequestContext` / `AgentRequestContext` (`thread-supervisor.ts`, `thread-api.ts`) — `{ inputTokenCount, outputTokenCount }` plus `status: "pending" | "suspended"`.
- `NativeMessageIdx` (`providers/provider-types.ts:279`) — branded number. `manager.getNativeMessageIdx()` returns `messages.length - 1`; `manager.truncateMessages(idx)` keeps `0..idx`.
- `FileSupervisor` (`supervisors/file-supervisor.ts`) — `ContextTracker` + `ThreadSupervisor`. State is `files: Files`, each entry `{ relFilePath, fileTypeInfo, agentView, lastStat }`. `agentView` is "what the agent has been shown". `pendingUpdates` is a derived cache refreshed by polling. Today: `static create({...})` and `static clone({ source, delivery: "preserve" | "reseed" })`.
- `GitSupervisor` / `GitTracker` (`supervisors/git-supervisor.ts`) — state is `GitTracker.agentView: GitState | undefined`. Not cloned today: `ThreadCore.clone` builds a fresh `GitTracker` from `context.contextDelivery.initialGitState`.
- `SystemInfoSupervisor` (`thread-supervisor.ts`) — state is a single `injected: boolean`, seeded from `alreadyInjected: manager.log.messages.length > 0`.
- `MaxTokensSupervisor`, `SubagentSupervisor`, `UnsupervisedSupervisor` (restartCount), `AutoCompactSupervisor`, `DockerSupervisor` — root-layer supervisors held in `NvimThread.supervisors`; today they are constructed fresh per thread and never cloned.
- `ThreadCore` (`node/server/src/thread-core.ts`) — owns the context supervisors (git, file, system-info) and composes them into `contextHooks`. `static create` / `static clone({ source, nativeMessageIdx, sourceBusy })`.
- `Thread.clone` (`node/server/src/thread.ts:232`) — the only caller of `ThreadCore.clone`.

## Files

- `node/server/src/thread-supervisor.ts` — supervisor interface, `composeSupervisors`, the stateless/simple supervisors.
- `node/server/src/thread-api.ts` — `AgentRequestContext`, `BeforeRequestHook`, `ToolResultsHook`, `ThreadHooks`.
- `node/server/src/agent.ts` — `runBeforeRequestHooks`, the tool-results hook call site.
- `node/server/src/thread-core.ts` — supervisor construction and the `create`/`clone` split.
- `node/server/src/supervisors/file-supervisor.ts` — the big one.
- `node/server/src/supervisors/git-supervisor.ts`.
- `node/nvimclient/chat/thread.ts`, `chat.ts` — root supervisor wiring.
- Tests: `supervisors/file-supervisor{,-delivery}.test.ts`, `supervisors/git-supervisor.test.ts`, `node/nvimclient/chat/fork-thread.test.ts`.

# Design

## The single rule

Every supervisor hook receives the `NativeMessageIdx` **of the message that will carry or reveal the state the hook commits**. Concretely:

- `onBeforeRequest`: `manager.getPendingUserMessageIdx()` — injections are *merged into* a trailing user message if there is one (the continuation case) and otherwise append. Stage 1 found `+ 1` to be wrong here; see that stage's notes.
- `onToolApplied` / `onToolResults`: `manager.getNativeMessageIdx() + 1` — the assistant message holding the `tool_use` is already written; the result message is not.
- `onEndTurnWithoutYield`: `manager.getNativeMessageIdx()` — nothing further will be written.

A supervisor that mutates agent-visible state records the new value in an append-only history keyed by that idx. `clone({ source, nativeMessageIdx })` copies the history, drops every entry with `key > nativeMessageIdx`, and derives its live state from what remains. This is exactly consistent with `manager.truncateMessages(nativeMessageIdx)`, which keeps `0..nativeMessageIdx`: an entry recorded at idx N survives iff message N survives.

`"preserve"` and `"reseed"` become degenerate cases of the same operation — cloning at the source's current idx preserves everything; cloning at an idx before any delivery reseeds — so the `sourceBusy` / `preserve` heuristic in `ThreadCore.clone` disappears.

## Which supervisors get history

Rewind is only meaningful for state the agent can see in the log:

- `FileSupervisor` — per-file `agentView` + `lastStat` history.
- `GitTracker` — `agentView: GitState | undefined` history.
- `SystemInfoSupervisor` — `injectedAt: NativeMessageIdx | undefined`.

The rest (`MaxTokens`, `Subagent`, `Docker`, `AutoCompact`) are stateless or hold counters with no log correspondence. They still get the `static create` / `static clone` shape for uniformity, but `clone` is a plain copy (`UnsupervisedSupervisor.restartCount` carries over; `AutoCompact` carries its config). They are root-owned and constructed fresh today, so nothing calls their `clone` yet — the shape is there so the contract is uniform.

## FileSupervisor history

Per file rather than per snapshot — a whole-`Files` snapshot per idx is quadratic in a long conversation, and the per-file list is the natural unit since only touched files change.

```
type FileViewEntry = {
  nativeMessageIdx: NativeMessageIdx;
  agentView: TrackedFileInfo["agentView"];
  lastStat: FileStat | undefined;
};
```

Each `Files[abs]` entry carries `history: FileViewEntry[]` (append-only, non-decreasing idx) instead of the bare `agentView` / `lastStat` pair. Live `agentView` / `lastStat` become getters over `history[history.length - 1]`. Every existing mutation of `fileInfo.agentView` becomes `recordView(fileInfo, idx, view, stat)`; the idx comes from the hook that is running.

`clone({ source, nativeMessageIdx })` deep-copies each file, truncates its history, and starts with empty `pendingUpdates` (it is derived: the next `refreshPendingUpdates` rebuilds it from `agentView` + disk). A file whose history is empty after truncation is still tracked (membership is the user's context list, not an agent-visible fact) but has `agentView === undefined`, so the next request sends the whole file — which is the correct "the agent has never seen this" answer.

The headline behaviour falls out: rewind to idx N restores the agentView the agent had at N, and `refreshPendingUpdates` diffs *that* snapshot against current disk content.

## GitTracker history

`agentView` becomes `history: { nativeMessageIdx, state }[]`, `getAgentView()` reads the last entry. `getUpdate(idx)` appends when the coarse identity changed; the "keep counts fresh without reporting" branch overwrites the last entry in place rather than appending (it is not an agent-visible fact). `GitSupervisor.clone({ source, nativeMessageIdx, onSent })` truncates.

`ThreadCore.clone` must stop rebuilding the git supervisor from `initialGitState` and clone the source's instead.

## SystemReminderSupervisor becomes a real supervisor

The `ReminderSupervisor` interface, the `noReminders` null object, and `ThreadCore.reminderAction` all exist only to work around the fact that this one collaborator is consulted out of band. It should implement `ThreadSupervisor` like the rest; a compact thread then simply omits it from the supervisor list, exactly as it already omits the file and system-info supervisors, and `ReminderSupervisor`/`noReminders` are deleted. `ThreadCore.systemReminders` becomes `SystemReminderSupervisor | undefined`, and its three external call sites (`thread.ts:274`, `404`, `530`) become optional calls.

Three things have to be settled to make that work:

- **Ordering.** Injections are applied in supervisor order, so the ordering requirement — the reminder immediately before the user's queued content — is satisfied by registering it as the last supervisor in the list, with `flushQueue` still registered after the whole group in `agentHooks()`. The owner supervisors then sit after it, which is fine: none of them inject (`MaxTokens` and `Subagent` are end-turn only, `AutoCompact` only suspends, `Docker` has no `onBeforeRequest`), so no injection can come between the reminder and the queued content.
- **`onToolResults` needs the structured results map,** which the `ThreadSupervisor` signature does not carry. Give the supervisor a `getStructuredResults: () => ReadonlyMap<ToolRequestId, ToolStructuredResult>` dependency at construction — `ThreadCore` passes `() => this.structuredToolResults` — matching how it already receives `contextTracker`.
- **`status: "suspended"`.** `reminderAction` declines on a suspended request, because committing "standing reminder sent" for a request that will never be issued loses the reminder. No other supervisor can make that check: `composeSupervisors` passes the hook straight through and `RequestContext` has no `status` field, so `FileSupervisor` and `GitSupervisor` currently *do* commit their agent view on requests that get suspended. **That is a pre-existing bug, and it is the same class of bug this whole plan is about.** Fix it here by moving `status` onto `RequestContext` (i.e. `RequestContext` becomes what `AgentRequestContext` is today) so every supervisor sees it, and have the committing supervisors decline.

## SystemReminderSupervisor history

All four pieces of its state are facts about the log:

- `standingReminderSent` + `tokensAtLastReminder` → `standingHistory: { nativeMessageIdx, outputTokenCount }[]`, appended when a standing reminder is injected. After truncation, the last surviving entry supplies `tokensAtLastReminder`; an empty history means "never sent", which correctly makes the clone's first request carry the standing reminder outright.
- `pendingBashReminder` → `bashHistory: { nativeMessageIdx, state: "armed" | "fired" }[]`; armed in `onToolResults`, fired in `onBeforeRequest`. Pending is "the last surviving entry is `armed`".
- `reminders: Set<string>` → `{ nativeMessageIdx, text }[]`, rebuilt into a deduped set after truncation. `activateReminder(text, nativeMessageIdx)` gains the idx; its call sites are `onToolResults` (get_files) and `thread.ts:404` / `thread.ts:530`, which pass `manager.getNativeMessageIdx() + 1`.
- The `.md`-derived reminders in `extraReminders()` need nothing: they are read live off the `ContextTracker`, which is the `FileSupervisor` and rewinds itself.

`create({ threadType, subagentConfig, contextTracker, getStructuredResults })` / `clone({ source, nativeMessageIdx, contextTracker, getStructuredResults })` — the clone must be given the *clone's* file supervisor, not the source's.

`ThreadCore.clone` currently rebuilds this fresh via `createReminderSupervisor()`, which is a real behaviour change to fix: a fork at head today re-sends the standing reminder and forgets every activated reminder.

## Interfaces

```ts
// thread-supervisor.ts
export type RequestContext = {
  inputTokenCount: number | undefined;
  outputTokenCount: number;
  /** The idx of the message that will carry this request's injections. */
  nativeMessageIdx: NativeMessageIdx;
};

export type EndTurnContext = {
  stopReason: StopReason;
  inputTokenCount: number | undefined;
  lastAssistantMessage: ReadonlyArray<ProviderMessageContent> | undefined;
  nativeMessageIdx: NativeMessageIdx;
};

export interface ThreadSupervisor {
  onBeforeRequest?(context: RequestContext): Promise<SupervisorAction>;
  onToolResults?(results: ToolResults, nativeMessageIdx: NativeMessageIdx): void;
  onToolApplied?: OnToolApplied; // gains a trailing nativeMessageIdx arg
  onEndTurnWithoutYield?(context: EndTurnContext): EndTurnAction;
  // unchanged: onYield, onReset, requestPreflightTokenCount, hasPendingContent
}

// file-supervisor.ts
static create(args: FileSupervisorDeps & { initialFiles?: Files }): FileSupervisor;
static clone(args: {
  source: FileSupervisor;
  nativeMessageIdx: NativeMessageIdx;
  onSent?: (updates: FileUpdates) => void;
}): FileSupervisor;

// git-supervisor.ts
static create(args: { gitClient; initialGitState; logger; onSent? }): GitSupervisor;
static clone(args: { source: GitSupervisor; nativeMessageIdx; onSent? }): GitSupervisor;

// thread-supervisor.ts
SystemInfoSupervisor.create({ systemInfo, alreadyInjected });
SystemInfoSupervisor.clone({ source, nativeMessageIdx });
```

`OnToolApplied` (`capabilities/context-tracker.ts`) gains the idx. `ThreadCore.onToolApplied` supplies `manager.getNativeMessageIdx() + 1`; tools themselves do not learn about idx.

## Invariants

- An entry recorded at idx N survives `clone(N)`; one recorded at N+1 does not. This must match `truncateMessages` semantics exactly, including its `computeTruncateEndIdx` adjustment — **verify** whether that method can move the boundary (e.g. snapping to a user-message boundary). If it can, `ThreadCore.clone` must pass the *effective* idx (read back via `manager.getNativeMessageIdx()` after truncation) to the supervisors, not the requested one.
- `onBeforeRequest`'s idx must be the idx the injection actually lands at. **Verify** whether injections append a new message or merge into an existing trailing user message; `+1` assumes append.
- `hasPendingContent` still commits nothing.
- `onReset` (compaction) clears all history — the log it described is gone.
- Cloning at the source's current idx must be byte-for-byte equivalent to today's `"preserve"`; cloning at an idx before the first delivery must be equivalent to `"reseed"`.
- `onSent` callbacks fire only for the live thread (`core?.isActive`) — unchanged.
- Histories are append-only and idx-monotonic; a supervisor never rewrites an entry at an idx < the last one.

# Stages

## Plumbing the idx through the contract — **DONE**

- Goal: `RequestContext`, `EndTurnContext`, `onToolResults`, and `OnToolApplied` all carry a `NativeMessageIdx`; every implementer compiles; no behaviour change.
- Includes resolving the two "verify" items above with a focused test that asserts the idx a before-request injection actually lands at.
- Tests:
  - A supervisor that records `ctx.nativeMessageIdx` in `onBeforeRequest` sees an idx that, after the request completes, names the message containing its injected text.
  - `onToolApplied` during a tool call reports the idx of the message that will hold the tool result.
  - Existing supervisor/agent suites still pass.

### What was done

- `RequestContext` and `EndTurnContext` gained `nativeMessageIdx`; `ToolResultsHook`
  and `ThreadSupervisor.onToolResults` gained a trailing `NativeMessageIdx`.
- `NativeInferenceManager` gained `getPendingUserMessageIdx()`, implemented by both
  providers. `runBeforeRequestHooks` reports it as `ctx.nativeMessageIdx`.
- `ToolExecutorDeps` gained `getPendingResultMessageIdx`; `ThreadCore` supplies
  `manager.getNativeMessageIdx() + 1` from a new `pendingResultMessageIdx` getter,
  and the same getter feeds `onToolApplied`.
- `Thread.plannedContinuation` passes `this.core.manager.getNativeMessageIdx()` to
  `onEndTurn`.
- Tests: `agent.test.ts` → `describe("nativeMessageIdx plumbing")` (3 cases);
  `anthropic-inference.test.ts` truncate test gained a `getNativeMessageIdx()` readback.

### Decisions and deviations

- **`onBeforeRequest`'s idx is NOT `getNativeMessageIdx() + 1`.** `appendUserMessage`
  *merges* into a trailing user message on both providers, and a continuation's
  before-request hooks run right after `appendToolResults` has pushed user messages.
  So the injection lands *on* the tool-result message. `+1` is only correct when the
  log ends with an assistant message. This is why `getPendingUserMessageIdx()` exists
  rather than arithmetic at the call site, and the plan's `+1` for `onBeforeRequest`
  is superseded. The continuation case is pinned by a test asserting
  `requestIdx[1] === resultIdx[0]`.
- `onToolApplied` / `onToolResults` keep `+1`: `appendToolResults` always pushes.
- **`truncateMessages` does move the boundary**, both forward (extending to keep the
  tool_result messages answering a kept `tool_use`) and backward (dropping an
  assistant message left empty after orphan `tool_use` blocks are stripped). So
  Stage 3's `ThreadCore.clone` **must** read the effective idx back via
  `manager.getNativeMessageIdx()` after truncating and hand *that* to the
  supervisors, not the requested idx. Pinned by the readback assertion in
  `anthropic-inference.test.ts`.
- `OnToolApplied` was left alone (it is the tool-facing type, and tools must not
  learn about indices). A separate `OnToolAppliedHook` in
  `capabilities/context-tracker.ts` carries the idx; `ThreadSupervisor.onToolApplied`
  and `ThreadHooks.onToolApplied` use it, and `ThreadCore` bridges the two.
- `status` has not moved onto `RequestContext` yet — that belongs to Stage 4.

### Review follow-ups (stage 1)

- **`+1` for tool results was wrong for both providers, not just openai.** Both
  write one message per result (anthropic a user message each, openai a
  `function_call_output` item each), so a parallel batch spans several messages.
  The formula moved onto the manager as
  `getPendingResultMessageIdx(toolCount)`, returning the *last* message of the
  batch — the conservative choice, since truncating anywhere inside the batch
  then drops whatever a supervisor keyed on it. `ToolExecutorDeps`'
  `getPendingResultMessageIdx` takes the count (the executor has the request
  list); `ThreadCore` records `liveBatchToolCount` when it builds the executor
  so `onToolApplied`, which fires mid-batch, can ask too.
- `test-helpers.ts` now calls `manager.getPendingResultMessageIdx` rather than
  restating the formula, so a wrong production value cannot be agreed with by
  construction.
- `OnToolAppliedHook` takes a single `ToolAppliedEvent` object, so an
  `OnToolApplied` (which ignores the trailing idx) is no longer silently
  assignable to it.
- New tests: `openai-inference.test.ts` →
  `describe("OpenAIInferenceManager pending message indices")` pins that an
  openai continuation's injection starts a *new* message after the batch
  (unlike anthropic, where it merges into the tool-result message) and that the
  reported result idx is the last of a two-tool batch; `agent.test.ts` gained
  the anthropic parallel-batch case.
- **Declined**: a separate `PendingNativeMessageIdx` brand. Stages 2-4 compare
  pending idxs against recorded ones and hand them to `truncateMessages`
  directly, so a second brand would need a conversion at every one of those
  points while adding nothing the "pending" name and doc comments do not
  already say.

### Review follow-ups (stage 1, second pass)

- Replaced the unconstrained tool count with `NonEmptyRequestedTools`, carried
  from `RequestResult` through `ToolExecutor` and `ToolExecutorHost` into
  `NativeInferenceManager.getPendingResultMessageIdx`. Provider request loops
  narrow their collected arrays with `isNonEmptyRequestedTools`, so negative,
  fractional, and empty counts are unrepresentable and the `Math.max` fallback
  is gone.
- Replaced `ThreadCore.toolExecutor` plus the independently stored default/stale
  count with a discriminated `toolBatch` state. The running variant owns the
  executor and exact non-empty request batch; `onToolApplied` can only compute
  its pending result idx while that state is active, and cleanup returns the
  state to `idle` only for the matching executor.
- Added OpenAI coverage for an image-bearing `get_files` result. It pins that
  the supervisor idx names the `function_call_output`, not the following
  attachment user message; that the continuation injection coalesces into the
  attachment message; and that truncating at either side of that boundary
  respectively drops or preserves the attachment.

### Validation (stage 1, second pass)

- Focused provider, executor, and agent suites pass (188 tests).
- `npx tsc -b`, `npx biome check .`, and `git diff --check` pass.
- The full suite excluding the previously documented, independently failing
  `node/nvimclient/nvim/buffer-reload.test.ts` passes 1,656 tests. An unfiltered
  full run again had only that file's existing "an agent edit is undone in a
  single undo" failure, which also fails by itself on the clean stage-1 base.

### Validation (stage 1)

- Focused stage suites pass: `agent.test.ts`, both inference-manager suites,
  and `file-supervisor.test.ts` (193 tests).
- `npx tsc -b`, `npx biome check .`, and `git diff --check` pass.
- The full `npx vitest run` passes 1,665 tests but has one unrelated failure in
  `node/nvimclient/nvim/buffer-reload.test.ts` ("an agent edit is undone in a
  single undo"). The same failure reproduces in a clean detached worktree at
  the pre-follow-up `80f66146b4` HEAD, so it was not introduced by this stage.

## FileSupervisor history + create/clone — **DONE**

### What was done

- `Files` entries now own append-only `FileViewEntry[]` histories keyed by
  `NativeMessageIdx`; `agentView` and `lastStat` are derived from the last entry.
- File deliveries from `onBeforeRequest` and tool-applied views both append at
  the idx supplied by the Stage 1 hook plumbing. PDF view values and histories
  are deep-copied so source and clone page lists remain isolated.
- `FileSupervisor.clone({ source, nativeMessageIdx })` truncates each file's
  copied history through the requested inclusive index while preserving context
  membership. Its `pendingUpdates` and stat-observation cache start empty and
  are rebuilt from the restored view and live disk state.
- Reset still retains context membership but clears all histories. Auto-context
  seeds now initialize the history-bearing `Files` shape.
- Added coverage for a head clone, a pre-delivery clone, restoring an older
  text baseline for a diff, retaining a later-added context file as unseen,
  and reporting a deletion against the restored snapshot.

### Decisions and deviations

- `lastStat` is recorded with each delivered view, while a separate
  clone-local `observedStats` cache handles polling between deliveries. Polls
  cannot append history because they have no message idx, and mutating an old
  history entry's stat could make a rewind incorrectly skip a disk diff.
- Stage 3 still owns removal of `ThreadCore.clone`'s `sourceBusy`/head-preserve
  heuristic. For this stage, that existing decision is translated to an index
  when calling the new FileSupervisor API; pending updates are no longer copied
  because they are derived state.

### Review follow-ups (stage 2)

- Replaced `FileSupervisor.clone`'s sentinel-index reseed convention with a
  `FileHistoryClone` discriminated union: `{ type: "reseed" }` or
  `{ type: "truncate", nativeMessageIdx }`. `ThreadCore` translates its
  temporary stage-2 preserve heuristic into that operation, so reseeding can
  never retain placeholder-indexed entries and tests no longer cast magic
  negative values to `NativeMessageIdx`.
- Moved file histories out of the public `Files` representation into a
  module-private `WeakMap`. Public tracked files expose only cloned readonly
  `agentView` / `lastStat` snapshots, while all construction and monotonic
  appends continue through `FileSupervisor` helpers. Auto-context seeds no
  longer manufacture a mutable `history` property.
- Added retained PDF-history coverage: page 1 is recorded at idx N, retained by
  an inclusive clone at N, and page 2 is applied to the clone without mutating
  the source's `[1]` page snapshot.
- The required full-suite run exposed the already-documented Neovim 0.8 undo
  failure in `buffer-reload.test.ts`. `reloadFromDisk` now refreshes Neovim's
  file timestamp by writing the already-matching buffer with `noautocmd write!`
  instead of `checktime`; the latter silently reloaded the buffer and discarded
  the agent edit's undo entry on older Neovim.

### Validation (stage 2)

- Focused file-supervisor suites pass (43 tests), including the retained PDF
  history isolation case.
- The full `npx vitest run` passes 1,670 tests (2 skipped, 1 todo), including
  `buffer-reload.test.ts` on Neovim 0.8.
- `npx tsc -b`, `npx biome check .`, and `git diff --check` pass.

- Goal: `Files` entries carry per-file view history; `clone({ source, nativeMessageIdx })` replaces `delivery: "preserve" | "reseed"`.
- Tests:
  - Clone at the source's current idx behaves identically to today's `"preserve"` (port the existing delivery tests).
  - Clone at an idx before any file was ever delivered sends the whole file on the next request.
  - **The headline case**: a file is delivered at idx N, edited on disk, delivered again at idx M > N; cloning at N and issuing a request yields a diff from the *N* snapshot, not from the M one.
  - A file added to context after idx N is still tracked by the clone but is sent whole.
  - A file deleted on disk after the clone point reports `file-deleted` against the restored snapshot.

## GitSupervisor history + ThreadCore wiring — **DONE**

### What was done

- `GitTracker` now owns an index-keyed history of agent-visible git states.
  Coarse branch/HEAD/repository changes append at the request's
  `nativeMessageIdx`; count-only refreshes update the latest entry without
  manufacturing an agent-visible history event.
- `GitSupervisor.create` and `GitSupervisor.clone` construct fresh and rewound
  trackers respectively. Clones deep-copy and inclusively truncate history, so
  a git update after the fork point is delivered again while one at the fork
  point is retained.
- `SystemInfoSupervisor.create` / `clone` replaced its boolean with
  `injectedAt`. `onBeforeRequest` records the actual pending user-message idx,
  clone retains it only through an inclusive boundary, and reset clears it.
- `ThreadCore` now receives its git and system-info supervisors as owned
  collaborators. `create` constructs them fresh; `clone` truncates the cloned
  manager first, reads back `manager.getNativeMessageIdx()`, and uses that
  effective index to clone file, git, and system-info state.
- Removed `sourceBusy` and the preserve/reseed heuristic. Busy forks now retain
  every context fact already committed to the native log, matching idle forks.
- Added tracker and supervisor rewind coverage, Thread-level git and system-info
  restoration tests, retained the earlier-message file-context fork coverage,
  and updated busy-fork snapshots to stop expecting redundant git delivery.

### Decisions and deviations

- The initial git view is stored at `PLACEHOLDER_NATIVE_MESSAGE_IDX`: it is
  seeded from `initialGitState` rather than learned by a supervisor hook. Every
  real message boundary therefore retains the seed, while subsequent delivered
  changes remain normally rewindable.
- `SystemInfoSupervisor.create({ alreadyInjected: true })` likewise uses the
  placeholder index because callers only know that a replacement log already
  describes the preamble, not which original request carried it. Normal live
  delivery always records the exact hook-supplied index.
- The plan's illustrative "clone at idx 0 repeats system info" is not valid for
  an Anthropic opening request: Stage 1 established that the preamble merges
  into the user message at idx 0, and clone boundaries are inclusive. Tests
  therefore assert that cloning at the injection idx retains it and cloning at
  the effective empty-log boundary (`-1`) re-arms it.
- `FileHistoryClone` keeps its explicit `reseed` variant for reset/direct file
  supervisor use, but `ThreadCore.clone` no longer uses it; thread forks always
  truncate against the manager's effective index.

### Review follow-ups (stage 3)

- Added GitTracker coverage proving that an unreported count-only refresh updates
  the retained agent view: a later branch/HEAD delivery uses the refreshed counts
  in `previous`, and a clone through the refresh retains the same state.
- Added coverage for the monotonic-history guard: after a coarse change is
  recorded at a higher native message index, a second coarse change at a lower
  index rejects with the invariant error.

### Validation (stage 3)

- Focused supervisor, context, and fork suites pass.
- The full `npx vitest run` passes 1,677 tests (2 skipped, 1 todo).
- `npx tsc -b`, `npx biome check .`, and `git diff --check` pass.

## SystemReminderSupervisor — **DONE**

### What was done

- `SystemReminderSupervisor` now implements `ThreadSupervisor` and is part of
  `ThreadCore`'s composed context-supervisor list. `ReminderSupervisor`,
  `noReminders`, `ThreadCore.reminderAction`, and the separate tool-result hook
  were removed; compact threads hold no reminder supervisor.
- Standing reminders, abbreviated-bash reminders, and activated reminders now
  use independent append-only histories keyed by `NativeMessageIdx`.
  `SystemReminderSupervisor.clone` inclusively truncates all three histories and
  receives the clone's own `FileSupervisor` plus a clone-local structured-result
  accessor.
- `RequestContext` now carries `status`. System-info, file, git, and reminder
  supervisors decline suspended requests before committing agent-visible state.
- Reminder activation from immediate submissions is keyed to
  `manager.getPendingUserMessageIdx()`. Stop-time queued resolutions use the
  same pending-message calculation, while mid-turn queued resolutions use the
  hook's exact `ctx.nativeMessageIdx`.
- `ThreadCore.agentHooks()` now runs owner before-request gates before the
  context supervisor group. The reminder remains the final context supervisor,
  followed only by queue flushing and token-count recording, so it still lands
  after context updates and immediately before queued/user content.
- Added unit coverage for standing-interval rewind, bash-arm rewind,
  get-files/activated-reminder rewind, deduplication, and suspended reminder
  delivery. Added Thread-level coverage that a head fork retains reminder state
  without resending the standing reminder and that suspension preserves file,
  git, system-info, and reminder delivery for the next issued request. Existing
  compact-thread coverage verifies requests contain no reminder content.

### Decisions and deviations

- The owner before-request hooks were moved ahead of the context supervisor
  group. Merely adding `status` checks cannot protect a committing supervisor
  that runs before the hook that suspends; built-in owner supervisors do not
  inject request content, so this preserves reminder placement while making the
  suspension guarantee enforceable.
- Activated reminders use the message index they actually ride rather than the
  plan's illustrative `getNativeMessageIdx() + 1`. This matters for Anthropic
  continuations, where queue content can merge into the trailing tool-result
  user message, and matches the Stage 1 pending-user-index rule.
- `onReset` clears all reminder histories for direct supervisor use. Thread
  reset/compaction already replaces the whole `ThreadCore`, so the replacement
  supervisor starts empty and re-derives markdown reminders from the newly
  reset file supervisor.

### Review follow-ups (stage 4)

- Added inclusive bash-latch rewind coverage: a clone through the `armed` entry
  still fires the reminder, while clones through and after the `fired` entry
  keep it consumed.
- Extended the deferred-reminder Thread test to fork immediately before and
  through the user message that carries the resolved queued submission. The
  earlier fork drops the activation and the inclusive fork retains it, pinning
  the stop-time `getPendingUserMessageIdx()` wiring.
- Replaced the independently optional reminder field with
  `ThreadCoreSupervision`, a discriminated union that owns both the concrete
  compact/reminder-bearing context and, for the latter, its required
  `SystemReminderSupervisor`. `Thread.clone` now accepts a `ThreadCloneContext`
  that cannot specify `threadType`; clone construction inherits the source
  discriminant, so compactness and reminder presence cannot diverge.

### Validation (stage 4)

- The full `npx vitest run` passes 1,684 tests (2 skipped, 1 todo), including
  the Docker sync suite after restarting the local OrbStack daemon.
- `npx tsc -b`, `npx biome check .`, and `git diff --check` pass.

## Uniform create/clone for the remaining supervisors — **DONE**

### What was done

- `MaxTokensSupervisor`, `SubagentSupervisor`, `UnsupervisedSupervisor`,
  `AutoCompactSupervisor`, and `DockerSupervisor` now expose `static create`
  and `static clone` factories and have private constructors.
- Stateless clones construct equivalent fresh supervisors. `AutoCompactSupervisor`
  retains its threshold and continuation prompt, while `UnsupervisedSupervisor`
  retains both its restart limit and consumed restart count.
- Root thread wiring and direct test construction now use the factories.
- Added a clone smoke test proving an `UnsupervisedSupervisor` clone resumes at
  the source's restart count, preserves the configured limit, and advances
  independently.

### Decisions and deviations

- A private `UnsupervisedSupervisor` constructor cannot support subclassing, so
  `DockerSupervisor` now implements `ThreadSupervisor` by composing an
  `UnsupervisedSupervisor` rather than extending it. Its clone copies the
  composed restart state, Docker paths/callback configuration, and any teardown
  result already recorded.

### Validation (stage 5)

- The full `npx vitest run` passes 1,685 tests (2 skipped, 1 todo). An initial
  full run had three transient Neovim socket-startup failures; all three passed
  together on retry, and the subsequent full run passed.
- `npx tsc -b`, `npx biome check .`, and `git diff --check` pass.
