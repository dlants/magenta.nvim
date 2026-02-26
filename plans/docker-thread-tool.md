# Context

**Objective**: Replace the `:Magenta docker <branch>` command with a `spawn_docker_thread` tool that reuses the existing spawn_subagent/yield infrastructure. The docker thread is a child of the calling thread, using the same parent-child mechanics (spawnThread, waitForThread, yieldResult) but with a richer tool set and supervisor behavior.

**Current state**: The `:Magenta docker <branch>` command manually provisions a container and creates a Docker-environment thread. Subagents cannot spawn their own subagents (tool whitelist restriction). Thread overview only renders one level of nesting (root → children). Indentation is boolean (`isChild`), not depth-aware.

**Desired state**: A `spawn_docker_thread` tool available to root threads. It provisions a container, spawns a `"docker_root"` child thread, sends it a prompt, and returns immediately (fire-and-forget). The docker thread:

- Is a **full child thread** using the existing parent-child relationship from spawn_subagent
- Gets root-level tools (including `spawn_subagent`, `spawn_foreach`, `wait_for_subagents`) plus `yield_to_parent`
- Can spawn its own subagents, which inherit the docker environment and run inside the same container
- Is observable in the sidebar, supports auto-compaction, accepts async user messages for course-correction
- Has a **supervisor loop** that handles lifecycle:
  - **end_turn without yield**: auto-restart with a reminder to complete the task and yield
  - **yield with dirty git state**: reject the yield, tell agent to commit/clean up, yield again
  - **yield with clean git state**: accept the yield, run teardown (fetch branch, stop container, clean up)

**Key design decisions**:

- **Reuse spawn_subagent infrastructure**: `spawn_docker_thread` uses `ThreadManager.spawnThread` to create the child, same as `spawn_subagent`. The docker thread is a child of the calling thread.
- New `ThreadType`: `"docker_root"` — gets `CHAT_STATIC_TOOL_NAMES` plus `yield_to_parent` (so it can spawn its own subagents AND yield).
- **Deeper nesting support**: A docker_root thread's subagents create grandchild threads. The thread overview and Chat already handle arbitrary-depth parent-child tracking (via `parentThreadId` and abort cascade). The main changes are: recursive rendering in the thread overview, and depth-aware indentation.
- **Supervisor is an optional, composable configuration** passed to the thread at construction — not a new thread subclass. All existing thread features (send message, abort, async commands, sidebar interaction) remain fully available. The supervisor just optionally overrides handling of specific events (end_turn without yield, yield with dirty state). If the user aborts, the supervisor steps aside — it's on the user to restart or course-correct.
- Teardown only happens on a **clean yield** (git status is clean inside the container).

**Relevant files and entities**:

- `node/core/src/tools/tool-registry.ts` — `CHAT_STATIC_TOOL_NAMES`, `SUBAGENT_STATIC_TOOL_NAMES`, capability filtering
- `node/core/src/tools/toolManager.ts` — `getToolSpecs()` switch on `ThreadType`, `TOOL_SPEC_MAP`
- `node/core/src/chat-types.ts` — `ThreadType` union type definition
- `node/core/src/tools/spawn-subagent.ts` — pattern for spawning threads from tools
- `node/core/src/tools/yield-to-parent.ts` — yield mechanism
- `node/core/src/capabilities/thread-manager.ts` — `ThreadManager` interface (`spawnThread`, `waitForThread`, `yieldResult`)
- `node/chat/chat.ts` — `Chat.spawnThread()`, `createThreadWithContext()`, `buildThreadHierarchy()`, `renderThreadOverview()` (currently one-level), `renderThread()` (boolean `isChild`)
- `node/chat/thread.ts` — `Thread` class, `createFreshAgent()`, yield detection in `tryAutoRespond`
- `node/core/src/container/provision.ts` — `provisionContainer()`
- `node/core/src/container/teardown.ts` — `teardownContainer()`
- `node/magenta.ts` — current `:Magenta docker` command handler, `dockerProvisions` map
- `node/core/src/tools/create-tool.ts` — `createTool()` factory, `CreateToolContext`
- `node/environment.ts` — `EnvironmentConfig`, `createDockerEnvironment()`

# Prework: Simplify thread.ts

thread.ts is ~2200 lines. Before adding supervisor logic, split it into manageable pieces.

## Prework A: Extract rendering code into thread-view.ts

Lines ~1596-2204 are standalone rendering functions with no dependency on Thread internals beyond reading public state. These can move to a separate file.

- [ ] Create `node/chat/thread-view.ts`
- [ ] Move these standalone functions:
  - [ ] `getAnimationFrame`, `renderStatus`, `renderStopReason`, `renderUsage`
  - [ ] `shouldShowContextManager`, `renderSystemPrompt`
  - [ ] `renderCompactionHistory`
  - [ ] `view` (the main export, currently `export const view`)
  - [ ] `renderMessageContent`
  - [ ] `findToolResult`, `renderStreamingBlock`
  - [ ] `LOGO`, `MESSAGE_ANIMATION`
- [ ] Keep exports from thread.ts that the view needs (types, `Thread` class)
- [ ] Update imports in files that reference `view` or `LOGO` from thread.ts
- [ ] Run `npx tsgo -b` and iterate until no type errors
- [ ] Run tests and iterate until they pass

## Prework B: Extract compaction into a CompactionManager

The compaction code (~380 lines, lines 607-990) is a self-contained subsystem with its own agent, tool handling, and state machine. It can become a helper class.

- [ ] Create `node/chat/compaction-manager.ts`
- [ ] Define `CompactionManager` class:
  - [ ] Owns the compaction state: `compactAgent`, `compactFileIO`, `compactEdlRegisters`, `compactActiveTools`, `chunks`, `currentChunkIndex`, `steps`
  - [ ] Constructor takes dependencies: `{ profile, mcpToolManager, environment, contextManager, threadId, dispatch, nvim, options }`
  - [ ] `start(messages: ProviderMessage[], nextPrompt?: string)`: initializes chunks, creates compact agent, sends first chunk
  - [ ] `handleAgentMsg(msg: AgentMsg)`: replaces `handleCompactAgentMsg`
  - [ ] `isComplete()`: returns whether compaction finished
  - [ ] `getResult()`: returns `{ summary, steps }` or undefined
  - [ ] Internal methods: `handleToolUse`, `handleToolCompletion`, `handleChunkComplete`, `sendChunkToAgent`, `createAgent`
- [ ] In `Thread`:
  - [ ] Replace `mode.type === "compacting"` state with a `CompactionManager` instance
  - [ ] `startCompaction()` creates a `CompactionManager` and calls `start()`
  - [ ] `compact-agent-msg` delegates to `compactionManager.handleAgentMsg()`
  - [ ] `handleCompactComplete()` stays on Thread (it resets the agent and context manager)
- [ ] Run `npx tsgo -b` and iterate until no type errors
- [ ] Run tests and iterate until they pass

# Implementation

## Step 1: Add `"docker_root"` thread type

- [ ] In `node/core/src/chat-types.ts`, add `"docker_root"` to the `ThreadType` union
- [ ] In `node/core/src/tools/tool-registry.ts`, add `DOCKER_ROOT_STATIC_TOOL_NAMES` — same as `CHAT_STATIC_TOOL_NAMES` plus `"yield_to_parent"`
- [ ] In `node/core/src/tools/toolManager.ts`, add `case "docker_root":` to the `getToolSpecs` switch, using the new tool name list
- [ ] Fix any exhaustiveness errors from the new `ThreadType` variant (search for `assertUnreachable` on `threadType`)
- [ ] Run `npx tsgo -b` and iterate until no type errors

## Step 2: Deeper nesting in thread overview

Currently `renderThreadOverview()` only renders root → direct children. `renderThread()` uses a boolean `isChild` for indentation. We need recursive rendering.

- [ ] Store `depth: number` on `ThreadWrapper` at creation time (root = 0, child = parent.depth + 1). Depth is fixed once a thread is spawned, so no need to recompute on every render.
- [ ] In `chat.ts` `renderThreadOverview()`:
  - [ ] Replace the two-level loop with a recursive render that walks `childrenMap` at arbitrary depth
  - [ ] Remove `buildThreadHierarchy()` — use stored depth instead
- [ ] In `chat.ts` `renderThread()`:
  - [ ] Replace `isChild: boolean` with `depth: number`
  - [ ] Use `"  ".repeat(depth)` for indentation
- [ ] Verify abort cascade already works recursively (it does — each child abort dispatches through `update()` which triggers the same loop)
- [ ] Run `npx tsgo -b` and iterate until no type errors

## Step 3: Extend `spawn_subagent` with `"docker"` agent type

Rather than a separate tool, add `"docker"` to `spawn_subagent`'s `agentType` enum and an optional `branch` parameter (required when agentType is `"docker"`).

- [ ] In `node/core/src/tools/spawn-subagent.ts`:
  - [ ] Add `"docker"` to the `agentType` enum in the input schema
  - [ ] Add optional `branch: string` parameter to the input schema (required when agentType is docker)
  - [ ] Update the tool description to explain the docker agent type and branch parameter
  - [ ] In `execute()`, when `agentType === "docker"`:
    - Validate that `branch` is provided
    - Provision the container via a `containerProvisioner` context capability
    - **Remap context file paths** from host → container:
      - Files inside the repo: translate host path to container workspace path (e.g., `<hostCwd>/src/foo.ts` → `<workspacePath>/src/foo.ts`)
      - Files outside the repo: include in the prompt as a note that the file is not available in the container
    - Map to `threadType: "docker_root"`
    - Pass `environmentConfig: { type: "docker", ... }` and `provisionResult` to `spawnThread()`
    - Always non-blocking (return thread ID immediately, ignore `blocking` param)
- [ ] Update `Input` type to include `branch?: string`
- [ ] Run `npx tsgo -b` and iterate until no type errors

## Step 4: Wire the docker agent type into the system

- [ ] In `node/core/src/tools/create-tool.ts`:
  - [ ] Add `containerProvisioner?: { provision, teardown, containerConfig }` to `CreateToolContext`
  - [ ] Pass it through to `spawn_subagent`'s execute when available
- [ ] In `node/chat/thread.ts`:
  - [ ] Pass the container provisioner context when creating tools (read container config from options)
- [ ] Extend `ThreadManager.spawnThread` to accept optional `environmentConfig` and `provisionResult`
- [ ] In `node/chat/chat.ts` `spawnThread()`:
  - [ ] Accept `environmentConfig` from opts, pass through to `createThreadWithContext()`
  - [ ] When `environmentConfig` is docker, use `"docker_root"` thread type
  - [ ] Store `provisionResult` on the thread for later teardown
- [ ] Run `npx tsgo -b` and iterate until no type errors

## Step 5: Thread supervisor (composable configuration)

The supervisor is an optional config object passed to the thread at construction. It hooks into existing thread lifecycle events without changing the thread's core behavior. User actions (abort, send message) are unaffected.

- [ ] Define a `ThreadSupervisor` interface (in core or thread.ts):
  - [ ] `onEndTurn()`: called when agent stops with end_turn and no yield. Returns an action: `{ type: "send-message", text: string }` to auto-restart, or `{ type: "none" }` to do nothing.
  - [ ] `onYield(result: string)`: called when agent calls yield_to_parent. Returns `{ type: "accept" }`, `{ type: "reject", message: string }` (to tell agent to fix up and yield again), or `{ type: "none" }`.
  - [ ] `onAbort()`: called when user aborts. Returns `{ type: "none" }` (supervisor steps aside).
  - [ ] Optional: `maxRestarts: number` to cap auto-restarts.
- [ ] Create a `DockerSupervisor` implementation:
  - [ ] `onEndTurn()`: returns send-message with a reminder to complete task, commit, and yield
  - [ ] `onYield()`: runs `git status --porcelain` inside the container. If dirty, returns reject. If clean, triggers teardown and returns accept.
  - [ ] `onAbort()`: returns none (user is in control)
  - [ ] Tracks restart count, stops auto-restarting after max retries
- [ ] In `node/chat/thread.ts`:
  - [ ] Accept optional `supervisor?: ThreadSupervisor` in thread context
  - [ ] In `tryAutoRespond` / agent status change handling, call supervisor hooks when present
  - [ ] On supervisor reject of yield: reset `yieldedResponse`, send the rejection message
- [ ] Store provision info for teardown:
  - [ ] The `DockerSupervisor` holds `provisionResult` and `containerConfig` (passed at construction)
  - [ ] On clean yield or max retries exceeded: call `teardownContainer()`, resolve thread waiters
- [ ] Run `npx tsgo -b` and iterate until no type errors

## Step 6: Handle system prompt for docker_root threads

- [ ] In `node/core/src/providers/system-prompt.ts`:
  - [ ] Add a case for `"docker_root"` — use the root system prompt plus instructions about committing all changes and calling `yield_to_parent` when done
- [ ] In `node/core/src/providers/system-reminders.ts`:
  - [ ] Add a case for `"docker_root"` — include a reminder to commit and yield when task is complete
- [ ] Run `npx tsgo -b` and iterate until no type errors

## Step 7: Write tests

- [ ] Tool spec tests in `node/capabilities/docker-environment.test.ts`:
  - [ ] `getToolSpecs("docker_root", ...)` includes root tools, `yield_to_parent`, and `spawn_docker_thread`
  - [ ] `getToolSpecs("docker_root", ...)` excludes `lsp` and `diagnostics` for docker capabilities
- [ ] Thread overview nesting tests:
  - [ ] Verify grandchild threads render with correct indentation
- [ ] Supervisor loop tests:
  - [ ] Test auto-restart on end_turn without yield
  - [ ] Test dirty yield rejection (git status dirty → agent told to clean up)
  - [ ] Test clean yield acceptance → teardown triggered
  - [ ] Test max retry limit prevents infinite loops
- [ ] Run tests and iterate until they pass

## Step 8: Update the `:Magenta docker` command (optional cleanup)

- [ ] Consider whether to keep the manual command or remove it in favor of spawn_subagent with docker type
- [ ] If keeping: refactor to share provisioning logic with spawn_subagent
- [ ] If removing: remove the `docker` and `docker-stop` cases from `magenta.ts` and the `dockerProvisions` map
- [ ] Update `plans/dev-container.md` to reflect the new architecture

