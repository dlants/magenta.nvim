# Sub-Agent Implementation Plan for magenta.nvim

## Overview

This plan outlines how to implement functionality that allows an agent to spawn a sub-agent to complete specific tasks and return results back to the parent agent. The implementation will consist of two new tools:

1. `spawn_subagent` - For the parent agent to create and delegate tasks to a sub-agent
2. `yield_to_parent` - For the sub-agent to yield results back to its parent agent

## Architecture

The sub-agent system will follow the existing architectural patterns of magenta.nvim:

- Leverage existing Chat and Thread management instead of creating a new controller
- Use ToolManager for tool state management
- Messages for communication between components
- Tools defined by specifications and implementations

## Key Components

### 1. Parent-Child Thread Relationship

- Extend the Thread class to track parent-child relationships
- Use the existing Chat controller to manage all threads (including sub-agent threads)
- Implement message passing between parent and child threads through the existing dispatch mechanism

### 2. New Tool Implementations

#### `spawn_subagent` Tool

- **Purpose**: Allow parent agent to create a sub-agent with a specific task
- **Input**:
  - `prompt`: Description of the task for sub-agent to complete
  - `contextFiles`: Optional list of files to provide to the sub-agent
- **Behavior**:
  - Creates a new Thread through the existing Chat controller
  - Establishes parent-child relationship between threads
  - Initializes with appropriate context
  - Returns a sub-agent ID to the parent agent
- **State**:
  - The tool will only store the threadId of the created sub-agent
  - It will NOT manage the sub-agent's lifecycle or messages

#### `yield_to_parent` Tool

- **Purpose**: Allow sub-agent to send results back to parent
- **Input**:
  - `result`: The information/result to return
- **Behavior**:
  - Captures the results from the sub-agent
  - Delivers them to the parent agent via dispatch
  - Terminates the sub-agent thread
- **State**:
  - Will only be available to sub-agent threads
  - Will store the result to be passed back to the parent

### 3. Thread Extension

Modifications to the Thread class to:

- Track parent-child relationships with these new state properties:
  ```typescript
  parent?: {
      threadId: ThreadId;
      ToolRequestId: ToolRequestId;
  }
  ```

### 4. UI/UX Considerations

- keep these minimal for now, since we just want to focus on the underlying architecture

## Implementation Steps

### Phase 1: Extend Thread Class

- [x] Add `parent` field to Thread state for tracking parent-child relationships
  - [x] Add `parent: { threadId: ThreadId; ToolRequestId: ToolRequestId } | undefined` to Thread state interface
  - [x] Update Thread constructor to accept optional parent parameter
- [x] Add tool selection support to Thread constructor
  - [x] Make tool selection parameter required in Thread constructor
  - [x] Update all existing Thread instantiations to explicitly pass in allowed tools
- [x] Run type checking and fix any compilation errors from Thread changes

### Phase 2: Add Thread Spawn Support in Chat

- [x] Define new chat message type for spawning sub-agent threads
  - [x] Add message type to root-msg.ts that contains:
    - Parent thread ID
    - Parent tool request ID
    - List of tool names the sub-agent is allowed to use
    - Initial prompt for the sub-agent
    - Optional context files
- [x] Implement message handling in Chat.update() function
  - [x] Add case for the new spawn thread message type
  - [x] Create new Thread instance with parent relationship
  - [x] Add new thread to the overall threads list
- [x] Run type checking and fix any compilation errors
- [x] **BONUS**: De-duplicated thread creation code by creating `createThreadWithContext` helper method

### Phase 3: Implement SpawnSubagentTool

- [x] Create `node/tools/spawn-subagent.ts` file
  - [x] Define SpawnSubagentToolSpec interface with prompt, contextFiles, and allowedTools inputs
  - [x] Implement SpawnSubagentTool class following existing tool patterns (use compact_thread as example)
  - [x] Add tool state to store threadId of created sub-agent and track spawning progress
- [x] Add schema definition for spawn_subagent tool
  - [x] Define JSON schema for tool inputs (prompt: string, contextFiles?: string[], allowedTools?: ToolName[])
- [x] Add validation functions within spawn-subagent.ts
  - [x] Create validation function for spawn_subagent tool inputs
- [x] Implement async tool application function
  - [x] Use dispatcher to communicate with chat class to create sub-thread
  - [x] Handle thread creation by dispatching spawn-subagent-thread message
  - [x] Store sub-agent state with proper error handling
- [x] Hook up SpawnSubagentTool to toolManager
  - [x] Add tool to the tool registry/manager in tool-registry.ts
  - [x] Update toolManager.ts to instantiate SpawnSubagentTool with proper context
- [x] Run type checking and fix any compilation errors
- [x] **BONUS**: Added handleSubagentResult() method for processing yields from sub-agents

### Phase 4: Add Thread Yield Support in Chat ✅

- [x] Define new chat message type for yielding to parent
  - [x] Add message type to root-msg.ts that contains:
    - Child thread ID
    - Parent thread ID
    - Parent tool request ID
    - Result data to return to parent
- [x] Implement yield message handling in Chat.update() function
  - [x] Add case for the new yield message type
  - [x] Extract result data from yielding thread
  - [x] Call handleSubagentResult() on spawn tool in parent thread's toolManager
  - [x] Remove/terminate the child thread
- [x] Run type checking and fix any compilation errors
- [x] **BONUS**: Added proper TypeScript imports and removed unsafe casting

### Phase 5: Implement YieldToParentTool

- [x] Create `node/tools/yield-to-parent.ts` file
  - [x] Define YieldToParentToolSpec interface with result input
  - [x] Implement YieldToParentTool class following existing tool patterns
  - [x] Add tool state to store result data
- [x] Add schema definition for yield_to_parent tool
  - [x] Define JSON schema for tool inputs (result: string)
- [x] Add validation functions to `node/tools/helpers.ts`
  - [x] Create validation function for yield_to_parent tool inputs
- [x] Implement tool behavior
  - [x] Capture result from sub-agent
  - [x] Use dispatcher to send yield message to chat
  - [x] Ensure tool never auto-responds after yielding
- [x] Hook up YieldToParentTool to toolManager
  - [x] Add tool to the tool registry/manager
  - [x] Ensure tool is only available to sub-agent threads (not parent threads)
- [x] Update Thread class to handle yield tool behavior
  - [x] Ensure thread stops processing after yield tool is used
  - [x] Prevent auto-response when yield tool is called
- [x] Run type checking and fix any compilation errors

### Phase 6: Final Integration and Testing

- [ ] Run full type checking across entire codebase
  - [ ] Fix any remaining compilation errors
  - [ ] Ensure all new message types are properly handled
- [ ] Add unit tests for new tools
  - [ ] Test SpawnSubagentTool functionality
  - [ ] Test YieldToParentTool functionality
  - [ ] Test parent-child thread relationship tracking
- [ ] Add integration tests for sub-agent workflow
  - [ ] Test complete parent → sub-agent → yield flow
  - [ ] Test error handling scenarios
  - [ ] Test multiple sub-agents from single parent
- [ ] Manual testing of sub-agent functionality
  - [ ] Verify UI behaves correctly with sub-agent threads
  - [ ] Test tool availability filtering for sub-agents
  - [ ] Verify proper cleanup of completed sub-agent threads

### New Files

- `node/tools/spawn-subagent.ts` - Tool implementation for spawning sub-agents
- `node/tools/yield-to-parent.ts` - Tool implementation for returning results

### Files to Modify

- `node/root-msg.ts` - Add sub-agent related message types
- `node/chat/thread.ts` - Add parentId, parentToolRequestId, and childIds tracking
- `node/tools/toolManager.ts` - Support filtered tool lists for sub-agents
- `node/chat/chat.ts` - Handle sub-agent creation and management
- `node/providers/provider.ts` - Update tool specs handling for parent/child scenarios
