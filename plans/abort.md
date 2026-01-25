# Context

The goal is to refactor how abort works to be cleaner and let tools manage their own lifecycle.

## Current behavior (problematic)

In `abortInProgressOperations()`:

1. Preemptively set conversation state to `{ type: "stopped", stopReason: "aborted" }`
2. Call `providerThread.abort()` (async - will emit status change later)
3. For each active tool that's not done:
   - Call `tool.abort()` (synchronous, doesn't dispatch)
   - Immediately insert a tool result via `providerThread.toolResult()`
4. Future tool-msg dispatches are ignored because we're in "aborted" state

Problems:

- Tools don't control their own completion message
- `abort()` is expected to NOT dispatch, but should
- Thread pre-inserts generic "Request was aborted" results instead of letting tools provide context-specific results
- BashCommand's `abort()` only handles `pending-user-action` state, not `processing` state (where `terminate()` sends SIGTERM but the exit handler will dispatch later, only to be ignored)

## Desired behavior

1. `abortInProgressOperations()` should:
   - Only call `providerThread.abort()` if streaming
   - Only abort tools if in `tool_use` state
   - Call `tool.abort()` on each tool, but NOT insert tool results
   - Track that we're aborting on each tool so `maybeAutoRespond` doesn't continue

2. Tools should:
   - Have an `aborted` flag that's set when `abort()` is called
   - Dispatch their completion asynchronously (via setTimeout) so they control their own result message
   - `getToolResult()` should return an appropriate abort message

3. `maybeAutoRespond()` should:
   - Check if any completed tool was aborted
   - If so, don't auto-respond (but still send tool results to provider thread)
   - If a pending tool was aborted, transition to the aborted state

## Relevant files

- `node/chat/thread.ts`: `abortInProgressOperations()`, `maybeAutoRespond()`, `handleToolMsg()`
- `node/tools/types.ts`: `Tool` and `StaticTool` interfaces
- `node/tools/bashCommand.ts`: Complex abort handling with SIGTERM/SIGKILL
- `node/tools/getFile.ts`: Simple abort handling
- `node/tools/insert.ts`, `node/tools/replace.ts`: Other tools that need abort updates

# Implementation

- [x] Add `aborted` flag to Tool interface
  - [x] Update `node/tools/types.ts` to add `aborted: boolean` to `Tool` and `StaticTool` interfaces
  - [x] Change `abort(): void` to `abort(): ProviderToolResult` - abort returns result synchronously
  - [x] Run type check to find all tools that need updating

- [x] Update BashCommandTool abort handling
  - [x] Add `aborted: boolean = false` property
  - [x] In `abort()`: set flag, stop tick interval, terminate process if processing, transition to done state synchronously, return result
  - [x] Add `if (this.aborted) return;` checks in async callbacks to prevent dispatching after abort
  - [x] Run type check

- [x] Update all other tools (GetFileTool, InsertTool, ReplaceTool, HoverTool, FindReferencesTool, DiagnosticsTool, ListDirectoryTool, MCPTool, PredictEditTool, ReplaceSelectionTool, SpawnForeachTool, SpawnSubagentTool, ThreadTitleTool, WaitForSubagentsTool, ForkThreadTool, InlineEditTool, YieldToParentTool)
  - [x] Add `aborted: boolean = false` property
  - [x] In `abort()`: set flag, transition to done state synchronously with abort error message, return result
  - [x] Add `if (this.aborted) return;` checks in async callbacks to prevent dispatching after abort
  - [x] Run type check

- [x] Update `abortInProgressOperations()` in thread.ts
  - [x] Call `tool.abort()` on each active tool and collect returned results
  - [x] Insert tool results into provider thread using `providerThread.toolResult()`
  - [x] Set conversation state to aborted
  - [x] Rebuild tool cache

- [x] Update `maybeAutoRespond()` in thread.ts
  - [x] After collecting completed tools, check if any have `aborted === true`
  - [x] If any were aborted:
    - Still send all tool results to provider thread (so the conversation state is correct)
    - Transition to aborted state
    - Return `{ type: "no-action-needed" }` instead of auto-responding
  - [x] Run type check

- [x] Test abort scenarios (existing tests in thread.spec.ts all pass - 29/29)
  - [x] Abort while streaming (no active tools)
  - [x] Abort while tool is pending user action (bash_command)
  - [x] Abort while tool is processing (bash_command running)
  - [x] Abort with multiple tools in flight
  - [x] Verify tools provide appropriate abort messages
