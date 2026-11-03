# Objective and Context

User request (verbatim): "Let's revisit the testing setup. How long does it take to run a full test suite? Are we taking advantage of parallelism? I think a lot of our tests no longer need the Newman client but rather can just run on the server side of the application. This means that we can probably save a lot of time relaunching the Neovim client and provisioning directories and stuff like that. I think that's kind of a new testing tier or I'm not sure if we have any tests that are in that tier. We should check. I want to do an audit of all our tests. Any tests that can be moved into that tier can use a fake file watcher and just test the server-side API so we do not have to bring up Neovim, things like that. I want to transition those tests into that format."

Baseline (measured 2026-11-03, 14 cores, `npx vitest run`, 2011 tests, all passing):

- Wall time 68s.
- Summed per-file time: `nvim` project 199s (58 files), `server` 97s (108 files), `node` 5s (20 files).
- `nvim` runs in a forks pool capped at `maxForks: 4`, so it dominates wall time (~199s / 4 ≈ 50s). `server` and `node` use the threads pool, uncapped.
- Heaviest nvim files: `chat/thread.test.ts` 20s, `render-tools/spawn-subagents.test.ts` 20s, `tools/bashCommand.test.ts` 12s, `context/context-manager.test.ts` 8s, `magenta.test.ts` 7s, `tools/spawn-subagents.test.ts` 7s.

The server-only tier already exists. Tier A is described in `context.md` and `.magenta/skills/doc-testing/skill.md` (`node/server/src/test/harness.ts`). It has 108 files, so this plan migrates tests into it rather than creating a new tier.

Per-test tier C cost, from `node/nvimclient/test/preamble.ts` `withDriver` (~259 call sites, one per test):

- Random tmp dir.
- `fs.cp` of the 208K fixtures dir, including `.git`.
- `nvim --headless` spawn, plus a socket poll at a 100ms interval.
- Lua bridge setup and writing `options.json`.
- Full `Magenta.start`.
- Teardown with `rm -rf`.

Every `pollUntil` iteration sleeps 100ms. Fixed sleeps also add up: `chat/attention.test.ts` (~3.4s of `delay`), `chat/reflect-anchor.test.ts`, `chat/reflections-overview.test.ts`.

No file watcher is needed. The server has no watcher abstraction. `FileSupervisor` compares `FileIO` contents at delivery time, and writes made through `SandboxFileIO` call `onFileWritten`. In tier A, an "out-of-process change" is just a mutation of `InMemoryFileIO` between submissions.

Relevant files:

- `vitest.config.ts`: project and pool config.
- `node/server/src/test/harness.ts`: `createHarness`/`withHarness`/`TestSessionHost`.
- `node/server/src/test/fakes.ts`: `FakeGitClient`, `FakeShell`, `FakeClient`, `FakeGitHubClient`.
- `node/nvimclient/test/preamble.ts`, `driver.ts`: tier C driver.
- `node/server/src/server-session-host.ts`: real host, with the sandbox/approval wiring the harness lacks.

# Audit findings

Migration principle: classify each test by its intent, not by its literal assertions. Many C tests check API behavior (abort, compaction, approvals, context delivery) by reading the display buffer. Those move whole to A and assert the behavior directly. They are not split, and their view assertions are not ported. A test stays C only if what it is actually about is nvim: buffers, windows, keymaps, rendering, lua, LSP. The success metric is the number of nvim spawns (`withDriver` calls, ~259 today). A "Split" that leaves an nvim test running anyway saves nothing. So for Split entries below, the default is to move the behavior to A and either delete the C test, or fold its remaining view check into an existing C test that already renders similar output.

Classes:

- A: asserts only server behavior; move to the harness.
- AC: client logic without nvim (fake protocol client, `*.node.test.ts`).
- C: needs nvim.
- Split: has A assertions mixed with view assertions; split the file.

## Move or split to A

- `chat/thread.test.ts`:
  - Split: deleted context updates, web search plus citations, custom command expansion, and the request content of context updates.
  - AC: "disposing the view leaves the thread alone".
  - C: rendering, streaming previews, thinking toggles, and `@buf`/`@qf`/`@diag`/`@diff`/`@staged`. These could later become AC with `FakeClient` plus `FakeGitClient`.
- `chat/thread-abort.test.ts`:
  - Split: abort clears pending approvals, send-during-tool_use, and aborting one tool leaves the batch running. Each needs the approval fake.
  - Keep in C: the input-buffer recovery tests.
- `chat/thread-compact.test.ts`: mostly A (compact flow, per-chunk children, summary carry, fork+compact). Check for overlap with `thread-compact-flow.test.ts`, `compaction/index.test.ts` and `fork-flow.test.ts` before moving anything.
- `chat/thread-compact-view.test.ts`: C. Only the errored-chunk continuation and the `activeThreadId` progression are A.
- `chat/thread-edited-files.test.ts`:
  - Split: the recorded edits/kinds are A (check overlap with `edited-files-flow.test.ts`).
  - C: diff windows and the unsaved-buffer test.
- `render-tools/spawn-subagents.test.ts`:
  - A: the three abort/yield tests.
  - Split: the pending approvals test.
  - C: the expand toggles.
- `tools/spawn-subagents.test.ts`:
  - A: explore agentType, the concurrency batches (duplicates server `spawn-subagents.test.ts`, so delete it), and slot occupied on error. Reconcile the last one with the server test "queue advances when one errors".
  - C: navigation (near-duplicate of the render-tools one, so delete one of them) and the `=` toggles.
- `tools/bashCommand.test.ts`:
  - A, duplicate: "duration in failed result" and "full output preserved". Delete these.
  - Split: approval required, rejection, error after approval, redundant `cd <cwd> &&` auto-approve (needs the approval fake and a fixed `ProjectDir`).
  - B: "executed only once" (real shell into a real tmp dir).
  - C: the remainder.
- `render-tools/edl.test.ts`: C. The behavior is already covered by the server EDL tests.

## Not yet audited per test

Sub-agent reports for these were lost. Stage 1 classifies them:

- Likely mostly A/Split:
  - `context/context-manager.test.ts`: "out-of-process file change", "autoContext loads", "large files summarized".
  - `context/git-context.test.ts`.
  - `chat/system-reminders.test.ts`: auto-respond combining reminders, `@implementplan` reminder.
  - `chat/fork-thread.test.ts`: "sandbox bypass and write approvals use the fork owner", "fork appends fork_notification".
  - `capabilities/render-pending-approvals.test.ts`: "toggling sandbox off auto-approves subtree".
  - `scripts/script-manager.test.ts` and `scripts/script-e2e.test.ts`: lifecycle and disposal parts.
  - `chat/chat-view-adapter.test.ts`: AC candidates. It already asserts session/adapter behavior.
  - `chat/chat.test.ts`: subtree delete, "submission that never issued a request".
  - `tools/edl.test.ts`, `tools/getFile.test.ts`: mostly C because of buffer interplay. Check for any A leftovers.
- Clearly C: `buffer-manager`, `buf-enter`, `nvim/buffer-reload`, `two-column`, `pane-state`, `reflect-anchor`, `reflections-overview`, `fork-keybinding`, `rewind-keybinding`, `archive-view`, `display-open-target`, `buffer-scoped-commands`, `sidebar`, `test/completions`, `attention`, `tools/hover`, `tools/findReferences`, `tools/nvimLua`.
- Check whether these actually start nvim. If not, rename them to `*.node.test.ts`:
  - `tea/*.test.ts`
  - `nvim/nvim-node/*.test.ts`
  - `bridge-guard.test.ts`
  - `utils/pdf-pages.test.ts`
  - `utils/file-summary.test.ts`
  - `chat/commands/file-paste.test.ts`

## Sandbox: explicit vs incidental

- Real sandbox behavior (policy, OS wrapping, violation detection) is only tested server-side: `capabilities/sandbox-shell*.test.ts`, `sandbox-file-io.test.ts`, `sandbox-violation-handler.test.ts`, `sandbox-manager.test.ts`. These stay as-is.
- No nvim test exercises the real sandbox. All of them use `MockSandboxManager` (`node/server/src/test/mock-sandbox-manager.ts`) through `driver.mockSandbox.setState`/`blockWritesTo`, purely to force an approval to appear.
- Approval UI tests stay C on the mock: dialog rendering, YES/NO buttons, the pending-approvals view (`render-pending-approvals`, the bash approval dialog/box formatting).
- Approval routing is server logic and moves to A: abort clears approvals, the sandbox bypass toggle auto-approves a subtree, fork owner routing, subagent approvals surfacing at the session level, reject producing a "user did not allow" result, and the redundant `cd` auto-approve.
- Incidental: tests that only call `setState` to get past or into an approval for some other purpose (script lifecycle, fork-keybinding, magenta.test). In A they use the mock with approvals off, or approve via `session.approve`.
- The harness gap is not a missing fake. `TestSessionHost` hands threads a raw `FakeShell`/`InMemoryFileIO`, so the `SandboxShell`/`SandboxFileIO` and violation-handler layers that produce approvals are never in the path. The fix is to wrap those fakes in the real sandbox layers with `MockSandboxManager`, mirroring `ServerSessionHost`.

## Server tests using real fs unnecessarily

- `archive.test.ts` and `thread-logger.test.ts` use a fixed path shared under `os.tmpdir()`. This is a parallelism hazard. Use `mkdtemp` at minimum.
- `server-session-host.test.ts` does `mkdtemp` plus real writes even though it also creates an `InMemoryFileIO`.
- `edl/executor.test.ts` and `edl/index.test.ts`: verify whether `fs.writeFile` there is real fs.

# Design

Keep the three tiers. The work is to:

1. Add the harness capabilities that currently force tests into C.
2. Move the A assertions into server tests next to the code under test (e.g. `node/server/src/tools/bash-command-flow.test.ts`), deleting duplicates instead of porting them.
3. Trim the remaining C tests down to view assertions only.
4. Cut the fixed per-test overhead of C.

Server tests assert on `thread.state`, tool results, provider request content and session APIs, never on rendered text.

## Interfaces

The harness option additions follow existing `HarnessOptions` style. The exact names will be settled against `ServerSessionHost`'s `sandbox`/`sandboxViolationHandler` wiring.

```ts
type HarnessOptions = {
  // existing...
  sandbox?: { config?: Partial<SandboxConfig>; requireApproval?: boolean }; // routes through the real Session approval APIs
  options?: Partial<MagentaOptions>; // customCommands, maxConcurrentSubagents, etc. (verify which already exist)
};
```

Approvals in tests go through the existing public session APIs (`session.getPendingApprovals()`, `approve`, `reject`, `toggleSandboxBypass`), not new test-only hooks. "Out-of-process file change" means `harness.fileIO.writeFile(...)` between submissions, so no watcher fake is added.

## Invariants

- No production API is added only for tests. White-box access stays in `test-helpers.ts`.
- Migrated tests must keep coverage. Before deleting a C test, an equivalent server assertion exists, either new or pre-existing (cite it in the commit).
- Server tests use `InMemoryFileIO` unless real fs semantics are under test (tier B), and never use a fixed shared tmp path.
- C tests keep exactly the assertions that need nvim.

# Stages

## 1. Finish audit and baseline

- Goal: a checklist appended to this plan. It classifies every `it()` in the unaudited files, records server-test overlaps, and lists files that don't start nvim.
- Tests: none. For each C test, record its intent (behavior vs view) and, for view tests, which other C test could absorb its check. Record the `withDriver` count and per-project timings with `--reporter=json` (the script used for the baseline) so later stages can compare.

## 2. Cheap wins (no migration)

- Goal:
  - Rename nvim-free files to `*.node.test.ts`.
  - Replace the fixed `delay`/`driver.wait` calls in `attention`, `reflect-anchor` and `reflections-overview` with fake timers or polling on conditions.
  - Drop the `pollUntil` interval from 100ms to ~10ms.
  - Make the shared tmp paths in `archive.test.ts` and `thread-logger.test.ts` unique.
  - Try raising `maxForks` (memory-bound; measure at 6 and 8 on 14 cores).
- Tests: the full suite passes 3x in a row (flakiness check), and wall time is compared to the 68s baseline.

## 3. Harness: sandbox/approvals and options

- Goal: `TestSessionHost` wraps `FakeShell`/`InMemoryFileIO` in the real `SandboxShell`/`SandboxFileIO` with a `MockSandboxManager` (exposed as `harness.sandbox`) and a violation handler, the same way `ServerSessionHost` does. Approvals then surface through the real `Session` APIs. Real sandbox enforcement is never exercised here. Options like `maxConcurrentSubagents` and `customCommands` can be passed per test.
- Tests: a server test where bash needs approval. The test asserts on `getPendingApprovals()`, approves it and gets the tool result. A reject variant gets the "user did not allow" result. `toggleSandboxBypass` auto-approves a subtree's pending approvals.

## 4. Migrate tools tests (bash, spawn_subagents)

- Goal: move the behavior-intent tests (including approval-routing tests that assert via the display) from `tools/bashCommand`, `tools/spawn-subagents` and `render-tools/spawn-subagents` into server flow tests. Delete the duplicates. Leave the C files with view-only tests.
- Tests: the abort-child / yield-resolves-parent flow, parent abort propagating to the spawn, slot accounting on error, approvals in subagents surfacing at the session level, and the redundant `cd` auto-approval with a fixed `ProjectDir`.

## 5. Migrate thread/context tests

- Goal: same for `chat/thread`, `thread-abort`, `thread-compact`, `thread-edited-files`, `system-reminders`, `fork-thread`, `context-manager`, `git-context` and `render-pending-approvals`. Out-of-process changes become `InMemoryFileIO` writes. Git branch changes go through `FakeGitClient`.
- Tests: delivered context-update content (including deleted files), compaction chunking and continuation, fork approval ownership, reminder combination, and edited-file records per turn.

## 6. Client-side AC tests and fixture cost

- Goal:
  - Move `chat-view-adapter`-style and script lifecycle tests to `*.node.test.ts` with `FakeClient`/an in-process server, where no nvim is involved.
  - For the remaining C, avoid the per-test `fs.cp` of fixtures by sharing one copied fixture per worker plus a cheap reset, or by copying lazily only when the test asks for files. Choose after measuring fixture-copy time versus nvim spawn time.
- Tests: the full suite stays green. Report the `withDriver` count, the `nvim` project's summed time and the overall wall time are reported against the baseline.

# Stage 1 results (done)

- [x] Classify unaudited files
- [x] Find nvim-free files
- [x] Re-measure baseline with `--reporter=json`

## Baseline (re-measured with `npx vitest run --reporter=json --outputFile=/tmp/vt.json`, 2012 tests)

- Wall 67.8s. Summed per-file: `nvim` 201.7s (58 files), `server` 97.6s (108), `node` 4.8s (20).
- `withDriver(` call sites: 259 (`grep -rE 'withDriver\(' --include=*.test.ts node/nvimclient | wc -l`).
- Project bucketing: path contains `/node/server/` or `/sdk/` is server, `*.node.test.ts` is node, the rest is nvim.
- Pre-existing failures, which also fail on clean HEAD a0e8eff (not caused by this work): `chat/pull-requests.test.ts` "renders the pull request summary and inline deliveries", and `render-tools/spawn-subagents.test.ts` "shows thread hierarchy with parent-child relationships" and "handles thread hierarchy with stopped and yielded children".

## Per-test classification

- `context/context-manager.test.ts`:
  - C: "returns diff when disk changes even if buffer has unsaved changes" (buffer interplay), the `dd` and `Enter` keymap tests (5).
  - A: "context-files end-to-end", "autoContext loads on startup and after new-thread", "large context files are summarized" (assert the summary in the request; the badge is folded into an existing render test), "out-of-process file change" (`fileIO.writeFile` between submissions). Overlap: check `node/server/src/context/*.test.ts` file-supervisor tests before porting.
- `context/git-context.test.ts`: A ("renders the git context update when the branch changes" is about delivery). Use `FakeGitClient`. Check overlap with the server git-supervisor tests.
- `chat/system-reminders.test.ts`:
  - C: "collapsed by default", "is rendered in UI", "only context updates and reminders gets no user header", "mentions tag names still renders as user text".
  - A: "auto-respond combines the standing and bash reminders", "@implementplan activates a persistent plan-maintenance reminder".
- `chat/fork-thread.test.ts`:
  - A: "sandbox bypass and write approvals use the fork owner" (needs stage 3), "fork appends an id-free fork_notification" (check overlap with `fork-flow.test.ts`).
  - C: the "forked from"/"forked to" navigation tests.
- `capabilities/render-pending-approvals.test.ts`:
  - A: "toggling sandbox off auto-approves pending approvals in the subtree".
  - Split, default move to A: "spawn_subagents surfaces bash_command approval in parent view" and "multiple agents surfaces pending approvals" (session-level `getPendingApprovals`). Keep one C test for the rendered approval view.
- `scripts/script-manager.test.ts`:
  - C: "renders running invocations...", "expands and collapses the script row".
  - Split: "toggles sandbox bypass for the whole invocation", "surfaces a spawned thread's pending permission ... and approves it", "toggling the invocation sandbox approves...". Routing goes to A against the server `ScriptManager`. The row/keymap check stays in one C test.
  - AC: "owner shutdown disposes the scripts and the session", "a failing script disposal still disposes the session" (composition root, no nvim needed).
- `scripts/script-e2e.test.ts`:
  - Split: "end-to-end: agent invokes run_script..." (the lifecycle goes to A in server script tests; a smaller UI check stays C).
  - C: "bell behavior" (bells are client/nvim).
- `chat/chat-view-adapter.test.ts`: all 7 are AC ("renders an initialized record ... as initializing" is AC only if it asserts adapter state; verify).
- `chat/chat.test.ts`:
  - A: "summarizes a submission that never issued a request as empty", subtree delete semantics (the two `dd` tests' session effects; the `dd` keymap stays covered by one C test).
  - C: "resets view when switching", "shows thread overview", both bell tests.
- `tools/edl.test.ts`: all C (display/expansion/navigation/buffer). The non-buffer behavior is already covered by the server EDL tests.
- `tools/getFile.test.ts`: all C (render/expand/unloaded buffer). No A leftovers.

## nvim-free files (rename to `*.node.test.ts` in stage 2)

- `utils/file-summary.test.ts` is the only candidate that never starts nvim.
- These do start nvim: `tea/highlights`, `tea/on-unhandled-key`, `tea/render`, `tea/update`, `tea/util`, `tea/view`, `nvim/nvim-node/attach`, `nvim/nvim-node/logger`, `bridge-guard`, `utils/pdf-pages`, `chat/commands/file-paste`. Check `pdf-pages` and `file-paste` in stage 2: their nvim usage may be incidental.

## Review follow-ups (queued-message removal)

- The working tree carried an unrelated feature (`Mailbox.remove`, `Thread.removeQueued`, the `thread.removeQueued` operation and `dd` on pending messages). Committed alongside its tests:
  - `submission/mailbox.test.ts` "remove": queue selection, out-of-range/negative indices, checked-out entries can't be removed and `restore` doesn't resurrect removals.
  - `protocol/server.test.ts` "removes a queued entry so it is never delivered": covers `Thread.removeQueued` through `execute`.
  - `chat/thread.test.ts` "dd on a next-queue entry removes only that entry" (tier C, checks the view→queue index mapping).
- The client `remove-pending-message` msg uses the server's `DeferredDelivery` type.

# Stage 2 results (done)

- [x] Renamed `utils/file-summary.test.ts` to `file-summary.node.test.ts`. `pdf-pages`/`file-paste` still start nvim; left as-is.
- [x] `pollUntil` interval 100ms → 25ms. 10ms was tried: it added load-related flakes (fork-keybinding, bashCommand, buf-enter, two-column) under the 4-fork pool, so 25ms was kept.
- [x] `thread-logger.test.ts` now uses a pid+timestamp unique tmp dir. `archive.test.ts` already used a `uuidv7` suffix.
- [ ] Fixed delays: not replaced. `attention.test.ts`'s `delay(1100)` waits out the 1s throttle that lives in a lua local (`lua/magenta/init.lua` attention autocmd), which can't be reset from the test without a production change. The `reflect-anchor`/`reflections-overview` waits are mostly negative assertions ("nothing happens") with no condition to poll. Deferred; these files are tier C anyway.
- [x] maxForks measured (with 10ms polling): 4 → 60.7s, 6 → 55.6s, 8 → 59.2s, each with more flaky failures as forks grew. Kept at 4.
- Result: wall time ~65s against the 68s baseline (25ms polling, 4 forks). Two consecutive full runs had only the 3 known pre-existing failures, plus one `display-open-target` flake in the first run. The real wins have to come from stages 3–6 (fewer nvim spawns).

# Stage 3 results (done)

- [x] `SandboxFileIO` takes an optional inner `FileIO` (default `FsFileIO`) and `SandboxShell` an optional `inner: Shell` (it replaces spawning bash). This is a dependency-injection seam, not a test-only API: the gating logic is unchanged and production keeps its defaults. Without it the real layers could not wrap the fakes, because they call `fs`/`spawn` directly.
- [x] `HarnessOptions.sandbox?: { config?: Partial<SandboxConfig> }`. When it is set, `TestSessionHost.sandboxed()` wraps `InMemoryFileIO`/`FakeShell` in the real `SandboxFileIO`/`SandboxShell` over `harness.sandbox` (`MockSandboxManager`), with `session.approvalsFor(id)` and `session.isSandboxBypassed(id)`, mirroring `createLocalEnvironment`. Session roots start bypassed, so `createRoot` turns the sandbox on for that root. Without the option, threads get the raw fakes as before.
- [x] `options.customCommands` was added. `maxConcurrentSubagents` already existed. Custom commands only expand through the new exported `submissionResolve`, which is the production `resolveSubmission` over the harness fileIO (it has no client, so client commands throw). The default resolver is unchanged.
- [x] `node/server/src/test/harness-sandbox.test.ts`: approve, reject ("The user did not allow running this command."), the `toggleSandboxBypass` auto-approve, a blocked write waiting for approval before it reaches `InMemoryFileIO`, and custom command expansion.
- Full suite: only the 3 known pre-existing failures. tsc and biome are clean.

# Stage 4 results (done)

- [x] `node/server/src/tools/spawn-subagents-flow.test.ts` gained: child abort keeps the spawn pending and a later yield resolves it (replaces both C "abort does not resolve parent tool calls" tests), parent abort aborts the spawn ("Sub-agent execution was aborted" in the tool result), a subagent's bash approval surfaces via `session.getPendingApprovals(childId)` and approving it runs the command, explore agentType uses the explore system prompt, and an errored subagent keeps its slot until it recovers and yields (`Successful: 2`).
- [x] `node/server/src/test/harness-sandbox.test.ts` gained "an approved command that fails reports its exit code and stderr". Approval-required and rejection were already covered there in stage 3.
- [x] Deleted from C: `tools/bashCommand` (requires approval, rejection, error after approval, redundant `cd`, duration in failed result — covered by server `bashCommand.test.ts`), `tools/spawn-subagents` (navigation duplicate of the render-tools test, explore, both concurrency tests — batching duplicates server "respects maxConcurrentSubagents"), `render-tools/spawn-subagents` (the 3 abort tests).
- Deviations:
  - Redundant `cd <cwd> &&` auto-approve: the server has no cd-stripping logic; the C test only passed because the mock sandbox needs no approval by default. Deleted without a port.
  - "truncates display preview but preserves full output" kept in C: half of it is a preview (view) check, and the full-output half is already covered by server `bashCommand.test.ts`.
  - "shows pending approvals from subagent in parent progress view" kept as the one C render check for subagent approvals; the routing is now asserted in A.
  - "executed only once" left in C for now (tier B candidate).
- `withDriver(` call sites: 259 → 248. Full suite: only the 3 known pre-existing failures; wall 66.9s. tsc and biome clean.
- Review follow-up: "an errored subagent keeps its slot" no longer uses a fixed `setTimeout(50)`. After the child fails, it is re-driven to a new request ("retry error_task"), and only then the test asserts that the parent still has exactly one child and no stream has mentioned `success_task`. That anchors the negative check to a later event instead of a timer.

# Stage 5 results (done)

- [x] `context/git-context.test.ts` deleted: covered by server `context/git-context.test.ts` "attaches a git context update when the branch changes".
- [x] `context/context-manager.test.ts`: deleted the 4 A tests (end-to-end + snapshot, autoContext, large-file summary, out-of-process change). Covered by `context/context-flow.test.ts` ("autoContext is delivered in the first message", "large context files are summarized", "returns diff when file is edited on disk", "user's @file: ...") and `file-supervisor-delivery.test.ts` "detects out-of-process change". The keymap/buffer tests stay.
- [x] `chat/system-reminders.test.ts`: "auto-respond combines..." deleted (server `system-reminders-flow.test.ts` has the same test); `@implementplan` ported there (uses `submissionResolve`, since commands only expand through the production resolver).
- [x] `chat/fork-thread.test.ts`: fork_notification test deleted (server `fork-flow.test.ts` + `session.test.ts` origin/listDerived). Approval ownership ported to `test/harness-sandbox.test.ts` "sandbox bypass and write approvals use the fork owner" (fork inherits the source's bypass at fork time, toggling the source doesn't affect it, a fork write's approval lands on the fork).
- [x] `capabilities/render-pending-approvals.test.ts`: subtree auto-approve ported to `spawn-subagents-flow.test.ts` "bypassing the root's sandbox auto-approves a subagent's pending approval"; the multiple-agents test deleted (per-child routing is in "a subagent's bash approval surfaces at the session level"). One C render test kept.
- [x] `chat/thread-abort.test.ts`: "clears pending file permission checks when aborting" ported to `harness-sandbox.test.ts` (via `session.abortThread`, which is what the client's abort calls).
- [x] `chat/thread-compact.test.ts` deleted: ported "@compact with a next prompt summarizes on the fast model and continues" (incl. hierarchy discovery after replacement) and "spawns one compact child thread per chunk..." to `thread-compact-flow.test.ts`; the fork+compact test is covered by "forks a thread and compacts the fork in one step". Compaction rendering stays in `thread-compact-view.test.ts`.
- [x] `chat/thread.test.ts`: custom command test deleted (covered by `harness-sandbox.test.ts` custom command expansion).
- Deviations, kept in C:
  - `thread-abort` "clears pending permissions when sending a new message during tool_use": the clearing is client logic (`chat/thread.ts` sends `approval.rejectAll` before submitting), the server alone does not clear them on preemption.
  - `thread-abort` "aborting one running tool...": driven by the `t` keymap.
  - `chat/thread.test.ts` deleted-context and web-search tests: their only real assertions are on the display (the deleted-context request check had no `expect`). Server coverage of deletion delivery already exists (`context-flow` "handles file deletion during tracking").
  - `thread-edited-files`: all three tests are about `<CR>` diff windows/buffers; records are covered by `edited-files-flow.test.ts`.
  - "disposing the view leaves the thread alone" (AC) is left for stage 6.
- `withDriver(` call sites: 248 → 232. Full suite: only the 3 known pre-existing failures (plus a `@staged` flake that passes in isolation). tsc and biome clean.
- Review follow-up: `thread-compact-flow.test.ts` "spawns one compact child thread per chunk" no longer uses `current!`; it checks the active compaction explicitly (re-read mid-run, since `current` is a state snapshot) and throws a clear error if it is missing.

# Stage 6 results (done)

- [x] `chat/chat-view-adapter.test.ts` → `chat/chat-view-adapter.node.test.ts` (all 7 tests). A `withChat` helper builds a `Chat` over `startInProcessServer` with a tmp project dir, mock profiles (`provider: "mock"` + `withMockClient`), a logger-only `Nvim` stub and `dispatch` wired back to `chat.update`. The rebuilt-adapter test submits through the server `Thread` instead of the input buffer.
- [x] Script lifecycle AC: "owner shutdown disposes the scripts and the session" is now in `in-process-server.node.test.ts` (spies on both disposals; child termination is covered by `script-manager.node.test.ts` "dispose terminates running invocations"). "a failing script disposal still disposes the session" was already covered by `in-process-server.node.test.ts`. Both C tests deleted.
- [ ] Fixture copy: not changed. Measured `fs.cp` of the fixtures dir at ~15ms per test (×223 ≈ 3.5s summed, <1s wall at 4 forks), negligible next to the nvim spawn. A shared-per-worker copy would need a reset step that risks cross-test leakage for no measurable gain.
- "disposing the view leaves the thread alone" (`chat/thread.test.ts`) left in C: it goes through the sidebar/buffer teardown.
- Review follow-up: the owner-shutdown test asserts scripts are disposed before the session (`invocationCallOrder`); the redundant `as ThreadId` casts in `chat-view-adapter.node.test.ts` were dropped (`serverThread` already returns `Thread`). The `Nvim`/`Lsp` partial stubs stay as casts: `Chat` only touches `nvim.logger` in these tests, and a typed fake of the full client interface isn't worth it for one fixture.
- Final numbers vs baseline: `withDriver(` call sites 259 → 223; nvim summed 201.7s → 157.5s; server 97.6s → 106.7s; node 4.8s → 6.5s; wall 67.8s → 59s. Only the 3 known pre-existing failures. tsc and biome clean.
