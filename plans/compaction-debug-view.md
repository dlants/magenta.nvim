# Context

**Objective**: Make compaction debuggable by storing each compact agent's full message history and rendering it in the thread view after compaction completes (or fails).

Currently, compaction creates a series of `Agent` instances (one per chunk), but discards them when done. If the compactor fails to produce a summary, there's no way to see what went wrong.

The key insight from the user: we already have a way to render `ProviderMessage[]` — the thread `view` function and `renderMessageContent` do this. We should reuse that machinery to render each compact agent's conversation.

## Relevant files and entities

- `node/chat/thread.ts`: The `Thread` class manages compaction. `ConversationMode` has a `compacting` variant that tracks the current compact agent, chunks, and progress. Key methods: `startCompaction`, `handleCompactChunkComplete`, `handleCompactComplete`, `handleCompactAgentMsg`, `handleCompactAgentToolUse`. The `view` export renders thread state.
- `node/chat/thread.ts` — `renderMessageContent`: Renders a single `ProviderMessageContent` block. Already handles all content types (text, thinking, tool_use, tool_result, etc.).
- `node/chat/thread.ts` — `ConversationMode`: Union type with `normal`, `tool_use`, and `compacting` variants. The `compacting` variant (lines 183-195) tracks `chunks`, `currentChunkIndex`, `compactAgent`, `compactFileIO`, etc.
- `node/chat/thread.ts` — `Msg`: The message type for thread updates. We'll add new variants for toggling compaction debug views.
- `node/chat/thread.ts` — `Thread.state`: Contains `messageViewState`, `toolViewState`, `mode`, `toolCache`, etc. We'll add a `compactionHistory` field.
- `node/core/src/providers/provider-types.ts` — `ProviderMessage`, `Agent`, `AgentState`: The agent exposes `getState().messages: ReadonlyArray<ProviderMessage>`.
- `node/chat/compact-renderer.ts` — `renderThreadToMarkdown`: Renders `ProviderMessage[]` to markdown. This is used to prepare compaction input, not for display.

## Design

### Data model

```typescript
type CompactionStep = {
  chunkIndex: number;
  totalChunks: number;
  messages: ProviderMessage[];
};

type CompactionRecord = {
  steps: CompactionStep[];
  finalSummary: string | undefined; // undefined if compaction failed
};
```

Store `compactionHistory: CompactionRecord[]` on `Thread.state`. Each compaction attempt appends one record.

### Capturing data

- In the `compacting` mode, add a `steps: CompactionStep[]` field to accumulate completed steps.
- In `handleCompactChunkComplete`, before creating a new agent for the next chunk, snapshot `mode.compactAgent.getState().messages` into `steps`.
- In `handleCompactComplete` (success path), move `steps` + `finalSummary` into `compactionHistory`.
- In `handleCompactAgentMsg` error path and the empty-summary error in `handleCompactChunkComplete`, also persist the steps collected so far (with `finalSummary: undefined`).

### Rendering

Add a collapsible section after the system prompt for each compaction record:

```
📦 [Compaction 1 — 3 steps, summary: 450 chars]   (collapsed)
📦 [Compaction 1 — 3 steps, summary: 450 chars]   (expanded)
  ## Step 1 of 3
  # user:
  [chunk content prompt...]
  # assistant:
  [agent response with tool calls...]
  ## Step 2 of 3
  ...
  ## Final Summary
  [the summary text]
```

For rendering each step's messages, reuse `renderMessageContent` from the thread view. Since compact agents use a limited set of tools (mainly EDL), most content blocks will be text and tool_use/tool_result, which are already handled.

The tool_use blocks in compaction steps won't have entries in `thread.state.toolCache` (those were from the compact agent's separate tool execution). We'll need to build a local tool result map from the step's own messages (same approach `rebuildToolCache` uses, but scoped to the step's messages).

### New messages

```typescript
| { type: "toggle-compaction-record"; recordIdx: number }
| { type: "toggle-compaction-step"; recordIdx: number; stepIdx: number }
```

### View state

```typescript
compactionViewState: {
  [recordIdx: number]: {
    expanded: boolean;
    expandedSteps: { [stepIdx: number]: boolean };
  };
};
```

# Implementation

- [x] Add types and state fields
  - [ ] Add `CompactionStep` and `CompactionRecord` types to `thread.ts`
  - [ ] Add `steps: CompactionStep[]` to the `compacting` variant of `ConversationMode`
  - [ ] Add `compactionHistory: CompactionRecord[]` to `Thread.state`
  - [ ] Add `compactionViewState` to `Thread.state`
  - [ ] Add `toggle-compaction-record` and `toggle-compaction-step` to `Msg`
  - [ ] Initialize new state fields in constructor and `handleCompactComplete` reset
  - [ ] Run type check, iterate until clean

- [x] Capture compaction step data
  - [ ] In `startCompaction`, initialize `steps: []` in the `compacting` mode object
  - [ ] In `handleCompactChunkComplete`, before creating the next agent, push `{ chunkIndex: mode.currentChunkIndex, totalChunks: mode.chunks.length, messages: [...mode.compactAgent.getState().messages] }` into `mode.steps`
  - [ ] In `handleCompactChunkComplete` success path (all chunks done), push the final step, then persist `{ steps: mode.steps, finalSummary: summary }` to `compactionHistory`
  - [ ] In `handleCompactChunkComplete` empty-summary error path, persist `{ steps: mode.steps, finalSummary: undefined }`
  - [ ] In `handleCompactAgentMsg` error handler, persist `{ steps: mode.steps, finalSummary: undefined }`
  - [ ] Run type check, iterate until clean

- [x] Handle new messages in `myUpdate`
  - [ ] Add cases for `toggle-compaction-record` and `toggle-compaction-step` in `myUpdate`
  - [ ] Run type check, iterate until clean

- [x] Render compaction history in the view
  - [ ] Write a `renderCompactionHistory` helper that iterates over `compactionHistory` and renders each record as a collapsible section
  - [ ] Write a `renderCompactionStep` helper that renders a single step's messages using `renderMessageContent`. Build a local tool result map from the step's messages for tool_use rendering.
  - [ ] Render the final summary text in each record (if present) or a failure indicator
  - [ ] Wire `renderCompactionHistory` into the main `view` after `systemPromptView`
  - [ ] Add `<CR>` bindings on record and step headers to dispatch toggle messages
  - [ ] Run type check, iterate until clean

- [x] Write tests
- [ ] Manual testing
  - [ ] Trigger compaction on a thread and verify collapsed compaction record appears
  - [ ] Expand record and steps, verify agent messages render correctly
  - [ ] Trigger a failing compaction (e.g. abort mid-compact) and verify the partial record is visible with `finalSummary: undefined`