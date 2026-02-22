# FileIO Interface Extraction

## Context

### Objective

Extract file interactions from `get_file` and `edl` tools into a unified `FileIO` interface, and move permission checking into a wrapping layer so the tools themselves just read/write without worrying about permissions. The permission approval UI moves from inline within each tool to a thread-level section rendered at the bottom of the thread view.

### Current State

**FileIO interface already exists** in `node/edl/file-io.ts`:

```typescript
interface FileIO {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
}
```

Two implementations exist:

- `FsFileIO` (`node/edl/file-io.ts`) — raw fs calls, used as default/test fallback
- `BufferAwareFileIO` (`node/tools/buffer-file-io.ts`) — checks nvim buffers first, falls back to fs

**EDL tool** already uses `FileIO` properly — it creates a `BufferAwareFileIO` and passes it to `runScript()`.

**get_file tool** does NOT use `FileIO` — it has inline `fs.promises.readFile` calls and manual buffer checking logic (duplicating what `BufferAwareFileIO` does).

**Permissions** are currently checked by each tool individually:

- `get_file` calls `canReadFile()` in `initReadFile()`, manages its own `pending-user-action` state and renders YES/NO buttons inline in `renderSummary()`
- `edl` calls `canReadFile()`/`canWriteFile()` in `checkPermissions()`, manages its own `pending-user-action` state and renders YES/NO buttons inline in `renderSummary()`
- `bash_command` checks `isCommandAllowedByConfig()` in constructor, manages `pending-user-action` state with YES/NO/ALWAYS buttons inline
- Permission logic lives in `node/tools/permissions.ts`

**Thread auto-respond flow**: `thread.ts:maybeAutoRespond()` is called after every tool message. It iterates `mode.activeTools` — if any tool's `isDone()` returns false, it returns `"waiting-for-tool-input"`. Only when ALL tools are done does it collect results and call `agent.continueConversation()`. Tools in `pending-user-action` state are NOT done, so they block auto-respond.

**Thread view composition**: The thread `view()` function (`thread.ts:1368-1499`) renders: title → system prompt → messages (with tool views inline via `renderMessageContent`) → streaming block → context manager → pending messages → status. Tool approval UIs are rendered inline within the message content via each tool's `renderSummary()`.

### Target State

1. **Expand `FileIO` interface** — add `readBinaryFile` and `stat` for get_file's binary/image handling
2. **Refactor `get_file`** to use `FileIO` instead of inline fs calls
3. **Inject `FileIO` into tools** via `create-tool.ts` instead of tools constructing it themselves
4. **Create `PermissionCheckingFileIO`** — a decorator wrapping `FileIO` that checks permissions and, when denied, returns a Promise that blocks until the user approves (or rejects). The decorator is associated with a thread and maintains a list of pending permission requests.
5. **Move permission UI to thread level** — the thread view renders pending permissions at the bottom (above status), not inline in each tool's `renderSummary()`
6. **Remove permission state from tools** — tools no longer have `pending-user-action` state for file permissions. They just call FileIO and await the result.

### Key Design: PermissionCheckingFileIO

The `PermissionCheckingFileIO` wraps a `FileIO` and intercepts read/write calls:

1. Tool calls `fileIO.readFile(path)` — returns a Promise
2. Wrapper calls `canReadFile(path)`. If allowed, delegates to underlying FileIO
3. If denied, creates a `PendingPermission` entry with a deferred Promise, and dispatches a message to the thread (so the view re-renders)
4. The thread view shows the pending permission at the bottom with YES/NO buttons
5. When user clicks YES, the wrapper resolves the deferred Promise and the original `readFile` call completes by delegating to the underlying FileIO
6. When user clicks NO, the wrapper rejects the Promise (tools handle this as an error)

This means:

- Tools never import or call `canReadFile`/`canWriteFile` directly
- Tools never have `pending-user-action` state for file permissions
- The tool's `isDone()` returns false while the Promise is pending, which naturally blocks auto-respond (the tool is still "processing")
- The permission UI is centralized at the thread level

The `PermissionCheckingFileIO` lives in the thread's context (one per thread), so its pending state is accessible to the thread view.

**Bash command permissions are NOT part of this change** — they're a different kind of permission (command-based, not file-based) and will be addressed separately.

### Relevant files

- `node/edl/file-io.ts` — existing `FileIO` interface + `FsFileIO`
- `node/tools/buffer-file-io.ts` — `BufferAwareFileIO` (buffer-aware `FileIO` impl)
- `node/tools/getFile.ts` — `GetFileTool` class, uses inline fs, has permission checking
- `node/tools/edl.ts` — `EdlTool` class, uses `BufferAwareFileIO`, has permission checking
- `node/tools/permissions.ts` — `canReadFile()`, `canWriteFile()`, `getEffectivePermissions()`
- `node/tools/create-tool.ts` — tool factory, where we'll inject FileIO
- `node/chat/thread.ts` — thread class, auto-respond logic, view composition
- `node/utils/files.ts` — `AbsFilePath`, `resolveFilePath`, path utilities
- `node/edl/executor.ts` — EDL executor, accepts `FileIO` in constructor
- `node/edl/index.ts` — `runScript()`, passes `FileIO` to executor
- `node/tools/render-pending-approvals.ts` — existing pending-approvals renderer (used by subagent tools only)

## Implementation

### Phase 1: Expand the FileIO interface

- [ ] Extend `FileIO` in `node/edl/file-io.ts` with additional methods needed by `get_file`:
  - `readBinaryFile(path: string): Promise<Buffer>` — for images/PDFs
  - `stat(path: string): Promise<{mtimeMs: number} | undefined>` — for checking existence and modification time
  - Keep using `string` paths (not `AbsFilePath`) in the interface — path resolution is the caller's responsibility
- [ ] Add these methods to `FsFileIO`
- [ ] Add these methods to `BufferAwareFileIO`
- [ ] Run `npx tsc --noEmit` and fix any type errors

### Phase 2: Refactor get_file to use FileIO

- [ ] Add `fileIO: FileIO` to `GetFileTool`'s context (passed from `create-tool.ts`)
- [ ] Replace inline `fs.promises.readFile(absFilePath, "utf-8")` and buffer-checking logic in `readFile()` with `this.context.fileIO.readFile(absFilePath)`
- [ ] Replace `fs.promises.readFile(absFilePath)` (binary read) with `this.context.fileIO.readBinaryFile(absFilePath)`
- [ ] Replace `fs.promises.stat()` with `this.context.fileIO.stat()`
- [ ] Remove `import fs from "fs"` and `import { getBufferIfOpen }` from getFile.ts (no longer needed)
- [ ] Update `create-tool.ts` to construct `BufferAwareFileIO` and pass it to `GetFileTool`
- [ ] Run `npx tsc --noEmit` and fix type errors
- [ ] Run existing get_file tests: `npx vitest run node/tools/getFile.test.ts` — iterate until passing

### Phase 3: Inject FileIO into EdlTool instead of constructing it internally

- [ ] Add `fileIO: FileIO` to `EdlTool`'s context
- [ ] Change `executeScript()` to use `this.context.fileIO` instead of `new BufferAwareFileIO(this.context)`
- [ ] Update `create-tool.ts` to pass the same `BufferAwareFileIO` instance to `EdlTool`
- [ ] Run `npx tsc --noEmit` and fix type errors
- [ ] Run existing edl tests: `npx vitest run node/tools/edl.test.ts` — iterate until passing

### Phase 4: Create PermissionCheckingFileIO

- [ ] Create `node/tools/permission-file-io.ts` with `PermissionCheckingFileIO` class
  - Constructor takes: `inner: FileIO`, permission context `{cwd, homeDir, options, nvim}`, and `onPendingChange: () => void` callback (so the thread can re-render when pending list changes)
  - Maintains a `Map<string, PendingPermission>` of pending permission requests
  - `PendingPermission` has: `absFilePath`, `accessType` ("read" | "write"), `resolve: () => void`, `reject: (err: Error) => void`, `displayPath: string`
  - `readFile(path)`: calls `canReadFile()`. If allowed, delegates. If denied, creates deferred Promise, adds to pending map, calls `onPendingChange()`, returns the Promise
  - `writeFile(path, content)`: same pattern with `canWriteFile()`
  - `readBinaryFile(path)`: same pattern with `canReadFile()`
  - `fileExists(path)`, `mkdir(path)`, `stat(path)`: pass through (no permission check)
  - `approve(path)`: resolves the deferred Promise for the given path, removes from pending map, calls `onPendingChange()`
  - `deny(path)`: rejects the deferred Promise, removes from pending map, calls `onPendingChange()`
  - `approveAll()` / `denyAll()`: batch operations
  - `getPendingPermissions()`: returns current pending list for rendering
  - `view()`: renders the pending permission approvals UI with YES/NO buttons that call `approve()`/`deny()`
- [ ] Run `npx tsc --noEmit` and fix type errors
- [ ] Write unit tests for PermissionCheckingFileIO
- [ ] Iterate until tests pass

### Phase 5: Wire PermissionCheckingFileIO into Thread and Subagent Approval Bubbling

- [ ] Add `permissionFileIO: PermissionCheckingFileIO` to the thread's context (created when the thread is created)
  - The `onPendingChange` callback should trigger a re-render (dispatch a message or call the existing render mechanism)
  - The inner FileIO is the `BufferAwareFileIO`
- [ ] Pass `permissionFileIO` (as `FileIO`) to tools via `create-tool.ts` context
- [ ] Update the thread `view()` function to include permission UI at the bottom:
  - Between `contextManagerView` and `statusView`, add `permissionView`
  - `permissionView` renders `thread.context.permissionFileIO.view()` (shows pending approvals with YES/NO buttons)
  - Only renders if there are pending permissions
- [ ] Update `renderPendingApprovals` (`node/tools/render-pending-approvals.ts`) to also include file permission requests from child threads:
  - Currently it only shows tools where `isPendingUserAction()` is true (bash_command approvals)
  - It also needs to check the child thread's `permissionFileIO.getPendingPermissions()` and render those
  - The subagent tools (`spawn-subagent`, `wait-for-subagents`, `spawn-foreach`) use `renderPendingApprovals` to bubble up child thread approvals into the parent thread — this must continue to work for file permissions
  - `renderPendingApprovals` needs access to the child thread's `PermissionCheckingFileIO`. It currently takes `(chat, threadId)` — it can look up the thread's permissionFileIO via the chat/thread
- [ ] Run `npx tsc --noEmit` and fix type errors

### Phase 6: Remove permission handling from get_file tool

- [ ] Remove `pending-user-action` state from `GetFileTool`'s `State` type
- [ ] Remove `request-user-approval` and `user-approval` message types from `GetFileTool`'s `Msg` type
- [ ] Remove `initReadFile()` method — the tool no longer pre-checks permissions
- [ ] Simplify constructor: go straight to processing (call `readFile()` in the setTimeout)
- [ ] Remove the `canReadFile` import
- [ ] In `readFile()`, just call `this.context.fileIO.readFile()` — if permission is denied, the Promise will block until the user approves (or reject if denied)
  - Handle rejection by dispatching a `finish` with an error result
- [ ] Remove the YES/NO buttons from `renderSummary()` — there's no `pending-user-action` state anymore
- [ ] Remove the `pending-user-action` case from `getToolResult()`
- [ ] Remove the `isPendingUserAction()` check for file permission (it should now always return false for get_file, since it's either processing or done)
- [ ] Run `npx tsc --noEmit` and fix type errors
- [ ] Run get_file tests — iterate until passing

### Phase 7: Remove permission handling from edl tool

- [ ] Remove `pending-user-action` state from `EdlTool`'s `State` type
- [ ] Remove `permissions-ok`, `permissions-denied`, `user-approval` message types from `EdlTool`'s `Msg` type
- [ ] Remove `checkPermissions()` method
- [ ] Remove `canReadFile`/`canWriteFile` imports and the `analyzeFileAccess` import
- [ ] Simplify constructor: go straight to `executeScript()` in the setTimeout
- [ ] `executeScript()` already uses `FileIO` — it will now use the `PermissionCheckingFileIO` passed via context, which handles permissions transparently. If a file access is denied, the edl executor's FileIO call will block until approved.
  - Handle rejection (user denied) by catching the error in `executeScript()` and dispatching a `finish` with error
- [ ] Remove the YES/NO buttons from `renderSummary()`
- [ ] Remove the `pending-user-action` case from `getToolResult()`
- [ ] Run `npx tsc --noEmit` and fix type errors
- [ ] Run edl tests — iterate until passing

### Phase 8: Test migration

See [plans/fileio-tests.md](./fileio-tests.md) for detailed test migration plan.

### Phase 9: Clean up and final verification

- [ ] Remove unused imports across all modified files
- [ ] Verify the thread's `maybeAutoRespond()` still works correctly:
  - While a tool's FileIO call is blocked on permission, the tool is still in `processing` state (not done)
  - `isDone()` returns false → auto-respond is blocked → correct behavior
  - After permission is approved, the FileIO call completes, tool finishes, `isDone()` returns true
- [ ] Verify `renderPendingApprovals` in subagent tools correctly bubbles up both bash_command approvals (via `isPendingUserAction()`) AND file permission requests (via the child thread's `permissionFileIO`) to parent threads
- [ ] Run full test suite: `npx vitest run` — iterate until passing
- [ ] Run `npx tsc --noEmit` — clean build
- [ ] Manual testing: verify permission prompts appear at bottom of thread, not inline with tools
