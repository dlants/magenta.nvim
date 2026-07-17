# Objective and Context

The user wants a simple, ordered key-value scratchpad tool that gives the agent
externalized, persistent state so it doesn't have to rely on inference for
enumeration, counting, and object-permanence style bookkeeping (motivating
example: counting the R's in "strawberry"). The tool's mere presence is meant to
encourage the agent to offload such tasks.

Requirements (from the user, kept deliberately minimal):

- State is an **ordered list of key/value pairs**. Keys and values are strings.
  Keys are short addresses for values.
- Operations, exposed through a **script-like interface** (agent submits a small
  script of commands, matching the EDL / nvim_lua pattern already in the repo):
  - append a key/value pair at the **end** of the list
  - delete one or more entries by key
  - get the value for a key
  - (implicitly) clear is achievable by deleting keys; no separate clear needed
    per the final scope, though we may add it cheaply.
- After running a script, the result printed back to the agent is the **full list
  of keys** (not values) to stay token-efficient. `get` is the only way to pull a
  value back into context.
- State **persists across tool calls within a thread** (like `edlRegisters`).

## Key types / entities involved

- `StaticToolName` / registry (`node/core/src/tools/tool-registry.ts`) — the union
  of built-in tool names, capability requirements, and per-thread-type tool lists.
- `StaticToolMap` / `StaticToolRequest` (`node/core/src/tools/toolManager.ts`) —
  maps tool name to input type; drives `getToolSpecs`.
- `CreateToolContext` + `createTool` (`node/core/src/tools/create-tool.ts`) — the
  dispatch switch that hands each tool its slice of thread context.
- `ThreadCore.state` (`node/core/src/thread-core.ts`) — holds per-thread mutable
  state such as `edlRegisters`; the scratchpad state lives here and is passed into
  `CreateToolContext` at the `createTool` call site (~line 787).
- `ProviderToolSpec`, `ToolInvocation`, `ProviderToolResult` — provider-facing
  tool contract; see `nvimLua.ts` for the canonical minimal example.
- render-tools (`node/render-tools/index.ts`, `streaming.ts`, plus a per-tool
  render module) — TUI rendering for the tool's summary/input in the sidebar.

## Relevant files

- `node/core/src/tools/nvimLua.ts` — closest template: a simple, self-contained
  tool that takes a code/script string and returns text. Copy its structure.
- `node/core/src/tools/tool-registry.ts` — add the new tool name, capability, and
  include it in the relevant thread-type tool lists.
- `node/core/src/tools/toolManager.ts` — add to `StaticToolMap` and `TOOL_SPEC_MAP`.
- `node/core/src/tools/create-tool.ts` — add a dispatch case wiring in the
  scratchpad state from context.
- `node/core/src/thread-core.ts` — add `scratchpad` to `ThreadCore.state`, init it,
  reset it where `edlRegisters` is reset (~line 499), and pass it into
  `CreateToolContext` (~line 787).
- `node/render-tools/index.ts`, `node/render-tools/streaming.ts`, and a new
  `node/render-tools/scratchpad.ts` — rendering wiring.
- New: `node/core/src/tools/scratchpad.ts` and `node/core/src/tools/scratchpad.test.ts`.

# Design

The scratchpad is an ordered list of `{ key, value }` string pairs stored on
`ThreadCore.state.scratchpad`. A single mutable object (e.g.
`{ entries: { key: string; value: string }[] }`) is created per thread and passed
by reference into the tool via `CreateToolContext`, exactly mirroring how
`edlRegisters` is threaded through. Mutations persist because the tool mutates the
shared object in place.

The tool exposes a **script interface**: the agent submits a `script` string
containing one command per line. Commands:

- `append <key> <value...>` — append a pair. The value is either the remainder of
  the line (single-line form) OR a **heredoc** for multi-line values, matching the
  EDL convention already used in this repo: `append <key> <<END` followed by value
  lines and a closing `END` sentinel on its own line. The agent picks any sentinel
  that doesn't collide with the value. If the key already exists, it is an **error**
  (keys are unique addresses); the whole script aborts with no partial mutation.
- `delete <key> [<key> ...]` — remove all listed keys. Deleting a missing key is a
  no-op (not an error), since the point is convenience.
- `get <key>` — look up a value; its output is included in the result.
- `move_after <key> [<anchorKey>]` — relocate `<key>`, preserving its value. With
  an `<anchorKey>`, `<key>` is placed immediately after it. With the anchor
  **omitted**, `<key>` moves to the **front** of the list. Error if `<key>` (or a
  given `<anchorKey>`) is missing, or if `<key>` == `<anchorKey>`. This is the only
  reordering primitive; combined with `append` at the end and move-to-front, it lets
  the agent place any entry anywhere.
- (optional, cheap) `clear` — empty the list.

Values may be multi-line via the heredoc form (see `append` above). The parser
consumes heredoc bodies verbatim up to the sentinel line, so newlines and special
characters in values are preserved. Keys remain single-line, whitespace-free
tokens.

Execution model (per `nvimLua.ts`):

1. Parse the script line by line. On a parse error (unknown command, missing
   args), return a `status: "error"` result naming the offending line; do not
   apply partial mutations, OR apply sequentially and stop at the first error and
   report what was applied. Default: parse all first, then apply, so a bad line
   aborts cleanly with no partial state.
2. Apply mutations in order to the shared state object.
3. Build the result text:
   - A **snapshot line** echoing the ordered keys, e.g.
     `The scratchpad is now [pos0, pos1, pos2]`. When empty:
     `The scratchpad is now []`. This line is printed after **every** script
     execution (token-efficient: keys only, never values).
   - Any `get` outputs, each as `key = value`, above the snapshot line.

Result formatting aims to be compact: always the keys-only snapshot line, plus any
explicitly requested values.

Alternatives considered:

- **Discrete tool params instead of a script** (e.g. an `operation` enum). Rejected
  because the user explicitly wants a script-like interface and it matches EDL /
  nvim_lua, letting the agent batch several ops in one call.
- **A separate managed file + EDL/bash** (the "do nothing new" option). Rejected
  per the discussion: a first-class tool's presence encourages use and removes
  boilerplate, and the token-efficient keys-only echo is a nice ergonomic that a
  raw file doesn't give for free.

## Lifecycle: subagents, compaction, forks (resolved decisions)

- **Subagents**: the scratchpad tool IS available to subagent threads, but each
  subagent starts with a **fresh, empty scratchpad**. Subagents are constructed as
  normal `ThreadCore`s (not clones), so the default fresh-init already gives this;
  we just add the tool name to `SUBAGENT_STATIC_TOOL_NAMES` (and thus the subagent
  tool lists).
- **Compaction**: reset the scratchpad to empty wherever `edlRegisters` is reset
  (`thread-core.ts` ~line 499). Same treatment as EDL registers.
- **Forks (`ThreadCore.clone`)**: forks **copy** the scratchpad (deep copy of the
  ordered entries). `clone` currently does NOT copy `edlRegisters` either — it
  relies on the constructor's fresh init, which is a latent bug. Fix both together:
  add an optional seed to the constructor (e.g. `initialState?: { scratchpad?;
  edlRegisters? }`, or discrete optional args) so `clone` passes **deep copies** of
  `sourceCore.state.scratchpad` AND `sourceCore.state.edlRegisters`; the constructor
  uses them when present, else inits empty. Deep-copy the entries array and the
  registers `Map` (and carry `nextSavedId`) so parent and fork don't alias.

Invariants:

- Keys are unique within a scratchpad at any time.
- Order is append order; delete preserves the relative order of survivors.
- A parse/validation error leaves scratchpad state unchanged (all-or-nothing per
  script).
- The result never dumps all values — only keys plus explicitly `get`-ed values —
  to preserve token efficiency.
- State is per-thread and reset wherever `edlRegisters` is reset (compaction/clear).
- Subagents get a fresh empty scratchpad; forks get a deep copy of the parent's.

# Stages

## core tool + state

**STATUS: DONE (Stage 1).** Implemented `node/core/src/tools/scratchpad.ts`
(execute/spec/Input/validateInput + pure `parseScript`/`evaluate`/`runScript`
over a shared `Scratchpad` object). Wired through `tool-registry.ts` (added to
STATIC/CHAT/SUBAGENT lists + no-capability requirement), `toolManager.ts`
(StaticToolMap + TOOL_SPEC_MAP), `create-tool.ts` (context field + dispatch
case), and `thread-core.ts` (state field, init, reset-after-compaction, passes
into CreateToolContext). Added a constructor `initialState` seed and updated
`ThreadCore.clone` to deep-copy BOTH scratchpad and edlRegisters (fixing the
latent edlRegisters aliasing bug). `compaction-manager.ts` also passes a fresh
scratchpad. Added minimal render wiring (index.ts/streaming.ts exhaustive
switches) to keep the build green; proper rendering is Stage 2. Tests in
`scratchpad.test.ts` (14 pure runScript cases) and `thread-core.test.ts`
(subagent fresh + clone deep-copy isolation for scratchpad AND edlRegisters).
Typecheck (`npx tsgo -b`), biome, and `npx vitest run node/core/` all pass. The
one failing root test (`thread.test.ts > expands context update diff with =
binding`) fails identically on baseline (pre-existing env flake) and is
unrelated; the tool-count snapshot (8→9) was regenerated.

**Code-review follow-ups (Stage 1):** (1) Split the `move_after` `Command`
variant's optional `anchorKey` into two disjoint variants
(`{ type: "move_after"; key; anchorKey }` | `{ type: "move_to_front"; key }`) in
`scratchpad.ts`, per make-invalid-states-non-representable; the script parser maps
`move_after <key>` (no anchor) to `move_to_front`. Script-level behavior/tests
unchanged. (2) Added a thread-core test asserting a populated scratchpad is emptied
on `reset-after-compaction`. Typecheck, biome, and core vitest all green; the two
pre-existing root nvim-env test flakes (`thread.test.ts > expands context update
diff` and `spawn-subagents > allows selecting parent and child threads`) fail
identically on baseline and are unrelated.

- Goal: `scratchpad.ts` exists with `execute`, `spec`, `Input`, `validateInput`,
  and a small pure parser/evaluator over the shared state object. `ThreadCore`
  owns a `scratchpad` state field, initialized and reset alongside `edlRegisters`,
  and passes it through `CreateToolContext`. `create-tool.ts`, `toolManager.ts`,
  and `tool-registry.ts` are wired so the tool is available on root/chat (and
  optionally subagent) threads. Type-checks with `npx tsgo -b`.
- Tests (`scratchpad.test.ts`, unit over the parser/evaluator + a thread-core
  integration):
  - Appending three keys then running a script that appends a fourth returns keys
    in append order.
  - `delete` of one and of multiple keys removes exactly those, preserving order.
  - `get <key>` returns the stored value; result for other ops shows only keys.
  - `append <key> <<END ...` stores a multi-line value verbatim (newlines
    preserved), and `get` returns it intact.
  - A script with an invalid line leaves state unchanged (all-or-nothing).
  - Duplicate-key append behaves per chosen semantics (error by default).
  - `move_after <key> <anchorKey>` places key immediately after anchor; order of
    other entries is preserved. Moving to its current position is a no-op.
  - `move_after <key>` with the anchor omitted moves key to the front of the list.
  - `move_after` with a missing key, missing anchor, or key == anchor is an error
    and aborts the script.
  - Duplicate-key append is an error and aborts the whole script (no partial state).
  - State persists across two separate tool invocations in the same thread, and is
    reset when the thread is cleared/compacted (mirror the edlRegisters reset).
  - A subagent thread starts with an empty scratchpad.
  - `ThreadCore.clone` produces a fork whose scratchpad equals the parent's at fork
    time, and subsequent mutations on one do not affect the other (deep copy).
  - `ThreadCore.clone` also copies `edlRegisters` (registers + `nextSavedId`), with
    the same deep-copy isolation between parent and fork.

**STATUS: DONE (Stage 2).** Added `node/render-tools/scratchpad.ts` with
`renderSummary` (📝 scratchpad) and `renderInput` (abridged/expanded script
preview via `withCode`, mirroring `nvimLua.ts`). Wired into
`render-tools/index.ts` (`renderToolSummary`/`renderToolInput` now delegate to
ScratchpadRender) and `render-tools/streaming.ts` (streams a `📝 scratchpad:`
script tail preview like edl). Exported `Scratchpad` namespace from
`node/core/src/index.ts`. Also fixed a Stage-1 gap: added the `scratchpad` case
to `node/core/src/tools/helpers.ts` `validateInput` (was throwing "Unexpected
toolName"), without which the tool couldn't execute at all. Added driver test
`node/render-tools/scratchpad.test.ts` (2 cases: completed summary+input render,
and streamed preview). Typecheck (`npx tsgo -b`) and biome pass; scratchpad tests
pass. Remaining full-suite failures (archive-view, thread.test winfixbuf/context
diff, spawn-subagents hierarchy, system-prompt/files socket) reproduce identically
on baseline (verified via git stash) — pre-existing nvim-env flakes, unrelated.

## rendering

- Goal: the tool renders in the sidebar like other tools — a summary line, input
  preview (the script), and a status line — via a new `render-tools/scratchpad.ts`
  wired into `index.ts` and `streaming.ts`.
- Tests: rendering is largely visual; a lightweight snapshot/driver test that the
  tool summary and expanded input show the script. Reuse existing render-tool test
  patterns. Manual check in the sidebar that keys-only output reads cleanly.

## prompt + system reminder

- Goal: make the agent reach for the scratchpad on enumeration/counting/tracking
  tasks. Two concrete edits (the whole point is behavioral nudging):
  - **Base prompt**: add a short paragraph to the default agent prompt at
    `node/providers/prompts/default-system-prompt.md` (and mirror into
    `node/core/src/agents/default.md` / `docker.md` if they carry their own copy)
    describing the scratchpad as externalized, persistent state for enumeration,
    counting, and object-permanence bookkeeping, with a one-line example of a
    script and the keys-only echo.
  - **System reminder**: add a `SCRATCHPAD_REMINDER` constant in
    `node/core/src/providers/system-reminders.ts` and include it in the
    `getSubsequentReminderBody` output for `root`, `docker_root`, and `subagent`
    thread types (alongside `SKILLS_REMINDER`, `BASH_REMINDER`, etc.). Keep it to
    ~2 lines: when tracking a set of items / counting / enumerating, prefer the
    scratchpad over holding state in your reasoning.
- Tests: `system-reminders` has existing unit coverage — add an assertion that the
  scratchpad reminder appears for root/subagent and not for `compact`. Otherwise
  evaluate qualitatively (re-run the "count the R's" task and observe whether the
  agent uses the scratchpad unprompted).
