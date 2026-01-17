# Tree-sitter Summary for Large Files

## Context

**Objective:** When `get_file` truncates large files (>40K chars), instead of just returning the first 100 lines, generate a structural "minimap" using tree-sitter that shows the top-level declarations with their line numbers.

**Current behavior:** In `node/tools/getFile.ts`, the `processTextContent` method checks if `totalChars > MAX_FILE_CHARACTERS` and if so, only returns `DEFAULT_LINES_FOR_LARGE_FILE` (100) lines.

**Proposed behavior:** For large files where a tree-sitter parser is available, return:

1. A tree-sitter generated minimap showing function/class/interface declarations with line numbers
2. The first N lines of actual content that fit in the remaining budget

**Relevant files:**

- `node/tools/getFile.ts`: Contains `processTextContent` which handles large file truncation
- `node/utils/files.ts`: File type detection and path utilities
- `node/tools/bashCommand.ts`: Example of spawning subprocesses

**Key approach:**

- Spawn a headless `nvim --headless` process to parse the file content
- Use `vim.treesitter.get_string_parser(content, lang)` to parse without loading into a buffer
- Walk the tree using BFS to extract nodes with their line content
- Gracefully fall back to current behavior if no parser available

**Tree traversal algorithm:**

- Use BFS (breadth-first search) to prioritize showing higher-level structure
- Total budget: we should print 100 lines maximum
- When a node has many children (>5), only show quintiles:
  - 1st child, child at 1/4, child at 1/2 (middle), child at 3/4, last child
  - This ensures we see representative samples without overwhelming output
- For each shown node, output: `{lineNumber}: {lineContent}`
  - Line numbers are 1-indexed
  - Truncate lines longer than 200 chars with `...`
- Stop traversing deeper once budget is exhausted

**Error handling - gracefully fall back to first 100 lines when:**

- Parser not installed for the detected filetype
- Parsing errors occur (tree-sitter is error-tolerant but nvim spawn could fail)
- Timeout: if parsing takes >5 seconds (for extremely large files), kill the process and fall back

## Implementation

- [x] Create `node/utils/treesitter.ts` utility module
  - [x] Define types for tree-sitter minimap output
    ```typescript
    type MinimapLine = {
      line: number; // 1-indexed line number
      text: string; // truncated line content
    };
    type TreeSitterMinimap = {
      language: string;
      lines: MinimapLine[];
    };
    ```
  - [x] Create `getTreeSitterMinimap(content: string, filePath: string): Promise<Result<TreeSitterMinimap>>` function
    - Spawns headless nvim with lua script passed via stdin or -c flag
    - Returns JSON output parsed by node
  - [x] Create lua script (embedded in TypeScript as template string) that:
    - Detects filetype from filename using `vim.filetype.match`
    - Checks if parser available using `pcall(vim.treesitter.language.inspect, lang)`
    - Parses with `vim.treesitter.get_string_parser(content, lang)`
    - BFS traversal with 100 node budget
    - For nodes with >5 children, select quintiles (indices 0, n/4, n/2, 3n/4, n-1)
    - For each selected node: extract start line, get that line from content, truncate to 100 chars
    - Skip trivial node types: `"("`, `")"`, `"{"`, `"}"`, `","`, `";"`, etc.
    - Output JSON array of `{line: number, text: string}` objects
  - [x] Handle errors gracefully (all should return error Result, caller falls back to line-based):
    - Timeout after 5 seconds - kill nvim process
    - Parser not installed for filetype
    - nvim spawn failure
    - JSON parse failure from nvim output
  - [x] Run type check and fix errors

- [x] Write unit tests for `treesitter.ts`
  - [x] Test with TypeScript content (has parser) - should return minimap
  - [x] Test with unknown file type (no parser) - should return error Result
  - [x] Test BFS quintile selection with a file that has many siblings
  - [x] Iterate until tests pass

- [x] Integrate into `getFile.ts`
  - [x] In `processTextContent`, when `isLargeFile` is true:
    - Call `getTreeSitterMinimap` with the file content and path
    - If successful, prepend minimap to the output
    - Calculate remaining character budget and include as many lines as fit
    - If minimap fails, fall back to current behavior (first 100 lines)
  - [x] Update the output format to clearly separate minimap from content
  - [x] Run type check and fix errors

- [x] Write integration tests
  - [x] Test get_file on a large TypeScript file shows minimap
  - [x] Test get_file on a large file with no parser falls back to line-based truncation
  - [x] Iterate until tests pass

- [x] Manual testing
  - [x] Test with a real large TypeScript file
  - [x] Test with a large file with no parser (e.g., .xyz extension)
  - [x] Verify fallback behavior works correctly
