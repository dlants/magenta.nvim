# context

The goal is to replace the current compaction approach (which sends the entire thread markdown to a single compact subthread that edits it with EDL) with a chunked, incremental summarization approach that processes the thread in message-boundary-aligned chunks of ~25K tokens.

## Problem with current approach

Currently `Thread.startCompaction()` (thread.ts:629) renders the entire thread to markdown via `renderThreadToMarkdown()`, then `Chat.handleSpawnCompactThread()` (chat.ts:820) spawns a single compact subthread. That subthread receives the full markdown as both a `<file_contents>` block in its prompt AND in an `InMemoryFileIO` file, and is asked to use EDL to reduce it. For very long threads, this means:

1. The full thread markdown consumes most of the compact thread's context window.
2. The compact thread is asked to perform complex EDL mutations on top of that, leaving very little room for reasoning.
3. A single compaction pass has diminishing returns as thread size grows.

## New approach: chunked incremental summarization with EDL

Instead of one big compaction, process the thread in sequential chunks:

1. Render the thread to markdown, tracking message boundaries (the start character offset of each `ProviderMessage` in the output).
2. Greedily group messages into chunks of ~25K tokens (using a simple character-based estimate, e.g. ~4 chars/token → ~100K chars). Each chunk boundary falls between messages—never splitting a message.
3. Process chunks sequentially. The running summary lives in `/summary.md` (in `InMemoryFileIO`). The new chunk is provided directly in the prompt:
   - **Chunk 1**: `/summary.md` is empty (or contains a minimal header). The chunk's raw markdown is included in the prompt. The compact subthread uses EDL to write a condensed summary into `/summary.md`.
   - **Chunk 2**: `/summary.md` contains the summary from chunk 1. Chunk 2's raw markdown is in the prompt. The compact subthread uses EDL to edit `/summary.md`, folding in the essential information from the new chunk.
   - Continue until all chunks are processed.
4. The final `/summary.md` contents replace the thread (same as today's `handleCompactComplete`).

Key design points:

- **No compact threads via Chat.** Instead, Thread creates lightweight compact agents directly via `getProvider().createAgent()`. The entire chunked compaction loop runs inside the Thread.
- Still uses **EDL and InMemoryFileIO**. A single `InMemoryFileIO` persists across chunks, holding `/summary.md`.
- `/summary.md` contains only the running summary. The new chunk of transcript goes in the prompt as context for the compact agent.
- Each compact agent is instructed to edit `/summary.md` to incorporate essential information from the new chunk, NOT to re-condense the existing summary.
- The prompt should indicate which chunk is being processed (e.g. "chunk 3 of 5") and flag the **last chunk** so the agent produces a final, complete summary.
- The Thread handles `AgentMsg` from the compact agent via a separate message type (`compact-agent-msg`), running a mini tool-execution loop for EDL/get_file tool calls against the `InMemoryFileIO`.
- When a compact agent finishes with `end_turn`, the Thread either starts the next chunk or calls `handleCompactComplete` with the final summary.

## Relevant files and entities

- `node/chat/compact-renderer.ts`: `renderThreadToMarkdown()` — needs to return message boundary offsets alongside the markdown string.
- `node/chat/thread.ts`:
  - `Thread.startCompaction()` — initiates chunked compaction, creates first compact agent.
  - `Thread.handleCompactComplete()` — stays mostly the same, receives the final summary.
  - `ConversationMode` — extended to track chunked compaction state (chunks, current index, InMemoryFileIO, compact agent).
  - `Msg` — new `compact-agent-msg` type for routing compact agent callbacks.
- `node/providers/anthropic-agent.ts`: `getContextWindowForModel()` — used to determine auto-compact threshold; no changes needed.
- `node/edl/in-memory-file-io.ts`: `InMemoryFileIO` — holds `/summary.md` across the chunking loop.
- `node/tools/toolManager.ts`: `COMPACT_STATIC_TOOL_NAMES` = `["get_file", "edl"]` — the tools available to compact agents.
- `node/tools/create-tool.ts`: `createTool()` — used to instantiate EDL/get_file tools for the compact agent's tool loop.
- `node/chat/chat.ts`: Remove compact thread spawning/completion logic (`handleSpawnCompactThread`, `handleCompactThreadComplete`, `spawn-compact-thread` message).

## Token estimation

We don't have a token estimation utility today. The codebase uses Anthropic's `countTokens` API post-flight, but that's async and provider-specific. For chunking, we need a fast local estimate. A simple heuristic of **~4 characters per token** is sufficient for chunking purposes (this is conservative; actual ratio for English text is ~3.5-4 chars/token for Claude's tokenizer). We can make this a constant `CHARS_PER_TOKEN = 4` and `TARGET_CHUNK_TOKENS = 25_000`, giving a target chunk size of ~100K characters.

# implementation

- [ ] Update `renderThreadToMarkdown` to also return message boundary info
  - [ ] Change return type from `string` to `{ markdown: string; messageBoundaries: number[] }` where `messageBoundaries[i]` is the character offset in `markdown` where message `i` starts.
  - [ ] Update tests in `compact-renderer.test.ts`
  - [ ] Check for type errors and iterate until they pass

- [ ] Add a chunking utility function
  - [ ] Create `chunkMessages(markdown: string, messageBoundaries: number[], targetChunkChars: number, toleranceChars: number): string[]` in `compact-renderer.ts`
  - [ ] Export constants `CHARS_PER_TOKEN = 4`, `TARGET_CHUNK_TOKENS = 25_000`, `TOLERANCE_TOKENS = 5_000` for the caller to compute char values from token values
  - [ ] Greedily adds messages until the chunk exceeds the token budget, then starts a new chunk
  - [ ] If a single message exceeds the budget + 5K token tolerance (i.e. > 30K tokens), split it at a character boundary. Chunks can range from 25K-30K tokens.
  - [ ] Returns an array of markdown strings, one per chunk
  - [ ] Write unit tests:
    - [ ] empty markdown + no boundaries → returns empty array
    - [ ] single small message (well under budget) → returns one chunk containing that message
    - [ ] multiple small messages all fitting in one chunk → returns one chunk
    - [ ] multiple messages where first N fit in budget and the rest don't → splits into correct number of chunks at message boundaries
    - [ ] single message between target and target+tolerance (e.g. target=20, tolerance=5, message=23 chars) → one chunk (within tolerance, no split)
    - [ ] single message just over tolerance (e.g. target=20, tolerance=5, message=26 chars) → gets split into two chunks
    - [ ] very large single message (e.g. target=20, tolerance=5, message=55 chars) → split into ~3 chunks
    - [ ] mix of small messages then a giant message → small messages grouped into chunks, giant message split, with the first part of the big message being chunked with the initial messages
    - [ ] all chunks concatenated equal the original markdown (no content lost or duplicated)
  - [ ] Check for type errors and iterate until they pass

- [ ] Update `ConversationMode` and `Msg` types on Thread
  - [ ] Extend `compacting` mode to include chunked state: `{ type: "compacting"; nextPrompt?: string; chunks: string[]; currentChunkIndex: number; compactFileIO: InMemoryFileIO; compactAgent: Agent; }`
  - [ ] Add a new `Msg` variant: `{ type: "compact-agent-msg"; msg: AgentMsg }`
  - [ ] Check for type errors and iterate until they pass

- [ ] Implement `startCompaction()` with chunking
  - [ ] Render markdown + boundaries via updated `renderThreadToMarkdown`
  - [ ] Chunk via `chunkMessagesByTokenBudget`
  - [ ] Create `InMemoryFileIO` with empty `/summary.md`
  - [ ] Create a compact agent via `getProvider().createAgent()` with compact tool specs, dispatching to `compact-agent-msg`
  - [ ] Build the prompt for chunk 0 (include chunk markdown, instruct to write summary to `/summary.md`)
  - [ ] Send the prompt to the compact agent and start it
  - [ ] Store everything in the `compacting` mode state
  - [ ] Check for type errors and iterate until they pass

- [ ] Implement compact agent message handling in `myUpdate`
  - [ ] Route `compact-agent-msg` to a new `handleCompactAgentMsg` method
  - [ ] On `agent-stopped` with `tool_use`: execute tools (EDL, get_file) against the `InMemoryFileIO`, feed results back, continue the compact agent
  - [ ] On `agent-stopped` with `end_turn`: read `/summary.md` from `InMemoryFileIO`. If more chunks remain, create a new compact agent for the next chunk (with updated `/summary.md` and next chunk's markdown in prompt). If last chunk, call `handleCompactComplete` with the summary.
  - [ ] On `agent-error`: log error, reset mode to normal
  - [ ] Check for type errors and iterate until they pass
  - [ ] Write tests for chunked compaction with a mock provider/agent
    - [ ] Test that a thread with messages spanning multiple chunks processes them sequentially
    - [ ] Test that `/summary.md` accumulates across chunks
    - [ ] Test edge case: thread fits in one chunk (single-pass)
    - [ ] Test edge case: compact agent error mid-chunking resets mode
    - [ ] Iterate until tests pass

- [ ] Remove compact thread logic from Chat
  - [ ] Remove `spawn-compact-thread` from Chat's `Msg` type
  - [ ] Remove `handleSpawnCompactThread` method
  - [ ] Remove `handleCompactThreadComplete` method
  - [ ] Remove compact thread detection in Chat's `update()` method
  - [ ] Remove `compactFileIO` from thread wrapper state
  - [ ] Check for type errors and iterate until they pass

- [ ] Clean up
  - [ ] Update compact-renderer tests if needed
  - [ ] Remove "compact" from `ThreadType` if no longer used
  - [ ] Check for type errors and iterate until they pass

- [ ] Final review
  - [ ] Run full test suite `npx vitest run`
  - [ ] Run type check `npx tsc --noEmit`
  - [ ] Verify the `@compact` command still works end-to-end
  - [ ] Verify auto-compact triggers still work
