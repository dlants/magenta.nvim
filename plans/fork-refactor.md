# Context

The goal is to make `@fork` operations non-destructive to the source thread.

## Current Flow

1. User types `@fork <prompt>` in input
2. `thread.prepareUserContent` transforms this into a prompt asking agent to use `fork_thread` tool, stores `forkNextPrompt` on the thread
3. Message is sent, agent responds with `fork_thread` tool call
4. `ForkThreadTool.doFork()` dispatches `fork-thread` chat message
5. `Chat.handleForkThread` creates new thread, dispatches `thread-forked` tool message back
6. `ForkThreadTool.update` receives `thread-forked`, sets state to done
7. `Thread.maybeAutoRespond()` sees tool is done, sends tool result, continues conversation

## Problem

After step 7, the original thread continues with the fork result, making the fork operation destructive.

## Desired Behavior

After fork completes:

- Delete messages added for the fork request (user message with @fork instruction + assistant message with fork_thread tool call)
- Reset provider thread status to `stopped` with `end_turn`
- Original thread remains in pre-fork state, allowing further interaction or additional forks

## Relevant Files

- `node/tools/fork-thread.ts`: ForkThreadTool implementation
- `node/chat/chat.ts`: Chat.handleForkThread, dispatches tool messages
- `node/chat/thread.ts`: Thread class, maybeAutoRespond, tool handling
- `node/providers/anthropic-thread.ts`: AnthropicProviderThread, manages message state
- `node/providers/provider-types.ts`: ProviderThread interface

## Key Interfaces

- `ProviderThread`: Interface for provider threads, currently has no method to remove messages
- `ForkThreadTool.state`: `"pending"` | `"done"` with result
- `ProviderThreadStatus`: `idle` | `streaming` | `stopped` | `tool_use` | `yielded` | `error`

## Tool Result Flow (Normal)

When a tool completes, results flow through the system as follows:

1. **Provider thread enters `tool_use` status** after streaming completes with `stop_reason: "tool_use"`
2. **`handleProviderToolUse()` is called** in response to status change
3. **`maybeAutoRespond()` iterates through `state.activeTools`**:
   ```typescript
   for (const [toolId, tool] of this.state.activeTools) {
     if (!tool.isDone()) {
       return { type: "waiting-for-tool-input" };
     }
     // Collect completed tool result
     completedTools.push({
       id: toolId,
       result: {
         type: "tool_result",
         id: toolId,
         result: tool.getToolResult().result,
       },
     });
   }
   ```
4. **`sendToolResultsAndContinue(completedTools, pendingMessages)` is called**:
   - Calls `providerThread.toolResult(id, result)` for each tool - this adds tool_result blocks to provider messages
   - Clears `state.activeTools`
   - Appends a user message with context/system reminder
   - Calls `providerThread.continueConversation()` to start next response

## Fork Interception Strategy

The fork tool should never complete in the traditional sense. Instead:

1. **Capture message index when `@fork` is detected** - In `Thread.prepareUserContent()`, when we detect `@fork` and set `forkNextPrompt`, also store the current message count as `forkMessageIdx`. This is the index we'll truncate back to after fork completes.

2. **ForkThreadTool stays in `pending` state** - Remove the `done` state initialization, keep it `pending`

3. **In `doFork()`**, after dispatching the fork-thread message:
   - Call `thread.truncateAndReset()` which uses the stored `forkMessageIdx`
   - This removes all messages added after the @fork request (user message, assistant message with tool_use, any thinking/other tool calls)
   - Clears `forkNextPrompt` and `forkMessageIdx`
   - Clears `activeTools` as part of truncation

4. **`maybeAutoRespond()` sees no active tools** - Thread is back to pre-fork state

This way the fork is handled synchronously in `doFork()`, the tool never reports as done, and the thread returns to its pre-fork state immediately. The approach is robust to any agent behavior between the @fork request and the fork tool call.

# Implementation

- [x] Add `truncateMessages(messageIdx: number)` method to `ProviderThread` interface
  - [x] Semantics: `truncateMessages(N)` keeps messages 0..N (inclusive), removes everything after
  - [x] Add method signature to `ProviderThread` interface in `provider-types.ts`
  - [x] Implement in `AnthropicProviderThread`:
    - `this.messages.length = messageIdx + 1` to truncate the array
    - Update cached provider messages
    - Set status to `{ type: "stopped", stopReason: "end_turn" }`
    - Dispatch `messages-updated` and `status-changed` actions
  - [x] Check for type errors and iterate until they pass

- [x] Store `forkMessageIdx` when `@fork` is detected
  - [x] In `Thread`, add `forkMessageIdx?: number` as class property alongside `forkNextPrompt`
  - [x] In `Thread.prepareUserContent()`, when setting `forkNextPrompt`, also store current message count:
    - `this.forkMessageIdx = this.providerThread.getState().messages.length`
    - This captures the index BEFORE we add the @fork user message

- [x] Update `Thread` to expose method to truncate and reset
  - [x] Add `truncateAndReset()` method to `Thread` class (no args, uses stored `forkMessageIdx`)
    - Reads `forkMessageIdx` from class property
    - Calls `providerThread.truncateMessages(forkMessageIdx - 1)` to truncate back to pre-fork state
    - Clears `activeTools` map
    - Clears relevant view state for removed messages (indices >= forkMessageIdx)
    - Clears `forkNextPrompt` and `forkMessageIdx`

- [x] Update `ForkThreadTool` to truncate in `doFork()`
  - [x] Change constructor to initialize state as `pending` (remove the `done` initialization)
  - [x] In `doFork()`, after dispatching `fork-thread` message:
    - Get the thread from `this.context.chat.threadWrappers[this.context.threadId]`
    - Call `thread.truncateAndReset()`
  - [x] The tool stays `pending` forever - it will be garbage collected when activeTools is cleared by truncation

- [ ] Test the changes
  - [ ] Manual test: fork a thread, verify source thread returns to pre-fork state
  - [ ] Manual test: fork same thread multiple times
  - [x] Verify type checks pass with `npx tsc --noEmit`
