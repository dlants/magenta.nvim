# In-Memory FileIO for Compaction

## Context

### Objective

Replace the temp-file-based compaction flow with an in-memory `FileIO` implementation. The compact sub-thread should receive both `get_file` and `edl` tools, operating against a virtual file system that contains only the rendered thread markdown. This eliminates temp file I/O and cleanup, and lets the compaction agent re-read the file if needed.

### Current State

**Compaction flow** (`thread.ts:startCompaction` → `chat.ts:handleSpawnCompactThread` → `chat.ts:handleCompactThreadComplete`):

1. Parent thread calls `renderThreadToMarkdown()` and writes result to a temp file at `MAGENTA_TEMP_DIR/threads/{id}/compact.md`
2. Dispatches `spawn-compact-thread` with `tempFilePath`, `fileContents`, and optional `nextPrompt`
3. `chat.ts:handleSpawnCompactThread` creates a compact thread with `threadType: "compact"`, embeds file contents in the user prompt, and stores `compactTempFilePath` on the thread wrapper
4. Compact thread runs with only the `edl` tool, editing the temp file on disk
5. On completion (`chat.ts:handleCompactThreadComplete`), reads the temp file with `readFileSync`, deletes it with `unlinkSync`, and dispatches `compact-complete` with the file contents as `summary` to the parent thread

**Tool registry**: `COMPACT_STATIC_TOOL_NAMES = ["edl"]` — compact threads only get EDL.

**Thread FileIO setup**: Each thread creates a `PermissionCheckingFileIO` wrapping a `BufferAwareFileIO` in its constructor. This is passed to tools via `CreateToolContext.fileIO`.

**Compact thread instructions**: The user prompt tells the agent the file is at a real path and to use EDL to edit it. The full file contents are also embedded inline in `<file_contents>` tags.

### Target State

1. **Create `InMemoryFileIO`** — a `FileIO` implementation backed by a `Map<string, string>`. It can be initialized with a single file (e.g. `/thread.md`) containing the rendered markdown.
2. **Grant `get_file` to compact threads** — add it to `COMPACT_STATIC_TOOL_NAMES` so the compaction agent can re-read the file if needed.
3. **Inject `InMemoryFileIO` into the compact thread** — instead of the normal `PermissionCheckingFileIO(BufferAwareFileIO)` chain, compact threads use `InMemoryFileIO` directly (no permissions needed for virtual files).
4. **Remove temp file I/O** — no more `mkdirSync`/`writeFileSync` in `startCompaction()`, no more `readFileSync`/`unlinkSync` in `handleCompactThreadComplete()`.
5. **Read result from `InMemoryFileIO`** — when the compact thread finishes, read the virtual file contents directly from the in-memory store instead of disk.

### Key Design: InMemoryFileIO

```typescript
class InMemoryFileIO implements FileIO {
  private files: Map<string, string>;

  constructor(initialFiles: Record<string, string>) {
    this.files = new Map(Object.entries(initialFiles));
  }

  async readFile(path: string): Promise<string> {
    /* read from map or throw */
  }
  async readBinaryFile(path: string): Promise<Buffer> {
    /* Buffer.from(readFile) */
  }
  async writeFile(path: string, content: string): Promise<void> {
    /* write to map */
  }
  async fileExists(path: string): Promise<boolean> {
    /* check map */
  }
  async mkdir(_path: string): Promise<void> {
    /* no-op */
  }
  async stat(path: string): Promise<{ mtimeMs: number } | undefined> {
    /* return synthetic stat if exists */
  }

  /** Read current contents of a file — used by chat.ts to get compaction result */
  getFileContents(path: string): string | undefined {
    /* synchronous read from map */
  }
}
```

The virtual file path should be something simple like `/thread.md` since the in-memory FS is self-contained. The compact agent's prompt references this path.

### Providing content to the compact agent

The file contents are embedded inline in the user prompt via `<file_contents>` tags (as currently done). The `InMemoryFileIO` backs the `get_file` and `edl` tools so the agent can re-read or edit `/thread.md` without touching disk. No context manager changes are needed — compact threads are background agents that don't use the context manager.

### How the result gets back to the parent

Currently `handleCompactThreadComplete` reads the temp file from disk. Instead:

- The compact thread's `InMemoryFileIO` is stored on the `ThreadWrapper` (or accessible from the compact `Thread` itself via `thread.permissionFileIO` being replaced by the in-memory impl).
- When the compact thread completes, `handleCompactThreadComplete` reads the virtual file contents from the `InMemoryFileIO` directly.
- Since the Thread already exposes `permissionFileIO` publicly, we can instead add a public `fileIO` property or store the `InMemoryFileIO` reference on the thread wrapper. Simplest: store a reference to the `InMemoryFileIO` on the thread wrapper alongside `parentThreadId`.

### Relevant files

- `node/edl/file-io.ts` — `FileIO` interface, `FsFileIO` implementation (new `InMemoryFileIO` goes here or in a new file)
- `node/tools/tool-registry.ts` — `COMPACT_STATIC_TOOL_NAMES` (add `get_file`)
- `node/chat/thread.ts` — `Thread` constructor (FileIO setup), `startCompaction()` (temp file creation)
- `node/chat/chat.ts` — `handleSpawnCompactThread()` (thread creation + prompt), `handleCompactThreadComplete()` (temp file reading), `spawn-compact-thread` message type, `ThreadWrapper` type
- `node/chat/compact-renderer.ts` — `renderThreadToMarkdown()` (unchanged, but relevant for understanding input)
- `node/tools/create-tool.ts` — `CreateToolContext` (how FileIO reaches tools)

## Implementation

### Phase 1: Create InMemoryFileIO

- [ ] Create `node/edl/in-memory-file-io.ts` with `InMemoryFileIO` implementing `FileIO`
  - Constructor takes `initialFiles: Record<string, string>`
  - `readFile` — returns content from map, throws `ENOENT`-style error if not found
  - `readBinaryFile` — returns `Buffer.from(readFile(path))`
  - `writeFile` — sets content in map
  - `fileExists` — checks map has key
  - `mkdir` — no-op
  - `stat` — returns `{ mtimeMs: Date.now() }` if file exists, `undefined` otherwise
  - `getFileContents(path): string | undefined` — synchronous accessor for reading result back
- [ ] Write unit tests for `InMemoryFileIO` in `node/edl/in-memory-file-io.test.ts`
- [ ] Run `npx tsc --noEmit` — fix any type errors
- [ ] Run tests — iterate until passing

### Phase 2: Add get_file to compact thread tools

- [ ] In `node/tools/tool-registry.ts`, change `COMPACT_STATIC_TOOL_NAMES` from `["edl"]` to `["get_file", "edl"]`
- [ ] Run `npx tsc --noEmit` — fix any type errors

### Phase 3: Allow Thread to accept an injected FileIO

Currently, the Thread constructor always creates `PermissionCheckingFileIO(BufferAwareFileIO)`. For compact threads, we want to inject an `InMemoryFileIO` instead.

- [ ] Add an optional `fileIO?: FileIO` parameter to the Thread constructor's context (or as a separate constructor param)
- [ ] In the Thread constructor, if `fileIO` is provided, use it directly for `this.permissionFileIO` — but since `permissionFileIO` is typed as `PermissionCheckingFileIO`, we need to adjust:
  - Option A: Change `permissionFileIO` to be typed as `FileIO` (since compact threads don't need permissions). This requires updating `view()` to conditionally render permission UI only when the fileIO is a `PermissionCheckingFileIO`.
  - Option B: Add a separate `public fileIO: FileIO` property that tools use, and keep `permissionFileIO` for the permission UI. The `fileIO` property is set to either the `PermissionCheckingFileIO` or the injected `InMemoryFileIO`.
  - **Preferred: Option B** — least disruptive. The `permissionFileIO` is only created for non-compact threads. Tools already receive `FileIO` (the interface), so they don't care which implementation they get.
- [ ] Update tool context creation in `handleProviderStoppedWithToolUse()` to use `this.fileIO` instead of `this.permissionFileIO`
- [ ] Update the permission view in `view()` to only render when `permissionFileIO` exists
- [ ] Run `npx tsc --noEmit` — fix any type errors

### Phase 4: Wire InMemoryFileIO into compact thread creation

- [ ] Update the `spawn-compact-thread` message type in `chat.ts`:
  - Remove `tempFilePath: string` field
  - Keep `fileContents: string` and `nextPrompt?: string`
- [ ] Update `thread.ts:startCompaction()`:
  - Remove `mkdirSync`, `writeFileSync`, and temp file path construction
  - Just call `renderThreadToMarkdown()` and dispatch `spawn-compact-thread` with `fileContents` (no `tempFilePath`)
  - Remove `MAGENTA_TEMP_DIR` import if no longer used elsewhere in the file
- [ ] Update `chat.ts:handleSpawnCompactThread()`:
  - Create an `InMemoryFileIO` with `{ "/thread.md": fileContents }`
  - Pass the `InMemoryFileIO` into `createThreadWithContext` (need to thread this through)
  - Update the user prompt to reference `/thread.md` and keep embedding contents in `<file_contents>` tags (so the agent has content upfront)
  - Remove the line that stores `compactTempFilePath` on the thread wrapper
  - Store the `InMemoryFileIO` reference on the thread wrapper instead (for result retrieval)
- [ ] Update `createThreadWithContext` to accept an optional `fileIO?: FileIO` and pass it to the `Thread` constructor
- [ ] Update `ThreadWrapper` type:
  - Remove `compactTempFilePath?: string`
  - Add `compactFileIO?: InMemoryFileIO` (or store it on the Thread itself)
- [ ] Run `npx tsc --noEmit` — fix any type errors

### Phase 5: Update compact thread completion to read from InMemoryFileIO

- [ ] Update `handleCompactThreadComplete()` in `chat.ts`:
  - Instead of `readFileSync(tempFilePath)`, read from the stored `InMemoryFileIO.getFileContents("/thread.md")`
  - Remove `unlinkSync(tempFilePath)` — no temp file to clean up
  - Update the signature to accept the `InMemoryFileIO` instead of `tempFilePath`
- [ ] Update the compact completion detection code (around line 200 in `chat.ts`):
  - Instead of checking `threadState.compactTempFilePath`, check `threadState.compactFileIO`
  - Pass the `InMemoryFileIO` to `handleCompactThreadComplete` instead of the temp file path
- [ ] Remove `compactTempFilePath` preservation in the `"thread-initialized"` handler
- [ ] Remove unused `readFileSync`/`unlinkSync`/`mkdirSync`/`writeFileSync` imports from `chat.ts` and `thread.ts` if no longer needed
- [ ] Remove `MAGENTA_TEMP_DIR` import from `thread.ts` if no longer used
- [ ] Run `npx tsc --noEmit` — fix any type errors

### Phase 6: Update compact thread prompt

- [ ] In `handleSpawnCompactThread`, update the user message to:
  - Reference `/thread.md` as the file path (instead of the temp file path)
  - Keep embedding file contents inline in `<file_contents>` tags
  - Mention that the agent can use `get_file` to re-read `/thread.md` if needed
  - Tell the agent to use `edl` to edit `/thread.md`

### Phase 7: Tests and verification

- [ ] Run `npx tsc --noEmit` — clean build
- [ ] Run `npx vitest run` — full test suite
- [ ] Check for any remaining references to `compactTempFilePath` or `MAGENTA_TEMP_DIR` in compact-related code
- [ ] Verify no temp file artifacts are created during compaction
