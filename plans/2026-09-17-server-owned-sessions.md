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

> Status: stage 1 complete (see progress notes under the stage).
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

## 3. Make Chat a presentation adapter

- Goal: Chat's wrapper map is a view cache over Session, not an authoritative registry. Initialize it from existing records and subscribe to changes/removals.
- Retain selection, expansion, viewed timestamps, error/input presentation, archive navigation, fork markers, and buffer cleanup locally. Server record state and parent relationships are not separately mutable in Chat.
- Forward callback metadata needed by existing views without moving expansion state to Session. Preserve source-thread fork markers and copied display context metadata.
- Tests:
  - Existing chat, buffer-manager, archive-view, fork-keybinding, and attention tests retain navigation, ordering, deletion, and buffer semantics.
  - Rebuilding the view adapter over an existing Session creates no duplicate Thread or title request.
  - Execution and lifecycle outcomes progress with no Chat event listener; reattaching a view reflects current state.

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
