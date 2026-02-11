# Context

The goal is to replace the tree-sitter based file minimap (`node/utils/treesitter.ts`) with a language-agnostic, information-theory based file summarizer. The current approach spawns a headless nvim process to run tree-sitter parsing, which is slow, fragile, and only works on files with tree-sitter grammars. The new approach should work on any file type (code, logs, HTML, config, prose, minified JS, etc.) and surface the most useful lines for an LLM agent to orient itself within a large file.

**Algorithm overview:**

1. **Chunking**: Split the file into chunks. Lines ≤ 200 chars become one chunk each. Lines > 200 chars are split into ~100-char sub-chunks at token boundaries, addressed as `line:col`.

2. **Token frequency**: Tokenize the entire file using word-boundary splitting (`/[a-zA-Z0-9_]+/`). Build a global frequency table. Track first-occurrence positions.

3. **Three scoring signals per chunk**:
   - **Surprise**: Average self-information of tokens in the chunk: `mean(-log2(freq(t) / N))`. Tokens appearing for the first time in the file get a bonus (e.g. 2× their self-information), favoring definition sites over usage sites.
   - **Scope size**: How many subsequent lines are indented deeper before returning to same/lesser indentation (blank lines skipped). Transformed as `log2(1 + scope_size)`.
   - **Indentation level**: Lower indentation = more structural importance. Expressed as `1 / (1 + indent_level)`.

4. **Combined score**: `score = surprise * (1 + scope_bonus) * indent_weight`. The scope bonus dominates for structural headers; indentation provides a secondary boost for top-level items; surprise breaks ties and catches non-structural landmarks.

5. **Selection**: Greedily pick highest-scoring chunks until total selected characters reach the budget (`token_budget * 4 chars/token`). Always include the first chunk. Sort selected chunks by file position.

6. **Formatting**: Display selected chunks with `line:col` markers and gap summaries showing how many lines/chars were omitted.

**Relevant files:**

- `node/utils/treesitter.ts`: Current minimap implementation to be replaced. Exports `getTreeSitterMinimap`, `formatMinimap`, and types `TreeSitterMinimap`, `MinimapLine`, `MinimapSummary`.
- `node/utils/treesitter.test.ts`: Existing tests for the treesitter minimap.
- `node/tools/getFile.ts`: Consumer of the minimap. Calls `getTreeSitterMinimap` and `formatMinimap` around lines 386-393 when processing large text files. Also imports the types/functions at line 44.
- `node/utils/result.ts`: `Result<T>` type used for return values.

# Implementation

- [x] Create `node/utils/file-summary.ts` with the core summarization algorithm
  - [x] Define types: `Chunk` (text, line, col, tokens), `FileSummary` (selected chunks + metadata)
  - [x] Implement `tokenize(content: string): string[]` — split on `/[a-zA-Z0-9_]+/`
  - [x] Implement `buildFrequencyTable(tokens: string[]): Map<string, number>` — global token counts
  - [x] Implement `chunkFile(content: string, maxChunkChars: number): Chunk[]` — split into line-based or sub-line chunks
  - [x] Implement `computeScopeSize(lines: string[], lineIndex: number): number` — count subsequent more-indented lines
  - [x] Implement `scoreChunk(chunk, freqTable, totalTokens, scopeSize): number` — surprise × scope bonus
  - [x] Implement `selectChunks(chunks: Chunk[], scores: number[], charBudget: number): Chunk[]` — greedy selection
  - [x] Implement `summarizeFile(content: string, options?: { charBudget?: number }): FileSummary` — main entry point combining all steps
  - [x] Implement `formatSummary(summary: FileSummary): string` — format for display with line:col markers and gap summaries
- [x] Check for type errors and iterate until clean

- [x] Write tests in `node/utils/file-summary.test.ts`
  - [x] Test tokenization edge cases (empty strings, punctuation-only, unicode)
  - [x] Test chunking of normal multi-line files
  - [x] Test chunking of single long-line files (minified JS)
  - [x] Test scope size computation (nested blocks, flat imports, blank lines)
  - [x] Test scoring: verify scope headers outscore leaf statements, imports rank low
  - [x] Test end-to-end on a realistic TypeScript file: class/function headers selected, imports mostly skipped
  - [x] Test end-to-end on a log-like file (flat structure, no indentation)
  - [x] Test formatting output includes line:col markers and gap summaries
  - [x] Iterate until all tests pass

- [x] Integrate into `node/tools/getFile.ts`
  - [x] Replace import of `getTreeSitterMinimap`/`formatMinimap` with new `summarizeFile`/`formatSummary`
  - [x] Update the large-file branch (~line 386) to call `summarizeFile` synchronously (no subprocess needed) and `formatSummary`
  - [x] Remove the async minimap call and related error handling
  - [x] Check for type errors and iterate until clean

- [x] Remove old treesitter minimap
  - [x] Delete `node/utils/treesitter.ts`
  - [x] Delete `node/utils/treesitter.test.ts`
  - [x] Verify no remaining imports/references to the deleted module
  - [x] Check for type errors and iterate until clean

- [x] Run full test suite and iterate until passing
