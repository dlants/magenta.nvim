# Objective and Context

User request (verbatim, answering "If git-repo is meant to replace `GitSupervisor`, ... do you want me to plan that?"):

> yes, that's the intent

Today two systems track git repos per thread:

- `GitSupervisor`/`GitTracker` (`node/server/src/supervisors/git-supervisor.ts`): seeded with the project dir's repo (`initialGitState`), registers the repo of every file `FileSupervisor` starts tracking (`registerGitPath`), polls `GitClient.getState` before each request and injects `# Git status update` on branch/HEAD changes. Its deliveries are recorded as `ContextDelivery.git` and it exposes `trackedGitRepos`.
- The git-repo watcher (`WatchSupervisor` + `MentionScanner`, `plans/2026-11-04-watcher-scan.md`): tracks repos mentioned anywhere in thread text, delivers via `context_update`, shown under `# watched:`.

The goal is to make the watcher the only git tracking: delete `GitSupervisor`, its delivery/view/protocol surface, and the `GitClient` capability that only it and the initial git read use.

Relevant files:

- `node/server/src/supervisors/git-supervisor.ts` (+ `.test.ts`): supervisor and tracker, deleted.
- `node/server/src/context/git-context.test.ts`: integration tests of git updates, deleted.
- `node/server/src/capabilities/git-client.ts`, `git-clients.ts` (+ `.test.ts`): `GitClient`, `GitState`, `LocalGitClient`, `readGitStateAt`, `formatGitInfo`, `formatGitHead`, `parseGitState`.
- `node/server/src/thread-core.ts`: creates/clones `GitSupervisor`, wires `registerGitPath`, `ContextDelivery.git`, `trackedGitRepos`, `ThreadCoreSeed.initialGitState`, `ThreadCoreContext.gitClient`.
- `node/server/src/thread.ts`: `contextSupervisors` ordering, `trackedGitRepos`, `initialGitState` in context and fresh-core seed.
- `node/server/src/thread-supervisor.ts`: `SystemInfoSupervisor` awaits the git promise for the system-info line.
- `node/server/src/providers/system-prompt.ts`: `SystemInfo.git`, `formatSystemInfo` git line.
- `node/server/src/supervisors/file-supervisor.ts`: optional `registerGitPath` dep.
- `node/server/src/server-session-host.ts`: reads `initialGitState`, passes `gitClient`.
- `node/server/src/environment.ts`: `gitClient: new LocalGitClient()`.
- `node/server/src/protocol/state.ts`: `trackedGitRepos` in thread state.
- `node/server/src/index.ts`: git exports.
- `node/server/src/test/{fakes,harness}.ts`, `test-helpers.ts`: `FakeGitClient`, `git` harness option, stub git client.
- `node/nvimclient/chat/thread-view.ts`: `# git repos:` section, `renderGitUpdate` call.
- `node/nvimclient/context/context-manager.ts`: `renderGitUpdate`.
- `node/nvimclient/chat/thread.ts`: imports `GitState`.
- `context.md`: mentions git in core/host descriptions.

# Design

What the agent loses and how the watcher covers it:

- Repo of the project dir. Covered by a seed scan: a fresh, non-compact core with a `WatchSupervisor` scans `[projectDir]` once at creation. The git-repo watcher resolves it to the worktree root (if it is under its configured roots). Forks/rewinds clone the supervisor and don't rescan; compaction replacement seeds from `watched` like today.
- Repos of files the agent reads/edits. Covered by the mention scan: file paths appear in `tool_use` inputs and results.
- The system-info git line (branch/HEAD/counts at thread start). Dropped: the watcher's first `context_update` carries the same state. The system-info `projectDir` line stays.
- Without a configured git-repo watcher, there is no git tracking at all. Accepted: git awareness becomes opt-in configuration.

Removal is mechanical: every consumer of `GitSupervisor`, `ContextDelivery.git`, `trackedGitRepos`, `initialGitState`, `SystemInfo.git` and `GitClient` is deleted, not stubbed. `FileSupervisor` loses `registerGitPath`. Existing tests that exercise git through the harness (`git` option, `FakeGitClient`) either move to the fake watcher transport or are deleted when they only tested git delivery.

## Interfaces

```ts
// thread-core.ts
export type ContextDelivery = { files?: FileUpdates; watched?: WatchContextUpdate };
export type ThreadCoreSeed = { initialFiles?: Files; watched?: ReadonlyArray<WatchSeed> };
// ThreadCoreContext: gitClient removed. Seed scan text comes from systemInfo.projectDir.

// providers/system-prompt.ts
interface SystemInfo { /* git removed */ }

// thread-supervisor.ts
SystemInfoSupervisor.create(args: { systemInfo: SystemInfo; alreadyInjected: boolean })

// protocol/state.ts: thread state drops trackedGitRepos.
// environment.ts: Environment drops gitClient.
```

## Invariants

- The project-dir seed scan runs once per fresh non-compact core, off the request path, and failures only log (same as other scans).
- A key the user untracked is not re-tracked by the seed scan of a later core (compaction seeds from `watched`, not by rescanning).
- No `# Git status update` injection and no git line in system info remain; only watcher `context_update`s describe repo state.
- The protocol thread state no longer has `trackedGitRepos`; the client renders only `# watched:`.

# Stages

## Seed scan of project dir

- Goal: a fresh core scans its project dir with the watchers, so the start repo shows under `# watched:` without being mentioned. GitSupervisor still exists.
- Tests (tier A, harness + `FakeWatcherTransport`):
  - creating a thread with a fake git-repo scanner sends `[projectDir]` to `scan` before any user message and tracks the returned key.
  - forking and rewinding don't scan the project dir again; compaction's replacement core keeps the user's untrack (the key isn't re-tracked).
  - compact threads don't scan.
- Status: done. `ThreadCoreSeed.watch` is a union: `{ type: "inherit", watched }` (replacement core) or `{ type: "scan", texts }` (scanned once at creation); `Thread.createFreshCore` passes `scan` of `[systemInfo.projectDir]` only when there is no inherited `watched` (thread-core.ts must not reference project dirs, per `project-dir-boundary.test.ts`). Compact threads have no `WatchSupervisor`, so they never scan. Tests in `supervisors/watch-supervisor.test.ts`. Review follow-up: `WATCHER_ICONS` is keyed by a `BuiltinWatcher` literal union; the render test asserts a full line (fallback icon + loading icon). The git-repo 'other worktrees' guard was skipped (that test file has no render helper; removal is intentional). Note: a fork only keeps a resource that has history/baseline, so the fork test pushes state for the repo.

## Remove GitSupervisor

- Goal: `GitSupervisor`/`GitTracker`, `ContextDelivery.git`, `trackedGitRepos` (core, thread, protocol), `registerGitPath`, `renderGitUpdate` and the `# git repos:` view are gone. `git-supervisor.test.ts` and `git-context.test.ts` deleted.
- Tests:
  - reading a file in a repo produces no `# Git status update` in the request (tier A).
  - sidebar render of a thread with watched repos shows `# watched:` and no `# git repos:` (update affected snapshots in `node/nvimclient/chat/thread.test.ts`).
  - `npx tsc -b`, `npx biome check .`, full `npx vitest run`.
- Status: done. The no-injection test lives in `thread-core-context.test.ts` (replaced the git rewind test; git-branch assertions dropped from the reset/compaction/budget tests). Sidebar snapshots in `thread.test.ts.snap` updated. `initialGitState`/`gitClient` remain in core context/seed for the system-info line until stage 3. `spawn-subagents.test.ts` "toggles yielded text" now waits for "All done." before pressing `=` (it raced the final render once the git section's re-render was gone).

## Remove GitClient and system-info git

- Goal: `initialGitState`, `SystemInfo.git`, the system-info git line, `GitClient`/`LocalGitClient`/`readGitStateAt`/`formatGitInfo`/`formatGitHead`/`parseGitState` and their exports, `Environment.gitClient`, `FakeGitClient` and the harness `git` option are removed. `context.md` updated.
- Tests:
  - system info text contains the project dir and no git line (update the existing system-info assertions).
  - `git-clients.test.ts` deleted with the client. Grep shows no remaining `GitClient`/`GitState` references outside the reference watchers.
  - `npx tsc -b`, full `npx vitest run`.
