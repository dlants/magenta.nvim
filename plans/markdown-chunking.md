# Context

The goal is to improve markdown chunking for the PKB (Personal Knowledge Base) by using structure-aware splitting instead of pure character-based splitting.

## Current State

The current `chunker.ts` uses a simple character-based approach:

- Fixed chunk size (~500 chars) with overlap (~50 chars)
- Splits by lines, creating chunks when size threshold is exceeded
- No awareness of markdown structure - can split in the middle of code blocks, headings, etc.

## Proposed Approach

Use simple regex-based detection for markdown structure. We only need to track:

1. **Headings** - lines starting with `#` (to maintain heading hierarchy context)
2. **Code fences** - lines starting with ``` (to avoid splitting inside code blocks)

Everything else can split at newline/paragraph boundaries like the current approach.

## Chunking Strategy

We'll detect headings, code blocks and other major/ common markdown boundaries. These will become "hard" break points.

When we chunk, we'll break on all the hard boundaries.

We will then consider the size of the resulting chunks. If the resulting chunk is too large, we will consider breaking on double-newlines. If the paragraphs are too long, we'll consider breaking by single newlines. If that is too long, we'll do sentences.

The process will be like this:
Consier the hard block. Chunk size = 5000 tokens. This is too large, so break the chunk down further.
Consider breaking by double-newlines. This gives us potential chunks of 100, 200, 150, 3000, etc... tokens.
We greedily roll up the lines until we reach a target chunk size of 500 tokens. So paragraphs 1, 2 and 3 become our first chunk.
The next chunk of 3000 would put us over the 500 token limit, so we break it off into a new chunk. This chunk is too large, so we consider breaking down further, by single newlines. And so on.

Up to the sentence level, we don't need to do overlap. Context-augmented retrieval should be sufficient to resolve ambiguity of the chunk. If we get down to sentence-level chunking and the resulting chunks are still too large, fall back to character-based chunking with interleave.

While we do this, we'll keep track of the heading hierarchy, and include it at the head of the chunk for context (before pushing it through context augmentation).

## Key Types

```typescript
// Our existing types
type ChunkInfo = {
  text: string;
  start: Position;
  end: Position;
};

type Position = { line: number; col: number };
```

## Relevant Files

- `node/pkb/chunker.ts` - Current chunker implementation to update
- `node/pkb/chunker.spec.ts` - Tests for chunker
- `node/pkb/pkb.ts` - Uses `chunkText()` in `embedFile()` method
- `node/pkb/embedding/types.ts` - `ChunkData` and `Position` types

# Implementation

- [x] Update `ChunkInfo` type to include heading context
  - [x] Add `headingContext?: string` field to `ChunkInfo` in `chunker.ts`

- [x] Implement hierarchical chunking in `chunker.ts`
  - [x] Define "hard" boundaries: headings, code fences
  - [x] Split text into hard blocks first
  - [x] Track heading hierarchy (h1-h6) as we process blocks
  - [x] For each hard block, recursively split if too large:
    - [x] First try double-newline (paragraph) boundaries
    - [x] Then single-newline boundaries
    - [x] Then sentence boundaries (`. `, `? `, `! `)
    - [x] Finally fall back to character-based with overlap
  - [x] Greedily roll up small segments until target chunk size (~500 tokens / ~2000 chars)
  - [x] Attach heading context to each resulting chunk

- [x] Handle edge cases
  - [x] Code blocks - keep intact as hard blocks, don't split further
  - [x] Documents with no headings (no context prefix)

- [x] Write tests for updated chunker
  - [x] Test hard block detection (headings, code fences)
  - [x] Test heading context hierarchy is captured correctly
  - [x] Test greedy rollup stays under target size
  - [x] Test recursive splitting works for large paragraphs
  - [x] Test code blocks are never split
  - [x] Test position calculations remain correct
  - [x] Iterate until tests pass

- [x] Update PKB to use heading context
  - [x] Modify `embedFile` in `pkb.ts` to include heading context in contextualized text
  - [x] Run existing PKB tests, iterate until they pass

- [x] Bump MAGENTA_EMBEDDING_VERSION
  - [x] Increment version in `embedding/types.ts` to trigger re-indexing
