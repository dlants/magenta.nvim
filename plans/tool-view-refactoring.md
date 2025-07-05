# Tool View Refactoring Plan

## Context

The goal is to refactor the tool view system to provide more flexible display options with:

- A tool summary (brief description)
- An optional tool preview (compact view of content)
- Detailed expanded view with full request/response information
- Improved handling of stop information (moving it from message-level to tool-level)

### Current Architecture

The relevant files and entities are:

**node/chat/message.ts**: Main message rendering logic

- `Message` class: Handles message display and state management
- `State.stops`: Currently stores stop information at message content level
- `State.toolDetailsExpanded`: Already tracks expanded/collapsed state per tool
- `renderTool()`: Current tool rendering method
- `renderContent()`: Handles different content types including tool_use
- `renderStop()`: Renders stop information (usage, stop reason)

**node/tools/types.ts**: Tool interface definitions

- `Tool` interface: Has `view()` method for MCP tools
- `StaticTool` interface: Has `renderRequest()` and `renderResponse()` methods
- `ToolRequestId`: Unique identifier for tool requests

**node/tools/toolManager.ts**: Tool management and bridging

- `ToolManager` class: Manages both static and MCP tools
- `renderToolResult()`: Renders tool results as JSON
- `getTool()`: Returns Tool interface (casts StaticTool to Tool)

**node/providers/helpers.ts**: Content rendering utilities

- `renderContentValue()`: Renders different content types to strings
- `stringifyContent()`: Converts content to string format

**Static Tool Examples**:

- **node/tools/getFile.ts**: `renderRequest()` and `renderResponse()` pattern
- **node/tools/replace.ts**: Shows diff preview in response
- **node/tools/insert.ts**: Shows content preview in response

**MCP Tool Example**:

- **node/tools/mcp/tool.ts**: Implements `view()` method directly. Should be updated to match the static tool implementation.

## Implementation

### Phase 1: update tools

- [ ] Update `Tool` interface in `node/tools/types.ts` to add new methods
  - [ ] Add `renderSummary(): VDOMNode` method
  - [ ] Add `renderPreview?(): VDOMNode` method (optional preview)
  - [ ] remove `view()` method
- [ ] Update `StaticTool` interface in `node/tools/types.ts` to add new methods
  - [ ] Add `renderSummary(): VDOMNode` method
  - [ ] Add optional `renderPreview(): VDOMNode` method
  - [ ] remove existing `renderRequest()` and `renderResponse()` methods
- [ ] Update static tools `node/tools/*.ts` to implement new methods (use findReference to find all references of StaticTool)
- [ ] Update `node/tools/mcp/tool.ts` to implement new methods
  - [ ] Implement `renderSummary()`: Extract tool name and basic status
  - [ ] Implement `renderPreview()`: Show brief tool execution info
  - [ ] remove existing `view()` method
- [ ] Run type checking: `npx tsc --noEmit`
- [ ] Iterate until no compilation errors

### Phase 2: Modify Message State to Handle Stop Information per Tool

- [ ] Update `State` type in `node/chat/message.ts`
  - [ ] consolidate stops into `toolMeta: { [requestId: ToolRequestId]: {showDetails: boolean, stop?: { stopReason: StopReason; usage: Usage }}}` field
  - [ ] Modify existing `"stop"` case to save to appropriate place when stop corresponds to tool request
- [ ] Run type checking: `npx tsc --noEmit`
- [ ] Iterate until no compilation errors

### Phase 3: Create New Tool Rendering Logic

- [ ] Update `renderTool()` method in `node/chat/message.ts`
  - [ ] If `showDetails` is false: render `tool.renderSummary()` + `tool.renderPreview()` (if exists)
  - [ ] If `showDetails` is true: render summary + skip preview + JSON input + full result + stop info
  - [ ] Use `renderContentValue()` from `node/providers/helpers.ts` for full result rendering
  - [ ] Include stop information when available and in detailed mode
  - [ ] Keep bindings for toggle functionality
- [ ] Run type checking: `npx tsc --noEmit`
- [ ] Iterate until no compilation errors
