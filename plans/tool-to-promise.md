# Tool-to-Promise Simplification Proposal

## Current State

Each tool is a class implementing the `Tool`/`StaticTool` interface with:

- Internal state machine (`processing` → `done`/`error`)
- `update(msg)` method to receive messages
- `myDispatch` to send messages back through the root dispatcher
- `isDone()`, `isPendingUserAction()`, `getToolResult()`, `abort()`
- `renderSummary()`, `renderPreview?()`, `renderDetail?()`

The message dispatch pattern requires:

1. Tool dispatches a message (e.g. `{ type: "finish", result }`)
2. Message flows through root dispatch → thread → `handleToolMsg`
3. Thread calls `tool.update(msg)` which sets `state = "done"`
4. Thread calls `maybeAutoRespond()` to check if all tools are done

Most tools have a trivial state machine: `processing` → `done`, with a single `finish` message. The dispatch round-trip is pure ceremony. Yield and subagent tools have special control flow handling that adds complexity.

## Observation

Now that permissions are externalized to `PermissionCheckingShell`/`PermissionCheckingFileIO`, the tool itself just does async work and produces a result. Tools don't need to be classes — they can be plain functions returning promises.

## Proposal

### Tools are functions, not classes

Each tool is a function that returns a `ToolInvocation`:

```typescript
type ToolInvocation = {
  promise: Promise<ProviderToolResult>;
  abort: () => void;
};
```

The function does its async work, resolves the promise with the result, and that's it. No state machines, no messages, no dispatch.

### Capability interfaces

Tools interact with the system through capability interfaces, just like `Shell` and `FileIO`:

```typescript
interface ThreadManager {
  spawnThread(opts: {
    prompt: string;
    threadType: ThreadType;
    contextFiles?: string[];
  }): Promise<ThreadId>;

  waitForThread(threadId: ThreadId): Promise<Result<string>>;

  yieldResult(threadId: ThreadId, result: Result<string>): void;
}
```

Chat implements `ThreadManager`. The permission layer can wrap it if needed in the future.

### Progress reporting for in-flight rendering

Tools that need to show progress (bash, subagents) maintain their own accumulated progress internally and report it through an `onProgress` callback. The tool is responsible for rolling up raw events into a coherent progress — the thread just stores and renders whatever the tool reports.

```typescript
// Bash progress — maintained and reported by the tool
type BashProgress = {
  liveOutput: OutputLine[];
  startTime: number | undefined;
};

function executeBashCommand(
  request: ToolRequest,
  context: { shell: Shell },
  onProgress: (state: BashProgress) => void,
): ToolInvocation;

// Subagent progress — maintained and reported by the tool
type SubagentProgress = {
  spawnedThreads: ThreadId[];
  completedThreads: ThreadId[];
};

function executeSpawnSubagent(
  request: ToolRequest,
  context: { threadManager: ThreadManager },
  onProgress: (state: SubagentProgress) => void,
): ToolInvocation;
```

Simple tools (getFile, edl, hover, etc.) don't need progress — no callback parameter.

### In-flight progress: tool owns it, thread stores a reference

The tool function accumulates its own progress and calls `onProgress` with the current state whenever it changes. The thread stores a reference to the latest reported state for rendering. Once the promise resolves, the tool is removed from `activeTools` and the result goes into `ToolCache` — from that point, the existing `renderCompletedSummary`/`renderCompletedPreview`/`renderCompletedDetail` static functions take over.

```typescript
// In the thread:
let progress: BashProgress | undefined;

const handle = executeBashCommand(request, context, (state) => {
  progress = state;
  this.requestRender();
});

activeTools.set(request.id, {
  handle,
  get progress() {
    return progress;
  },
  toolName: request.toolName,
});
```

### View layer: fully separate

Views are standalone functions that read `progress` + request. They live in the UI layer, not with tool logic.

```typescript
type ToolViewFns = {
  renderInFlightSummary(
    progress: unknown,
    request: ToolRequest,
    viewContext: ToolViewContext,
  ): VDOMNode;
  renderInFlightPreview?(
    progress: unknown,
    request: ToolRequest,
    viewContext: ToolViewContext,
  ): VDOMNode;
};
```

Abort/terminate is just a binding closure that calls `handle.abort()` — no dispatch needed.

### Yield is just a normal tool

Currently yield has special `control_flow` mode handling in the thread. With this approach:

1. The yield tool function calls `threadManager.yieldResult(threadId, result)` and resolves immediately
2. The thread's `maybeAutoRespond()` simply checks: "did any completed tool have `toolName === 'yield_to_parent'`?" — if so, don't auto-respond
3. The `control_flow` conversation mode is eliminated entirely

```typescript
function executeYieldToParent(
  request: ToolRequest,
  context: { threadManager: ThreadManager; threadId: ThreadId },
): ToolInvocation {
  context.threadManager.yieldResult(context.threadId, request.input.result);
  return {
    promise: Promise.resolve(successResult("Yielded result to parent thread.")),
    abort: () => {},
  };
}
```

### All subagent tools as functions

```typescript
// spawn_subagent (non-blocking)
function executeSpawnSubagent(request, context, onProgress): ToolInvocation {
  const result = (async () => {
    const threadId = await context.threadManager.spawnThread({ ... });
    onProgress({ type: "spawned", threadId });

    if (!request.input.blocking) {
      return successResult(`Sub-agent started with threadId: ${threadId}`);
    }

    const threadResult = await context.threadManager.waitForThread(threadId);
    onProgress({ type: "completed", threadId });
    return formatThreadResult(threadId, threadResult);
  })();

  return { result, abort: () => {} };
}

// wait_for_subagents
function executeWaitForSubagents(request, context): ToolInvocation {
  const result = Promise.all(
    request.input.threadIds.map((id) => context.threadManager.waitForThread(id)),
  ).then((results) => formatResults(results));

  return { result, abort: () => {} };
}

// spawn_foreach
function executeSpawnForeach(request, context, onProgress): ToolInvocation {
  const result = (async () => {
    const results = [];
    // concurrency control via batching
    for (const batch of batches(request.input.elements, maxConcurrent)) {
      const batchResults = await Promise.all(
        batch.map(async (element) => {
          const threadId = await context.threadManager.spawnThread({ ... });
          onProgress({ type: "element-spawned", element, threadId });
          const r = await context.threadManager.waitForThread(threadId);
          onProgress({ type: "element-completed", element, threadId });
          return r;
        }),
      );
      results.push(...batchResults);
    }
    return formatResults(results);
  })();

  return { result, abort: () => {} };
}
```

### Thread integration

```typescript
// In handleProviderStoppedWithToolUse:
for (const toolRequest of toolRequests) {
  const { handle, progress } = createTool(toolRequest, context);
  activeTools.set(toolRequest.id, {
    handle,
    progress,
    toolName: toolRequest.toolName,
  });

  handle.result.then((result) => {
    this.state.toolCache.results.set(toolRequest.id, result);
    this.maybeAutoRespond();
    this.requestRender();
  });
}

// In maybeAutoRespond:
// Check all tools resolved
for (const [id, tool] of activeTools) {
  if (!toolCache.results.has(id)) {
    return { type: "waiting-for-tool-input" };
  }
}
// Check for yield — just a tool name check, no special mode
const hasYield = [...activeTools.values()].some(
  (t) => t.toolName === "yield_to_parent",
);
if (hasYield) {
  return { type: "yielded-to-parent" };
}
// All done, send results and continue
this.sendToolResultsAndContinue(completedTools);
```

### What changes

| Component                       | Before                                  | After                                      |
| ------------------------------- | --------------------------------------- | ------------------------------------------ |
| Tool implementation             | Classes with state machines             | Plain functions returning `ToolInvocation` |
| Tool messages                   | `Msg` type + `update()` + `myDispatch`  | Eliminated                                 |
| Progress                        | Mutable state on tool class             | `onProgress` callback → thread accumulates |
| Completion detection            | `isDone()` polled in `maybeAutoRespond` | `.then()` callback                         |
| Tool result                     | `getToolResult()`                       | `await invocation.promise`                 |
| View methods                    | On the tool class                       | Separate view functions per tool type      |
| Abort / terminate (bash)        | Two separate mechanisms                 | Single `abort()` → shell.terminate()       |
| Yield                           | Special `control_flow` mode             | Normal tool + name check in autoRespond    |
| Subagent interaction            | Direct Chat/dispatch coupling           | `ThreadManager` capability interface       |
| `isPendingUserAction`           | On tool interface                       | Thread checks directly via Chat            |
| Thread dispatch path            | root → thread → handleToolMsg → update  | Eliminated                                 |
| `ToolMsg` / `wrapStaticToolMsg` | Required                                | Eliminated                                 |

### What stays the same

- `createTool()` factory (returns `ToolInvocation` instead of tool class)
- Completed tool rendering (static functions) — already separate
- Permission layer (external to tools)
- `ToolCache`

### Context

Relevant files and entities:

- `node/tools/types.ts` — `Tool`, `StaticTool`, `ToolMsg`, `ToolManagerToolMsg` interfaces. These get replaced by `ToolInvocation`.
- `node/tools/create-tool.ts` — `createTool()` factory, `CreateToolContext`, `ToolDispatch`. Factory stays but returns `ToolInvocation` instead of class instances.
- `node/tools/tool-registry.ts` — `StaticToolName`, tool name groupings. Unchanged.
- `node/tools/toolManager.ts` — `renderCompletedToolSummary/Preview/Detail`, `getToolSpecs`. Completed rendering stays. Add in-flight view registry here.
- `node/chat/thread.ts` — `Thread` class, `ConversationMode`, `handleToolMsg`, `maybeAutoRespond`, tool dispatch chain. Major consumer of the migration.
- `node/chat/chat.ts` — `Chat` class with `getThreadResult`, `handleSpawnSubagentThread`, `getThreadSummary`, `threadHasPendingApprovals`. Implements `ThreadManager`.
- `node/root-msg.ts` — `RootMsg`. Tool messages get removed from here.
- Simple tools: `node/tools/getFile.ts`, `node/tools/hover.ts`, `node/tools/findReferences.ts`, `node/tools/diagnostics.ts`, `node/tools/thread-title.ts`, `node/tools/edl.ts`
- Complex tools: `node/tools/bashCommand.ts`, `node/tools/spawn-subagent.ts`, `node/tools/spawn-foreach.ts`, `node/tools/wait-for-subagents.ts`, `node/tools/yield-to-parent.ts`
- MCP tools: `node/tools/mcp/tool.ts`, `node/tools/mcp/types.ts`

### Migration path

- [ ] **Step 1: Define `ToolInvocation` type and `ThreadManager` interface**
  - [ ] Add `ToolInvocation` type to `node/tools/types.ts`: `{ promise: Promise<ProviderToolResult>; abort: () => void }`
  - [ ] Define `ThreadManager` interface in a new file `node/tools/thread-manager.ts` with methods: `spawnThread(opts)`, `waitForThread(threadId)`, `yieldResult(threadId, result)`
  - [ ] Type check: `npx tsc --noEmit`

- [ ] **Step 2: Update thread to support both old `Tool` and new `ToolInvocation` in parallel**
  - [ ] Add `ActiveToolEntry` type to thread: `{ type: "legacy"; tool: Tool | StaticTool } | { type: "invocation"; handle: ToolInvocation; progress: unknown; toolName: ToolName; request: ToolRequest }`
  - [ ] Change `ConversationMode.tool_use.activeTools` from `Map<ToolRequestId, Tool | StaticTool>` to `Map<ToolRequestId, ActiveToolEntry>`
  - [ ] Update `maybeAutoRespond` to handle both entry types: legacy uses `tool.isDone()`, invocation checks `toolCache.results.has(id)`
  - [ ] Update `handleToolMsg` to only route to legacy entries
  - [ ] Update `abortAndWait` to handle both entry types
  - [ ] Update thread view rendering to handle both entry types
  - [ ] Type check and fix errors: `npx tsc --noEmit`
  - [ ] Run tests: `npx vitest run`

- [ ] **Step 3: Migrate simple tools to functions**
  - [ ] Migrate `getFile` — convert class to `executeGetFile(request, context): ToolInvocation`. Move async logic from constructor into the function body. Keep `renderCompletedSummary`/`renderCompletedDetail` as-is.
  - [ ] Migrate `hover` — same pattern
  - [ ] Migrate `findReferences` — same pattern
  - [ ] Migrate `diagnostics` — same pattern
  - [ ] Migrate `threadTitle` — same pattern
  - [ ] Migrate `edl` — same pattern
  - [ ] Update `createTool()` to return `ToolInvocation` for migrated tools
  - [ ] Update thread's `handleProviderStoppedWithToolUse` to wire up `.promise.then()` → `toolCache.results.set()` + `maybeAutoRespond()` + `requestRender()` for new-style tools
  - [ ] Type check: `npx tsc --noEmit`
  - [ ] Run tests: `npx vitest run`

- [x] **Step 4: Add in-flight view registry**
  - [x] Add `renderInFlightSummary()` to each of the 6 simple tool modules (getFile, hover, findReferences, diagnostics, thread-title, edl) — each matches the old class `renderSummary()` processing case
  - [x] Add `renderInFlightToolSummary()` registry function in `toolManager.ts` that dispatches to each tool's `renderInFlightSummary()` (with fallback placeholders for bash, subagent, etc.)
  - [x] Update thread view to use `renderInFlightToolSummary()` for invocation-type entries instead of generic `⚙️ processing...`
  - [x] Type check: `npx tsc --noEmit`

- [x] **Step 5: Migrate `bashCommand`**
  - [x] Define `BashProgress` type: `{ liveOutput: OutputLine[]; startTime: number | undefined }`
  - [x] Add `execute()` function returning `ToolInvocation & { progress: BashProgress }` — shell callbacks mutate progress, `requestRender()` triggers re-render
  - [x] Tick interval inside `execute()` calls `requestRender()` every 1s for timer display
  - [x] `abort()` calls `shell.terminate()` — unified (no separate terminate mechanism)
  - [x] Added `renderInFlightSummary`, `renderInFlightPreview`, `renderInFlightDetail` to bashCommand.ts
  - [x] Added `renderInFlightToolPreview`/`renderInFlightToolDetail` registry functions to toolManager.ts
  - [x] Updated thread view: invocation entries now show full summary/preview/detail with `t` binding for abort
  - [x] Added `requestRender` to `CreateToolContext`, `tool-progress` message type to thread
  - [x] Updated `createTool()` for bash — calls `BashCommand.execute()`
  - [x] Updated bash tests: 't' key and direct terminate tests now use abort flow
  - [x] Type check: `npx tsc --noEmit` ✅
  - [x] Run tests: `npx vitest run` — 835 pass ✅

- [x] **Step 6: Migrate `yield_to_parent`**
  - [x] Added `execute()` and `renderInFlightSummary()` to yield-to-parent.ts — resolves immediately with the result
  - [x] Removed `control_flow` mode and `ControlFlowOp` from `ConversationMode` — yield now uses `tool_use` mode like all other tools
  - [x] Added `yieldedResponse?: string` to thread state — set by `maybeAutoRespond` when it detects yield_to_parent
  - [x] Updated `maybeAutoRespond` to set `yieldedResponse` and check it at the top
  - [x] Updated `Chat.getThreadResult()`, `notifyParent`, and `getThreadSummary` to use `thread.state.yieldedResponse`
  - [x] Updated `createTool()` for yield — calls `YieldToParent.execute()`
  - [x] Updated `renderStatus` to use `yieldedResponse` parameter
  - [x] Type check: `npx tsc --noEmit` ✅
  - [x] Run tests: `npx vitest run` — 835 pass ✅

- [x] **Step 7: Implement `ThreadManager` in Chat**
  - [ ] Add `ThreadManager` implementation to `Chat` class
  - [ ] `spawnThread()` — extracts logic from `handleSpawnSubagentThread`, returns `Promise<ThreadId>` directly instead of dispatching back
  - [ ] `waitForThread(threadId)` — returns a `Promise<Result<string>>` that resolves when the thread reaches a terminal state (yield, error, abort). Uses polling or event-based approach.
  - [ ] `yieldResult(threadId, result)` — stores the yield result so `waitForThread` can resolve
  - [ ] Remove `handleSpawnSubagentThread` dispatch-based approach from Chat
  - [ ] Remove `spawn-subagent-thread` from `ChatMsg`
  - [ ] Type check: `npx tsc --noEmit`

- [x] **Step 8: Migrate subagent tools**
  - [ ] Define `SubagentProgress` types for each subagent tool
  - [ ] Migrate `spawn_subagent` — async function that calls `threadManager.spawnThread()`, then optionally `threadManager.waitForThread()` for blocking mode
  - [ ] Migrate `wait_for_subagents` — `Promise.all` over `threadManager.waitForThread()` calls
  - [ ] Migrate `spawn_foreach` — batched concurrent spawning with progress callbacks
  - [ ] Register in-flight views for subagent tools (show spawned/completed threads, pending approvals)
  - [ ] Update `createTool()` for subagent tools
  - [ ] Type check: `npx tsc --noEmit`
  - [ ] Run tests: `npx vitest run`

- [x] **Step 9: Migrate MCP tools**
  - [x] Convert `MCPTool` class to `execute(request, context): ToolInvocation` with `MCPProgress` and timer tick
  - [x] Remove `wrapMcpToolMsg`/`unwrapMcpToolMsg` and dead `renderToolResult` from MCP modules
  - [x] Added `renderInFlightSummary` and `renderCompletedSummary` standalone functions to mcp/tool.ts
  - [x] Update `createTool()` and `toolManager.ts` rendering for MCP tools
  - [x] Type check: `npx tsc --noEmit` ✅
  - [x] Run tests: `npx vitest run` — 835 pass ✅

- [ ] **Step 10: Remove legacy tool infrastructure**
  - [ ] Remove `Tool` and `StaticTool` interfaces from `node/tools/types.ts`
  - [ ] Remove `ToolMsg`, `ToolManagerToolMsg` types
  - [ ] Remove `ToolDispatch` type from `create-tool.ts`
  - [ ] Remove `tool-msg` case from thread's `Msg` type and `update()` handler
  - [ ] Remove `handleToolMsg()` from thread
  - [ ] Remove `ActiveToolEntry` dual type — all entries are now invocations
  - [ ] Simplify `ConversationMode.tool_use` to store `Map<ToolRequestId, { handle: ToolInvocation; progress: unknown; toolName: ToolName; request: ToolRequest }>`
  - [ ] Remove `isPendingUserAction` from tool interface — thread checks permissions directly via Chat
  - [ ] Clean up `CreateToolContext` — remove `dispatch` (subagent tools use `ThreadManager` instead), remove `chat` direct reference
  - [ ] Type check: `npx tsc --noEmit`
  - [ ] Run tests: `npx vitest run`
