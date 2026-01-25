# Context

## Objective

Simplify `ToolManager` by making it stateless. Currently it stores all tool controllers indefinitely, but we only need controllers for _active_ tools. Completed tools have their request + result stored in the provider thread already.

## Current Architecture

### ToolManager (`node/tools/toolManager.ts`)

- Stores all tool controllers in `this.tools: {[id: ToolRequestId]: StaticTool}`
- Has two message types: `init-tool-use` (creates tool) and `tool-msg` (forwards to tool)
- Provides `getToolSpecs()` to get tool specifications for provider
- Provides `getTool(id)` to retrieve tool instances
- Provides `hasTool(id)` to check existence

### Tool Interface (`node/tools/types.ts`)

```typescript
interface Tool {
  toolName: ToolName;
  isDone(): boolean;
  isPendingUserAction(): boolean;
  getToolResult(): ProviderToolResult;
  request: ToolRequest;
  abort(): void;
  renderSummary(): VDOMNode;
  renderPreview?(): VDOMNode;
  renderDetail?(): VDOMNode;
}
```

### Thread usage (`node/chat/thread.ts`)

- Creates ToolManager in constructor
- Dispatches `init-tool-use` when new tool_use blocks appear
- Dispatches `tool-manager-msg` to forward tool messages
- Calls `toolManager.getTool(id)` for:
  - Checking `isDone()` and `isPendingUserAction()` in `maybeAutoRespond()`
  - Checking if tool exists in `initializeNewTools()` via `hasTool()`
  - Rendering in `renderMessageContent()` via `tool.renderSummary()`, etc.
  - Aborting active tools in `abortInProgressOperations()`

### MCPToolManager (`node/tools/mcp/manager.ts`)

- Similar pattern: stores MCP tools in `this.tools: Map<ToolRequestId, MCPTool>`
- Accessed via ToolManager which delegates MCP tool operations

### Chat access (`node/chat/chat.ts`)

- Accesses parent thread's tool manager to notify `wait_for_subagents` and `spawn_foreach` tools when subagents complete

## Key Insight

For **active tools**, we need the full controller to:

- Track state transitions (pending → processing → done)
- Handle async operations
- Respond to user input (e.g., approval dialogs)

For **completed tools**, we don't need to store anything extra:

- The request is already in `ProviderMessage.content[]` as `tool_use` blocks
- The result is already in the subsequent user message as `tool_result` blocks
- Rendering can be done with pure functions using request + result from ProviderMessage

## Design: Active Tools in ConversationState

Make tools part of `ConversationState` to enforce the state machine:

```typescript
export type ConversationState =
  | { state: "message-in-flight"; sendDate: Date }
  | { state: "stopped"; stopReason: StopReason }
  | { state: "tool-use"; activeTools: Map<ToolRequestId, Tool> }
  | { state: "error"; error: Error }
  | { state: "yielded"; response: string };
```

Benefits:

- Tools only exist when in "tool-use" state - type system enforces this
- When we respond (transition to "message-in-flight"), tools naturally get discarded
- Clear ownership: Thread owns tools during "tool-use", then releases them
- Thread routes tool messages to `activeTools` only when in "tool-use" state

## Relevant Files

- `node/tools/toolManager.ts` - Main class to refactor
- `node/tools/types.ts` - Tool interface definitions
- `node/chat/thread.ts` - Primary consumer, manages tool lifecycle
- `node/chat/chat.ts` - Accesses tools for subagent completion notifications
- `node/tools/mcp/manager.ts` - MCP tool management (similar pattern)
- `node/tools/*.ts` - Individual tool implementations

# Implementation

## Phase 1: Create Pure Rendering Functions

- [x] Create `node/tools/tool-renderers.ts` with pure rendering functions
  - [x] Define `CompletedToolInfo` type: `{ request: ToolRequest; result: ProviderToolResult }`
  - [x] Create `renderCompletedToolSummary(info: CompletedToolInfo): VDOMNode`
  - [x] Create `renderCompletedToolDetail(info: CompletedToolInfo): VDOMNode`
  - [x] Create `renderCompletedToolPreview(info: CompletedToolInfo): VDOMNode`
  - [x] These functions dispatch on `request.toolName` to call tool-specific renderers
- [x] For each tool that has custom rendering, export static render functions:
  - [x] `getFile.ts`: export `renderCompletedSummary(request, result)`
  - [x] `insert.ts`: export `renderCompletedSummary(request, result)`
  - [x] `replace.ts`: export `renderCompletedSummary(request, result)`
  - [x] Continue for all tools with custom rendering...
- [x] Check for type errors and iterate until they pass

## Phase 2: Update ConversationState with Tool-Use State

The `StopReason` in `provider-types.ts` is derived from Anthropic's types, but we don't need to use the same type internally. We'll:

1. Keep Anthropic's `stop_reason` values at the provider boundary (in stream parsing)
2. Create our own internal `StopReason` that excludes `"tool_use"` (since that's lifted to ConversationState)
3. Remap `"tool_use"` → `"tool-use"` ConversationState at the point where we process the stream response

- [x] Update `ConversationState` type in `thread.ts`:
  - [x] Add `{ state: "tool-use" }` variant (activeTools to be added in Phase 3)
  - [x] Create `ConversationStopReason = Exclude<StopReason, "tool_use">` for internal use
  - [x] This replaces checking `stopReason === "tool_use"` with explicit state
- [x] Keep `StopReason` in `provider-types.ts` unchanged (includes `"tool_use"` at provider boundary)
- [x] Update `getConversationState()` to remap `"tool_use"` → `"tool-use"` state
- [x] Update all code that checks `stopReason === "tool_use"` to check `state === "tool-use"` instead:
  - [x] `thread.ts`: 4 places updated
  - [x] `chat.ts`: 2 switch statements updated to handle `"tool-use"` state
- [x] Check for type errors and iterate until they pass

## Phase 3: Update Thread to Manage Tools in ConversationState

- [x] Update `initializeNewTools()` to:
  - [x] Create tools and add them to `activeTools` in the "tool-use" state
  - [x] Use ToolManager as a factory (not storage)
- [x] Update state transitions:
  - [x] When provider stops with `tool_use`, transition to `{ state: "tool-use", activeTools }`
  - [x] When responding (in `sendToolResultsAndContinue`), transition to `message-in-flight` and discard tool references
- [x] Update `maybeAutoRespond()` to work with "tool-use" state
- [x] Update `abortInProgressOperations()` to access tools from ConversationState
- [x] Check for type errors and iterate until they pass

## Phase 4: Update Tool Message Routing

- [ ] Add new Thread message type for tool-specific messages: `{ type: "tool-msg"; toolId: ToolRequestId; msg: ToolMsg }`
- [ ] Thread routes tool messages to `activeTools` when in "tool-use" state
- [ ] Tool controllers dispatch via Thread's myDispatch (not through ToolManager)
- [ ] Check for type errors and iterate until they pass

## Phase 5: Update Rendering

- [ ] Update `renderMessageContent()` for tool_use blocks:
  - [ ] If in "tool-use" state and tool is active, use `tool.renderSummary()` etc.
  - [ ] Otherwise, use pure rendering functions with request + result from ProviderMessage
  - [ ] Look up `tool_result` from the next user message for completed tools
- [ ] Check for type errors and iterate until they pass

## Phase 6: Simplify ToolManager

- [ ] Remove `tools` map from ToolManager
- [ ] Change ToolManager to:
  - [ ] Provide `getToolSpecs(threadType)` - unchanged
  - [ ] Provide `createTool(request, context)` factory method that returns a Tool instance
  - [ ] No longer store or track tools
- [ ] Update MCPToolManager similarly:
  - [ ] Remove `tools` Map
  - [ ] Add `createTool(request, context)` factory method
- [ ] Remove `getTool()`, `hasTool()`, `renderToolResult()` from ToolManager
- [ ] Remove `Msg` type from ToolManager (no more update method needed)
- [ ] Check for type errors and iterate until they pass

## Phase 7: Update Chat for Subagent Tools

- [ ] Update `chat.ts` subagent completion handling:
  - [ ] Get conversation state from parent thread
  - [ ] If in "tool-use" state, access `activeTools` to notify `wait_for_subagents` / `spawn_foreach`
  - [ ] Cast to specific tool type as before
- [ ] Check for type errors and iterate until they pass

## Phase 8: Tests and Cleanup

- [ ] Update existing tool tests to work with new architecture
- [ ] Run full test suite: `npx vitest run`
- [ ] Iterate until tests pass
- [ ] Remove any dead code from ToolManager
- [ ] Verify type checking passes: `npx tsc --noEmit`
