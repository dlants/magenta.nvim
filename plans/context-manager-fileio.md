# context

The goal is to make `ContextManager` use the `FileIO` interface for all filesystem access, removing direct `fs` calls. This establishes a clean boundary so that `ContextManager` is editor-agnostic and can live in a standalone core process, while buffer-awareness is handled by the `FileIO` implementation layer.

Additionally, we extract auto-context glob resolution out of `ContextManager` into a standalone function, called from `chat.ts` before thread creation.

## Current state

### Direct `fs` usage in `context-manager.ts` (6 calls, all synchronous)

- `fs.existsSync` — 2 sites: checking tracked file exists (line ~388), checking glob match exists (line ~775)
- `fs.statSync` — 1 site: getting mtime to compare buffer vs disk (line ~427)
- `fs.readFileSync(...).toString()` — 1 site: reading text file not in buffer (line ~471)
- `fs.readFileSync` — 1 site: reading binary image for base64 (line ~655)
- `fs.realpathSync` — 1 site: symlink resolution for glob dedup (line ~798)

### Buffer-tracking logic in `handleTextFileUpdate`

Currently context-manager directly uses `bufferTracker.getSyncInfo()`, compares changeTick and mtime, calls `buffer.attemptEdit()` to reload, and reads buffer lines via `buffer.getLines()`. This logic should move into `BufferAwareFileIO.readFile`.

### Auto-context loading (3 private static methods to extract)

- `loadAutoContext` — orchestrates glob resolution
- `findFilesCrossPlatform` — uses `glob` + `fs.existsSync` + `fs.realpathSync`
- `filterSupportedFiles` — uses `detectFileType`

### FileIO interface (current)

```typescript
interface FileIO {
  readFile(path: string): Promise<string>;
  readBinaryFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  stat(path: string): Promise<{ mtimeMs: number } | undefined>;
}
```

### BufferAwareFileIO.readFile (current behavior)

Checks `bufferTracker.isBufferModifiedSinceSync` — if buffer has unsaved changes, reads from buffer; otherwise reads from disk. Does NOT handle "disk changed → reload buffer" or conflict detection.

### BufferTracker.getSyncInfo returns

`{ mtime: number, changeTick: number, bufnr: BufNr }` — mtime is `fs.stat().mtime.getTime()` at last sync.

### ContextManager creation call sites

1. `chat.ts:createThreadWithContext` — calls `ContextManager.create()` which loads autoContext
2. `chat.ts:forkThread` (~line 662) — same, then copies files from source thread
3. `thread.ts:resetContextManager` (~line 618) — recreates ContextManager for compaction

### Relevant files

- `node/context/context-manager.ts` — being converted
- `node/capabilities/file-io.ts` — `FileIO` interface, `FsFileIO`
- `node/capabilities/buffer-file-io.ts` — `BufferAwareFileIO` (to be enhanced)
- `node/capabilities/permission-file-io.ts` — `PermissionCheckingFileIO` (delegates `fileExists`/`stat` directly, intercepts read/write with permission checks)
- `node/edl/in-memory-file-io.ts` — `InMemoryFileIO` for testing
- `node/buffer-tracker.ts` — `BufferTracker` class (72 lines)
- `node/chat/chat.ts` — thread creation, calls `ContextManager.create`
- `node/chat/thread.ts` — `resetContextManager`, stores `contextManager`
- `node/context/context-manager.test.ts` — 15 integration tests using `withDriver()`

## Design decisions

1. **`BufferAwareFileIO.readFile` absorbs the buffer-sync logic** from `handleTextFileUpdate`. When called, it:
   - Checks if file is tracked in `bufferTracker`
   - If tracked: compares disk mtime vs stored mtime and changeTick vs stored changeTick
   - If disk newer + buffer unchanged → reload buffer (`attemptEdit`), then read from buffer
   - If both changed → throw a conflict error
   - If buffer changed + disk unchanged → read from buffer
   - Otherwise → read from disk
     This replaces the manual buffer logic in context-manager.

2. **Auto-context extracted to `node/context/auto-context.ts`** as a standalone `resolveAutoContext()` function. Called in `chat.ts`, results passed as initial files to ContextManager constructor.

3. **`ContextManager` constructor becomes public**, `create` static method removed (no longer async). Initial files passed directly.

4. **`bufferTracker` removed from ContextManager's context** — it only uses `FileIO`.

5. **`detectFileType` and `getSummaryAsProviderContent`** stay as direct imports for now (separate refactor concern).

# implementation

- [x] Enhance `BufferAwareFileIO.readFile` to absorb buffer-sync logic
  - [x] Add disk mtime comparison: call `stat` on disk, compare with `bufferTracker.getSyncInfo().mtime`
  - [x] If disk is newer and buffer unchanged → call `buffer.attemptEdit()` to reload, then update sync tracking, then read from buffer
  - [x] If both disk and buffer changed → throw an error describing the conflict
  - [x] If buffer changed but disk unchanged → read from buffer (current behavior)
  - [x] If neither changed → read from disk (current behavior)
  - [x] Run type checks: `npx tsgo --noEmit`
  - [x] Write tests for `BufferAwareFileIO` covering: disk-only change, buffer-only change, conflict, no change
  - [x] Iterate until tests pass

- [x] Extract auto-context glob resolution
  - [x] Create `node/context/auto-context.ts` with a `resolveAutoContext()` function
  - [x] Move `loadAutoContext`, `findFilesCrossPlatform`, and `filterSupportedFiles` logic into it
  - [x] Return type: `Promise<Array<{ absFilePath: AbsFilePath; relFilePath: RelFilePath; fileTypeInfo: FileTypeInfo }>>`
  - [x] Remove the three static methods and `glob` / `path` imports from `context-manager.ts`
  - [x] Run type checks: `npx tsgo --noEmit`

- [x] Simplify `ContextManager` construction
  - [x] Make the constructor public
  - [x] Remove the `create` static method
  - [x] Add `fileIO: FileIO` to the constructor's context parameter
  - [x] Remove `bufferTracker` from the constructor's context parameter (no longer needed)
  - [x] Accept pre-resolved initial files in the constructor (already does this via `initialFiles` param)
  - [x] Run type checks: `npx tsgo --noEmit`

- [x] Update `chat.ts` call sites
  - [x] In `createThreadWithContext`: call `resolveAutoContext(...)`, convert result to `Files` map, pass to ContextManager constructor. Merge with `contextFiles` from `addFiles`.
  - [x] In `forkThread` (~line 662): call `resolveAutoContext(...)`, same pattern, then overlay source thread's files
  - [x] Pass `fileIO` to ContextManager (use the same `FileIO` assembled for the thread, or a basic `FsFileIO` since context reads don't need permission checks)
  - [x] Run type checks: `npx tsgo --noEmit`

- [x] Update `thread.ts:resetContextManager`
  - [x] Construct ContextManager directly (no `create`), passing current files or empty files as appropriate
  - [x] Pass `fileIO` from thread context
  - [x] Run type checks: `npx tsgo --noEmit`

- [x] Convert remaining `fs` calls in `ContextManager` to use `fileIO`
  - [x] `getFileMessageAndUpdateAgentViewOfFile`: replace `fs.existsSync` with `await this.context.fileIO.fileExists()`
  - [x] `handleTextFileUpdate`: remove manual bufferTracker/buffer logic, replace with `await this.context.fileIO.readFile()` (BufferAwareFileIO now handles sync). Keep the try/catch for error handling.
  - [x] `handleTextFileUpdate`: replace `fs.statSync` usage — this is no longer needed since BufferAwareFileIO handles mtime comparison internally
  - [x] `handleBinaryFileUpdate`: replace `fs.readFileSync` with `await this.context.fileIO.readBinaryFile()`
  - [x] Run type checks: `npx tsgo --noEmit`

- [x] Clean up imports in `context-manager.ts`
  - [x] Remove `import fs from "node:fs"`
  - [x] Remove `import path from "node:path"` if no longer used
  - [x] Remove `import { glob } from "glob"` (moved to auto-context.ts)
  - [x] Remove `BufferTracker` import
  - [x] Remove `NvimBuffer` import
  - [x] Remove `Row0Indexed` import (if only used for buffer lines)
  - [x] Verify no remaining `fs.` calls
  - [x] Run type checks: `npx tsgo --noEmit`

- [x] Run existing tests
  - [x] `npx vitest run node/context/` — run context-manager tests
  - [x] Fix any failures
  - [x] `npx vitest run` — full test suite
  - [x] Iterate until all tests pass

