I want to revamp how compact works.

Instead of a tool, it should be a chat-level feature, like @fork.

When the user invokes @compact, we will take the current thread, and _render it into a markdown file_.

When we do this, we:

- remove all the thinking blocks
- remove all the get_file reads and context updates, and replace them with summaries, like: "read file xxx", or "context update from file xxx"
- remove all the system reminders

We drop this markdown into a temporary file.

We then spin up a compaction agent. This is a _fast agent_. This agent gets the contents of the file. It gets access to the edl tool, and permission to read just that one file.

After the contents of the file, the compact agent gets instructions to edit the file to reduce its size (similar to the compact message we send now). It should use the edl tool to:

- cut out parts of the file where we iterated a bunch before arriving at a result, and just replace it with the result
- remove any parts of the file that are not relevant to the next prompt

When the compaction agent stops, we take the final contents of the markdown file, and insert it as text content into a fresh agent (what we do now when the compact tool returns).

We then append the user's post-@compact message, as we do now, and kick off the fresh thread.

# Context

## Objective

Replace the current compact mechanism (which relies on the main agent calling a `compact` tool to produce a summary) with a new flow where the thread is rendered to markdown, a fast subagent edits it down using EDL, and the result is injected as a fresh thread.

## Relevant files and entities

- `node/chat/thread.ts`: `Thread` class — handles `@compact` detection in `prepareUserContent()` (line ~1103), `handleCompactRequest()` (line ~545), `maybeAutoRespond()` compact branch (line ~900), `resetContextManager()` (line ~606). This is where the new flow will primarily live.
- `node/providers/provider-types.ts`: `ProviderMessage`, `ProviderMessageContent` — the message/content types that need to be rendered to markdown.
- `node/providers/anthropic-agent.ts`: `AnthropicAgent.compact()` / `executeCompact()` (line ~474) — current compaction logic that replaces messages with a summary. Will still be used but with a different summary source.
- `node/chat/chat.ts`: `Chat` class — `handleSpawnSubagentThread()` (line ~753), `createThreadWithContext()` (line ~368). Provides the pattern for spawning subagent threads.
- `node/tools/tool-registry.ts`: `SUBAGENT_STATIC_TOOL_NAMES` — tool list for subagents. The compact subagent needs a custom subset (just `edl` + `get_file` for the temp file).
- `node/tools/compact.ts`: `CompactTool` — the current compact tool. Will be removed.
- `node/chat/commands/fork.ts`: `forkCommand` — reference pattern for how `@fork` works as a chat command.
- `node/providers/system-prompt.ts`: `getBaseSystemPrompt()`, `AgentType` — system prompt generation, agent types.
- `node/root-msg.ts`: `RootMsg` — root message type.

## Current compact flow

1. User types `@compact <next prompt>` → `prepareUserContent()` replaces user text with instructions telling the agent to call the compact tool
2. Agent responds with a `compact` tool_use containing `{summary, contextFiles?, continuation?}`
3. `handleProviderStopped()` → `isCompactToolUseRequest()` detects it → `handleCompactRequest()`
4. `handleCompactRequest()` resets context manager, calls `agent.compact({summary})`
5. `agent.compact()` replaces all messages with just the summary text
6. `maybeAutoRespond()` sends `nextPrompt` as a new user message

## New compact flow

1. User types `@compact <next prompt>`
2. Thread renders its messages to a temporary markdown file (filtering out thinking, summarizing get_file/context_updates, removing system reminders)
3. Thread spawns a compact subagent (fast model, EDL-only tools + get_file for the temp file)
4. The subagent receives the file path and contents as input, uses EDL to cut it down
5. When the subagent stops, Thread reads back the edited file contents
6. Thread calls `agent.compact({summary: editedMarkdown})`
7. Thread resets context manager and continues with `nextPrompt`

# Implementation

- [ ] **Step 1: Create `renderThreadToMarkdown()` function**
  - [ ] Add a new function (in `node/chat/thread.ts` or a new `node/chat/compact-renderer.ts`) that takes `ProviderMessage[]` and renders them to a markdown string
  - [ ] For each message, render a `# user:` or `# assistant:` header
  - [ ] Render content blocks:
    - `text` → render as-is
    - `thinking` / `redacted_thinking` → skip entirely
    - `system_reminder` → skip entirely
    - `context_update` → render as `[context update from files]` (extract filenames from text)
    - `tool_use` → render the tool name and full input as JSON
    - `tool_result` → for `get_file`: just render "read file successfully" or "failed to read file" (do NOT include file contents). For all other tools: render the full tool output text.
    - `image` → `[Image]`
    - `document` → `[Document: <title>]`
    - `server_tool_use` → `[web search: <query>]`
    - `web_search_tool_result` → `[search results]`
  - [ ] Write unit tests for the renderer
  - [ ] Iterate until tests pass

- [ ] **Step 1.5: Auto-approve writes to `MAGENTA_TEMP_DIR`**
  - [ ] In `node/tools/permissions.ts`, update `canWriteFile()` to auto-approve files under `MAGENTA_TEMP_DIR` (same pattern as `canReadFile()` already does for reads). This is safe since magenta owns that directory, and it means the compact subagent's EDL edits to the temp file won't trigger permission prompts.
  - [ ] Check for type errors and iterate until they pass
- [ ] **Step 2: Create compact subagent system prompt and tool config**
  - [ ] Add a new `ThreadType` value: `"compact"` in `node/chat/types.ts`
  - [ ] Add a `COMPACT_STATIC_TOOL_NAMES` list in `node/tools/tool-registry.ts` containing just `["edl"]`
  - [ ] Update `getToolSpecs()` in `node/tools/toolManager.ts` to handle the new `"compact"` thread type
  - [ ] Add a brief `COMPACT_SYSTEM_PROMPT` in `node/providers/system-prompt.ts` — just a one-liner like "You are a compaction agent that reduces conversation transcripts using the edl tool." The detailed instructions will be in the user message.
  - [ ] Update `getBaseSystemPrompt()` to handle the `"compact"` thread type
  - [ ] Check for type errors and iterate until they pass

- [ ] **Step 3: Implement the new `@compact` flow in `Thread`**
  - [ ] Modify `prepareUserContent()` to no longer inject compact tool instructions. Instead, when `@compact` is detected:
    - Set `this.state.mode` to a new mode like `{ type: "compacting", nextPrompt }`
    - Don't send any message to the current agent
    - Instead, call a new method `startCompaction(nextPrompt)`
  - [ ] Implement `startCompaction(nextPrompt)`:
    - Call `renderThreadToMarkdown()` on the current messages
    - Write the markdown to a temp file at `MAGENTA_TEMP_DIR/threads/<threadId>/compact.md` (follows existing convention for per-thread temp files)
    - Dispatch a message to Chat (e.g. `{ type: "spawn-compact-thread", parentThreadId, tempFilePath, fileContents, nextPrompt }`)
    - Store `nextPrompt` in thread state (in the `compacting` mode)
  - [ ] Check for type errors and iterate until they pass

- [ ] **Step 4: Handle compact subagent lifecycle in `Chat`**
  - [ ] In `Chat`, handle the `"spawn-compact-thread"` message:
    - Call `createThreadWithContext()` with `parent: parentThreadId`, `threadType: "compact"`, and the user message containing the file path, contents, next prompt, and instructions
    - Store the `tempFilePath` on the `ThreadWrapper` (or in a side map `compactMeta: Map<ThreadId, { tempFilePath, parentThreadId }>`)
  - [ ] In `Chat.update()`, when a compact subagent thread stops (agent status `stopped` with `end_turn`):
    - Look up the parent via `threadWrapper.parentThreadId` (same pattern as existing `notifyParent`)
    - Read the final contents of the temp file
    - Clean up the temp file
    - Dispatch `{ type: "compact-complete", summary }` to the parent thread
  - [ ] Add a new message type to `Thread.Msg` like `{ type: "compact-complete", summary: string }`
  - [ ] In `Thread.myUpdate()`, handle `"compact-complete"`:
    - Call `resetContextManager()` (preserving context files mentioned in the edited markdown, or all current ones)
    - Call `agent.compact({summary})`
    - Set mode to `{ type: "control_flow", operation: { type: "compact", nextPrompt } }` so `maybeAutoRespond()` continues the conversation
  - [ ] Check for type errors and iterate until they pass

- [ ] **Step 5: Remove the compact tool**
  - [ ] Remove `compact` from `CHAT_STATIC_TOOL_NAMES` in `node/tools/tool-registry.ts`
  - [ ] Remove `CompactTool` class from `node/tools/compact.ts` (or delete the file)
  - [ ] Remove `compact` from `STATIC_TOOL_NAMES`
  - [ ] Remove compact tool creation from `node/tools/create-tool.ts`
  - [ ] Remove `isCompactToolUseRequest()` and `handleCompactRequest()` from `Thread`
  - [ ] Remove the compact branch from `maybeAutoRespond()` in Thread (since compact-complete will now set up control_flow mode directly)
  - [ ] Clean up the `CompactRequest` type from `anthropic-agent.ts` if no longer needed externally
  - [ ] Check for type errors and iterate until they pass

- [ ] **Step 6: Integration test**
  - [ ] Write an integration test that:
    - Creates a thread with a few messages (including tool uses)
    - Triggers `@compact` with a next prompt
    - Verifies a subagent is spawned
    - Verifies the temp file is created with the expected markdown structure
    - Verifies that after the subagent completes, the thread has been compacted and the next prompt is sent
  - [ ] Iterate until tests pass

- [ ] **Step 7: Handle edge cases**
  - [ ] Handle the case where the compact subagent errors out (fall back gracefully, e.g., use the unedited markdown as the summary)
  - [ ] Handle `@compact` with no next prompt (just compact without continuing)
  - [ ] Make sure the compact subagent's `get_file` is restricted to just the temp file (or at minimum, the temp file is prominently featured in instructions so the agent focuses on it)
  - [ ] Ensure the temp file cleanup happens even if errors occur
