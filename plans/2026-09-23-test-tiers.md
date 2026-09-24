# Objective and Context

User request (verbatim):

> the tests in this repo take a while to run. Since we're moving towards a server/client architecture, I think this is an opportunity to speed up the tests some.
>
> tests that spin up nvim, with a full plugin init, are quite slow. For tests of the server, we don't need a full nvim environment. We can just make assertions over the session/thread/core/inference manager state. I think we have a lot of tests around ordering, or tests that verify that a specific thing is rendered, when really we just want to verify a state transition.
>
> tests that spin up tmp directories and actual git repos are also not always necessary. We abstract the agents access to the filesystem via FileIO anyways, so we can provide a fake one for anything that's not actually directly testing the interaction with the file system (like file writes / buffer interactions / etc...)
>
> So the default should be - node only, inside the vitest process, just driving the server-side machinery using a mock fs and mock inference endpoint, and making assertions about the resulting state of the thread / session.
>
> When we need an actual git repo / fs, then we provide just the tmp dir and fs.
>
> And we only provide the nvim process when the thing under test is the interaction with nvim machinery directly.

Tiers:

- A (default): node-only in the vitest process. Drives `Session`/`Thread`/`ThreadCore`/`NativeInferenceManager` with the mock Anthropic client and `InMemoryFileIO`, asserts on state.
- B: A plus a real tmp dir / git repo, only when real fs/git behavior is under test.
- C: nvim process (`withDriver` / `withNvimClient`), only when nvim machinery is under test (buffers, extmarks, windows, keymaps, TUI rendering, lua bridge, completions).

Key entities:

- `Session` (`node/server/src/session.ts`) is constructed from a `SessionHost` whose `prepareThread(request, session, signal)` returns a `PreparedThread` (`{ context: PreparedThreadContext, autoCompactThreshold?, autoCompactPrompt, archiveBaseDir?, release? }`). This is the seam: production uses `NvimSessionHost`; tier A supplies a node-only host.
- `NvimSessionHost.prepareThread` (`node/nvimclient/chat/session-host.ts`) builds the context from nvim-bound helpers: `resolveAutoContext`, `discoverHierarchyContext` (`context/auto-context.ts`, nvim used only for its logger), `buildSystemInfo` (reads `nvim_eval` for version), `createSystemPrompt` (nvim for logger), `createLocalEnvironment` (fileIO/shell/git/lsp/lua/sandbox), `commandRegistry.processMessage` for `resolve`, and `getProvider(nvim, profile)`.
- `FileIO`, `GitClient` (`getState()`), `Shell` (`execute`, `terminate`), `LspClient` capability interfaces in `node/server/src/capabilities/`.
- `InMemoryFileIO` (`node/server/src/edl/in-memory-file-io.ts`) implements the full `FileIO` (incl. `stat`, `readdir`, `isDirectory`).
- Existing server test helpers (`node/server/src/test-helpers.ts`): `createMockProvider`, `createAgentWithMock`, `baseTestContext` (stub fileIO/git), `awaitNextStream`, `sendText`, `userTexts`, `getFileSupervisor`, `getContextDeliveries`, `resetThread`, `compactorSlot`. `session.test.ts` has an ad-hoc `fixture()` building a `Session` over `createAgentWithMock`.
- `vitest.config.*` (root): one config for everything, `pool: "forks"`, `maxForks: 4`, with nvim-only `globalSetup` (clones blink.cmp, git-inits fixtures) and `setupFiles`. Server tests are throttled by the nvim cap.

Relevant files:

- `node/server/src/session.ts` — Session, SessionHost, PreparedThread.
- `node/server/src/thread-assembly.ts` — `PreparedThreadContext`, `assembleThread`.
- `node/server/src/test-helpers.ts` — existing mock provider/agent helpers.
- `node/server/src/edl/in-memory-file-io.ts` — fake FileIO.
- `node/nvimclient/chat/session-host.ts` — production host; reference for what a prepared context contains.
- `node/nvimclient/context/auto-context.ts`, `node/nvimclient/providers/system-prompt.ts` — context/prompt building with incidental nvim deps.
- `node/nvimclient/chat/commands/registry.ts` — `@`-command expansion (`@file`, `@diff`, `@staged` are fs/git; `@diag`, `@qf`, `@buf` are nvim).
- `node/nvimclient/test/preamble.ts`, `driver.ts` — tier C harness.
- `vitest.config.*` — test runner config.

# Design

1. Split the vitest run into projects so tier A/B tests run with high parallelism and without nvim global setup, and C tests keep the nvim cap.
2. Build a reusable tier A harness around a node-only `SessionHost` (`TestSessionHost`) that produces the same shape of `PreparedThreadContext` as `NvimSessionHost`, but from in-memory collaborators: `InMemoryFileIO`, a scripted `FakeGitClient`, a scripted `FakeShell`, stub LSP/MCP, mock provider. Tests drive the public API (`session.createRootThread`, `thread.submit`, mock stream responses) and assert on `thread` state (`getProviderMessages`, `loopState`, `contextFiles`, `getContextDelivery`, `turnSupervisors`, session records).
3. Make the pieces of context preparation that only incidentally depend on nvim node-only, so the harness uses the same code as production rather than re-implementing it: hierarchy/auto-context discovery (logger + FileIO), system prompt (logger), system info (take `neovimVersion` as input). Only genuinely nvim-bound pieces (`@diag`/`@qf`/`@buf`, lua executor, buffer tracking) stay behind the host.
4. Port tests file by file from C to A (or B), in order of runtime cost, deleting C tests that duplicate existing server coverage and keeping thin C tests for rendering/keybindings. Each ported C file shrinks to its nvim-only cases.
5. Convert server tests that use tmp dirs only for seeding (B) to `InMemoryFileIO` (A).

Porting rule of thumb: if the C test's assertions are on `getProviderMessages()`, `thread.*` state, `mockAnthropic` requests, or display text that is a direct projection of one of those, it becomes an A test asserting the underlying state. If it asserts on window/buffer/extmark/keymap behavior, it stays C, reduced to one representative case per rendering path.

## Interfaces

Vitest projects (root config):

```ts
export default defineConfig({
  test: {
    projects: [
      { test: { name: "server", include: ["node/server/**/*.test.ts", "sdk/**/*.test.ts"], pool: "threads" } },
      { test: { name: "node", include: [/* nvimclient A/B files, listed or matched by *.node.test.ts */], pool: "threads" } },
      { test: { name: "nvim", include: ["node/nvimclient/**/*.test.ts"], exclude: [/* node project files */],
                globalSetup: ["./node/nvimclient/test/global-setup.ts"], setupFiles: ["./node/nvimclient/test/setup.ts"],
                pool: "forks", poolOptions: { forks: { maxForks: 4, minForks: 1 } } } },
    ],
  },
});
```

Naming convention: nvimclient tests that do not start nvim are named `*.node.test.ts` so the include globs need no hand-maintained lists. Installed vitest is ^3.2.4, which already supports `test.projects`. Optionally upgrade to the latest (5.x) in stage 1; note that `poolOptions` was removed in v4 in favor of top-level `maxWorkers` per project.

Tier A harness (`node/server/src/test/harness.ts`, exported only for tests; nvimclient node tests may import it):

```ts
export type HarnessOptions = {
  files?: Record<string, string>;          // abs path -> content, seeds InMemoryFileIO
  cwd?: string;                            // default "/project"
  homeDir?: string;                        // default "/home"
  git?: GitState;                          // initial FakeGitClient state
  shell?: FakeShellScript;                 // command -> result
  agents?: AgentsMap;
  options?: Partial<HarnessThreadOptions>; // autoCompactThreshold/Prompt, hierarchyContextFileNames, autoContext globs, maxConcurrentSubagents...
  resolve?: (host: TestSessionHost) => ResolveSubmission; // default: text + @file/@compact handling
  provider?: "anthropic" | "openai";
};

export type Harness = {
  session: Session;
  host: TestSessionHost;
  mockClient: MockAnthropicClient;         // existing mock
  fileIO: InMemoryFileIO;
  git: FakeGitClient;
  shell: FakeShell;
  createRoot(): Promise<{ id: ThreadId; thread: Thread }>;
  thread(id: ThreadId): Thread;            // throws unless initialized
  send(thread: Thread, text: string): Promise<RestResult>;
  nextStream(): Promise<MockStream>;       // wraps awaitNextStream
  dispose(): Promise<void>;
};

export function createHarness(options?: HarnessOptions): Harness;
export function withHarness<T>(options: HarnessOptions, fn: (h: Harness) => Promise<T>): Promise<T>;

export class FakeGitClient implements GitClient {
  constructor(state?: GitState);
  set(state: GitState | undefined): void;  // simulate branch/HEAD changes
  getState(): Promise<GitState | undefined>;
}

export class FakeShell implements Shell {
  constructor(script?: FakeShellScript);
  calls: string[];
  // execute() resolves from script or a Defer the test controls
}
```

`TestSessionHost implements SessionHost`: `prepareThread` mirrors `NvimSessionHost.prepareThread` (auto-context unless fork/custom fileIO, system info/prompt from source on fork, `initialFiles`, `initialGitState`, `discoverHierarchy`, `clientToolCreator` wired to the fakes, `threadManager: session`, `resolve` delivered at delivery time against `session.getThread(id)`), using the node-only helpers from the "context preparation" stage.

Node-only context helpers (moved to `node/server/src/context/`):

```ts
resolveAutoContext(ctx: { fileIO: FileIO; logger: Logger; cwd; homeDir; globs: string[] }): Promise<AutoContextFile[]>;
discoverHierarchyContext(absFilePath, ctx: { fileIO: FileIO; logger: Logger; cwd; homeDir; hierarchyContextFileNames: string[] }): Promise<...>;
buildSystemInfo(ctx: { cwd; neovimVersion: string; overrides? }): SystemInfo;
```

`resolveAutoContext` performs glob matching through `FileIO` (`readdir`/`isDirectory`, walking directories and matching with a pure matcher such as `minimatch`/`picomatch` if already a dependency) instead of the `glob` package, and file-type detection via `FileIO.readBinaryFile`/`stat`. Production passes `FsFileIO`; the harness passes `InMemoryFileIO`.

## Invariants

- Production behavior is unchanged: `NvimSessionHost` and `TestSessionHost` share the context-building helpers; only collaborators differ. Any helper moved to the server package keeps its existing behavior, verified by the existing tests before they are ported.
- The harness goes through `Session.createRootThread`/`forkThread` and `thread.submit`, never constructing `ThreadCore` directly, so wiring bugs (supervisor order, compactor attachment, resolver timing) are still caught.
- White-box helpers (`resetThread`, `getFileSupervisor`, ...) remain test-only and are not exported from the server barrel.
- The server package still cannot import from the root project; nvimclient node tests may import server test helpers, not the reverse.
- Each ported behavior keeps at least one assertion. When a C test is removed as a duplicate, the plan entry names the A test that covers it.
- Every rendering path that was covered in C keeps at least one C test (e.g. one compaction view, one fork navigation, one approval prompt, one edited-files diffsplit).
- Tier B tests create their own tmp dir and clean it up; no tier A test touches the real fs (enforce by having the harness default `archiveBaseDir` to an in-memory or tmp location already used by `TEST_ARCHIVE_DIR`, and auditing for `fs.` imports in A files).
- Timing-sensitive tests use `Defer`/mock stream control rather than sleeps, same as today.

# Stages

## 1. Split vitest projects

- Optionally upgrade vitest to latest and migrate `poolOptions` to the new per-project worker settings.
- Goal: `npx vitest run` runs server tests in a thread pool without nvim global setup; nvim tests keep `maxForks: 4`. `npx vitest run --project server` works for fast iteration. Record a baseline wall time for the full suite and per project (append to this plan).
- Tests: full suite passes with identical test counts before/after (compare `--reporter=json` totals). Server project does not execute `global-setup.ts` (no blink clone attempted when run alone).

## 2. Node-only context preparation helpers

- Goal: `resolveAutoContext`, `discoverHierarchyContext`, `buildSystemInfo`, `createSystemPrompt` (nvimclient variant) take `Logger`/`FileIO`/values instead of `Nvim`, and live in (or delegate to) `node/server/src/`. `NvimSessionHost` calls them with nvim-derived values.
- `resolveAutoContext` no longer uses the `glob` package or direct fs access: directory walking, pattern matching, and file-type detection all go through `FileIO`.
- Tests:
  - Port `context/auto-context.test.ts` and `providers/system-prompt.test.ts` to A using `InMemoryFileIO` (walks up from nested file, empty names disables, home before project, docker prompt text, systemInfo overrides).
  - Glob parity: for a fixture tree, the FileIO-based matcher over `InMemoryFileIO` returns the same set as the previous `glob` implementation for the default autoContext patterns (`context.md`, `CLAUDE.md`, `.magenta/*.md`, `~/`-prefixed, case-insensitive), `nodir`, and gitignored paths if previously excluded.
  - Existing C tests in `context-manager.test.ts` for autoContext and hierarchy still pass unchanged (proves production wiring).
- Status: DONE.
  - `node/server/src/context/auto-context.ts` (`resolveAutoContext({fileIO, logger, cwd, homeDir, globs})`, `discoverHierarchyContext(abs, {fileIO, logger, cwd, homeDir, hierarchyContextFileNames})`, `globFiles`, `autoContextFilesToInitialFiles`) and `context/system-info.ts` (`buildSystemInfo({cwd, neovimVersion, overrides})`), exported from the server barrel. The nvimclient `context/auto-context.ts` and `providers/system-prompt.ts` wrappers were deleted; `NvimSessionHost` calls the server `createSystemPrompt` directly with `nvim.logger` and reads `v:version` itself.
  - Globbing is a small in-house matcher over `FileIO` (`*`, `?`, `[...]`, `{a,b}`, `**`, case-insensitive, nodir, wildcards skip dotfiles like glob's default) — no new dependency. `glob` moved to devDependencies (used only by the parity test).
  - Deviations: dedup is by `path.normalize` only (previously `fs.realpathSync`), so symlinked duplicates are no longer collapsed. Magic-less patterns return on-disk casing (glob echoed the pattern). The host passes a module-level `FsFileIO` for auto/hierarchy discovery (unchanged semantics: host fs, not the thread's sandbox/docker fileIO).
  - Review follow-up: symlink duplicates are intentionally accepted (FileIO has no realpath), pinned by a test; lexical dedup across overlapping patterns tested. Parity loop extended with `[cC]laude.md`, `[!x]*.md`, `docs/**`, `../<tmp>/context.md`; this caught and fixed a bug where a trailing `**` didn't match files. Added a hierarchy test that an unsupported (binary) `context.md` is skipped while the walk continues. `globFiles` brands paths once via `Set<AbsFilePath>`.
  - Tests: `node/server/src/context/auto-context.test.ts` (hierarchy, autoContext over `InMemoryFileIO`, glob parity vs `glob` on a real tmp tree — tier B) and `context/system-info.test.ts` (ported system-prompt tests; the two docker prompt tests merged into one).

## 3. Tier A harness

- Goal: `createHarness`/`withHarness`, `TestSessionHost`, `FakeGitClient`, `FakeShell` exist in `node/server/src/test/`. `session.test.ts`'s `fixture()` is replaced by the harness.
- Tests:
  - Harness smoke tests: create root thread, send, respond via mock stream, assert `getProviderMessages`; fork; subagent spawn through `session`; `@file:` resolves against `InMemoryFileIO` into context; git state appears in first message system info; `dispose` leaves no pending threads.
  - A root thread's `turnSupervisors` order equals what `supervisor-wiring.test.ts` asserts for the nvim host (proves parity of the two hosts).
- Status: DONE.
  - `node/server/src/test/harness.ts` (`createHarness`, `withHarness`, `TestSessionHost`, `defaultHarnessResolve`) and `test/fakes.ts` (`FakeGitClient`, `FakeShell` with scripted responses or test-settled `pending` Defers). `TestSessionHost` uses the server `resolveAutoContext`/`discoverHierarchyContext`/`buildSystemInfo`/`createSystemPrompt` over the thread's FileIO, mirrors fork inheritance, and resolves at delivery time via `session.getThread(id)`.
  - Deviations: `HarnessOptions.provider` (openai) not implemented yet — anthropic mock only. The default resolver handles `@compact` and `@file:` (via `detectFileTypeViaFileIO` + `contextFiles.addFileContext`, since `FileSupervisor.addFiles` detects type on the real fs). Host test knobs: `contextOverrides` (merged into every prepared context), `intercept(request, prepare)` (gate/fail/add `release`), mutable `options` (policy changes), `rejectedApprovals`. Archive still goes to `TEST_ARCHIVE_DIR`.
  - `session.test.ts` now uses the harness (all 17 tests unchanged in intent). Smoke + parity tests in `test/harness.test.ts` (root order `[MaxTokens, Title]`, subagent order `[MaxTokens, Subagent, Title]` matching `supervisor-wiring.test.ts`).
  - Review follow-up: harness tests now cover FakeShell (scripted command via `bash_command`, unscripted command settled through `h.shell.pending`, `terminate()` → 143/SIGTERM drains pending), fork keeping the source's system info after `h.git.set` changes the branch, `autoContext` seeding, and that disposal rejects a pending `createRootThread`. Profile uses `satisfies ProviderProfile`; `@file:` match is null-checked before branding.

## 4. Server tmp-dir tests → InMemoryFileIO

- Goal: `edl/executor`, `edl/index`, `tools/getFile`, `tools/edl`, `agents/agents`, `providers/codex-auth` use `InMemoryFileIO` (codex-auth: inject fs or FileIO for auth.json). `thread-core-context.test.ts` split into A (`FakeGitClient`) and a small B file for cases that need a real git repo.
- Tests: same test names and assertions pass; no `mkdtemp`/`withTmpDir` remains in these files (grep check). Binary cases in getFile (PDF/image) keep fixture bytes loaded into `InMemoryFileIO` via `Buffer` (extend `InMemoryFileIO` to store `Buffer` if needed).
- Status: DONE.
  - `InMemoryFileIO` now stores `string | Buffer` (`writeBinaryFile`), `stat` reports real byte size, and has sync `readFileSync`/`readdirSync`/`statSync` for agent discovery.
  - `edl/executor`, `edl/index`, `tools/getFile`, `tools/edl`: a local `fs` shim over a fresh `InMemoryFileIO` per test; `withTmpDir` now yields a virtual `/project/...` path. EDL `.edl` fixture scripts are still read from disk (source fixtures, not tmp dirs).
  - Production fixes surfaced by the port: `extractPDFPage`/`getPDFPageCount`/`getSummaryAsProviderContent` take an optional `FileIO` (getFile passes its context fileIO; previously PDFs bypassed FileIO), and `FileSupervisor.addFiles` detects file type via `detectFileTypeViaFileIO(this.fileIO)` instead of the host fs.
  - `agents/agents.ts`: `loadAgents`/`parseAgentFile` accept an optional sync `fs: AgentsFs` (defaults to `node:fs`); tests pass `InMemoryFileIO`. Builtin-agent test still reads the real builtin dir; the override test seeds builtin files into memory.
  - `thread-core-context.test.ts`: already used a fake git client (no real repo), so no B split was needed; converted wholesale to `InMemoryFileIO` + `FakeGitClient`.
  - Deviation: `providers/codex-auth.test.ts` stays tier B — it tests the atomic rename + `0o600` permissions of `auth.json`, which is real-fs behavior.
  - Review follow-up: `pdf-pages` functions now require `fileIO` (no node:fs fallback; `FileSupervisor` PDF summaries pass `this.fileIO`, nvimclient `pdf-pages.test.ts` passes `FsFileIO`). `loadAgents` resolves `fs ?? node:fs` once; internal helpers and `parseAgentFile` require `fs`. `InMemoryFileIO` builds ENOENT via a typed `enoent()` helper. Added unit tests for `statSync`/`readdirSync` branches and exact binary round-trip, and a `FileSupervisor.addFiles` test detecting text/JPEG/missing via `InMemoryFileIO`.

## 5. Port chat/thread, thread-abort, supervisor-wiring

- Goal: `chat/thread.test.ts` reduced to input-buffer/rendering cases; message interleaving, `@async`/`@next` queueing, fork message preservation, thinking/redacted blocks, streaming preview state move to A (`node/server/src/thread-flow.test.ts` or extend `thread.test.ts`). `thread-abort.test.ts`: abort-during-stream/tool, error tool results, fork-without-abort → A; input-buffer recovery stays C. `supervisor-wiring.test.ts` → A entirely.
- Tests: each moved test keeps its name and asserts the same state (message arrays, `loopState`, `request.aborted`). `@diag`/`@qf`/`@buf` expansion tests: covered by `commands/registry.test.ts` (already node-only); delete the C duplicates, keep one C test proving `@buf` reaches the thread end-to-end.

## 6. Port compaction and fork

- Goal: 14 of 16 `thread-compact.test.ts` cases → A (auto-compact thresholds/prompts, script overrides, parked submission cancel/fail, context files and reminders retained, `@compact` in compact thread). `fork-thread.test.ts` context-update/reseed/tool-result/isolation cases → A. `thread-compact-view`, `fork-keybinding`, fork navigation and fork approval routing stay C.
- Tests: moved tests assert `compactorSlot`, `thread.contextFiles`, deliveries, submission results. Remove any A case already equivalent to `compaction/index.test.ts` / `session.test.ts` and note which.

## 7. Port context, git, reminders, skills, options-loader

- Goal: `context-manager.test.ts` disk-diff, hierarchy discovery, autoContext, fork inheritance, discovery idempotence, `hierarchyContextFileNames: []`, large-file summary state → A (edits simulated via `fileIO.writeFile` + mtime bump). dd/Enter keybindings, pending-context view, and "diff when buffer has unsaved changes" stay C. `git-context.test.ts` → A with `FakeGitClient.set` (plus one B test using a real repo via `GitClient` impl). `system-reminders.test.ts` ordering/content → A, collapse/render stays C. nvimclient `providers/skills.test.ts` → A (merge with server `providers/skills.test.ts`). `options-loader.test.ts` → B (real options.json in tmp dir, no nvim).
- Tests: as enumerated above, same names. Add an A test for `EditedFiles` state (none exists in server) before trimming `thread-edited-files.test.ts`.

## 8. Port tool tests

- Goal: nvimclient tool tests reduced to nvim-only behavior.
  - `bashCommand`: approval/allowlist, formatting/truncation, progress timer state → A via `FakeShell`; SIGTERM→SIGKILL and log file writing → B (real process, tmp dir, no nvim).
  - `getFile`, `edl`, `render-tools/edl`: result/summary/context-tracking → A; EDL write into an open buffer and unloaded-buffer reads stay C.
  - `nvimLua`: eval/nil/error → A with stub lua executor; side effects stay C.
  - `thread-title`: → A (assert fast-model request + `thread.title`).
  - `mcp/manager`: → A against the existing mock MCP server (runs in-process, no nvim).
  - `spawn-subagents` (tools + render-tools): concurrency, agentType/model routing, custom agents, completion result → A (dedupe against server `spawn-subagents.test.ts`); preview/navigation/expansion stays C.
  - `magenta.test.ts` project bash allowlist → A. `render-pending-approvals` state transitions (sandbox toggle auto-approves subtree) → A; prompt rendering stays C.
- Tests: moved tests keep names; each C file retains ≥1 rendering test per tool.

## 9. Port scripts

- Goal: script discovery (project and home), parameter/contextFiles/reminder forwarding, spawn→yield resolution, subprocess cleanup on dispose → A/B against server `ScriptManager` with the harness session (B only where real script files/child processes are required). Overview rendering, row expansion, bypass toggle, approval under collapsed row stay C.
- Tests: as above; confirm child processes are reaped (no leaked pids) in B tests.

## 10. Pure-logic nvimclient cleanups

- Goal: tests that start nvim only incidentally run as `*.node.test.ts`: `chat/thread-view` (render status to string via a non-mounted render helper, or assert the status model), `openai-streaming-view` (assert completed blocks in state), `nvim-node/logger`, `utils/files` (`detectFileType` on buffers/in-memory), `tea/util` `strWidthInBytes`, `commands/file-paste` pass-through, `chat-view-adapter` no-view cases, `archive-view` list model (if separable), `render-tools/docker-sync` without nvim.
- Tests: same assertions; file runs in the `node` project.

## 11. Measure and prune

- Goal: record new wall times per project next to the stage 1 baseline. Remove C tests left redundant after stages 5–10; update `.magenta/skills/doc-testing/skill.md` and `context.md` Testing section to describe the three tiers, the harness, and the `*.node.test.ts` convention (default = tier A).
- Tests: full suite green; test count delta explained (moved vs deleted-as-duplicate, with the covering test named).

# Appendix: per-file audit

## node/nvimclient (C unless noted)

- bridge-guard: lua bridge refuses second channel. C.
- buf-enter: magenta buffer/window coercion, archive jump restore. C.
- buffer-manager: display/input buffer naming, rename on title, deletion. C.
- capabilities/docker-environment: DockerFileIO/Shell/GetFile via real docker. Docker, no nvim.
- capabilities/render-pending-approvals: approvals surfaced in parent, sandbox toggle. State → A (stage 8), UI C.
- capabilities/sandbox-file-io, sandbox-shell, sandbox-violation-handler, shell-utils, strace; sandbox-manager: sandbox policy/config with mocked runtime. Already node-only.
- chat/archive-view: archive list/pagination/detail/open. C; list model → A (stage 10).
- chat/chat-view-adapter: adapter rebuild, no-view turn, init/failure. No-view cases → A (stage 10).
- chat/chat: overview nav, subtree delete, bells. C; empty-submission summary → A.
- chat/commands/file-paste: @file: wrap on paste. Pass-through → A.
- chat/commands/registry: @-command parsing/expansion. Already node-only.
- chat/display-open-target: <CR> opens paths/URLs. C.
- chat/fork-keybinding: F key fork. C.
- chat/fork-thread: fork context/tool results/navigation/approvals. Mostly A (stage 6).
- chat/openai-streaming-view: completed blocks mid-stream. A (stage 10).
- chat/resolve-submission: @compact resolution. Already node-only.
- chat/supervisor-wiring: policy stacks/budgets. A (stage 5).
- chat/system-reminders: reminder injection/ordering. Mostly A (stage 7).
- chat/thread-abort: abort/fork during stream/tool. Mostly A (stage 5).
- chat/thread-compact-view: compaction status rendering. C.
- chat/thread-compact: compaction flow. Mostly A (stage 6).
- chat/thread-edited-files: edited-files summary + diffsplit. C, plus new A state test.
- chat/thread-view: status line. A (stage 10).
- chat/thread: chat flow/queueing/@commands/fork. Mostly A (stage 5).
- chat/tool-definitions-view: `=` toggle. C.
- context/auto-context: hierarchy discovery. A (stage 2).
- context/context-manager: file context. Mostly A (stage 7).
- context/git-context: git state/branch change. A + one B (stage 7).
- magenta: commands, paste, profiles, bash allowlist. C; allowlist → A.
- nvim: quickfix conversion. C.
- nvim/buffer-reload, nvim/buffer, nvim/cursorToken, nvim-node/attach: nvim buffer/extmark APIs. C.
- nvim-node/logger: log formatting. A (stage 10).
- options: option parsing. Already node-only.
- options-loader: options.json reload. B (stage 7).
- providers/copilot: skipped.
- providers/skills: skill loading. A (stage 7).
- providers/system-prompt: prompt/system info. A (stage 2).
- render-tools/docker-sync: docker sync-back. Docker, drop nvim (stage 10).
- render-tools/edl: failed-command rendering. A (stage 8).
- render-tools/spawn-subagents: preview/navigation/approvals. Mostly C; results → A.
- scripts/script-manager: discovery/lifecycle/rendering. Split (stage 9).
- sidebar: layout. C.
- tea/*: TUI renderer. C (pure helpers already node-only).
- test/completions: blink.cmp. C.
- tools/bashCommand: split A/B/C (stage 8).
- tools/edl, tools/getFile, tools/nvimLua: mostly A (stage 8).
- tools/findReferences, tools/hover (skipped): LSP end-to-end. C.
- tools/mcp/manager: A (stage 8).
- tools/spawn-subagents: mostly A (stage 8).
- tools/thread-title: A (stage 8).
- utils/file-summary: already node-only.
- utils/files: A (stage 10).
- utils/pdf-pages: B, or A with in-memory bytes.

## node/server/src (all node-only)

- Already A: agent, archive, archive-renderer, compact-renderer, compaction/index, compaction/token-budget, docker-supervisor, edl/document, edl/parser, edl/split-by-file, edl/in-memory-file-io, loop-state, providers/* (except codex-auth), session, submission/*, supervisors/*, system-reminder-supervisor, thread-assembly, thread-logger, thread-supervisor, thread, tool-executor, tools/* (except getFile, edl), utils/*.
- B → A (stage 4): edl/executor, edl/index, tools/getFile, tools/edl, agents/agents, providers/codex-auth.
- Split (stage 4): thread-core-context.
- Docker: container/container.

## sdk

- sdk/test/sdk.test.ts: already node-only.
