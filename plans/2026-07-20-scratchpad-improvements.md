# Objective and Context

Three related changes to the scratchpad tool (`node/core/src/tools/scratchpad.ts`):

1. `get` should optionally take multiple keys (the tool description already claims this: `get <key> [<key> ...]`), but `parseScript` currently rejects more than one key.
2. When a scratchpad is non-empty ("active"), list its keys in the system reminder and nudge the agent to delete no-longer-needed keys.
3. Make the scratchpad survive compaction: seed the compaction sub-agent's scratchpad from the thread's scratchpad, allow the compact agent to use the scratchpad tool, tell the compaction prompt to prune it, and pass the resulting scratchpad back into the reset thread.

## Key entities

- `Scratchpad` / `ScratchpadEntry` / `Command` — data + command types in `scratchpad.ts`. `parseScript`, `evaluate`, `runScript`, `execute`, `spec`.
- `ThreadCore` (`node/core/src/thread-core.ts`) — holds `this.state.scratchpad`; `getActiveReminders()` (line ~1359) assembles `extraReminders`; `reset-after-compaction` reducer (line ~529) currently zeroes the scratchpad; `handleCompactComplete()` (line ~1586) reseeds the fresh agent; `startCompaction()` (line ~1523) builds the `CompactionManager`.
- `buildSystemReminder` / `getActiveReminders` interplay — `getActiveReminders()` returns strings that are appended to the subsequent reminder body by `buildSystemReminder` (`node/core/src/providers/system-reminders.ts`).
- `CompactionManager` (`node/core/src/compaction-manager.ts`) — owns a private `this.scratchpad = Scratchpad.emptyScratchpad()`; builds `CreateToolContext` with that scratchpad (`buildToolEntries`); produces a `CompactionResult` (`type: "complete"` with `summary`, `steps`, `nextPrompt`).
- `COMPACT_STATIC_TOOL_NAMES` (`node/core/src/tools/tool-registry.ts:29`) — currently `["get_files", "edl"]`; consumed via `getToolSpecs("compact", ...)` in `toolManager.ts`.
- `compact-system-prompt.md` — the compaction prompt template.

## Relevant files

- `node/core/src/tools/scratchpad.ts` — parse/eval/spec for the tool.
- `node/core/src/tools/scratchpad.test.ts` (if present) — unit tests for parse/eval.
- `node/core/src/thread-core.ts` — reminders + compaction wiring.
- `node/core/src/compaction-manager.ts` — compaction sub-agent + scratchpad seeding/return.
- `node/core/src/tools/tool-registry.ts` — compact tool allowlist.
- `node/core/src/compact-system-prompt.md` — compaction prompt.

# Design

## 1. Multi-key `get`

Change the `Command` variant from `{ type: "get"; key: string }` to `{ type: "get"; keys: string[] }`. In `parseScript`, accept `tokens.slice(1)` (require >= 1). In `evaluate`, loop over keys, pushing each to `getOutputs`; keep the "not found" error behaviour per missing key. `getOutputs` / `runScript` output formatting is already per-entry, so no change there. Update the tool `description` only if wording drifts (it already documents multi-key).

## 2. Scratchpad-key reminder

The scratchpad key list is thread state, and `getActiveReminders()` already runs on `ThreadCore` (has `this.state.scratchpad`). Add, when `this.state.scratchpad.entries.length > 0`, a reminder string such as: "Scratchpad keys: [a, b, c]. Delete keys you no longer need with the scratchpad tool." This flows through the existing `extraReminders` path into every subsequent reminder — no change to `system-reminders.ts` signature needed. Keep the static `SCRATCHPAD_REMINDER` (the "prefer the scratchpad" nudge) as-is; the new dynamic line is additive and only appears when the scratchpad is non-empty.

## 3. Survive compaction

Data flow: thread scratchpad -> CompactionManager (seed) -> compact agent may prune it -> CompactionResult carries final scratchpad -> handleCompactComplete writes it into fresh thread state.

- `CompactionManager` constructor / context: accept an optional initial scratchpad and clone it into `this.scratchpad` instead of always `emptyScratchpad()`. `startCompaction()` passes `Scratchpad.cloneScratchpad(this.state.scratchpad)`.
- Allow the tool: add `"scratchpad"` to `COMPACT_STATIC_TOOL_NAMES`. `buildToolEntries` already wires `scratchpad: this.scratchpad` into the compact `CreateToolContext`, so the tool will just work.
- Return it: extend the `complete` `CompactionResult` with `scratchpad: this.scratchpad` (set in `reduceChunkComplete` when building the complete state).
- Reseed: in `handleCompactComplete`, after `update({ type: "reset-after-compaction" })` (which zeroes the scratchpad at thread-core.ts:531), assign `this.state.scratchpad = result.scratchpad` (or pass it through the reset). Simplest: pass the compacted scratchpad into `handleCompactComplete` and set `this.state.scratchpad` right after the reset update.
- Prompt: add a short section to `compact-system-prompt.md` telling the agent the scratchpad persists across compaction, that its current keys are available, and to prune stale keys and keep only entries relevant to the next prompt. Include the current scratchpad key list in the context block built in `sendChunkToAgent` (only when non-empty).

Invariants:

- `get` with zero keys is still an error; a missing key is still a hard error mid-script.
- The scratchpad-key reminder only appears when the scratchpad is non-empty; empty scratchpad reminders must not add noise.
- Compaction must not mutate the live thread scratchpad mid-run — the manager operates on a clone; the thread scratchpad is only replaced after a successful `complete`.
- On compaction error (non-complete result), the thread scratchpad is untouched (do not overwrite from a failed run).
- Existing behaviour where `reset-after-compaction` clears other transient state (edlRegisters, counters) is preserved; only the scratchpad is re-seeded afterward.

# Stages

## multi-key get

- Goal: `get a b c` parses and prints all three values; `get` alone still errors.

**Status: DONE.** `Command` `get` variant now `{ type: "get"; keys: string[] }`; `parseScript` uses `tokens.slice(1)` (>=1 key required); `evaluate` loops over keys pushing each to `getOutputs` with per-key not-found errors. Tests added in scratchpad.test.ts (multi-value get, zero-key parse error, unknown-key eval error). Note: pre-existing biome lint errors in node/render-tools/getFile.ts are unrelated to this stage and were left untouched.
- Tests:
  - `parseScript("get a b")` returns a single `get` command with `keys: ["a","b"]`.
  - `runScript` on a scratchpad with a=1,b=2 given `get a b` outputs both `a = 1` and `b = 2` lines plus the snapshot line.
  - `get` with no key still returns a parse error.
  - `get missing` (unknown key) returns an eval error.

## scratchpad reminder

- Goal: subsequent system reminders list current scratchpad keys and nudge deletion when the scratchpad is non-empty.

**Status: DONE.** `getActiveReminders()` in `thread-core.ts` now appends, when `this.state.scratchpad.entries.length > 0`, a line: `Scratchpad keys: [<keys>]. Delete keys you no longer need with the scratchpad tool.` It flows through the existing `extraReminders` path; empty scratchpad adds nothing. Tests added in `thread-core.test.ts` ("lists scratchpad keys in active reminders when non-empty" and "adds no scratchpad reminder when the scratchpad is empty"), calling the private `getActiveReminders` via a cast. No change to `system-reminders.ts`. Note: two pre-existing failures unrelated to this stage were left untouched — biome lint errors in `node/render-tools/getFile.ts`, and a failing `agents.test.ts > builtin agents` prompt-content assertion (both present on the clean Stage 1 HEAD).
**Review follow-up (DONE).** Addressed the code-review nit about reaching the private `getActiveReminders` via a `core as unknown as {...}` double-cast in tests. Extracted a pure helper `scratchpadReminder(scratchpad): string | undefined` in `scratchpad.ts` (returns the key-list + delete-nudge line, or undefined when empty). `getActiveReminders()` now calls `Scratchpad.scratchpadReminder(this.state.scratchpad)`. Tests now exercise the pure helper directly (no cast). Pre-existing unrelated biome errors in `node/render-tools/getFile.ts` remain untouched.
- Tests:
  - With a populated scratchpad, `getActiveReminders()` includes a line containing the keys and the delete nudge.
  - With an empty scratchpad, no scratchpad-key line is present.
  - Integration: after a turn that appends a key, the next assembled reminder (via the existing reminder path) contains that key.

## compaction survival

- Goal: keys present before compaction are still present after, the compact agent can edit the scratchpad, and the prompt instructs pruning.

**Status: DONE.** `CompactionManagerContext` gained a required `initialScratchpad`; the constructor seeds `this.scratchpad = Scratchpad.cloneScratchpad(context.initialScratchpad)`. `startCompaction()` passes `Scratchpad.cloneScratchpad(this.state.scratchpad)`. `COMPACT_STATIC_TOOL_NAMES` now includes `scratchpad`. The `complete` `CompactionResult` (compaction-controller.ts) gained `scratchpad: Scratchpad.Scratchpad`, populated in `reduceChunkComplete`. `handleCompactionResult` forwards it to `handleCompactComplete`, which reseeds `this.state.scratchpad = scratchpad` right after the `reset-after-compaction` update (only on success; error path leaves the live scratchpad untouched). `sendChunkToAgent` appends a `<scratchpad>` context block (keys + prune nudge) only when non-empty; `compact-system-prompt.md` gained a matching instruction line. Tests: allowlist test in thread-core.test.ts; existing archive test updated for the new 4th arg. The pre-existing unrelated `agents.test.ts > builtin agents` failure and biome getFile.ts errors remain (untouched by this stage).
- Tests:
  - Unit: `CompactionManager` seeded with a scratchpad containing keys exposes them to the compact tool context and returns the (possibly pruned) scratchpad in its `complete` result.
  - `COMPACT_STATIC_TOOL_NAMES`/`getToolSpecs("compact")` includes `scratchpad`.
  - Integration (thread-core compaction test): a thread with scratchpad keys before compaction retains them (minus any the compact agent deletes) on the fresh thread after compaction; a compaction error leaves the original scratchpad intact.
