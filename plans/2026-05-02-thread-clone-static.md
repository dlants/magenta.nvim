# Context

The goal is to introduce a static async method `Thread.cloneFromNativeMessageIdx()` that produces an independent copy of an existing thread, frozen at a given `NativeMessageIdx`. The forked thread continues the same conversation up to that point and can then take a different direction. Today this logic lives in `Chat.handleForkThread()` and is entangled with chat-level bookkeeping; we want a focused factory on `Thread`.

Design intent: the fork is a snapshot of the source thread up to the clone point. We do not re-resolve auto-context, do not regenerate the system prompt, do not abort the source agent, and do not share any mutable state between the source and the fork. The new thread starts as a clean continuation of the snapshot, with no immediate context updates emitted (only post-fork file changes generate updates on the next turn).

## Architectural layering

The clone operation should respect a clean separation of concerns across three layers. Each layer owns its own state, and each layer has its own clone responsibility. The composition flows top-down: the `Thread` layer clones by asking `ThreadCore` to clone, which asks `Agent` to clone.

### Layer 1 — `Agent` (provider-native, cache-friendly)

Closest to the provider's HTTP API. Persists messages in the **provider-native format** (`Anthropic.MessageParam[]` for the Anthropic agent) so we maximize prompt-cache hit rates on subsequent turns. The conversion direction is **one-way**: native → unified `ProviderMessage` (for consumers), never the other direction. Multiple providers can plug in here behind the same `Agent` interface.

State owned by this layer:
- `messages` (native format), `messageStopInfo`, `latestUsage`, `inputTokenCount`, `status`, in-flight streaming block.

Clone primitive: `Agent.clone()` + `Agent.truncateMessages(idx)` — both already exist.

### Layer 2 — `ThreadCore` (magenta integration, conversation state)

Wraps the `Agent` and adds everything needed to actually drive the conversation through magenta's pipeline: the system prompt, tool registry plumbing, reminder counters, compaction state, in-flight tool tracking, and the `ContextManager` that watches files. This is the layer that knows how to "send a message" or "auto-respond after a tool result."

State owned by this layer:
- `agent` (Layer 1).
- `contextManager`.
- `state.systemPrompt`, `state.threadType`, `state.title`.
- `state.mode` (including `mode.activeTools` map for in-flight tools).
- `state.pendingMessages`, `state.edlRegisters`.
- `state.compactionHistory`, `state.compactionController`.
- `state.editedFilesThisTurn`, all reminder/token counters.
- `supervisor`.

Clone primitive (new): `ThreadCore.clone(nativeMessageIdx, options)` — described in the implementation section.

### Layer 3 — `Thread` (chat / neovim integration, render state)

Wraps `ThreadCore` and bridges into the chat system: nvim dispatch, sidebar rendering, view-state for collapsed/expanded sections. **The tool-result rendering map (`toolCache`) belongs here**, because its only purpose is rendering: it is a `ToolRequestId → ProviderToolResult` lookup so the view can find a result for each `tool_use` block in O(1), plus carries `structuredResult` data that the provider strips from native messages but the rich view rendering needs.

State owned by this layer:
- `core` (Layer 2).
- `sandboxBypassed`, `sandboxViolationHandler`.
- `state.showSystemPrompt`, `state.contextFilesExpanded`.
- `state.messageViewState`, `state.toolViewState`, `state.compactionViewState`.
- **(new home)** `state.toolResultMap: Map<ToolRequestId, ProviderToolResult>` — the rendering cache, currently `state.toolCache.results` on `ThreadCore`.

Clone primitive (new): `Thread.cloneFromNativeMessageIdx(args)` — described in the implementation section.

### Toolcache relocation

Today `state.toolCache.results` lives on `ThreadCore` and is consumed by two distinct paths:

1. **Live tool execution (Layer 2 concern):** during `mode === "tool_use"`, `maybeAutoRespond` reads cached results to know which active tools have completed before submitting them back to the agent.
2. **Rendering (Layer 3 concern):** the view looks up `toolCache.results[id]` to render the result for a `tool_use` block.

These should be split:
- The live-execution data moves *onto each `ActiveToolEntry`* as `result?: ProviderToolResult`. `cache-tool-result` becomes a mutation on the active tool entry inside `mode.activeTools`. Auto-respond reads `entry.result` instead of consulting a global cache.
- The rendering map moves to `Thread.state.toolResultMap`. It is rebuilt from the agent's messages (preserving any `structuredResult` from prior cache state) on relevant transitions, and updated when a live tool completes.

This makes Layer 2 self-contained for the auto-respond loop and lets Layer 3 own all rendering-only state.

## Per-layer clone responsibilities

### Layer 1 — `Agent.clone()` + `truncateMessages`
Already exists. Cloning happens **exactly once** in the entire fork pipeline. The clone is owned by Layer 2 (`ThreadCore.clone`) — Layer 3 does not clone the agent itself.

### Layer 2 — `ThreadCore.clone(nativeMessageIdx, options)` (new)
Responsible for everything that is "the conversation up to message N":

- Calls `sourceCore.agent.clone()` and `truncateMessages(nativeMessageIdx)`. Source is not aborted.
- Carries forward `systemPrompt`, `threadType`, `subagentConfig` from source. Does NOT regenerate the system prompt or re-resolve auto-context.
- Constructs a fresh `ContextManager` with `initialFiles` derived from source's tracked files. For each tracked file, the new manager's `agentView` is set to the **current on-disk content** so `getContextUpdate()` produces no diff on the first turn — only post-fork changes will trigger updates.
- Resets transient state: `mode = normal`, empty `pendingMessages`, empty `edlRegisters`, empty `editedFilesThisTurn`, default reminder counters.
- Resets snapshot-irrelevant state: empty `compactionHistory` (out of scope), undefined `title` (re-derived on first user message), undefined `compactionController`, undefined `supervisor`.

Inputs the constructor needs that come from outside Layer 2: `id`, fresh capability bag (fileIO, shell, lspClient, diagnosticsProvider, helpTagsProvider, environmentConfig), `profile`, `mcpToolManager`, `threadManager`, `getAgents`, `getProvider`, `availableCapabilities`, `maxConcurrentSubagents`, `cwd`, `homeDir`, `logger`. These are normal `ThreadCoreContext` fields supplied by Layer 3.

### Layer 3 — `Thread.cloneFromNativeMessageIdx(args)` (new)
Responsible for the rendering / nvim integration around the cloned core:

- Creates a fresh `Environment` for the new `threadId` (per-thread `SandboxViolationHandler` cannot be shared) using the standard bypassRef bootstrap pattern from `createThreadWithContext`. No fork-specific `forkBypassRef` concept.
- Constructs a `ThreadCore` via `ThreadCore.clone(...)` (Layer 2 API), passing the freshly built capability bag from the new environment plus all `ThreadCoreContext` fields drawn from the source's context where applicable.
- Initializes Layer 3 state:
  - `sandboxBypassed`: copied as a snapshot boolean from `sourceThread.isSandboxBypassed`. Independent — toggling source post-fork has no effect on the fork.
  - `state.toolResultMap`: built from the cloned agent's messages, preserving `structuredResult` from `sourceThread.state.toolResultMap` for any tool_use IDs that survive the truncation.
  - View-state maps. All read-sites use optional chaining (`viewState?.expandedContent?.[idx] || false`, `toolViewState?.resultExpanded`, etc.) and entries are populated lazily on user toggle, so an empty `{}` is safe at the type/runtime level for the pure UI-toggle entries:
    - `toolViewState`: start empty. Pure UI collapse/expand state per `ToolRequestId`; rebuilt lazily as the user toggles.
    - `compactionViewState`: start empty. Pure UI state, and we reset `compactionHistory` anyway so there are no records to render.
  - `messageViewState` is a special case: in addition to UI-toggle fields (`expandedContent`, `expandedUpdates`), it also carries `contextUpdates: FileUpdates` — content data populated by the `contextUpdatesSent` listener at the moment a context update is dispatched. The view uses this to render the rich file-list block above user messages (`renderContextUpdate`). Without it, past user messages would still render (the `<context_update>` text is in the agent's messages) but lose the rich UI affordance.
    - For the fork: deep-copy entries from `sourceThread.state.messageViewState` whose `messageIdx <= nativeMessageIdx`. Drop entries beyond the truncation point. UI-toggle fields can be copied along with the contextUpdates data — the user keeps their expansion state for past messages, which is a reasonable default.
- Wires the bypassRef closure: `bypassRef.get = () => thread.isSandboxBypassed`.
- Returns the constructed `Thread`.

## What gets cloned/preserved vs reset (consolidated view)

**Carried from source (snapshot at clone point):**
- Layer 1: `agent.messages` (cloned + truncated), `messageStopInfo`, `latestUsage`, `inputTokenCount`.
- Layer 2: `systemPrompt`, `threadType`, `subagentConfig`, profile, set of tracked files (with `agentView` synced to current disk state).
- Layer 3: `sandboxBypassed` (snapshot value); `structuredResult` for surviving tool results; `messageViewState` entries for `messageIdx <= nativeMessageIdx` (so rich `contextUpdates` rendering survives past messages).

**Reset to fresh:**
- Layer 2: `mode = normal`, `pendingMessages`, `edlRegisters`, `editedFilesThisTurn`, all reminder/token counters, `compactionHistory`, `compactionController`, `supervisor`, `title`.
- Layer 3: `toolViewState`, `compactionViewState`, `showSystemPrompt`, `contextFilesExpanded`. (`messageViewState` is partially carried — see Carried section.)

**Reconstructed (independent per fork):**
- Layer 3: `Environment` (fresh per threadId), `bypassRef` closure (standard pattern), `Thread.state.toolResultMap` (built from cloned messages).

## Things explicitly NOT done

- We do **not** call `sourceThread.abortAndWait()`. `Agent.clone()` already handles in-flight assistant blocks via `cleanupClonedMessages`. The source thread is unaffected.
- We do **not** call `resolveAutoContext()` again — auto-context is in the cloned message history.
- We do **not** call `createSystemPrompt()` again — system prompt is reused from source.
- We do **not** double-clone the agent. Layer 2 clones once; Layer 3 does not re-clone.
- There is no `forkBypassRef` indirection — the fork uses the same bypassRef bootstrap as a normal new thread. Source and fork share no closures.

## Method signature (Layer 3)

```ts
class Thread {
  static async cloneFromNativeMessageIdx(args: {
    sourceThread: Thread;
    newThreadId: ThreadId;
    nativeMessageIdx: NativeMessageIdx;
    chat: Chat;
    mcpToolManager: MCPToolManagerImpl;
    dispatch: Dispatch<RootMsg>;
    nvim: Nvim;
    cwd: NvimCwd;
    homeDir: HomeDir;
    lsp: Lsp;
    sandbox: Sandbox;
    getOptions: () => MagentaOptions;
    getDisplayWidth: () => number;
  }): Promise<Thread>;
}
```

## Method signature (Layer 2)

```ts
class ThreadCore {
  static async clone(args: {
    sourceCore: ThreadCore;
    newId: ThreadId;
    nativeMessageIdx: NativeMessageIdx;
    context: ThreadCoreContext; // the fresh per-thread capability bag from Layer 3
  }): Promise<ThreadCore>;
}
```

# Implementation

## Phase A — Move tool result map from ThreadCore to Thread

This is a prerequisite for clean cloning, since Layer 3 cannot reach into Layer 2's state to clone the rendering map.

- [ ] Add `result?: ProviderToolResult` field to `ActiveToolEntry` in `node/core/src/thread-core.ts`.
- [ ] Replace `cache-tool-result` action with `set-active-tool-result` that writes to `mode.activeTools[id].result` (when in `tool_use` mode). Adjust call sites in `handleProviderStoppedWithToolUse`'s `invocation.promise.then(...)` chain.
- [ ] Update `maybeAutoRespond` to read `entry.result` instead of `state.toolCache.results.get(toolId)`.
- [ ] Remove `state.toolCache` from `ThreadCore` and the related actions: `cache-tool-result`, `rebuild-tool-cache`, and the cache reset in `reset-after-compaction`.
- [ ] Add `state.toolResultMap: Map<ToolRequestId, ProviderToolResult>` to `Thread` in `node/chat/thread.ts`.
- [ ] Add a Thread-level `rebuildToolResultMap()` helper that walks `core.agent.getProviderMessages()` and constructs the map (preserving `structuredResult` from the prior map). Call it on relevant lifecycle hooks: after agent updates that include new tool_results, after compaction, on construction (for restored / cloned threads).
- [ ] Update view code that reads `core.state.toolCache.results.get(id)` to read `thread.state.toolResultMap.get(id)`. Find with `rg "toolCache"` and update each call site.
- [ ] Update tests that reference `toolCache`. Most likely `node/core/src/thread-core.test.ts` and `node/chat/thread*.test.ts`.
- [ ] Run typecheck and full test suite. Iterate.

## Phase B — Add `ThreadCore.clone`

- [ ] Add a `buildClonedFiles(sourceFiles, fileIO)` helper alongside `ContextManager` (or as a private static on `ContextManager`):
  - For each tracked file: copy `relFilePath` and `fileTypeInfo`; for text files re-read disk contents and set `agentView = { type: "text", content: <currentContent> }`; for binary/pdf copy source's `agentView` as-is; set `lastStat` to the current `fileIO.stat()` result.
  - Skip files that no longer exist on disk.
- [ ] Add `ThreadCore.clone(args)` static method:
  - Clone agent: `const agent = sourceCore.agent.clone(); agent.truncateMessages(nativeMessageIdx);`
  - Build cloned `ContextManager` files via `buildClonedFiles(sourceCore.contextManager.files, context.fileIO)`. Pass these as `context.initialFiles` to a new `ThreadCore` constructor invocation.
  - Construct `ThreadCore` with the pre-cloned, pre-truncated agent. **Update the constructor to use the supplied agent as-is, no defensive re-clone.** Document the ownership transfer contract.
  - Return the new core.
- [ ] Update `ThreadCore` constructor: when `clonedAgent` is provided, assign `this.agent = clonedAgent` directly (no `.clone()`). Audit the only existing call site (`Chat.handleForkThread`) for safety; it clones inline and immediately passes, so this is safe.
- [ ] Run typecheck and tests. Iterate.

## Phase C — Add `Thread.cloneFromNativeMessageIdx`

- [ ] Add the static method on `Thread` per the signature above. Steps:
  1. Resolve `environmentConfig` from `sourceThread.context.environment.environmentConfig`. For MVP, support local-source forks; throw a clear error for docker-source forks (add as follow-up). Or support both via parallel `createDockerEnvironment` path.
  2. Build new `Environment` via the standard `bypassRef` pattern used in `Chat.createThreadWithContext`. The `onPendingChange` callback dispatches to `newThreadId`.
  3. Build the `ThreadCoreContext` capability bag from the new environment plus source's profile, `mcpToolManager`, `getAgents`, `getProvider`, etc.
  4. Call `ThreadCore.clone({ sourceCore: sourceThread.core, newId: newThreadId, nativeMessageIdx, context })`.
  5. Construct `Thread` directly (not via the existing constructor's `clonedAgent` path — instead expose a private constructor or factory that accepts a pre-built `ThreadCore`). Either: (a) add an optional `core?: ThreadCore` parameter to the existing constructor that, when provided, skips creating its own `ThreadCore`; or (b) make the public constructor handle the standard "create new thread" case and add a static `fromCore(core, ...)` factory for assembled-elsewhere cases. Recommendation: option (a).
  6. Initialize `state.toolResultMap` on the new Thread by walking `core.agent.getProviderMessages()`, preserving `structuredResult` for IDs that exist in `sourceThread.state.toolResultMap`.
  7. `thread.sandboxBypassed = sourceThread.isSandboxBypassed;`
  8. `bypassRef.get = () => thread.isSandboxBypassed;`
  9. Return `thread`.
- [ ] Run typecheck. Iterate.

## Phase D — Refactor `Chat.handleForkThread` to delegate

- [ ] Replace the body of `handleForkThread` with:
  - Validate `sourceThreadWrapper.state === "initialized"`.
  - Resolve `idx = truncateAtMessageIdx ?? sourceThread.agent.getNativeMessageIdx()`.
  - Generate `newThreadId` via `uuidv7()`.
  - Register `threadWrappers[newThreadId]` with `state: "pending"`, `parentThreadId: undefined`, `depth: 0`, `lastActivityTime: Date.now()`.
  - Call `Thread.cloneFromNativeMessageIdx({ sourceThread, newThreadId, nativeMessageIdx: idx, chat: this, mcpToolManager: this.mcpToolManager, dispatch: this.context.dispatch, nvim: this.context.nvim, cwd: this.context.cwd, homeDir: this.context.homeDir, lsp: this.context.lsp, sandbox: this.context.sandbox, getOptions: this.context.getOptions, getDisplayWidth: this.context.getDisplayWidth })`.
  - Dispatch `thread-initialized`.
  - Return `newThreadId`.
- [ ] Drop now-unused imports in `chat.ts` (`resolveAutoContext`, `autoContextFilesToInitialFiles`, `createSystemPrompt`, `FsFileIO`, `createLocalEnvironment`) if no longer referenced.

## Phase E — Tests

- [ ] Test: no `<context_update>` on first turn after fork when files are unchanged.
  - **Behavior:** Forking a thread that has tracked `poem.txt` produces a new thread whose first user-turn stream contains no `<context_update>` block referencing `poem.txt`.
  - **Setup:** `withDriver({})`, send a user message that triggers `get_file` on `poem.txt`, mock the tool result. Let the turn end.
  - **Actions:** Capture source's last `nativeMessageIdx`. Trigger fork via `magenta.forkAtMessageAndSwitch(sourceThreadId, idx)`. Send a fresh user message on the fork. Capture the next pending stream.
  - **Expected output:** Latest user message contains no `<context_update>` for `poem.txt`.
  - **Assertions:** Search user message text blocks for `"<context_update>"`; assert none reference `poem.txt`.

- [ ] Test: `<context_update>` IS sent if a tracked file changes after fork.
  - **Behavior:** Fork is independent of source — modifying a tracked file post-fork triggers an update on the fork's next turn.
  - **Setup:** Same as above.
  - **Actions:** Fork. Modify `poem.txt` on disk. Send a new user message on fork; capture stream.
  - **Expected output:** User message contains a `<context_update>` block for `poem.txt`.
  - **Assertions:** Find text block containing `"<context_update>"`; assert it references the path.

- [ ] Test: tool result map survives the fork (rendering layer clone).
  - **Behavior:** The fork's view does not show "tool result not found" for tool_use blocks carried over from source.
  - **Setup:** Source completes a `get_file` turn so a tool result exists in messages.
  - **Actions:** Fork at the post-tool-result `nativeMessageIdx`; switch to the fork; render the display buffer.
  - **Assertions:** `await driver.assertDisplayBufferDoesNotContain("tool result not found")`.

- [ ] Test: sandbox bypass is copied as an independent value.
  - **Behavior:** Source's `sandboxBypassed=true` results in fork's `isSandboxBypassed===true` at fork time; subsequently toggling source does NOT change fork.
  - **Setup:** `withDriver({})`. Send a message. Toggle bypass on source.
  - **Actions:** Fork. Toggle bypass off on source. Inspect fork.
  - **Assertions:** `expect(forkThread.isSandboxBypassed).toBe(true); expect(sourceThread.isSandboxBypassed).toBe(false);`

- [ ] Test: source agent is unaffected by clone.
  - **Behavior:** Cloning never mutates source's agent or thread state.
  - **Setup:** Source completes a turn with N messages.
  - **Actions:** Fork at index N-1.
  - **Assertions:** `sourceThread.agent.getState().messages.length === N`; `sourceThread.agent.getState().status.type === "stopped"` with original stop reason.

- [ ] Test: agent clone happens exactly once.
  - **Behavior:** Spying / counting `Agent.clone` calls during a fork shows exactly one invocation across the whole pipeline (not two as in the current code).
  - **Setup:** Source completes a turn.
  - **Actions:** Wrap `sourceThread.agent.clone` with a counter (or use `vi.spyOn`); trigger the fork.
  - **Assertions:** `expect(cloneSpy).toHaveBeenCalledTimes(1)`.

- [ ] Run the full fork-keybinding test suite to confirm no regression.
  - `npx vitest run node/chat/fork-keybinding.test.ts`

# Open follow-ups (out of scope)

- Docker-source forks: build appropriate environment via `createDockerEnvironment`. MVP throws.
- Carrying `compactionHistory` and `title` across forks if user feedback wants it.
- Per-message snapshot of `agentView` to exactly reflect state at `nativeMessageIdx` (rather than current source state). Current "current disk content" approach is a deliberate, simpler choice.
