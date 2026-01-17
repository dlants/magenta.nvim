I want to do a pretty big refactor.

Currently, it's really awkward because for each provider, we translate from the provider's representation of the messages and events into a shared ProviderMessage format.

We then take all those events and combine them into messages, that are stored outside of the provider.

Then, when we want to send followup messages, we have to convert from those unified ProviderMessage representations back to the provider representation.

During this round trip, we have to be careful to not change the preceding messages, to not accidentally break the cache, which means that this has to be a lossless translation back and forth.

This is quite brittle.

Instead, I want to create a new, stateful controller for the thread. This will have a shared interface called ProviderThread that will allow consumers to extract the conversation state in a unified format, and listen for thread updates.

It should have:

- a list of ProviderMessages
- an optional StreamingMessage
- a thread state (stopped / streaming / etc...)

There should be a way to subscribe to the ProviderThread udpates - when new messages come in, when new tool requests happen, etc...

Each provider should return an object that implements this ProviderThread interface when we `sendMessage`.

Internally, each provider can have its own ProviderThread implementation, so we can store the messages in a native format, listen to the native events in the expected format, and just derive the unified interface and events for the consumption of the rest of the app.

The ProviderThread should expose a unified interface for populating user messages, tool responses, etc... This should be linear / append only (since we can only push onto the end of the thread to avoid breaking the cache). When we populate a message, we should also have an option to trigger a response (to continue the conversation).

the Thread and Message classes should just read off of this ProviderThread state, and augment it (with view state, etc...)

# Context

## Objective

Refactor the provider architecture to eliminate the brittle round-trip translation of messages between unified and provider-specific formats. Each provider will maintain its own stateful thread that stores messages in native format while exposing a unified interface for the UI and tool system.

## Current Problems

1. **Brittle round-trip translation**: Messages flow Thread → Provider → Thread → Provider. The `getMessages()` method in `Thread` reconstructs `ProviderMessage[]` from internal state, then `createStreamParameters()` in each provider converts back to native format.

2. **Cache fragility**: Any change to preceding messages breaks the prompt cache. The lossless translation requirement is hard to maintain, especially for OpenAI which requires `providerMetadata.openai.itemId` to reconstruct messages.

3. **Complex conversion logic**: `createStreamParameters()` in OpenAI is 300+ lines. Tool results, images, documents, thinking blocks all need special handling per provider.

4. **State reconstruction on every send**: `Thread.getMessages()` walks all `Message` objects and rebuilds the message array each time.

## Proposed Solution

Create a `ProviderThread` interface that:

1. Stores messages in native format internally
2. Exposes unified read interface for UI consumption
3. Accepts unified input for user messages / tool results
4. Is created when we send the first message, then reused for follow-ups

## Key Interfaces

```typescript
// The unified interface consumers will use
interface ProviderThread {
  // Read the current state for UI rendering
  getState(): ProviderThreadState;

  // Subscribe to state changes
  subscribe(dispatch: (action: ProviderThreadAction) => void): () => void;

  // Append a user message and optionally trigger response
  appendUserMessage(content: ProviderMessageContent[], respond: boolean): void;

  // Append tool results for completed tool uses nad optionally trigger repsonse
  appendToolResult(toolUseId: ToolRequestId, result: ProviderToolResult, respond: boolean): void;

  // Abort in-flight request
  abort(): void;
}

interface ProviderThreadState {
  status:
    | { type: "idle" }
    | { type: "streaming"; startTime: Date }
    | { type: "stopped"; stopReason: StopReason; usage: Usage }
    | { type: "error"; error: Error };

  // Messages in unified format for UI consumption
  messages: ReadonlyArray<ProviderMessage>;

  // Current streaming block if any
  streamingBlock?: StreamingBlock;
}

// Provider interface change - returns a thread instead of one-shot request
interface Provider {
  createThread(options: {
    model: string;
    systemPrompt: string;
    tools: ProviderToolSpec[];
    thinking?: { enabled: boolean; budgetTokens?: number };
    reasoning?: { effort?: string; summary?: string };
  }): ProviderThread;

  // Keep forceToolUse as one-shot for thread title etc.
  forceToolUse(...): ProviderToolUseRequest;
}
```

## Relevant Files

- `node/providers/provider-types.ts`: Current provider types, will add `ProviderThread`
- `node/providers/anthropic.ts`: Will implement `AnthropicProviderThread`
- `node/providers/openai.ts`: Will implement `OpenAIProviderThread`
- `node/providers/bedrock.ts`: Will extend `AnthropicProviderThread`
- `node/chat/thread.ts`: Will consume `ProviderThread` instead of managing messages directly
- `node/chat/message.ts`: May become simpler or purely view-focused
- `node/providers/helpers.ts`: Some helpers may move into provider threads

## Key Design Decisions

1. **Native storage**: Each provider thread stores messages in whatever format is most efficient for that provider (e.g., OpenAI stores `ResponseInputItem[]`, Anthropic stores `MessageParam[]`)

2. **Unified read interface**: `getState().messages` returns `ProviderMessage[]` for UI, computed lazily or cached

3. **Append-only**: User messages and tool results can only be appended, not modified, preserving cache

4. **Subscription model**: UI subscribes to state changes instead of receiving stream events directly

5. **Tool results handled by provider thread**: When a tool completes, the result is appended to the thread in native format

# Implementation

## Phase 1: Define the interface and create base implementation

- [x] Add `ProviderThread` and `ProviderThreadState` interfaces to `provider-types.ts`
- [x] Create abstract `BaseProviderThread` class with common logic
- [x] Add `createThread()` method signature to `Provider` interface
- [x] Run type checks and fix any errors

## Phase 2: Implement AnthropicProviderThread

- [x] Create `node/providers/anthropic-thread.ts`
- [x] Implement native Anthropic message storage
- [x] Implement `appendUserMessage()` - converts unified to native
- [x] Implement `appendToolResult()` - converts unified to native
- [x] Implement `continueConversation()` - sends request, handles stream
- [x] Implement `getState()` - converts native to unified for UI
- [x] Implement `subscribe()` for state change notifications
- [x] Write unit tests for AnthropicProviderThread
- [x] Iterate until tests pass

## Phase 3: Integrate with Thread class

- [ ] Add `providerThread: ProviderThread` field to `Thread`
- [ ] Update `Thread.sendMessage()` to use `providerThread.appendUserMessage(content, respond: true)`
- [ ] Update tool result flow to use `providerThread.appendToolResult(id, result, respond: true)`
- [ ] Subscribe to `providerThread` actions and update internal state
- [ ] Remove `getMessages()` reconstruction logic (now handled by provider thread)
- [ ] Run type checks and fix errors
- [ ] Run existing tests and fix failures

## Phase 4: Update Message class

- [ ] Simplify `Message` to be view-focused only
- [ ] Remove `streamingBlock` handling (now in provider thread)
- [ ] Update `view()` to read from provider thread state
- [ ] Run type checks and fix errors

## Phase 5: Disable other providers temporarily

- [ ] Update `getProvider()` to throw for non-anthropic providers
- [ ] Add TODO comments for OpenAI, Bedrock, Ollama, Copilot implementations
- [ ] Run full test suite with Anthropic
- [ ] Manual testing

## Phase 6: Update mock provider for testing

- [ ] Create `MockProviderThread` implementation
- [ ] Update test infrastructure to use new interface
- [ ] Run all tests and fix failures

## Future: Implement other providers

After the Anthropic implementation is stable:

- [ ] Implement `OpenAIProviderThread`
- [ ] Implement `BedrockProviderThread` (extends Anthropic)
- [ ] Re-enable Ollama, Copilot providers
