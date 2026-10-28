# Objective and Context

User request (verbatim): "Does the agent core need a concept of a current working directory? I know we populate context off of the current working directory but I think that happens when the thread is initialized. I think we can do that in the client, right? The client can maybe pass in an initialization directory that we can initialize the files off of and we don't actually have to pass that into the agent. For bash commands I think we can basically just always have the root directory start at the system root instead of the current working directory. I think that way we can basically just have the agent be agnostic and use absolute paths all the time. Let's scope out this change and come up with a plan. One thing here is that I want to encourage the agent to always render paths as absolute file paths."

Today `Cwd` (`utils/files.ts`, branded `AbsFilePath`) is threaded from `Session.createThread` → `ServerSessionHost` → `Environment` → `ThreadCoreContext` → every tool context. Its uses split into two categories:

- Preparation-time discovery (legitimately needs a directory, but only once):
  - `config/options-store.ts`, `config/options.ts` `loadProjectSettings` — `<dir>/.magenta/options.json`
  - `providers/skills.ts` (walks up from cwd), `agents/agents.ts` (resolves agent dirs)
  - `context/auto-context.ts` — initial file globs
  - `sandbox-manager.ts` — resolves relative sandbox allow/deny paths
  - `environment.ts`, `server-session-host.ts` — docker workspace path, environment construction
  - `context/system-info.ts` `buildSystemInfo`, `providers/system-prompt.ts` `formatSystemInfo` — "Current working directory:" line in the `<system-info>` block (prepended to the first user message, not the cached system prompt)
- Runtime (agent-facing; what we want to remove):
  - `utils/files.ts` `resolveFilePath`/`relativePath`/`displayPath` — relative path resolution and display
  - Tools: `getFile.ts`, `edl.ts` + `edl/index.ts`, `hover.ts`, `findReferences.ts`, `create-tool.ts`, `spawn-subagents.ts` (`directory` resolved against cwd)
  - `supervisors/file-supervisor.ts` — keys/display via `relativePath(this.cwd, …)`
  - `capabilities/sandbox-shell.ts`, `docker-shell.ts` — `spawn(..., { cwd })`
  - `capabilities/git-clients.ts` — `execFile("git", …, { cwd })` for GitSupervisor
  - `capabilities/sandbox-file-io.ts`, `capabilities/client.ts` (LSP factory takes cwd)
  - `submission/resolve.ts`, `submission/commands/{file,diff}.ts` — `@file:`/`@diff:` resolution (client already absolutizes `@file:`)
  - `scripts/script-manager.ts` — script options `cwd` resolution
  - `protocol/state.ts` (`cwd` in thread state), `archive.ts`/`thread-logger.ts` metadata

# Design

Rename the surviving concept to `ProjectDir` ("the directory this thread was initialized from") and confine it to preparation. The agent runtime gets no cwd: tool inputs must be absolute (or `~/`), the shell starts at `/`, and all paths shown to the model are absolute.

- Session/host keep accepting a directory at creation, renamed `projectDir`. Host uses it for options, skills, agents, auto-context, sandbox config, docker workspace. It is not put on `ThreadCoreContext` or any tool context.
- Path resolution: replace `resolveFilePath(cwd, p, home)` with `resolveAbsPath(p, home): Result<AbsFilePath>` that expands `~` and rejects relative paths with an error telling the model to use absolute paths. `relativePath`/`displayPath(cwd, …)` are deleted; display uses the absolute path (`shortenPath` with `~` optional for UI only, never in model-facing text).
- Shell: spawn with `cwd: "/"` (docker: `/` too). Sandbox write/read policies are already absolute after `sandbox-manager` resolution, so they're unaffected.
- Git context follows the files the agent reads. Right now `GitTracker` (`supervisors/git-supervisor.ts`) wraps one `GitClient` tied to one directory (`LocalGitClient(cwd)` / `DockerGitClient(container, cwd)` in `environment.ts`) and keeps a history of one `GitState`. New design:
  - `GitClient` doesn't know about any directory: `findRepoRoot(file: AbsFilePath): Promise<AbsFilePath | undefined>` (`git -C <dir> rev-parse --show-toplevel`, cached per directory) and `getState(repoRoot)`.
  - `GitSupervisor.registerPath(path: AbsFilePath): Promise<void>` is the only way repos get tracked. It calls `gitClient.findRepoRoot(path)`; if the path is in a repo that isn't tracked yet, it adds that root to the supervisor's tracked set. Paths outside any repo, or in repos already tracked, do nothing. The tracked set lives in the supervisor, and each root records when it was registered so a fork keeps only the repos registered at or before the fork point. Also, `GitTracker` history entries hold `Map<repoRoot, GitState>` instead of a single state.
  - The supervisor posts updates about every tracked repo. On each delivery it gets the state of all tracked roots. A newly registered repo is reported in full (root, branch, HEAD); after that, each repo gets its own section when `coarseChanged` holds for it, and a repo that disappears is reported as gone.
  - Who calls `registerPath`: the host calls it once with the start directory before the first delivery, and `FileSupervisor` calls it for each newly tracked file (get_file, edl, context files, `@file:`), through a capability on `ThreadCoreContext`, the same way it looks up hierarchy context. Nothing outside observes file additions.
  - Fork/clone filters the per-repo history at the fork index, like today.
- System info (not the system prompt): `SystemInfo.cwd` becomes `projectDir`, and `formatSystemInfo` replaces the "Current working directory" line with something like "- The user started this thread from: <abs>. There is no working directory: bash starts at `/` and tools require absolute paths. Use absolute file paths in all tool calls and when showing paths to the user." This keeps the volatile, per-thread directory out of the cached system prompt prefix. Tool descriptions for get_file/edl/hover/find_references state `filePath` must be absolute.
- spawn_subagents `directory`: require absolute; child `projectDir` = that dir (default: parent's projectDir, taken from session metadata, not core).
- Scripts: the `create-thread` option `options.cwd` (`scripts/script-manager.ts` `normalizeThreadRequest`) is renamed `projectDir` and must be an absolute path (or `~/`); relative values are rejected with an error sent back to the script. That path becomes the spawned thread's `ProjectDir`: the host uses it at preparation for options, skills, agents, auto-context, sandbox config, the system-info start directory, and the initial `GitSupervisor.registerPath`. If it's left out, the thread uses the session's start directory. `scriptsPaths` config entries are server config, so they keep resolving against the session's start directory.
- Client: `NvimCwd` → `threadProjectDirFromNvimCwd`; client keeps absolutizing `@file:`. nvim tools (hover/LSP) receive absolute paths only.

Open questions:

- Relative `@diff:` paths from users: absolutize in client like `@file:`.
- Archived threads with `cwd` metadata: read as `projectDir` for back-compat.

## Interfaces

```ts
// utils/files.ts
export type ProjectDir = AbsFilePath & { __projectDir: true };
export function toProjectDir(dir: string): ProjectDir;
export function resolveAbsPath(
  p: UnresolvedFilePath | AbsFilePath,
  homeDir: HomeDir,
): Result<AbsFilePath>; // error if not absolute after ~ expansion

// ThreadCoreContext, tool contexts, Shell/FileIO contexts: no cwd field.
// ServerSessionHost.prepare(opts: { projectDir: ProjectDir; ... })
// ThreadManager.spawn(opts: { projectDir?: ProjectDir; ... })
// protocol/state.ts ThreadState: projectDir: ProjectDir (display only)
// providers/system-prompt.ts SystemInfo: { timestamp; platform; neovimVersion; projectDir: ProjectDir; git? }
// capabilities/git-client.ts
interface GitClient {
  findRepoRoot(path: AbsFilePath): Promise<AbsFilePath | undefined>;
  getState(repoRoot: AbsFilePath): Promise<GitState | undefined>;
}
// supervisors/git-supervisor.ts
class GitSupervisor {
  registerPath(path: AbsFilePath): Promise<void>;
}
```

## Invariants

- No type reachable from `ThreadCore` or a tool context contains `ProjectDir`/`Cwd` (enforce with a boundary test like `fs-boundary.node.test.ts` grepping `node/server/src/tools`, `thread-core.ts`, `supervisors/`, `edl/`).
- Every path in model-facing text (tool results, context updates, file supervisor diffs, system reminders) is absolute.
- Relative tool paths fail loudly rather than resolving against anything.
- Fork/compaction carry no directory state (ThreadCore replacement stays trivial).
- Sandbox path policies resolve identically to today (they're resolved against projectDir at preparation).

# Stages

## Absolute-only path resolution

Status: done.

- [x] `resolveAbsPath(p, homeDir): Result<AbsFilePath>` added in `utils/files.ts` (expands `~`, errors on relative paths, normalizes).
- [x] get_file, hover, find_references use `resolveAbsPath`; hover/find_references print LSP locations as absolute paths.
- [x] EDL: `runScript(..., { homeDir })` resolves `file`/`newfile` paths up front and fails the script on relative paths; mutations/errors carry absolute paths, so the edl tool no longer resolves anything.
- [x] FileSupervisor: `relFilePath` removed from `TrackedFile`, `FileUpdates`, `DiscoveredContextFile` usage and `addFileContext(abs, fileTypeInfo)`; no `cwd` dep; context updates and diff headers use absolute paths. `addFiles` skips (with a warning) relative paths.
- [x] `@file:` submission command uses `resolveAbsPath` (client already absolutizes).
- [x] Tests: relative get_file errors and `~/` works (`tools/getFile.test.ts`), EDL relative/`~/` (`edl/index.test.ts`), file supervisor delivery asserts absolute `File \`/test/file.txt\``; existing tests switched to absolute tool paths; two nvim snapshots updated (absolute paths in context updates).

Decisions/deviations:

- `resolveFilePath`, `relativePath` and `displayPath` are kept (still exported) for the remaining preparation-time callers (auto-context, harness `@file` fake, `sandbox-file-io`) and the nvim client's UI display; they get deleted in the rename/client stages.
- Script `create-thread` `contextFiles` are resolved against the thread's directory in `scripts/script-manager.ts` `normalizeThreadRequest` (script-API convenience), since thread file tracking now only accepts absolute paths.
- spawn_subagents `contextFiles` are not resolved; relative entries are skipped by `FileSupervisor.addFiles`. Its schema/description updates belong to the later stages.
- `render-tools/spawn-subagents.test.ts` "handles thread hierarchy with stopped and yielded children" and `tools/spawn-subagents.test.ts` "respects maxConcurrentSubagents limit" also fail on `main` (pre-existing). Several nvim tests time out under full-suite load but pass when run on their own.
- Review follow-ups: `runScript`'s `pathContext` is required, and `EdlResultData.mutations[].path` is `AbsFilePath` (taken from the up-front resolution map), so the edl tool doesn't cast. get_file's `PerFileResult.filePath` is `AbsFilePath | UnresolvedFilePath`, so relative-path errors report the raw input without a cast. `normalizeThreadRequest` is exported for unit tests (`scripts/script-manager.test.ts`). Added tests: `utils/files.test.ts` (`~`, normalization), hover relative path → tool error, `@file:` relative → error with no context added (registry.test.ts).

- Goal: `resolveAbsPath` replaces `resolveFilePath`; tools, EDL, file supervisor, submission commands stop using cwd; display is absolute.
- Tests:
  - get_file/edl with relative path returns an error mentioning absolute paths; `~/x` works.
  - File supervisor context updates render absolute paths (harness, assert on delivered context).
  - EDL `file \`rel\`` errors.

## Shell at root

Status: done.

- [x] `SandboxShell` spawns bash with `cwd: "/"`; `DockerShell` runs `docker exec -w /`. `DockerShell` context has no cwd.
- [x] Tests: `sandbox-shell.node.test.ts` "runs commands at the filesystem root" (`pwd` → `/`); docker shell test asserts `pwd` → `/`; sandbox-shell unit tests assert spawn `cwd: "/"`.

Decisions/deviations:

- `SandboxShell`'s context field `cwd` is renamed `projectDir` and is only used to resolve relative sandbox config paths in `sandbox.updateConfigIfChanged` (same resolution as before). It becomes the `ProjectDir` type in the rename stage.
- Review follow-up: the `ProjectDir` brand (`toProjectDir`) is introduced now in `utils/files.ts`. `SandboxShell`'s `projectDir`, `Sandbox.updateConfigIfChanged` and `resolveConfigPaths` take `ProjectDir`; `environment.ts` and `startSandbox` convert from `Cwd` with `toProjectDir` until the rename stage removes `Cwd`.
- `createDockerEnvironment` still takes/returns `cwd` (environment-level, used for git/docker workspace); handled in the rename stage.

- Goal: sandbox/docker shell spawn at `/`; drop cwd from Shell contexts.
- Tests:
  - Tier B: `pwd` in bash_command returns `/`.
  - Sandbox still allows writes to project dir and denies outside (existing sandbox tests).

## System info and tool descriptions

Status: done.

- [x] `formatSystemInfo` replaces "Current working directory" with "The user started this thread from: <dir>" plus the no-working-directory / absolute-paths instruction. The system prompt is unchanged.
- [x] get_file, hover, find_references `filePath` descriptions say absolute (or `~/`), relative rejected; `edl-description.md` says paths must be absolute and its examples use `/project/src/...`.
- [x] Tests: `context/system-info.test.ts` (start dir + instruction; tool spec descriptions), `thread.test.ts` system-info preamble asserts the first message carries the instruction.

Decisions/deviations:

- `SystemInfo.cwd` field is not renamed yet (rename stage).

- Goal: `<system-info>` states the directory the user started the thread from plus the absolute-path instruction; the system prompt is unchanged; tool schemas say "absolute path".
- Tests: `formatSystemInfo` output contains the start directory and the instruction, and the first user message of a harness thread includes it; tool spec descriptions contain the requirement.

## Git context follows read files

Status: done.

- [x] `GitClient` is directory-less: `findRepoRoot(path)` (tries the path, then its parent, via `git -C`; found roots cached) and `getState(repoRoot)`. `readGitStateAt(client, path)` helper for preparation. `LocalGitClient()`/`DockerGitClient(container)` take no cwd.
- [x] `GitTracker` keeps per-repo histories (`Map<root, GitViewEntry[]>`); `registerPath` adds unseen roots to a pending set; `getUpdate` awaits in-flight registrations, reports new repos in full (`previous: undefined`), coarse changes per repo, and vanished repos (`current: undefined`). `GitContextUpdate` is now `{ repos: GitRepoUpdate[] }`; `gitUpdateToText` emits one section per repo; the nvim `renderGitUpdate` shows one line per repo.
- [x] `FileSupervisorDeps.registerGitPath` (called for newly tracked and seeded files); ThreadCore wires it to its `GitSupervisor.registerPath` in create and clone.
- [x] Tests: `supervisors/git-supervisor.test.ts` "GitTracker multi-repo" (new repo reported once, non-repo paths ignored, fork before the registering delivery drops the repo, vanished repo); `context/git-context.test.ts` (get_files in a second repo announces it, a later HEAD change there is reported and an untouched repo isn't; outside any repo there's no git update); `git-clients.test.ts` uses `findRepoRoot`/`readGitStateAt`.

Decisions/deviations:

- The host doesn't call `registerPath` for the start directory; it still seeds `initialGitState` (read via `readGitStateAt(client, cwd)`), which registers that repo at `PRE_HISTORY` and feeds system info. Same effect, no extra delivery.
- A repo's "registration point" for forks is the first delivery that showed it; registrations not yet delivered at fork time are dropped (consistent with file history truncation).
- `FakeGitClient` holds multiple repos (`set` replaces by `repoRoot`, `remove(root)`); harness `git` option accepts `GitState | GitState[]`.
- `container/container.test.ts` hangs (docker) on this machine; nvim suite timeouts under heavy load pass individually, except the pre-existing `render-tools/spawn-subagents.test.ts` failure.
- Review follow-ups: `GitRepoUpdate` is a union (`registered` / `changed` / `gone`) that `gitUpdateToText` and the nvim `renderGitUpdate` switch on; `readAll` returns `{kind: "new" | "tracked"}`. `GitState.repoRoot`, tracker maps/sets, `FakeGitClient` and the root cache are keyed on `AbsFilePath`; git output goes through `parseRepoRoot` (rejects non-absolute). Added tests: re-registering a tracked repo, an unawaited registration showing up in the next update, a failed lookup not blocking updates, `findRepoRoot` before/after `git init`, autoContext files in another repo reported in the first request, and a fork registering into its own tracker (source unaffected).

- Goal: `GitClient` takes the directory per call; `GitSupervisor.registerPath` adds repos to a tracked set; updates cover all tracked repos; FileSupervisor and the host call `registerPath`.
- Tests:
  - Harness with `FakeGitClient` holding two repos: starting in repo A, then reading a file in repo B, the next context delivery announces repo B; a later HEAD change in B is reported, and a change in a repo never touched is not.
  - Starting outside any repo with no reads: no git context at all.
  - Fork before the read of B: the fork's git view doesn't include B.

## Rename and confine Cwd → ProjectDir

- Goal: `ProjectDir` only in session/host/environment/config/skills/agents/auto-context/sandbox-manager/scripts/protocol; removed from `ThreadCoreContext` and tool contexts; spawn_subagents and scripts require absolute dirs; archive reads legacy `cwd`.
- Tests:
  - Boundary test described in Invariants.
  - spawn_subagents with relative `directory` errors; absolute one loads that dir's options/skills.
  - Loading an archive with `cwd` metadata populates `projectDir`.

## Client

- Goal: nvimclient passes `projectDir` from nvim cwd at thread creation; `@diff:` absolutized client-side; views show `projectDir`.
- Tests: tier A node test that a submitted `@diff:rel` arrives absolute; existing nvim sidebar tests pass.
