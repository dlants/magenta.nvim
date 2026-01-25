# Context

The goal is to refactor the state management between `ProviderThread` and `Thread` to create cleaner separation of concerns.

## Current Problems

1. `ConversationState` duplicates `ProviderThreadStatus` (both have idle/streaming/stopped/error)
2. State synchronization is complex - Thread mirrors ProviderThread state via event handlers
3. Control flow operations (compact, fork, yield) are tools but don't follow normal tool lifecycle
4. The name "ProviderThread" doesn't communicate its role as an external actor

## Design Decision

- Rename `ProviderThread` → `Agent` (conceptually an external actor like the user)
- `ConversationMode` tracks only Thread-specific concerns:
  - `normal` - default state, Thread follows Agent events
  - `tool_use` - processing regular tool requests
  - `control_flow` - processing compact/fork/yield operations
- Thread reads `agent.getState().status` for display but doesn't duplicate it
- Centralize tool_use interpretation in a single function

## Communication Model

**Thread → Agent (synchronous method calls):**

- `appendUserMessage(content)` - add user message
- `toolResult(id, result)` - provide tool result
- `continueConversation()` - start/resume streaming
- `abort()` - cancel current operation
- `truncateMessages(idx)` - truncate for fork
- `compact(replacements)` - execute compaction

Synchronous because Thread is the orchestrator and Agent is a service it owns.
When Thread calls a method, Agent's state updates immediately, ensuring view consistency.

**Agent → Thread (asynchronous message dispatch):**

Replace EventEmitter with explicit messages dispatched into Thread's message loop:

```typescript
type AgentMsg =
  | { type: "agent-content-updated" } // messages or streamingBlock changed
  | { type: "agent-stopped"; stopReason: StopReason; usage?: Usage }
  | { type: "agent-error"; error: Error };
```

This makes Agent communicate with Thread the same way the user does - via async messages.
The Thread processes these in its `myUpdate` handler, maintaining unidirectional data flow.

**Why the asymmetry?**

| Direction      | Nature                  | Why                                       |
| -------------- | ----------------------- | ----------------------------------------- |
| Thread → Agent | Command ("do this")     | Thread orchestrates; Agent is a service   |
| Agent → Thread | Event ("this happened") | Agent does async work, notifies when done |

Analogy: Calling a database API (sync) vs receiving webhooks (async).
Thread _commands_ Agent synchronously. Agent _notifies_ Thread asynchronously.

## Key Types

```typescript
// New ConversationMode (replaces ConversationState)
type ConversationMode =
  | { type: "normal" }
  | { type: "tool_use"; activeTools: Map<ToolRequestId, Tool | StaticTool> }
  | { type: "control_flow"; operation: ControlFlowOp };

type ControlFlowOp =
  | { type: "compact"; nextPrompt?: string; truncateIdx?: NativeMessageIdx }
  | { type: "fork"; nextPrompt: string; truncateIdx: NativeMessageIdx }
  | { type: "yield"; response: string };
```

## Relevant Files

- `node/providers/provider-types.ts` - Defines `ProviderThread` interface and types
- `node/providers/anthropic-thread.ts` - Main implementation of `ProviderThread`
- `node/chat/thread.ts` - Uses `ProviderThread`, defines `ConversationState`
- `node/inline-edit/inline-edit-app.ts` - Uses `ProviderThread` for context
- `node/providers/anthropic.ts`, `mock.ts`, `openai.ts`, etc. - Provider implementations

# Implementation

## Phase 1: Rename ProviderThread → Agent ✅

- [x] In `node/providers/provider-types.ts`:
  - [x] Rename `ProviderThread` interface to `Agent`
  - [x] Rename `ProviderThreadStatus` to `AgentStatus`
  - [x] Rename `ProviderThreadState` to `AgentState`
  - [x] Rename `ProviderThreadInput` to `AgentInput`
  - [x] Removed `ProviderThreadEvents` (replaced with dispatch)
  - [x] Rename `ProviderThreadOptions` to `AgentOptions`
  - [x] Define `AgentMsg` type for Agent → Thread communication
  - [x] Update `Agent` interface to accept a dispatch function instead of extending EventEmitter

- [x] In `node/providers/anthropic-thread.ts`:
  - [x] Rename file to `node/providers/anthropic-agent.ts`
  - [x] Rename `AnthropicProviderThread` class to `AnthropicAgent`
  - [x] Replace EventEmitter with dispatch function passed to constructor
  - [x] Replace `this.emit(...)` calls with `this.dispatch(...)` calls
  - [x] Update all internal references

- [x] Update all provider files that reference the renamed types:
  - [x] `node/providers/anthropic.ts`
  - [x] `node/providers/mock.ts`
  - [x] `node/providers/provider.ts`
  - Note: openai.ts, copilot.ts, ollama.ts are currently disabled/commented out

- [x] Update test file:
  - [x] Rename `node/providers/anthropic-thread.spec.ts` to `node/providers/anthropic-agent.spec.ts`
  - [x] Update class references in tests
  - [x] Update tests to provide dispatch function

- [x] Update consumers:
  - [x] `node/chat/thread.ts` - rename `providerThread` field to `agent`
  - [x] `node/chat/thread.ts` - pass dispatch function to agent constructor
  - [x] `node/chat/chat.ts` - rename `getContextThread` to `getContextAgent`
  - [x] `node/inline-edit/inline-edit-app.ts` - update type references
  - [x] `node/magenta.ts` - update `getContextThread` to `getContextAgent`
  - [x] `node/tools/compact.ts` - update `providerThread` to `agent`
  - [x] `node/tools/helpers.ts` - update `ProviderStreamingBlock` to `AgentStreamingBlock`

- [x] Run `npx tsc --noEmit` and fix any type errors

## Phase 2: Refactor ConversationState → ConversationMode ✅

- [x] In `node/chat/thread.ts`:
  - [x] Define new `ControlFlowOp` type
  - [x] Define new `ConversationMode` type (without idle/streaming/stopped/error)
  - [x] Rename `state.conversationState` to `state.mode`

- [x] Update all references to use new mode + agent status:
  - [x] `agentDispatch` - simplified to not duplicate agent status
  - [x] `send-message` handler - checks agent status and mode
  - [x] `tool-msg` handler - checks agent status for aborted
  - [x] `handleProviderStoppedWithToolUse` - sets mode to tool_use or control_flow/yield
  - [x] `handleCompactRequest` - sets mode to control_flow/compact
  - [x] `handleProviderStopped` - resets mode to normal
  - [x] `handleToolMsg` - uses mode.activeTools
  - [x] `abortInProgressOperations` - uses mode.activeTools
  - [x] `maybeAutoRespond` - reads agent status and mode
  - [x] `sendToolResultsAndContinue` - resets mode to normal
  - [x] `playChimeIfNeeded` - reads agent status and mode

- [x] Update view rendering (`renderStatus`):
  - [x] Read agent status directly for streaming/idle/error display
  - [x] Read `mode` for tool_use/control_flow display
  - [x] Compose both for complete status view

- [x] Update `chat.ts` consumers:
  - [x] Thread notification to parent
  - [x] `getSubagentResult`
  - [x] `getThreadSummary`
  - [x] `notifyParent`

- [x] Update test file `bashCommand.spec.ts` to use `mode`

- [x] Run `npx tsc --noEmit` - passes
- [x] Run agent tests - 35 passing
- [x] Run chat tests - 57 passing
- [x] Run bashCommand tests - 33 passing

## Phase 3: Clean Up and Test

- [x] Remove now-unused code:
  - [x] Remove `isCompactToolUseRequest()` method (logic moved to interpretToolUse)
  - [x] Simplify event handler since it no longer mirrors state

- [x] Update inline-edit if it uses ConversationState

- [x] Run existing tests: `npx vitest run node/providers/anthropic-agent.spec.ts`

- [x] Run existing tests: `npx vitest run node/chat/`

- [x] Manual testing:
  - [x] Verify normal conversation flow
  - [x] Verify tool use works
  - [x] Verify compact operation
  - [x] Verify fork operation
  - [x] Verify yield_to_parent
  - [x] Verify abort works in all states
