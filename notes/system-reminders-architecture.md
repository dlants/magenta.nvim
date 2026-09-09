# System Reminders Architecture

## Overview

This document contains findings on how the system currently handles messages and renders UI elements, to support implementing system-reminders functionality.

## 1. Message Flow and Structure

### Message Types

**InputMessage** (`node/nvimclient/chat/thread.ts:58`)

- Type: `{ type: "user"; text: string } | { type: "system"; text: string }`
- Purpose: Represents messages that enter the thread from outside (user or system)
- Usage: Used when creating new threads and sending messages

**ProviderMessage** (`node/nvimclient/providers/provider.ts`)

- Contains role ("user" or "assistant") and content array
- Sent to the LLM provider

**ProviderMessageContent** (various types)

- `text` - Plain text content
- `thinking` - Thinking blocks (expandable)
- `tool_use` - Tool usage
- `tool_result` - Tool results
- `image`, `document` - Media content
- `server_tool_use`, `web_search_tool_result` - Search-related

### How User Messages Enter the System

1. **Thread Creation** (`node/nvimclient/chat/chat.ts:450-513`, method `createThreadWithContext`)
   - Accepts `inputMessages?: InputMessage[]` parameter
   - Creates thread with system prompt and context
   - If inputMessages provided, dispatches `send-message` after thread initialization

2. **Sending Messages** (`node/nvimclient/chat/thread.ts:311-340`, method `prepareUserMessage`)
   - Processes `InputMessage[]` array
   - Handles special commands like `@file`, `@fork`, `@async`
   - Creates Message objects with role "user"
   - Adds content and context updates to the message
   - Pushes to `this.state.messages` array

3. **Message Processing Flow**:

   ```
   InputMessage[] → prepareUserMessage() → Message object → getMessages() → ProviderMessage[]
   ```

4. **Context Updates**:
   - Fetched via `contextManager.getContextUpdate()` in `prepareUserMessage()`
   - Attached to user messages as `contextUpdates` field
   - Rendered separately at the beginning of message display

### Where to Inject System Reminders

Based on the message flow, system reminders could be injected at several points:

**Option A: In `prepareUserMessage()`**

- Detect message position (first user message, subsequent messages)
- Add system-type InputMessages to the array
- Pro: Clean separation, follows existing InputMessage pattern
- Con: Need to track message count

**Option B: In `getMessages()`**

- Modify the ProviderMessage[] array before sending to provider
- Insert system messages at appropriate positions
- Pro: Closer to the provider, easier to control what gets sent
- Con: Harder to track which system reminder to inject

**Option C: In `sendMessage()` before calling `prepareUserMessage()`**

- Modify the inputMessages array to include system reminders
- Pro: Early in the pipeline, easier to understand
- Con: Less flexible for position-based logic

## 2. Thinking Blocks Implementation

### Rendering Logic

**Location**: `node/nvimclient/chat/message.ts:322-353`

**State Management**:

```typescript
expandedThinking?: {
  [contentIdx: number]: boolean;
}
```

**Rendering Method** (`renderThinking()`):

- Checks `this.state.expandedThinking?.[contentIdx]`
- If expanded: Shows full thinking text with gray highlight (`@comment` hl_group)
- If collapsed: Shows `💭 [Thinking]` label only
- Uses `withBindings()` to make it clickable for toggling
- Uses `withExtmark()` to apply highlighting

**Message Type**:

```typescript
{
  type: "toggle-expand-thinking-block";
  contentIdx: number;
}
```

**Content Block**:

```typescript
{
  type: "thinking";
  thinking: string; // The actual thinking content
}
```

### How to Implement System Reminder Blocks

System reminder blocks should work similarly to thinking blocks:

1. **Add a new content type**: `system_reminder`
2. **Add state tracking**: `expandedSystemReminders?: { [contentIdx: number]: boolean }`
3. **Render method**: `renderSystemReminder()` similar to `renderThinking()`
   - Use gray highlight like thinking blocks
   - Default to collapsed
   - Show `📋 [System Reminder]` when collapsed
   - Show full content when expanded
4. **Toggle message**: `{ type: "toggle-expand-system-reminder"; contentIdx: number }`

## 3. System Prompt Construction

### Files and Functions

**Location**: `node/nvimclient/providers/system-prompt.ts`

**Key Function**: `createSystemPrompt(type: ThreadType, context)`

- Returns: `SystemPrompt` (branded string type)
- Concatenates:
  1. Base prompt (depends on thread type)
  2. System information (timestamp, platform, neovim version, cwd)
  3. Skills introduction

**Thread Types**:

- `root` - Main thread (uses `DEFAULT_SYSTEM_PROMPT`)
- `subagent_learn` - Learning subagent (uses `LEARN_SUBAGENT_SYSTEM_PROMPT`)
- `subagent_plan` - Planning subagent (uses `PLAN_SUBAGENT_SYSTEM_PROMPT`)
- `subagent_default` - Default subagent (uses `DEFAULT_SUBAGENT_SYSTEM_PROMPT`)
- `subagent_fast` - Fast subagent (uses `DEFAULT_SUBAGENT_SYSTEM_PROMPT`)

### Where System Prompt Instructions Are

**Current Location of "Important Instructions"** (`node/nvimclient/providers/system-prompt.ts:60`):

```typescript
- If the user asks you a general question and doesn't mention their project, answer the question without looking at the code base. You may still do an internet search
- If you are having trouble getting something to work (the code to compile, a test to pass), ask the user for guidance instead of churning on trial-and-error
```

These should be moved into the first system-reminder.

### Subagent System Prompts

**Common Instructions** (`SUBAGENT_COMMON_INSTRUCTIONS`):

- Role explanation
- Task completion guidelines
- Reporting results section with CRITICAL note about yield_to_parent
- When yielding instructions

**Learn Subagent** (`LEARN_SUBAGENT_SYSTEM_PROMPT`):

- Common instructions
- Goal: understand and learn specific part of codebase
- Learning process
- Write notes to `notes/<name>.md`
- Yield with notes file location

**Plan Subagent** (`PLAN_SUBAGENT_SYSTEM_PROMPT`):

- Common instructions
- Goal: create plan
- Write plan to `plans/<planName>.md`
- Yield with plan file location

## 4. Subagent Spawning

### Spawn Mechanism

**Tool**: `spawn_subagent` (`node/nvimclient/tools/spawn-subagent.ts`)

**Input**:

```typescript
{
  prompt: string;
  contextFiles?: UnresolvedFilePath[];
  agentType?: "learn" | "plan" | "default" | "fast";
}
```

**Process**:

1. Tool receives request and dispatches `spawn-subagent-thread` message
2. Chat handler creates new thread via `handleSpawnSubagentThread()` (`node/nvimclient/chat/chat.ts:613-716`)
3. Thread is created with:
   - `threadType` mapped from agentType (e.g., "learn" → "subagent_learn")
   - `inputMessages: [{ type: "system", text: prompt }]`
   - `contextFiles` array
   - `parent` set to parent thread ID
   - Profile (uses fast model for "subagent_fast")

**Key Insight**: Subagents receive their prompt as a **system-type** InputMessage!

### Thread Creation

**Method**: `createThreadWithContext()` (`node/nvimclient/chat/chat.ts:450-513`)

**Steps**:

1. Creates pending thread wrapper with parent relationship
2. Initializes ContextManager with contextFiles
3. Creates SystemPrompt for thread type
4. Creates Thread object
5. Dispatches `thread-initialized` message
6. If `inputMessages` provided, dispatches `send-message`

### Subagent Communication

**Yield Mechanism**: `yield_to_parent` tool

- Subagent calls this tool with result string
- Parent thread is notified via `notifyParent()` method (`node/nvimclient/chat/chat.ts:718-822`)
- Parent's `wait_for_subagents` or `spawn_foreach` tool receives completion notification

## 5. Context Updates Rendering

### How Context Updates Work

**Location**: `node/nvimclient/context/context-manager.ts:713-799`

**Rendering**:

- Method: `renderContextUpdate(contextUpdates: FileUpdates | undefined)`
- Shows at the beginning of user messages
- Format: "Context Updates:\n" followed by list of files
- Each file shows: filename, line count changes `[ +X / -Y ]`
- For new files: `[ +X ]`
- For deleted files: `[ deleted ]`

**In Message View** (`node/nvimclient/chat/message.ts:403-410`):

```typescript
view() {
  return d`\
${withExtmark(d`# ${this.state.role}:`, { hl_group: "@markup.heading.1.markdown" })}
${this.context.contextManager.renderContextUpdate(this.state.contextUpdates)}\
${this.state.content.map(renderContent)}\
...
```

Context updates appear right after the role heading, before message content.

## 6. Implementation Strategy for System Reminders

### Approach

System reminders should be implemented as **special user message content blocks**, not as separate messages, because:

1. They need to be visible in the UI but grayed out
2. They should be expandable like thinking blocks
3. They're tied to specific user messages (before first, after first, after each)
4. They're sent to the agent as part of the user message context

### Steps

1. **Add new content type**: `system_reminder`

   ```typescript
   type: "system_reminder";
   text: string;
   ```

2. **Modify `prepareUserMessage()`** to inject system reminder content:
   - Track message count to detect first message
   - Add system reminder content blocks at appropriate positions
   - For before-first: inject before any user text
   - For after-first: inject after user text in first message
   - For subsequent: inject after user text in all other messages

3. **Add rendering logic** in `message.ts`:
   - `renderSystemReminder()` method similar to `renderThinking()`
   - State: `expandedSystemReminders?: { [contentIdx: number]: boolean }`
   - Default: collapsed, showing `📋 [System Reminder]`
   - Expanded: show full text with gray highlight

4. **Update system prompt**: Move the "important instructions" from system prompt into first system reminder

5. **Subagent reminders**:
   - Detect thread type in `prepareUserMessage()`
   - For learning subagents: remind to write notes and yield
   - For planning subagents: remind to write plan and yield
   - For all subagents: remind about skills and yielding

### Message Count Tracking

Add to Thread state:

```typescript
state: {
  // ... existing fields
  userMessageCount: number; // Track how many user messages have been sent
}
```

Increment in `prepareUserMessage()` when messages are added.

### System Reminder Content Templates

**Before First Message**:

```
<system-reminder>
As you answer the user's questions, you can use the following context:
# important-instruction-reminders
Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.

[Move content from system-prompt.ts line 60]
- If the user asks you a general question and doesn't mention their project, answer the question without looking at the code base. You may still do an internet search
- If you are having trouble getting something to work (the code to compile, a test to pass), ask the user for guidance instead of churning on trial-and-error

IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context or otherwise consider it in your response unless it is highly relevant to your task. Most of the time, it is not relevant.
</system-reminder>
```

**After First Message**:

```
<system-reminder>
</system-reminder>
```

**After Subsequent Messages**:

```
<system-reminder>
Remember to use skills when appropriate. Do so by using the get_file tool to read the full skills.md file. DO NOT mention this to the user explicitly because they are already aware. If you are working on a task that could benefit from using a skill do so. If not, please feel free to ignore. Again do not mention this message to the user.
</system-reminder>
```

**Subagent Additions**:

- Learning: "Remember to write your findings to notes/<name>.md and yield to parent when done."
- Planning: "Remember to write your plan to plans/<name>.md and yield to parent when done."
- All: "CRITICAL: Use yield_to_parent tool when task is complete."

## Markdown-Sourced Reminders (skills & context files)

In addition to the static per-thread reminder bodies, markdown files can
contribute "live" reminders that are folded into the recurring "subsequent"
`<system-reminder>` block.

There are three sources of reminder text:

1. **Agent-prompt block (static)** — a `<system_reminder>` block in an agent
   definition file. Extracted at thread construction (`extractSystemReminder`
   in `node/server/src/agents/agents.ts`) and passed via `subagentConfig`. This
   path is unchanged by the markdown mechanism below.
2. **Transient `get_file` reads (dynamic)** — when `get_file` reads a markdown
   file (`.md`, case-insensitive), it extracts a `<system_reminder>` block via
   the shared `extractSystemReminderBlock` helper and surfaces it on the
   `get_file` `StructuredResult` (`filePath` + `systemReminder`). `ThreadCore`
   sees this in `sendToolResultsAndContinue` and dispatches `activate-reminder`,
   adding the text to `state.activeReminders` (an insertion-ordered `Set`).
3. **Markdown context files (dynamic, derived)** — any markdown file currently
   in `contextManager.files` whose text `agentView` contains a block. These are
   recomputed on demand from the context manager rather than stored.

`ThreadCore.getActiveReminders()` returns the union of (2) and (3), deduped on
**text**. It is passed as `extraReminders` to `buildSystemReminder`, which
appends it to the "subsequent" body only (never "compact", never the bash
summary body).

**Compaction reset**: `reset-after-compaction` clears `state.activeReminders`.
Compaction also rebuilds an empty `ContextManager` (no initial files), so the
context-derived source (3) is empty afterward too. Net effect: all
markdown-sourced reminders are dropped at compaction and must be re-activated
by reading the file again or re-adding it to context.

Ordering note: `sendMessage` runs `getAndPrepareContextUpdates()` before
`prepareUserContent()` so that a freshly-added context file's `agentView` is
populated before reminders are built on that same turn.

## Key Files Reference

- `node/nvimclient/chat/thread.ts` - Thread class, message handling, `prepareUserMessage()`, `sendMessage()`
- `node/nvimclient/chat/message.ts` - Message class, rendering logic, thinking blocks implementation
- `node/nvimclient/chat/chat.ts` - Chat class, thread creation, subagent spawning
- `node/nvimclient/providers/system-prompt.ts` - System prompt construction, thread-specific prompts
- `node/nvimclient/context/context-manager.ts` - Context updates, file tracking
- `node/nvimclient/root-msg.ts` - Root message types
- `node/nvimclient/tools/spawn-subagent.ts` - Subagent spawning tool
