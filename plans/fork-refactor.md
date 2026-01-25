I want to change the way @fork works. Instead of being done with a tool call, and summarizing the thread so far, I want it to instead just do a straight-up clone of the thread.

So we need to add a "clone" method to the agent. This should assert we are in stopped mode (not streaming). It should make a deep copy of all of the native messages.

When it detects "@fork" at the start of the message (must be the first thing), chat should immediately clone the agent from the active thread, create a new thread using this cloned agent, switch focus to the new thread, then trim the @fork from the user's message, and submit the user message to the new thread.

# interaction with @compact

@fork should be stackable with @compact, so:

@fork @compact next prompt should:

1. clone the thread
2. insert the user message with "@fork" removed, so "@compact next prompt"
3. then the new thread should process the "@compact next prompt" as needed

# context

The relevant files and entities are:

- `node/providers/provider-types.ts`: Defines the `Agent` interface - need to add a `clone()` method
- `node/providers/anthropic-agent.ts`: `AnthropicAgent` implementation - already has `getNativeMessages()` which returns a copy of the native Anthropic messages. Need to implement `clone()`.
- `node/chat/thread.ts`:
  - `Thread` class handles messages and the agent lifecycle
  - `prepareUserContent()` (line ~1140) currently detects `@fork` and sets up `awaiting_control_flow` mode, then modifies the message to ask the model to use the `fork_thread` tool
  - `Mode` type (line ~183) has `{ type: "fork"; nextPrompt: string; truncateIdx: NativeMessageIdx }`
  - `truncateAndReset()` resets the source thread after fork tool completes
- `node/chat/chat.ts`:
  - `Chat` class manages threads
  - `handleForkThread()` (line ~582) creates a new thread from fork tool results
  - `Msg` type includes `fork-thread` message with `contextFilePaths` and `inputMessages`
- `node/tools/fork-thread.ts`: The current `ForkThreadTool` implementation - will be deleted
- `node/tools/index.ts`: Tool registration - need to remove `fork_thread`

# implementation

- [x] Add `clone()` method to `Agent` interface in `node/providers/provider-types.ts`
  - Signature: `clone(dispatch: Dispatch<AgentMsg>): Agent`
  - Must only be called when agent is in stopped state (not streaming)

- [x] Implement `clone()` in `AnthropicAgent`
  - Deep copy all native messages using `getNativeMessages()`
  - Deep copy `messageStopInfo` map
  - Copy `cachedProviderMessages`
  - Create new `AnthropicAgent` with same options/params
  - Assert `this.status.type === "stopped"` or throw error

- [x] Check for type errors and iterate until they pass
- [x] Add unit tests for clone in anthropic-agent.spec.ts, and iterate until they pass

- [x] Update `Thread` to support initialization with a cloned agent
  - Add optional `clonedAgent` parameter to constructor
  - If provided, use the cloned agent instead of creating a new one

- [x] Refactor `@fork` detection in `Thread.prepareUserContent()`
  - Only trigger fork if message starts with `@fork` (use regex like `/^\s*@fork\s*/`)
  - Remove the fork-specific message transformation that prompts for tool use
  - Instead, strip `@fork` from the message and return a signal that fork is requested
  - Remove the `awaiting_control_flow` mode setting for fork

- [x] Update `Chat.Msg` type
  - Modify `fork-thread` message to include `sourceThreadId` and `strippedMessages` (messages with @fork removed)
  - Remove `contextFilePaths` and `inputMessages` with system summary since we're cloning

- [x] Update `Chat.handleForkThread()`
  - Get source thread and its agent
  - Assert agent is stopped, abort if streaming
  - Call `agent.clone()` to get cloned agent
  - Create new thread with cloned agent
  - Switch focus to new thread
  - Send the stripped user message to new thread

- [x] Handle fork in `Thread.sendMessage()` or `Thread.myUpdate()` for `send-message`
  - Check if message contains `@fork`
  - If so, dispatch `fork-thread` to Chat instead of processing locally
  - Chat handles the clone and thread creation

- [x] Check for type errors and iterate until they pass

- [x] Delete `node/tools/fork-thread.ts`

- [x] Remove `fork_thread` from tool registration in `node/tools/index.ts`
  - Remove import
  - Remove from `TOOL_SPECS`
  - Remove from `initTool()` switch statement

- [x] Clean up `Mode` type in `Thread`
  - Remove `fork` from `ControlFlowOp` type
  - Remove fork-related branches in `awaiting_control_flow` handling
  - Remove `truncateAndReset()` method or simplify it

- [x] Check for type errors and iterate until they pass

- [x] Update system prompt in `node/providers/system-prompt.ts`
  - Remove `fork_thread` tool description if present

- [x] Write tests for the new fork behavior
  - Test that @fork clones the thread
  - Test that @fork @compact works (clone then compact)
  - Test that @fork with additional text sends that text to the new thread

- [x] Run tests and iterate until they pass
