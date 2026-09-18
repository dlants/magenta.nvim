# Objective and Context

> let's make a plan for part 1 - server-owned sessions

Part 1 of `plans/2026-09-16-client-server-protocol.md`: introduce one implicit server-owned session, moving thread hierarchy/lifecycle, construction policy, title generation, and script orchestration out of the Neovim controllers. Preserve existing behavior while making Chat a client of Session.

## Current ownership and relevant files

- `node/nvimclient/chat/chat.ts`: authoritative pending/initialized/error registry, parent relationships, result defers, fresh/subagent/script creation, subtree abort/deletion, fork orchestration, and mixed-in UI state.
- `node/nvimclient/chat/thread.ts`: `NvimThread` presentation, submission observation, title requests, and mixed fresh/fork construction. `createNvimThread` builds supervisors, compactor, tools, and Thread. Wrapper destruction currently destroys Thread too.
- `node/server/src/thread.ts`: stable Thread identity, title/archive, mailbox, submission lifecycle, and private replaceable ThreadCore. Session must not duplicate these responsibilities.
- `node/server/src/capabilities/thread-manager.ts`: existing `spawnThread`, `deleteThread`, and `awaitThreadResult` capability used by tools and compaction.
- `node/server/src/compaction/compactor.ts`: compaction orchestration through ThreadManager; retain this relationship with Session as the implementation.
- `node/server/src/tools/thread-title.ts`: existing provider-neutral title generation helper; scheduling and late-result guards currently live in NvimThread.
- `node/nvimclient/scripts/script-manager.ts`: catalog discovery, child-process IPC, invocation state/lifecycle, title requests, plus rendering and editor actions.
- `node/server/src/capabilities/script-runner.ts`: discover/catalog/run capability; scripts already outlive the triggering thread.
- `sdk/protocol.ts`: self-contained script IPC types. Preserve this protocol and process isolation.
- `node/nvimclient/environment.ts`: editor-dependent environment preparation; remains an injected adapter in this part.
- `node/nvimclient/magenta.ts`: composition root, dispatch, Chat/ScriptManager wiring, and shutdown.
- `node/server/src/emitter.ts`: existing typed event subscription pattern.

# Design

Introduce `Session` in the server package. It owns the authoritative thread registry, parent/script associations, pending creation, lifecycle result tracking, construction policies, title scheduling, and a server ScriptManager. Use one instance per Magenta initially; no session picker or global session registry yet.

Chat retains selection, navigation, expansion, viewed timestamps, archive screens, buffers, and NvimThread view adapters. The root ScriptManager becomes a script controller/view around the server manager. Read access to live server handles is allowed during this migration; serializable snapshots are part 3, not part 1.

## Boundary and scope

- Session creates Thread and compactor instances and chooses fresh/fork policy composition. Root code may prepare environment/provider/prompt/resolver dependencies, but must not return an NvimThread or construct the server Thread on Session's behalf.
- Inject server-typed capabilities for editor-dependent setup, command resolution, hierarchy-context discovery, and approval handling. These adapters must not require a Chat/NvimThread registry to execute. Preparation receives Session's thread-manager capability, not Chat.
- Preserve cwd, sandbox, provider configuration, discovery, and shell semantics. Agent-owned mutable cwd, standalone execution, and replacement of editor-backed capabilities belong to part 2.
- Do not implement WebSockets, wire actions, snapshots, persistence, authentication, multi-client arbitration, or multiple-session UI.
- Retain child-process script execution. Do not replace SDK IPC with in-process script execution or add dependencies.

## Interfaces

These are proposed in-process interfaces, not a wire schema. Reuse existing server types and derive capability signatures rather than creating parallel definitions.

```ts
type SessionId = string & { __sessionId: true };
type SpawnThreadOptions = Parameters<ThreadManager["spawnThread"]>[0];

type ThreadPolicy = {
  docker?: DockerSpawnConfig;
  autoCompactThreshold?: number;
  autoCompactPrompt?: string;
};

type CreateThreadOptions = {
  id: ThreadId;
  threadType: ThreadType;
  profile: ProviderProfile;
  parentThreadId?: ThreadId;
  scriptInvocationId?: ScriptInvocationId;
  scriptName?: string;
  environmentConfig?: EnvironmentConfig;
  contextFiles?: UnresolvedFilePath[];
  initialInput?: SubmissionInput;
  subagentConfig?: SubagentConfig;
  yieldSchema?: JSONSchemaType;
  fileIO?: FileIO;
  label?: string;
  policy?: ThreadPolicy;
};

type ForkThreadOptions = {
  id: ThreadId;
  sourceThreadId: ThreadId;
  nativeMessageIdx: NativeMessageIdx;
};

type SessionThread = {
  id: ThreadId;
  parentThreadId: ThreadId | undefined;
  scriptInvocationId: ScriptInvocationId | undefined;
  lastActivityTime: number;
} & (
  | { state: "pending" }
  | { state: "initialized"; thread: Thread; compactor: ThreadCompactor | undefined }
  | { state: "error"; error: Error }
);

interface SessionOperations extends ThreadManager {
  readonly id: SessionId;
  getThread(id: ThreadId): SessionThread | undefined;
  listThreads(): readonly SessionThread[];
  createThread(options: CreateThreadOptions): Promise<ThreadId>;
  forkThread(options: ForkThreadOptions): Promise<ThreadId>;
  abortThread(id: ThreadId): ReturnType<Thread["abort"]>;
  dispose(): Promise<void>;
}
```

Returned records are read-only views of Session-owned state, not externally mutable registry entries. Keep private preparation data with each initialized record so child profile/environment selection no longer reads NvimThread.context. Keep `ThreadManager` unchanged, including synchronous `deleteThread`; detach records synchronously and track asynchronous cleanup for `dispose()`.

The preparation seam returns existing execution dependencies, not a second generic dependency-injection framework:

```ts
type PreparedThreadContext = Omit<
  ThreadCloneContext,
  "chatSupervisors" | "compactor"
>;

type ThreadPreparation =
  | { type: "fresh"; options: CreateThreadOptions }
  | { type: "fork"; options: ForkThreadOptions; source: Thread };

interface SessionHost {
  prepareThread(
    request: ThreadPreparation,
    threads: ThreadManager,
    signal: AbortSignal,
  ): Promise<{
    context: PreparedThreadContext;
    policy: ThreadPolicy;
    release: () => Promise<void>;
  }>;
}
```

Session attaches `threadType` only for fresh construction and uses `Thread.clone` with a clone context for forks. The host must bind both the context and tool creator to the supplied ThreadManager and the session-owned ScriptRunner. The resolver looks up current `thread.contextFiles` at delivery time; it must not capture a retired core. Session owns preparation release on failed/stale creation and deletion; release only per-thread acquired resources, never shared services.

Use existing `Emitter` with a `threadChanged: [id: ThreadId]` invalidation event and `threadRemoved: [id: ThreadId]`. Forward file/git/submission callbacks with the thread ID using their existing `ThreadCallbacks` parameter types where the client still needs them. Session handles title generation before notifying observers. Docker teardown progress is session-owned and triggers invalidation. Notifications must not be necessary for execution: starting initial input and settling results never depends on RootMsg dispatch or an attached view.

For scripts, move `ScriptInvocationId`, status/entry types, and authoritative invocation data to the server. Public invocation data omits `ChildProcess` and pending IPC maps; those are private execution state. The server ScriptManager implements existing `ScriptRunner` and additionally exposes the existing control shapes as public methods:

```ts
startScript(
  scriptName: string,
  parameters: unknown,
  opts: { sandboxBypassed: boolean },
): ScriptInvocationId;
abortInvocation(id: ScriptInvocationId): void;
deleteInvocation(id: ScriptInvocationId): void;
dispose(): Promise<void>;
```

Its existing `runScript` capability delegates to `startScript` after reading the triggering thread's bypass policy through an injected capability. Script thread creation goes directly through Session with invocation metadata and yield schema; do not introduce a second script-specific thread registry. Retain existing discovery/catalog methods and add typed change/removal notifications using the same emitter pattern.

Move the self-contained IPC declarations into the server package and make `sdk/protocol.ts` a type-only compatibility re-export, preserving SDK import paths. This avoids importing root-project source into the server's `rootDir: src` project. Verify SDK type checking and script launch/bundling after the move. Move generic process-termination helpers server-side as needed; Node child processes are server concerns, not editor capabilities.

## Lifecycle and ownership invariants

- A thread belongs to exactly one Session. Parent IDs and script associations are validated within that Session. No global mutable registry.
- Reserve the ID and pending record before asynchronous preparation. Failed preparation produces an error record and settles waiting lifecycle consumers with an aborted reason; the creation promise rejects.
- Deletion invalidates pending construction before cleanup. A late environment/provider preparation result must be released, not registered or submitted. Parent or invocation deletion also invalidates in-flight children.
- Subscribe to Thread.result once. Preserve one-shot accepted yield versus abort semantics and keep them separate from submit/retry outcomes. Retain results for known deleted IDs until Session disposal; unknown IDs fail rather than creating promises that never settle.
- Preserve subtree abort behavior. Only the explicitly requested thread's unsent input is returned for client input restoration; descendant input is not appended to the active editor.
- Server-owned initial input starts after registration without UI dispatch. Labels are set before automatic title scheduling. Late title results cannot resurrect deleted records or overwrite an already-set title.
- Session manages stable Threads, never ThreadCore identity or compaction replacement. Forks use destination collaborators and preserve existing policy/context history behavior and current local-source limitation.
- Wrapper disposal removes timers/listeners only. Explicit Session deletion destroys execution. Owner shutdown calls Session.dispose; client view disposal does not.
- Script runs outlive their triggering thread. Invocation abort/delete prevents late IPC creation completions from registering orphan threads or sending results to a terminated process.
- Session disposal is idempotent, rejects new work, invalidates pending creation, terminates scripts, destroys threads, and awaits tracked cleanup. It does not dispose externally owned shared services.

# Stages

> Status: stages 1-2 complete (see progress notes under each stage).
> A previous unscoped attempt at this plan was left uncommitted in the working
> tree; it is preserved in `git stash` as "wip broad session attempt
> (pre stage-1)" and stage 1 was implemented fresh from `main`.

## 1. Separate construction from presentation

- Goal: extract server-side fresh/fork assembly and title scheduling from `createNvimThread`; NvimThread wraps ready Thread/compactor handles.
- Keep preparation in a root adapter with server-typed inputs/outputs. Move supervisor selection/default policy handling into server assembly. Preserve delivery-time resolver and fork-local approval routing.
- Separate wrapper disposal from Thread destruction; retain explicit owner deletion at current call sites until Session takes over.
- Tests:
  - Existing supervisor-wiring, fork-thread, and thread-compact integration tests preserve policy ordering, context isolation, and compaction continuation.
  - Labels and late title responses do not get overwritten or applied after deletion; title generation requires no view wrapper.
  - Disposing a view cancels rendering timers without aborting a controlled provider request.

- Progress:
  - [x] `assembleThread` (`node/server/src/thread-assembly.ts`) owns compactor creation, chat-supervisor ordering and automatic title generation; it takes `PreparedThreadContext` (`Omit<ThreadCloneContext, "chatSupervisors" | "compactor">`), a `ThreadInitialization` (fresh/fork) and a `ThreadPolicy`, and returns ready `{ thread, compactor }` handles.
  - [x] `createNvimThread` is now a thin root adapter: `prepareThreadContext` builds editor-backed collaborators in server-typed shape (including the delivery-time resolver, which looks up `thread.contextFiles` lazily), then hands them to `assembleThread` and wraps the handles.
  - [x] Title scheduling moved into assembly and no longer needs a view: it wraps `onSubmission`, requests once, and drops late results when a title/label already exists or the thread was destroyed. `NvimThread.onSubmission` is gone.
  - [x] `NvimThread.dispose()` clears render/animation timers only; `destroy()` is dispose plus `thread.destroy()`. Chat's existing deletion path still calls `destroy()`, so thread ownership stays where it is until stage 2.
  - [x] Tests: `node/server/src/thread-assembly.test.ts` (title once / label preserved / late title after destroy dropped / supervisor ordering for root, subagent, compact, supervised docker) and a root test that disposing a view neither destroys the thread nor aborts its in-flight request. Existing supervisor-wiring, fork-thread and compaction tests pass unchanged.
- Review follow-ups (stage 1 code review):
  - [x] `ThreadPolicy` became `ChatThreadPolicy` and moved *inside* `ThreadInitialization`'s fresh non-compact variant. A compaction thread cannot carry compaction knobs, `autoCompactPrompt` is required (the `?? ""` fallback is gone), and `onProgress` now lives inside `docker` so it cannot be set without a docker config.
  - [x] A fork carries no policy at all: it inherits conversation kind and `AutoCompactSupervisor` settings from its source (forking a compact thread stays supported and yields a compact thread with no compactor).
  - [x] `AssembledThread` is a discriminated result (`{ threadType: "compact"; thread; compactor?: undefined } | { threadType: ChatThreadType; thread; compactor }`). The compact variant keeps `compactor` present-but-undefined so existing callers can still destructure both variants.
  - [x] The identical-branch `ThreadContext` ternary is gone: each branch builds its own correctly-shaped context (compact without a compactor, chat with one).
  - [x] `let thread!: Thread` is gone. `createTitleScheduler` returns `{ attach, onSubmission }` and is attached immediately after construction, which invokes no callbacks.
  - [x] The fork auto-compact lookup moved to `AutoCompactSupervisor.find` and no longer optional-chains `chatSupervisors` (the getter is non-optional). A `kind` discriminant would not have removed the runtime check: `ThreadSupervisor` is an interface, not a closed union, so `s.kind === "auto-compact"` cannot narrow a `ThreadSupervisor[]` to the class.
  - [x] New assembly tests: fork inherits kind + cloned threshold/prompt + title wiring; host compaction knobs reach the supervisor; `docker_root` added to the supervisor-ordering cases.
  - [ ] Deliberately kept: `NvimThread.dispose()` has no production caller until stage 2 takes over thread ownership; the split (and its test) pins the wrapper/Thread lifetime separation that stage 2 depends on, so it stays.
- Decisions/deviations:
  - `DockerSupervisor` moved from `node/nvimclient/chat/thread-supervisor.ts` to `node/server/src/docker-supervisor.ts` (with its tests) so supervisor selection could move server-side; it had no editor dependencies.
  - Option-derived defaults (`autoCompactThreshold`, `autoCompactPrompt`) are resolved by the root adapter and passed through `ThreadPolicy`; assembly never reads editor options.
  - `Thread` gained a public `isDestroyed` getter so assembly-owned callbacks can guard late work without inspecting private state.

## 2. Make Session the thread owner

- Goal: introduce Session registry, preparation cancellation, result tracking, hierarchy operations, and teardown. Route subagent tools and compact children to Session's ThreadManager.
- Move child profile/environment derivation, root/agent creation, fork registration, and bootstrap submission out of Chat. Existing Chat methods may temporarily delegate for compatibility, but cannot own lifecycle state.
- Move approval ancestry/bypass lookups to session metadata plus injected approval capabilities; the concrete editor-backed approval implementation stays in the root.
- Tests:
  - Server tests with real Threads/mock providers create roots, children, forks, and compact children without Chat or RootMsg dispatch.
  - Defer-controlled deletion during preparation and parent deletion during child creation release resources without late registration/submission.
  - Result waiting works before initialization, after yield, after failure/deletion, and through compaction; unknown IDs fail explicitly.
  - Subtree abort/delete leaves unrelated roots untouched. Two Session instances reject each other's IDs and share no registry state.

- Progress:
  - [x] `Session` (`node/server/src/session.ts`) is the authoritative registry: `SessionThread` records (identity, parent, script invocation, last activity, and the resolved `SessionCreateOptions`), pending-creation `AbortController`s, per-thread `release` handles, retained result defers, docker teardown messages, and a tracked cleanup set drained by `dispose()`. It implements `ThreadManager`, so subagent tools and compact children route through it.
  - [x] Construction goes through stage 1's `assembleThread`: Session builds the `ThreadInitialization` (fresh policy vs. fork) and forwards thread-id-tagged callbacks; supervisors, compactor and title generation stay in assembly rather than being duplicated.
  - [x] `SessionHost.prepareThread(request, session, signal)` is the only editor seam. `NvimSessionHost` (`node/nvimclient/chat/session-host.ts`) owns auto-context/environment/system-info/system-prompt preparation, the per-thread `PreparedNvimContext` map the view wraps, the delivery-time resolver, `discoverHierarchy`, and approval capabilities (`rejectApprovals`, `isSandboxBypassed`, `toggleSandboxBypass`, `setSandboxBypassed`, `approveAllPendingInSubtree`). Bypass ancestry is resolved from session metadata (`getRootAncestorId`) plus a registered script-invocation sandbox root.
  - [x] Session owns root/agent creation (`createRootThread`, `createAgentThread` via `host.getAgents`), child profile/environment derivation (`spawnThread` reads the parent record), script-thread creation, script titles, fork registration (`forkThread`), bootstrap submission (`inputMessages` submitted directly, no dispatch), labels before title scheduling, subtree abort, deletion and disposal.
  - [x] `Chat` is now a view adapter: it constructs the host + Session, mirrors records into `threadWrappers` on `changed`/`removed`, forwards `filesSent`/`gitSent` into message view state, and delegates every lifecycle method (`createNewThread`, `createNewAgentThread`, `handleForkThread`, `spawnThread`, `spawnScriptThread`, `deleteThread`, `abortThread`, `awaitThreadResult`, `generateScriptTitle`, bypass/approval queries). Its own state is selection, expansion, viewed timestamps, archive navigation and buffers.
  - [x] `createNvimThread`/`cloneFromNativeMessageIdx` are gone from `node/nvimclient/chat/thread.ts`; `NvimThread` wraps ready handles, reads bypass through the session, and `abortAndWait` goes through `chat.abortThread` (subtree abort with only the requested thread's unsent input returned).
  - [x] Tests: `node/server/src/session.test.ts` (15 cases) covers construction/fork policy with no view, child profile/environment derivation, preparation failure + unknown-id rejection, Defer-gated deletion/abort during preparation with exactly-once release, parent deletion invalidating an in-flight child while other roots survive, compact children/forks, bootstrap input settling a yield with retained post-deletion results, approval rejection plus release when destruction throws, docker-source fork rejection, index-frozen forks, and two independent sessions. Root integration tests (supervisor wiring, fork thread/keybinding, compaction, scripts, buffer manager, archive) pass unchanged except where they constructed threads directly.

- Review follow-ups (stage 2 code review):
  - [x] `ThreadPreparation` is a discriminated union (`{ options } & ({ type: "fresh" } | { type: "fork"; source; nativeMessageIdx })`), so "fork source without index" is unrepresentable and the runtime throw in `initialization()` is gone. `NvimSessionHost.prepareThread` narrows on `request.type`.
  - [x] `ScriptInvocationId` moved into the server package (`chat-types.ts`, re-exported from the barrel and from `scripts/script-manager.ts`), so `Session`/`SessionThread` carry the branded id and chat.ts no longer casts.
  - [x] `ThreadManager["spawnThread"]` and `Session.spawnScriptThread` take `NvimCwd`/`UnresolvedFilePath[]`; the casts now live at the untyped caller boundary (`Chat.spawnScriptThread`, `spawn-subagents` resolving a directory).
  - [x] `create()`'s failure path skips `thread.destroy()` when the thread is already destroyed, so a record deleted after assembly destroys exactly once.
  - [x] New session tests: subtree abort (parent/child/grandchild — descendants aborted, only the requested thread's unsent returned, `{ unsent: [] }` for an unknown target), deletion after assembly (destroy and release each run once), and the duplicate-id guard.
  - [ ] Deliberately deferred: splitting `SessionCreateOptions` into a discriminated union on origin. The script-only fields (`yieldSchema`, `scriptInvocationId`, `scriptName`) move server-side with the script manager in stage 4; the union is worth drawing once that ownership settles rather than twice.
- Decisions/deviations:
  - The record retains its `SessionCreateOptions` (with the host-resolved `environmentConfig` substituted after preparation). Child derivation and fork policy read that, never a view wrapper.
  - Forks capture the `nativeMessageIdx` at request time rather than snapshotting history: `Thread.clone` truncates to that index, so a source that advances during preparation cannot widen the fork. A source whose core is *replaced* (compaction) mid-preparation is not supported; the stashed pre-stage-1 attempt used a `captureFork` closure for that, which stage 1's assembly API does not expose.
  - `abortThread` issues every `thread.abort()` before its first await, so a caller that dispatched an abort can observe it having landed synchronously (an existing subagent test depends on this).
  - `PreparedThread.archiveBaseDir` lets the host say where archives go; tests point it at the scratch archive dir instead of the user's.
  - Chat's `Msg` no longer has `thread-initialized`/`thread-error`: records are mirrored from session events instead of dispatched.
  - Owner shutdown still does not call `Session.dispose()`; per the plan that consolidation belongs to stage 5.
  - `node/nvimclient/chat/supervisor-wiring.test.ts` white-box cases that called `createNvimThread` now create threads through `session.createThread`/`forkThread`. One `spawn_subagents` expansion test was made deterministic (it pressed `=` while the row could still be the in-flight progress row).

## 3. Make Chat a presentation adapter

- Goal: Chat's wrapper map is a view cache over Session, not an authoritative registry. Initialize it from existing records and subscribe to changes/removals.
- Retain selection, expansion, viewed timestamps, error/input presentation, archive navigation, fork markers, and buffer cleanup locally. Server record state and parent relationships are not separately mutable in Chat.
- Forward callback metadata needed by existing views without moving expansion state to Session. Preserve source-thread fork markers and copied display context metadata.
- Tests:
  - Existing chat, buffer-manager, archive-view, fork-keybinding, and attention tests retain navigation, ordering, deletion, and buffer semantics.
  - Rebuilding the view adapter over an existing Session creates no duplicate Thread or title request.
  - Execution and lifecycle outcomes progress with no Chat event listener; reattaching a view reflects current state.

- Progress:
  - [x] `Chat.threadWrappers` is now a derived getter: it projects `session.listThreads()` (parent, script invocation, activity time, state) plus Chat-local view state (`threadViews` NvimThread cache, `lastViewedTimes`, derived depth). Mutating a returned wrapper changes nothing; internal reads go through a private `wrapper(id)` projection so a single-id read stays O(depth) rather than O(threads).
  - [x] No server state is mirrored or mutated in Chat anymore: `parentThreadId`/`depth` are walked from session records, and the dispatch-driven activity bumps (`send-message` on the root, `turn-ended`, `permission-pending-change`) call the new `Session.recordActivity(id)` instead of writing into the wrapper.
  - [x] `Chat` accepts an optional `{ session, host }` so a view can be attached to an existing Session; the constructor seeds the cache by calling `syncThread` for every existing record and then subscribes to `changed`/`removed`/`filesSent`/`gitSent`. `syncThread` only builds/repaints the NvimThread wrapper and the error-state navigation fallback; `removeThreadView` disposes the wrapper and drops view-local state (expansion, viewed timestamp, buffers).
  - [x] Retained locally: selection/navigation, expansion, viewed timestamps, archive navigation and deletion, error/input presentation, fork markers and copied display context in `handleForkThread`, and buffer cleanup.
  - [x] Tests: `node/nvimclient/chat/chat-view-adapter.test.ts` covers rebuilding a second `Chat` over a live Session (same ids, same server `Thread` instance, title mirrored, no extra thread and no extra `forceToolUse` title request) and a turn completing after `session.removeAllListeners()` (no view observer at all). Existing chat, buffer-manager, archive, fork-keybinding, compaction, script and attention tests pass unchanged.
- Decisions/deviations:
  - `lastActivityTime` stays server-owned; `Session.recordActivity` is the one mutation the view may request. `lastViewedTime` stays client-side (defaulting to the record's activity time until first observed) since it is a per-view notion.
  - `threadWrappers` was kept as a public getter rather than replaced with an accessor method, so the existing tests and `magenta.ts` readers did not have to change; it is now a read-only projection.
  - Chat still constructs its Session/host when none is supplied; consolidating ownership into Magenta is stage 5.

## 4. Move script orchestration into Session

- Goal: Session owns a server ScriptManager, catalog, child-process IPC, logs, titles, lifecycle, and invocation/thread associations. Root script controller retains expansion, rendering, file opening, and notifications only.
- Keep discovery caching, child launch environment, registration timeouts, IPC protocol, two-step run_script behavior, and termination escalation. Extract script title logic from Chat using injected provider/profile dependencies.
- Prevent circular construction with the existing late-bound ScriptRunner capability, wired before any thread is created. Preserve discover-before-thread catalog behavior.
- Tests:
  - Run existing real fixture-script integration tests for logs, structured yield results, multiple threads, done/error, abort/delete, and discovery cache invalidation.
  - A triggering thread can finish or be deleted while its script continues.
  - Abort/delete while script thread preparation is pending cannot leave orphan execution or send to a dead child.
  - Script and thread title completion after invocation deletion cannot recreate UI/state.
  - Preserve sandbox bypass inheritance and approval routing; no root dispatch is required to start/abort script threads.

## 5. Consolidate ownership and validate

- Goal: Magenta constructs one implicit Session and its adapters; owner shutdown disposes it. Remove duplicate registries, construction helpers, root result defers, and temporary forwarding paths no longer needed.
- Update context.md and capability comments to document Session/Thread/view ownership and the remaining host adapters. Do not claim standalone detach/reattach works yet.
- Tests:
  - Session disposal during streaming, compaction, script execution, and pending preparation settles work once and drains cleanup without late UI callbacks.
  - `npx tsc -b` verifies the server cannot import Neovim or root SDK implementation files.
  - Run targeted tests after each stage, then `npx vitest run` and `npx biome check .`.
  - Verify existing SDK scripts still launch through the production bundle path, not only under the test driver.

Completion criterion: Chat and the root script controller can be removed as observers without losing the authoritative thread/script registry or requiring them to drive execution. Editor-dependent services may still be supplied by the in-process host until part 2.
