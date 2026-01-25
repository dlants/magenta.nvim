# Context

I want to add a new tool - compact.

It should work like this:

- we should create a checkpoint at the end of every user message we send to the agent. These would be messages that are typed out by the user, but also when we send system reminders after providing tool results
- these should be simple simple text messages: <checkpoint abcdef>. Short, alphanumeric sequences that are unique to the thread.
- we should then create a new tool: 'compact'
- the tool should be invoked with the following structure:

```
replace: {
    from?: string;
    to?: string;
    value: string;
}[]
```

from and to are checkpoint values.

- When the tool executes, we should replace all the content between the checkpoints with an assistant message with the provided value.
- if `to` is not defined, we should replace everything from the `from` checkpoint to the end of the thread
- if `from` is not defined, we should replace everything from the beginning of the thread up to the `to` checkpoint
- if value is empty, we should just delete the given range
- we should also strip all the `<system reminder>` blocks from the user messages, and all <thinking> blocks from the assistant messages.

for example:

```
# user
<content>
<system reminder>
<checkpoint aaaaaa>

# assistant
<thinking>
<content>
<tool request 1>

# user
<tool response 1>
<system reminder>
<checkpoint bbbbbb>

# assistant
<thinking>
<content>
<tool request 2>

# user
<tool response 2>
<system reminder>
<checkpoint cccccc>

# assistant
<thinking>
<content>
```

replacing from aaaaaa to cccccc would result in:

```
# user
<content>
<checkpoint aaaaaa>

# assistant
<replace value>

# assistant
<content>
```

replacing from aaaaaa to undefined would result in:

```
# user
<content>
<checkpoint aaaaaa>

# assistant
<replace value>
```

replacing from undefined to cccccc would result in:

```
# assistant
<replace value>

# assistant
<content>
```

When the agent emits a tool request to compact, we apply the changes to the thread.

If the tool_use request is still part of the thread after compaction, we replace that request with a "I compacted the thread" text message. If not, then we don't have anything to clean up.

Finally, when we're done, we should continue the thread to give the agent an opportunity to resume its work.

## Relevant files and entities

- `node/chat/thread.ts`: The `Thread` class manages conversation state and message handling. Key methods:
  - `sendMessage()` and `prepareUserContent()` - where user messages are constructed (system reminders added here)
  - `sendToolResultsAndContinue()` - where tool result messages are sent with system reminders
  - `maybeAutoRespond()` - handles auto-responding after tool completion
- `node/providers/anthropic-thread.ts`: `AnthropicProviderThread` manages the native Anthropic message array. Key methods:
  - `truncateMessages()` - removes messages after a given index
  - `getNativeMessages()` - returns copy of native messages (useful for manipulation)
  - `messages` - private array of `Anthropic.MessageParam[]`
- `node/providers/provider-types.ts`: Defines `ProviderThread` interface, `ProviderMessage`, `ProviderMessageContent`
- `node/tools/tool-registry.ts`: Lists available tools in `STATIC_TOOL_NAMES` and `CHAT_STATIC_TOOL_NAMES`
- `node/tools/toolManager.ts`: Maps tool names to specs and controllers, exports `getToolSpecs()`
- `node/tools/create-tool.ts`: Factory function for creating tool instances
- `node/tools/types.ts`: Defines `Tool`, `StaticTool`, `ToolRequest` interfaces
- `node/tools/fork-thread.ts`: Example of a tool that modifies thread state (good reference pattern)
- `node/providers/system-reminders.ts`: `getSubsequentReminder()` generates system reminder text

## Key types

```typescript
// From provider-types.ts
type ProviderMessage = {
  role: "user" | "assistant";
  content: Array<ProviderMessageContent>;
  stopReason?: StopReason;
  usage?: Usage;
};

type ProviderMessageContent =
  | ProviderTextContent        // { type: "text", text: string }
  | ProviderThinkingContent    // { type: "thinking", thinking: string, signature: string }
  | ProviderSystemReminderContent  // { type: "system_reminder", text: string }
  | ProviderToolUseContent     // { type: "tool_use", id, name, request }
  | ProviderToolResult         // { type: "tool_result", id, result }
  | ... // images, documents, etc.
```

## Design decisions

1. **Checkpoint format**: `<checkpoint:xxxxxx>` where `xxxxxx` is a 6-character alphanumeric ID. Stored as a separate text block at the end of user messages.

2. **Checkpoint type**: New `ProviderCheckpointContent` type: `{ type: "checkpoint", id: string }`

3. **Compact tool input schema**:

```typescript
type Input = {
  replacements: Array<{
    from?: string; // checkpoint id, undefined = start of thread
    to?: string; // checkpoint id, undefined = end of thread
    summary: string; // replacement content (empty = delete)
  }>;
};
```

4. **Implementation approach**:
   - Add a new method to `ProviderThread` interface: `compact(replacements)` that manipulates the native message array
   - The compact tool calls this method, which handles all the message manipulation
   - After compaction, the thread continues automatically

5. **Stripping logic**:
   - Remove `<system-reminder>` blocks from user messages
   - Remove `<thinking>` blocks from assistant messages
   - Keep checkpoint markers (needed for future compactions)
   - The user message containing the `from` checkpoint keeps content before the checkpoint
   - The user message containing the `to` checkpoint keeps content after the checkpoint

# Implementation

- [x] **Phase 1: Add checkpoint infrastructure**
  - [x] Add `ProviderCheckpointContent` type to `provider-types.ts`: `{ type: "checkpoint", id: string }`
  - [x] Add checkpoint to `ProviderMessageContent` union type
  - [x] Create `node/chat/checkpoint.ts` with:
    - [x] `generateCheckpointId(): string` - generates 6-char alphanumeric ID
    - [x] `createCheckpointContent(id: string): ProviderCheckpointContent`
  - [x] Update `thread.ts` `prepareUserContent()` to append checkpoint content after system reminder
  - [x] Update `thread.ts` `sendToolResultsAndContinue()` to append checkpoint content after system reminder
  - [x] Update `anthropic-thread.ts` `convertInputToNative()` to handle checkpoint type (convert to text block)
  - [x] Update `anthropic-thread.ts` `convertBlockToProvider()` to detect checkpoint text blocks and convert back
  - [x] Run type checks and iterate until no errors

- [x] **Phase 2: Add compact method to ProviderThread**
  - [x] Add `compact()` method signature to `ProviderThread` interface in `provider-types.ts`:
    ```typescript
    compact(replacements: Array<{
      from?: string;
      to?: string;
      summary: string;
    }>): void;
    ```
  - [x] Implement `compact()` in `AnthropicProviderThread`:
    - [x] Find message indices for each checkpoint
    - [x] For each replacement:
      - [x] Identify the message range to replace
      - [x] Strip system_reminder and thinking blocks from messages being kept
      - [x] Insert summary as assistant message text block
      - [x] Remove messages in the range
    - [x] Update cached provider messages
    - [x] Emit messages-updated event
  - [x] Run type checks and iterate until no errors
  - [x] Write unit tests for `compact()` method
  - [x] Iterate until tests pass

- [x] **Phase 3: Create compact tool**
  - [x] Create `node/tools/compact.ts`:
    - [x] Define `spec: ProviderToolSpec` with input schema for replacements array
    - [x] Define `Input` type
    - [x] Define `ToolRequest` type
    - [x] Define `Msg` type (just `{ type: "finish" }`)
    - [x] Define `State` type (pending | done)
    - [x] Implement `CompactTool` class:
      - [x] Constructor calls `context.thread.providerThread.compact()` immediately
      - [x] Then dispatches finish message to self
    - [x] Implement `validateInput()`
    - [x] Implement `renderCompletedSummary()`
  - [x] Register tool in `tool-registry.ts`:
    - [x] Add `"compact"` to `STATIC_TOOL_NAMES`
    - [x] Add `"compact"` to `CHAT_STATIC_TOOL_NAMES`
  - [x] Register tool in `toolManager.ts`:
    - [x] Import `* as Compact from "./compact.ts"`
    - [x] Add to `StaticToolMap` type
    - [x] Add to `TOOL_SPEC_MAP`
    - [x] Add case to `renderCompletedToolSummary()`
  - [x] Register tool in `create-tool.ts`:
    - [x] Import `* as Compact from "./compact.ts"`
    - [x] Add case to `createTool()` switch
  - [x] Run type checks and iterate until no errors

- [x] **Phase 4: Handle tool_use cleanup**
  - [x] The compact tool_use is always in the latest assistant message, which is never in a compaction range (checkpoints are in user messages)
  - [x] Tool result is added normally after compaction
  - [x] Auto-respond continues the conversation as expected

- [ ] **Phase 5: Integration testing**
  - [ ] Write integration test in `node/tools/compact.spec.ts`:
    - [ ] Test basic compaction (from checkpoint A to checkpoint B)
    - [ ] Test compaction from start (from undefined to checkpoint)
    - [ ] Test compaction to end (from checkpoint to undefined)
    - [ ] Test empty summary (deletion)
    - [ ] Test multiple replacements
    - [ ] Test that system reminders are stripped
    - [ ] Test that thinking blocks are stripped
  - [ ] Iterate until tests pass

- [ ] **Phase 6: Add tool description for agent**
  - [ ] Write clear tool description explaining:
    - [ ] When to use compact (long threads, repetitive content)
    - [ ] How checkpoints work
    - [ ] Best practices for writing summaries
