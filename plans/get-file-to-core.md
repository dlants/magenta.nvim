# context

## Objective

Port the `get_file` tool from `node/tools/getFile.ts` to `core/tools/`, following the established patterns from the EDL and bash_command tool ports. The core version handles the state machine, text content processing, file summary generation, and output formatting. It delegates file type detection, binary file reading, PDF operations, and permissions to new environment interfaces.

## Key interfaces

### `FileAccess` (new, to add to core/tools/environment.ts)

```typescript
type FileCategory = "text" | "image" | "pdf" | "unsupported";

type FileInfo = {
  size: number;
  category: FileCategory;
  mimeType: string;
};

interface FileAccess {
  getFileInfo(path: AbsFilePath): Promise<Result<FileInfo>>;
  readBinaryFileBase64(path: AbsFilePath): Promise<Result<string>>;
  extractPDFPage(
    path: AbsFilePath,
    pageNumber: number,
  ): Promise<Result<string>>;
  getPDFPageCount(path: AbsFilePath): Promise<Result<number>>;
}
```

- `getFileInfo`: detects file type (using magic numbers / mime-types library), gets size. The environment handles the `file-type` and `mime-types` library deps.
- `readBinaryFileBase64`: reads file as base64 string (for images).
- `extractPDFPage`: extracts single page as base64-encoded PDF (using `pdf-lib`).
- `getPDFPageCount`: returns page count from PDF.

### `FileIO` (existing, core/tools/environment.ts)

Already has `readFile(path: AbsFilePath): Promise<Result<string>>` — used for text file reading. The node implementation (`buffer-file-io.ts`) reads from nvim buffers when available.

### `Tool` / `StaticTool` (core/tools/types.ts)

Same interface as EdlTool/BashCommandTool: `isDone()`, `isPendingUserAction()`, `getToolResult()`, `abort()`, `update(msg)`.

### Node getFile tool (node/tools/getFile.ts, 959 lines)

- **States**: `pending`, `processing`, `pending-user-action`, `done`
- **Msgs**: `finish`, `automatic-approval`, `request-user-approval`, `user-approval`
- **Text processing**: `MAX_FILE_CHARACTERS=40000`, `MAX_LINE_CHARACTERS=2000`, `DEFAULT_LINES_FOR_LARGE_FILE=100`. Line truncation (abridging long lines), head/footer with line range info, large file summary.
- **File types**: text (with line ranges), images (base64), PDFs (page extraction or summary), unsupported (error)
- **Input**: `filePath` (required), `force`, `pdfPage`, `startLine`, `numLines` (all optional)

## What stays in core vs. what gets removed

### Stays (pure tool logic)

- State machine: simplified to `processing` → `done`
- Text content processing (`processTextContent`): line slicing, line truncation, large file detection, header/footer formatting with line range info
- File summary generation: port `node/utils/file-summary.ts` to `core/utils/file-summary.ts` (entirely pure — no IO deps)
- File size validation: pure function given size and category
- Constants: `MAX_FILE_CHARACTERS`, `MAX_LINE_CHARACTERS`, `DEFAULT_LINES_FOR_LARGE_FILE`, `FILE_SIZE_LIMITS`
- `FileCategory` type
- Spec with full input schema (`filePath`, `force`, `pdfPage`, `startLine`, `numLines`)
- `validateInput` with validation for all parameter types
- Output formatting for all file types (text content, image base64, PDF document/summary)

### Removed (environment/client concerns)

- Permission checking (`canReadFile`, `pending-user-action` state, YES/NO UI)
- `pending-user-action` state and `automatic-approval`/`request-user-approval`/`user-approval` messages
- Reading from nvim buffers (`getBufferIfOpen`) — environment's `FileIO` impl handles this
- File type detection using `file-type` library (magic numbers) — delegated to `FileAccess.getFileInfo`
- PDF extraction using `pdf-lib` — delegated to `FileAccess.extractPDFPage`/`getPDFPageCount`
- Context manager integration (`context-manager-msg`, `tool-applied`)
- View/render methods (`renderSummary`, `renderCompletedSummary`, `renderCompletedDetail`)
- `nvim` dependency, `displayPath`, `withBindings`/`withExtmark`
- `getBufferIfOpen` and buffer-aware reading (node `FileIO` implementation handles this)

## Relevant files

- `node/tools/getFile.ts` — source to port from (959 lines)
- `node/utils/file-summary.ts` — pure file summary logic to port (236 lines)
- `node/utils/files.ts` — has `FileCategory`, `categorizeFileType`, `validateFileSize`, `detectFileType`, `FILE_SIZE_LIMITS`
- `core/tools/edl-tool.ts` — reference pattern for core tool implementation
- `core/tools/bash-command-tool.ts` — reference pattern for core tool implementation
- `core/tools/specs/edl.ts` — reference pattern for spec file
- `core/tools/specs/bash-command.ts` — reference pattern for spec file
- `core/tools/create-tool.ts` — factory to extend
- `core/tools/toolManager.ts` — registry to extend
- `core/tools/environment.ts` — `FileIO`, `FileAccess` (new) interfaces
- `core/tools/types.ts` — `Tool`, `StaticTool`, `ToolMsg`, `ToolContext`
- `core/utils/files.ts` — has `AbsFilePath`, `Cwd`, `HomeDir`, `resolveFilePath`

# implementation

- [x] **Port `core/utils/file-summary.ts`** from `node/utils/file-summary.ts`
  - Copy the entire file — it's pure logic (string processing, maps, no IO)
  - Update imports: `Result` path adjustment if needed
  - Verify no node-specific deps (there shouldn't be any)
  - Type check: `npx tsc --noEmit`

- [x] **Add `FileCategory`, `FileInfo`, `FileAccess`, and file size constants to `core/tools/environment.ts`**
  - `FileCategory = "text" | "image" | "pdf" | "unsupported"` (as a string union, not enum — matches core style)
  - `FileInfo = { size: number; category: FileCategory; mimeType: string }`
  - `FILE_SIZE_LIMITS = { text: 1_048_576, image: 10_485_760, pdf: 33_554_432 }` (1MB, 10MB, 32MB)
  - `FileAccess` interface with: `getFileInfo`, `readBinaryFileBase64`, `extractPDFPage`, `getPDFPageCount`
  - Type check: `npx tsc --noEmit`

- [x] **Create spec file `core/tools/specs/get-file.ts`**
  - `Input` type: `{ filePath: string; force?: boolean; pdfPage?: number; startLine?: number; numLines?: number }`
  - `validateInput(args)`: check `filePath` is string, `force` is boolean if present, `pdfPage` is positive integer if present, `startLine` is positive integer if present, `numLines` is positive integer if present
  - `spec: ProviderToolSpec` with name `"get_file"`, description (text/image/PDF support, line range params), and input_schema
  - `ToolRequest` type alias: `GenericToolRequest<"get_file", Input>`
  - Type check: `npx tsc --noEmit`

- [x] **Create `core/tools/get-file-tool.ts`**
  - Pure functions (ported from `node/tools/getFile.ts`):
    - `abbreviateLine(line: string, maxChars: number): string` — truncates long lines with `[N chars omitted]` in middle
    - `processTextContent(lines: string[], startIndex: number, requestedNumLines: number | undefined, summaryText?: string): { text: string; isComplete: boolean; hasAbridgedLines: boolean }` — handles line slicing, large file detection, summary, header/footer
    - `validateFileSize(size: number, category: FileCategory): { isValid: boolean; maxSize: number }` — pure validation
  - State type: `{ state: "processing" } | { state: "done"; result: ProviderToolResult }`
  - Msg type: `{ type: "finish"; result: Result<ProviderToolResultContent[]> }`
  - `GetFileTool` class implementing `StaticTool`
  - Constructor context: `{ fileIO: FileIO; fileAccess: FileAccess; logger: Logger; cwd: Cwd; homeDir: HomeDir; myDispatch: Dispatch<Msg> }`
  - Constructor creates `AbortController`, schedules `executeGetFile()` via `setTimeout`
  - `executeGetFile()` flow:
    1. Resolve file path using `resolveFilePath(cwd, input.filePath, homeDir)`
    2. Get file info via `fileAccess.getFileInfo(absPath)` → `{ size, category, mimeType }`
    3. Validate file size via `validateFileSize(size, category)`
    4. Branch on `category`:
       - **text**: Read via `fileIO.readFile(absPath)`, split into lines, call `processTextContent()` with line range params. For large files with no line params, generate summary via `summarizeFile`/`formatSummary`. Return `[{ type: "text", text }]`
       - **image**: Validate size, read via `fileAccess.readBinaryFileBase64(absPath)`, return `[{ type: "image", source: { type: "base64", media_type: mimeType, data } }]`
       - **pdf with pdfPage**: Extract via `fileAccess.extractPDFPage(absPath, pdfPage)`, return as document content
       - **pdf without pdfPage**: Get count via `fileAccess.getPDFPageCount(absPath)`, return summary text with page count
       - **unsupported**: Return error
    5. Dispatch `finish` with result
  - `abort()`: calls `abortController.abort()`, sets state to done with abort message
  - `isDone()`, `isPendingUserAction()` (always false), `getToolResult()`, `update(msg)`
  - Type check: `npx tsc --noEmit`

- [x] **Wire into factory and manager**
  - Add `get_file` case to `core/tools/create-tool.ts` `createTool` switch
  - Add `fileAccess: FileAccess` to `CreateToolContext`
  - Add `get_file` spec to `core/tools/toolManager.ts` `TOOL_SPEC_MAP`
  - Type check: `npx tsc --noEmit` — fix any errors from new `CreateToolContext` field (callers need updating)

- [x] **Fix callers of `CreateToolContext`**
  - Find all places that construct a `CreateToolContext` and add the `fileAccess` field
  - This includes test files and any node wiring code
  - Type check: `npx tsc --noEmit`

- [x] **Write tests `core/tools/get-file-tool.test.ts`**
  - Reference `node/tools/getFile.test.ts` (2697 lines, 40 tests) for expected behaviors and edge cases
  - Reference `core/tools/bash-command-tool.test.ts` and `core/tools/edl-tool.test.ts` for mock patterns and test structure
  - **Mock FileAccess**: implements `FileAccess` with configurable per-method responses (handler functions + call trackers)
  - **Mock FileIO**: reuse in-memory file store pattern from edl-tool tests
  - **Pure function unit tests** (`describe("abbreviateLine")`, `describe("processTextContent")`, `describe("validateFileSize")`):
    - `abbreviateLine`: short lines unchanged, long lines (>2000 chars) get `[N chars omitted]` in middle
    - `processTextContent`:
      - Full small file: returns all content, `isComplete: true`
      - Line range slice (`startLine`/`numLines`): returns correct slice with `[Lines X-Y of Z]` header and `[N more lines not shown. Use startLine=X to continue.]` footer
      - Large file (>40K chars) with summary text: returns summary directly
      - Large file without summary: returns first 100 lines (DEFAULT_LINES_FOR_LARGE_FILE)
      - `startLine` beyond EOF: appropriate error handling
      - Lines >2000 chars: `hasAbridgedLines: true`, `isComplete: false`
    - `validateFileSize`: within limits for each category, exceeding limits for text (1MB), image (10MB), pdf (32MB)
  - **Text file integration tests** (full tool lifecycle with mock environment):
    - Successful read: dispatches finish with text content
    - With `startLine`/`numLines`: result contains correct line slice with header/footer (ref: node test at line 1885 "startLine and numLines parameters work")
    - `startLine` alone without `numLines`: reads from startLine to end (ref: node test at line 1952)
    - `startLine` beyond file length: returns error with "startLine N is beyond end of file" (ref: node test at line 2138)
    - Large text file (>40K chars): triggers summary generation via `summarizeFile`/`formatSummary` (ref: node test at line 2255 "should show file summary for large TypeScript file")
    - Lines too long (>2000 chars): abridged with "chars omitted" marker (ref: node test at line 1812)
    - Line ranges with long lines: both slicing and abridging applied (ref: node test at line 2184)
    - Large file with unknown extension: still gets summary (ref: node test at line 2635)
  - **Image file integration tests**:
    - Successful image read: returns `{ type: "image", source: { type: "base64", media_type, data } }` (ref: node test at line 1217 "should process image files end-to-end")
    - Correct media_type from `fileAccess.getFileInfo` (e.g. `"image/jpeg"`, `"image/png"`)
    - Image too large (>10MB): returns "File too large" error with size info (ref: node test at line 1671)
  - **PDF integration tests** (ref: node tests at lines 85-579 which use `pdf-lib` to create test PDFs):
    - PDF with `pdfPage` param: calls `fileAccess.extractPDFPage`, returns `{ type: "document", source: { type: "base64", media_type: "application/pdf", data }, title }` containing page info (ref: node test at line 85)
    - PDF without `pdfPage` param: calls `fileAccess.getPDFPageCount`, returns summary text with "Pages: N" and instructions to use pdfPage parameter (ref: node test at line 429)
    - Invalid PDF page (out of range): `extractPDFPage` returns error, tool returns error with page count info (ref: node test at line 510 "should handle invalid PDF page index")
  - **Error handling tests**:
    - Unsupported file type (category "unsupported"): returns error (ref: node test at line 1339 "should reject binary files that are not supported")
    - File not found / `fileAccess.getFileInfo` returns error: returns error
    - `fileIO.readFile` returns error: returns error
  - **Abort tests**:
    - Abort before completion: returns abort result, pending promise ignored
    - Abort after completion: returns original result
  - **`validateInput` tests**:
    - Missing filePath: error
    - Non-string filePath: error
    - Valid filePath only: ok
    - Invalid `pdfPage` (0, negative, non-integer, float): error
    - Invalid `startLine` (0, negative, non-integer): error
    - Invalid `numLines` (0, negative, non-integer): error
    - Invalid `force` (non-boolean): error
    - All valid params together: ok
  - **`createTool` factory test**: `"get_file"` request returns a `GetFileTool` instance
  - **`toolManager` tests**: `TOOL_SPEC_MAP["get_file"]` registered, `getToolSpec("get_file")` returns spec

- [x] **Run tests**: `npx vitest run core/tools/get-file` and iterate until passing

