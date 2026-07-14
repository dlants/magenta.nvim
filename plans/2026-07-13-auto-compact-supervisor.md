# Objective and Context

User request (verbatim):

> I'd like to look into auto-compact behavior. I'd like to implement this as a thread supervisor. Let's default to 300k tokens. When we breach this threshold, we compact with a auto-compact prompt (which is also configurable). write a plan

We want to move the existing auto-compaction trigger out of the hard-coded inline logic in `ThreadCore` and model it as a **thread supervisor** concern. The trigger threshold should default to **300k input tokens** and be configurable, and the prompt that drives compaction should also be configurable.

## Current state

Auto-compaction already exists, but it is inline in `ThreadCore`:

- `ThreadCore.shouldAutoCompact()` (`node/core/src/thread-core.ts`) returns true when `agent.getState().inputTokenCount >= getContextWindowForModel(profile.model) * 0.8`, and false for `threadType === "compact"`.
- It is consulted at two submit points: in the message-send preparation path (~line 1048) and in the continue-after-tool-results path (~line 1402). When true, it calls `startCompaction(nextPrompt?)`.
- `startCompaction` spins up a `CompactionManager` (`node/core/src/compaction-manager.ts`), which summarizes the transcript using `COMPACT_PROMPT_TEMPLATE`, loaded from `compact-system-prompt.md`. That template is currently fixed (not configurable).

The supervisor abstraction already exists:

- `ThreadSupervisor` interface (`node/core/src/thread-supervisor.ts`) with `onEndTurnWithoutYield`, `onYield`, `onAbort`, returning a `SupervisorAction` (`send-message` / `accept` / `reject` / `none`). Implementations: `SubagentSupervisor`, `UnsupervisedSupervisor`; the root layer adds `DockerSupervisor` (`node/chat/thread-supervisor.ts`).
- `ThreadCore.supervisor` is an optional field consulted at end-of-turn (line ~692) and on yield (line ~1228). It is assigned per thread type in `node/chat/chat.ts` (`DockerSupervisor` for supervised docker, `SubagentSupervisor` for subagent/docker_root). **Root/user threads currently have no supervisor.**

## Key relationships

- `ThreadCore` owns the agent, the token accounting (`inputTokenCount`), and `startCompaction`.
- The supervisor is a pluggable policy object. Today it only reacts at turn boundaries; auto-compact must react at *every handoff* — whenever the agent gives up its turn (stops streaming with a `tool_use`, `end_turn`, `max_tokens`, etc. stop reason), before `ThreadCore` decides how to proceed. This is a new hook, consulted at the single `handleProviderStopped` chokepoint rather than at individual submit sites.

Relevant files:

- `node/core/src/thread-supervisor.ts` — supervisor interface + core implementations (add hook + base class here).
- `node/core/src/thread-core.ts` — inline `shouldAutoCompact`, the two submit call sites, `handleProviderStopped` (the single handoff chokepoint), `startCompaction`.
- `node/core/src/compaction-manager.ts` — `COMPACT_PROMPT_TEMPLATE`, summarization request.
- `node/chat/chat.ts` — assigns supervisors per thread type.
- `node/chat/thread-supervisor.ts` — `DockerSupervisor`.
- `node/options.ts` — `MagentaOptions` and parsing; add config for threshold + prompt.
- `lua/magenta/options.lua` — lua-side option defaults/plumbing.
- `sdk/protocol.ts` — `ThreadOptions` (per-`thread()` options exposed to scripts); add threshold + prompt fields.
- `node/scripts/script-manager.ts` — `create-thread` handler; forward the new options into `spawnScriptThread`.
- `node/chat/chat.ts` — `spawnScriptThread` / `createThreadWithContext`; accept per-thread overrides and pass them into supervisor + compaction construction.

# Design

## Threads hold a list of supervisors

A thread can have several independent supervisor concerns active at once (e.g. a subagent's yield-policing *and* auto-compact). Replace the single `ThreadCore.supervisor?: ThreadSupervisor` field with `ThreadCore.supervisors: ThreadSupervisor[]` (default `[]`), and update `Thread` (`node/chat/thread.ts`) / `chat.ts` accordingly.

Aggregation semantics: at each hook, `ThreadCore` iterates the supervisors **in order** and returns the **first non-`none` action**; if all return `none` (or don't implement the hook), the result is `none`. This makes each supervisor responsible for a disjoint concern and keeps ordering explicit. Because most supervisors only care about one or two hooks, make every `ThreadSupervisor` method **optional**; `ThreadCore` guards each call (`sup.onHandoff?.(...)`) and treats a missing method as `none`.

## Add a handoff supervisor hook

Extend `ThreadSupervisor` with a new (optional) method:

```
onHandoff(context: { inputTokenCount: number | undefined; stopReason: StopReason }): SupervisorAction
```

Add a new `SupervisorAction` variant:

```
| { type: "compact"; nextPrompt?: string }
```

`ThreadCore` consults the supervisor list (first non-`none` wins) at the top of `handleProviderStopped` — the single chokepoint reached every time the agent gives up its turn, regardless of stop reason. This replaces the two inline `shouldAutoCompact()` call sites (message-send prep and continue-after-tool-results); the existing inline `shouldAutoCompact()` method is removed and the threshold logic moves into a supervisor. If the aggregated action is `compact`, `ThreadCore` calls `startCompaction(action.nextPrompt)` and returns.

Sequencing note: on a `tool_use` handoff the agent has pending tool calls, and compaction summarizes the whole transcript and starts fresh. To avoid dropping tool results mid-flight, run the `onHandoff` compaction check *after* pending tool calls have resolved for `tool_use` (i.e. keep the check at the continue-after-tool-results point for that path) while firing it directly at handoff for the terminal stop reasons (`end_turn`, `max_tokens`). The net effect: compaction is evaluated at every handoff, but never interrupts an in-progress tool round-trip.

## Auto-compact is its own supervisor in the list

Auto-compact becomes a standalone `AutoCompactSupervisor` that implements only `onHandoff` (the threshold check). It is **not** a base class; `SubagentSupervisor` and `UnsupervisedSupervisor` are left as-is (they keep their current single-concern behavior, now with the other hooks simply omitted).

`chat.ts` builds each thread's `supervisors` array:
- root/user threads: `[new AutoCompactSupervisor(...)]` (previously no supervisor).
- subagent/docker_root: `[new SubagentSupervisor(), new AutoCompactSupervisor(...)]`.
- supervised docker: `[new DockerSupervisor(...), new AutoCompactSupervisor(...)]`.

Every non-compact thread thus gets auto-compact via a shared entry in its list, while its yield/turn policy remains a separate supervisor. Compact-type threads get `[]` (never auto-compact — preserves today's guard).

## Configuration

Threshold and prompt are passed into the `AutoCompactSupervisor` constructor (it stores them). Defaults:

- `autoCompactThreshold: number` — default `300000`. The base returns `{ type: "compact" }` when `inputTokenCount !== undefined && inputTokenCount >= threshold` and the thread is not itself a compact thread. (Note: the "not a compact thread" guard currently lives in `shouldAutoCompact` via `state.threadType`; since the supervisor doesn't see thread type, either pass `threadType` into `onHandoff`'s context, or simply never assign a supervisor to compact threads — prefer the latter for simplicity, since compact threads are internal to `CompactionManager` and never get a supervisor anyway.)
- `autoCompactPrompt: string | undefined` — the configurable compaction prompt. When set, it overrides `COMPACT_PROMPT_TEMPLATE`. Plumb it through `ThreadCoreContext` → `startCompaction` → `CompactionManager` (add an optional `compactPromptTemplate` field; fall back to the bundled markdown when absent).

Add both to `MagentaOptions` (`node/options.ts`) with parsing + validation (positive number for threshold; non-empty string for prompt), mirror defaults in `lua/magenta/options.lua`, and thread them into wherever `ThreadCoreContext` / supervisor construction happens (`chat.ts`).

Per-thread overrides (magenta scripts): a script's `thread(prompt, yieldSchema, options)` call may set `autoCompactThreshold` and `autoCompactPrompt` per spawned thread. These override the global `MagentaOptions` defaults for that thread only. Precedence: per-thread option → global `MagentaOptions` → hard-coded default (`300000` / bundled `COMPACT_PROMPT_TEMPLATE`). The overrides flow `ThreadOptions` (`sdk/protocol.ts`) → `create-thread` IPC → `ScriptManager` → `chat.spawnScriptThread` → `createThreadWithContext`, where they are fed into the thread's supervisor construction (threshold) and `ThreadCoreContext` (prompt). Threads spawned outside scripts simply omit the overrides and use the global defaults.

Design note / decision: we keep `startCompaction` and `CompactionManager` in `ThreadCore` (the supervisor only *decides* to compact and supplies the prompt); the supervisor does not itself run compaction. This keeps token accounting and agent ownership in `ThreadCore` and matches how the other supervisor actions are executed by `ThreadCore` rather than the supervisor.

Invariants:
- Compaction must never be triggered on a `compact`-type thread (avoid infinite recursion). Preserve today's guard.
- Behavior for docker/subagent threads at their existing turn/yield hooks must be unchanged. Those hooks now iterate the supervisor list, but `AutoCompactSupervisor` doesn't implement them, so the aggregated result is identical to today.
- The existing `onEndTurnWithoutYield` / `onYield` / `onAbort` call sites (thread-core ~692 and ~1228) must be updated to iterate `supervisors` and take the first non-`none` action.
- When no threshold is breached, the handoff proceeds exactly as before (no behavioral change to the normal path).
- The default threshold moves from model-relative (`contextWindow * 0.8`) to an absolute `300000`; call this out as an intentional behavior change.

# Stages

## 1. Supervisor list + `onHandoff` hook + `compact` action + `AutoCompactSupervisor` — DONE

Progress notes (Stage 1):
- Made all `ThreadSupervisor` methods optional; added `onHandoff?(context: HandoffContext)` and `HandoffContext` type.
- Added `{ type: "compact"; nextPrompt?: string }` to `SupervisorAction`.
- Added standalone `AutoCompactSupervisor` (default threshold 300000) implementing only `onHandoff`; `SubagentSupervisor`/`UnsupervisedSupervisor` unchanged.
- Minimally guarded the two existing call sites in `thread-core.ts` (`onEndTurnWithoutYield?.`/`onYield?.` with `{ type: "none" }` fallback) so the now-optional methods typecheck; full list iteration is Stage 2.
- Added `node/core/src/thread-supervisor.test.ts` covering at/over/under threshold, `undefined`, default threshold, and custom `nextPrompt`.
- Full suite green: `npx tsgo -b`, `npx vitest run node/core/`, `npx biome check .` all pass.

Code-review follow-ups (Stage 1):
- Narrowed hook return types so unhandled actions are non-representable: added `EndTurnAction` (send-message | none), `YieldAction` (accept | reject | send-message | none), `AbortAction` (none), and `HandoffAction` (compact | none). `SupervisorAction` is now the union of these. `compact` is only representable from `onHandoff`, so it can no longer be silently returned from `onYield`/`onEndTurnWithoutYield`.
- `ThreadSupervisor` methods now return their narrow per-hook types; concrete supervisors and `DockerSupervisor.onYield` updated accordingly.
- Exported the new action/context types from `node/core/src/index.ts`; updated `node/tools/spawn-subagents.test.ts` annotations.
- Made the `onYield` switch in `thread-core.ts` exhaustive with `assertUnreachable`.
- Decision on optional methods (nit): kept all `ThreadSupervisor` methods optional — a supervisor implements exactly the subset of hooks it needs (single-concern supervisors compose in a list). `ThreadCore` guards each call and treats a missing method as `{ type: "none" }`. This is the intended design.

- Goal: make all `ThreadSupervisor` methods optional and add `onHandoff`; add the `compact` `SupervisorAction`; add a standalone `AutoCompactSupervisor` implementing the 300k threshold check; `SubagentSupervisor`/`UnsupervisedSupervisor` are unchanged.
- Verification:
  - Behavior: `onHandoff` returns `compact` at/over threshold and `none` below.
  - Setup: construct a supervisor with `autoCompactThreshold: 300000`.
  - Actions: call `onHandoff({ inputTokenCount, stopReason })` with values just under and at/over the threshold, and with `undefined`.
  - Expected: `{ type: "compact" }` at/over; `{ type: "none" }` under and for `undefined`.
- Before moving on: confirm tests, type checks, and linting all pass.

## 2. Route `ThreadCore` through the supervisor list

Progress notes (Stage 2) — DONE:
- Replaced `ThreadCore.supervisor?: ThreadSupervisor` with `supervisors: ThreadSupervisor[] = []`. Updated `Thread` getter/setter (`node/chat/thread.ts`) to `supervisors`, and `chat.ts` to assign single-element arrays (`[DockerSupervisor]` / `[SubagentSupervisor]`; full lists incl. `AutoCompactSupervisor` are Stage 3).
- Added three aggregation helpers in `thread-core.ts` (first non-`none` wins): `consultEndTurnSupervisors`, `consultYieldSupervisors` (async), `consultHandoffSupervisors`. The two existing hook sites now iterate via these helpers.
- Consulted `onHandoff` in `handleProviderStopped`: fires for the terminal `end_turn` path (guarded `stopReason !== "aborted"`) and the `max_tokens`-without-tool-use path, and in `sendToolResultsAndContinue` for the `tool_use` path (after pending tools resolve). On a `compact` action calls `startCompaction(nextPrompt)` and returns.
- Removed `shouldAutoCompact` and the two inline call sites (message-send prep in `sendMessage`, continue-after-tool-results). Dropped the now-unused `getContextWindowForModel` import. Intentional behavior change: default trigger is the supervisor's absolute threshold, not `contextWindow * 0.8`.
- Exported `AutoCompactSupervisor` from `node/core/src/index.ts`.
- Tests: added `AutoCompactSupervisor integration` cases in `thread-core.test.ts` (spies on `startCompaction`; over- vs under-threshold on `end_turn` handoff). Reworked `thread-compact.test.ts`'s auto-compact integration test to the new handoff-driven mechanism (attach an `AutoCompactSupervisor` with a configured `nextPrompt`; drive two turns so the post-flight `inputTokenCount` lag is respected; assert `compacting` mode + preserved `nextPrompt` + summarized transcript). Updated `spawn-subagents.test.ts` and `thread-core.test.ts` to the new `supervisors` array field.
- `npx tsgo -b`, `npx biome check .`, and `npx vitest run node/core/` all green. Full `npx vitest run` failures are pre-existing/flaky nvim-env tests (winfixbuf buffer-switch, `thinkingModel` profile mismatch, display-buffer timing, completions under parallelism), unrelated to this change and present on a clean checkout.
- Code-review follow-ups (Stage 2): added three `thread-core.test.ts` tests to close coverage gaps flagged in review — (1) compaction on a `tool_use` handoff after the tool loop resolves (the branch that replaced the old post-tool `shouldAutoCompact` trigger); (2) compaction on a `max_tokens`-without-tool-use handoff; (3) multi-supervisor first-wins ordering/short-circuit (three supervisors: `none` → `compact` → never-consulted). All checks (`npx tsgo -b`, `npx biome check .`, `npx vitest run node/core/`) remain green.

- Goal: replace `ThreadCore.supervisor` with `supervisors: ThreadSupervisor[]`; update the existing `onEndTurnWithoutYield`/`onYield`/`onAbort` sites to iterate the list (first non-`none` wins); consult the list's `onHandoff` in `handleProviderStopped` (firing on every stop reason, but after pending tool calls resolve for the `tool_use` path) and call `startCompaction(nextPrompt)` on a `compact` action; `shouldAutoCompact` is removed.
- Verification:
  - Behavior: a thread with an over-threshold `AutoCompactSupervisor` in its list triggers compaction on the next handoff; an under-threshold one does not; a second supervisor in the list still fires its own hooks.
  - Setup: a `ThreadCore` test (see `node/core/src/thread-core.test.ts`) with a supervisor whose threshold is exceeded by a stubbed `inputTokenCount`.
  - Actions: drive a turn that stops (end_turn) and a continue-after-tool-results.
  - Expected: `startCompaction` runs (mode transitions to `compacting`); with a low `inputTokenCount`, the handoff proceeds normally; the `tool_use` path never compacts before its tools resolve.
- Before moving on: confirm tests, type checks, and linting all pass.

## 3. Build supervisor lists in `chat.ts`

Progress notes (Stage 3) — DONE:
- `chat.ts` `createThreadWithContext` now builds an `autoCompact` list (`[]` for `compact` threads, else `[new AutoCompactSupervisor()]`) and appends/prepends it: supervised docker → `[DockerSupervisor, ...autoCompact]`; subagent/docker_root → `[SubagentSupervisor, ...autoCompact]`; all other (root/user) threads → `autoCompact`.
- Imported `AutoCompactSupervisor` from `@magenta/core`.
- Uses the default 300000 threshold for now; configurable threshold/prompt is Stage 4/5.
- `npx tsgo -b` and `npx biome check` green. Core suite green except a pre-existing flaky `archive.test.ts` fs-cleanup race (ENOTEMPTY rmdir), unrelated to this change.

Code-review follow-ups (Stage 3):
- Added `node/chat/supervisor-wiring.test.ts` (withDriver integration) covering the reachable supervisor-wiring branches: a root/user thread's `supervisors` includes an `AutoCompactSupervisor` (and no `SubagentSupervisor`); a spawned subagent thread's `supervisors` include *both* `SubagentSupervisor` and `AutoCompactSupervisor`.
- Decision: the `threadType === "compact"` → `autoCompact = []` branch is defensive and not reachable via any real flow — compaction runs on a bare agent inside `CompactionManager` (`createCompactAgent`), so no `compact`-type `Thread` is ever created through `createThreadWithContext` / stored in `threadWrappers`. A driver-based assertion for it is therefore impossible; the guard remains to prevent recursive auto-compaction should a compact `Thread` ever be introduced.

- Goal: `chat.ts` builds each thread's `supervisors` array — root: `[AutoCompactSupervisor]`; subagent/docker_root: `[SubagentSupervisor, AutoCompactSupervisor]`; supervised docker: `[DockerSupervisor, AutoCompactSupervisor]`; compact threads: `[]`.
- Verification:
  - Behavior: a freshly created root thread has an `AutoCompactSupervisor` in its list that triggers compaction at the threshold; a subagent thread keeps its `SubagentSupervisor` behavior *and* auto-compacts.
  - Setup: existing chat/thread integration test harness.
  - Actions: create root and subagent threads; inspect `thread.supervisors`; simulate over-threshold handoff.
  - Expected: correct supervisors present; compaction triggered; subagent yield-policing intact.
- Before moving on: confirm tests, type checks, and linting all pass.

## 4. Make threshold + prompt configurable — DONE

Progress notes (Stage 4):
- `node/options.ts`: added `autoCompactThreshold: number` (default 300000) and optional `autoCompactPrompt?: string` to `MagentaOptions`; parse+validate in both `parseOptions` and `parseProjectOptions` (positive number for threshold; non-empty trimmed string for prompt); honored in `mergeOptions` (project overrides). Default 300000 added to the defaults object and to `node/options.test.ts`'s `makeBaseOptions`.
- `lua/magenta/options.lua`: added `autoCompactThreshold = 300000` default. `autoCompactPrompt` left unset (optional; falls back to bundled template).
- `CompactionManager` (`node/core/src/compaction-manager.ts`): added optional `compactPromptTemplate` to its context; `sendChunkToAgent` now uses `this.context.compactPromptTemplate ?? COMPACT_PROMPT_TEMPLATE`.
- `ThreadCoreContext` (`node/core/src/thread-core.ts`): added optional `autoCompactPrompt`; `startCompaction` forwards it as `compactPromptTemplate` to the `CompactionManager`.
- `node/chat/thread.ts`: both `ThreadCoreContext` construction sites now forward `context.options.autoCompactPrompt` (when set) into the core context.
- `node/chat/chat.ts`: `AutoCompactSupervisor` is now constructed with `{ threshold: getOptions().autoCompactThreshold }`.
- Tests: added `autoCompact options` describe in `node/options.test.ts` (defaults, valid parse, rejects non-positive threshold / blank prompt, project-merge override) and an integration test in `node/chat/thread-compact.test.ts` asserting a configured `autoCompactPrompt` template (with a unique marker) reaches the compact subagent's request.
- Decision: `autoCompactPrompt` is a full prompt *template* (must contain `{{status}}`/`{{next_prompt}}` placeholders), matching the bundled `compact-system-prompt.md`; it is not just an instruction string.
- All green: `npx tsgo -b`, `npx biome check .`, `npx vitest run node/options.test.ts node/core/`, and the new compaction test.

- Goal: `autoCompactThreshold` (default 300000) and `autoCompactPrompt` are parsed in `node/options.ts`, defaulted in `lua/magenta/options.lua`, and plumbed into supervisor construction and `CompactionManager` (prompt override). `COMPACT_PROMPT_TEMPLATE` becomes the fallback default.
- Verification:
  - Behavior: options parsing accepts/validates the new fields; a custom prompt reaches the compaction request; a custom threshold changes the trigger point.
  - Setup: options-parsing unit tests (mirror existing `maxConcurrentSubagents` tests) and a compaction test asserting the request uses the overridden prompt.
  - Actions: parse options with/without the fields; run compaction with a custom prompt.
  - Expected: defaults applied when absent; overrides respected; invalid values rejected/warned as with other options.
- Before moving on: confirm tests, type checks, and linting all pass.

## 5. Per-thread auto-compact config for magenta scripts

- Goal: a magenta script can set `autoCompactThreshold` and `autoCompactPrompt` per spawned thread via `thread(prompt, yieldSchema, options)`; these override the global defaults for that thread only, and threads without overrides fall back to global config.
- Plumbing: add the two fields to `ThreadOptions` (`sdk/protocol.ts`); forward them in the `create-thread` handler (`node/scripts/script-manager.ts`) into `chat.spawnScriptThread`; thread them through `createThreadWithContext` into the thread's supervisor (threshold) and `ThreadCoreContext` (prompt override).
- Verification:
  - Behavior: a script-spawned thread with a custom threshold/prompt compacts at that threshold using that prompt; one without overrides uses the global defaults.
  - Setup: the SDK test harness (`sdk/testing.ts`) plus a chat/thread integration test; assert `handle.nextThread()` carries the options through, and that the resulting thread's supervisor/compaction use the overrides.
  - Actions: spawn a script thread with overrides and one without; simulate an over-threshold handoff.
  - Expected: overrides respected for the first; global defaults for the second.
- Before moving on: confirm tests, type checks, and linting all pass.
