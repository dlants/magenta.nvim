### Phase 8: Test migration

The goal is to move permission and FileIO logic into unit tests where possible, and keep integration tests only for end-to-end flows that genuinely need nvim.

#### Existing test files and their disposition

**`node/tools/permissions.test.ts`** (27 tests) — **KEEP AS-IS**
These are already pure unit tests (no nvim/driver). They test `getEffectivePermissions`, `hasNewSecretSegment`, `canReadFile`, `canWriteFile` directly. They remain valid and useful.

**`node/tools/bash-parser/permissions.test.ts`** (67 tests) — **KEEP AS-IS**
Already pure unit tests for command permission matching. Not affected by this change.

**`node/edl/executor.test.ts`** (~65 tests) — **KEEP AS-IS**
Already pure unit tests using real filesystem via `withTmpDir`. They test the EDL executor with default `FsFileIO`. Not affected by this change.

**`node/edl/index.test.ts`** (~10 tests) — **KEEP AS-IS**
Already pure unit tests for `runScript()`. Not affected.

**`node/tools/getFile.test.ts`** (40 integration tests) — **SPLIT INTO UNIT + INTEGRATION**

Tests to **convert to PermissionCheckingFileIO unit tests** (`node/tools/permission-file-io.test.ts`):

- [ ] `"getFile automatically allows files matching getFileAutoAllowGlobs"` → unit test: given options with globs, `PermissionCheckingFileIO.readFile()` delegates without blocking
- [ ] `"getFile automatically allows files matching glob patterns"` → unit test: same, multiple glob patterns
- [ ] `"getFile still requires approval for files not matching getFileAutoAllowGlobs"` → unit test: non-matching file creates pending permission
- [ ] `"getFile automatically allows files in skills directory"` → unit test: skillsPaths auto-allows read
- [ ] `"getFile rejection"` → unit test: denied path, call `deny()`, verify Promise rejects
- [ ] `"displays approval dialog with proper box formatting"` → unit test: verify pending permission view renders YES/NO
- [ ] `"getFile approval"` → unit test: denied path, call `approve()`, verify Promise resolves
- [ ] `"getFile requests approval for file outside cwd"` → unit test: path outside cwd creates pending permission
- [ ] `"getFile respects filePermissions from ~/.magenta/options.json for external directories"` → unit test: `filePermissions` with read=true auto-allows
- [ ] `"getFile requires approval for external directory without filePermissions"` → unit test: no filePermissions → pending
- [ ] `"getFile respects tilde expansion in filePermissions paths"` → unit test: tilde in filePermissions expands correctly
- [ ] `"getFile can read files using tilde path with user approval"` → unit test: tilde path without permission → pending → approve → resolves

Tests to **convert to GetFileTool unit tests** (`node/tools/getFile.unit.test.ts`) using mock FileIO:

- [ ] `"getFile returns early when file is already in context"` → unit test: mock contextManager has file, verify early return without FileIO call
- [ ] `"getFile reads file when force is true even if already in context"` → unit test: force=true, verify FileIO.readFile is called
- [ ] `"should handle file size limits appropriately"` → unit test: mock FileIO.stat returns large size, verify error
- [ ] `"large text files are truncated and skip context manager"` → unit test: mock FileIO.readFile returns large content, verify truncation
- [ ] `"lines that are too long are abridged and skip context manager"` → unit test: mock FileIO.readFile returns long lines, verify abridging
- [ ] `"startLine and numLines parameters work and skip context manager"` → unit test: mock FileIO.readFile returns known content, verify line slicing
- [ ] `"startLine parameter alone works and skips context manager"` → unit test: same pattern
- [ ] `"requesting line range from file already in context returns early without force"` → unit test: line range on file in context
- [ ] `"force parameter with line range returns just those lines"` → unit test: force + line range
- [ ] `"invalid startLine beyond file length returns error"` → unit test: startLine past EOF
- [ ] `"line ranges with long lines still get abridged"` → unit test: line range + long lines

Tests to **keep as integration tests** (need real nvim for buffer interaction or rendering):

- [ ] `"render the getFile tool."` — verifies rendering in sidebar
- [ ] `"should expand get_file tool detail on <CR>"` — verifies keybinding + rendering
- [ ] `"should extract PDF page as binary document when pdfPage parameter is provided"` — complex file type handling
- [ ] `"should handle multiple PDF pages and show correct context summary"` — PDF multi-page
- [ ] `"should return PDF basic info when pdfPage parameter is not provided"` — PDF metadata
- [ ] `"should handle invalid PDF page index"` — PDF error handling
- [ ] `"getFile adds file to context after reading"` — verifies context manager in real thread
- [ ] `"getFile reads unloaded buffer"` — nvim buffer lifecycle
- [ ] `"should process image files end-to-end"` — file type detection + content
- [ ] `"getFile provides PDF summary info when no pdfPage parameter is given"` — PDF summary
- [ ] `"should reject binary files that are not supported"` — unsupported file type error
- [ ] `"should add images to context manager"` — image context tracking
- [ ] `"should add PDFs to context manager"` — PDF context tracking
- [ ] `"should continue to add text files to context normally"` — text context tracking
- [ ] `"should handle mixed content types in a single conversation"` — multi-type conversation
- [ ] `"should show file summary for large TypeScript file"` — needs real file for summary
- [ ] `"should show file summary for large file with unknown extension"` — same

**`node/tools/edl.test.ts`** (10 integration tests) — **PARTIALLY CONVERT**

Tests to **keep as integration tests**:

- [ ] `"can execute a successful script"` — full tool rendering cycle
- [ ] `"returns error on parse error"` — error rendering
- [ ] `"returns error on execution error"` — partial failure rendering
- [ ] `"shows mutation summary in display"` — summary rendering
- [ ] `"toggles between preview and detail view"` — keybinding + rendering
- [ ] `"preview shows abridged script for long scripts"` — preview truncation rendering
- [ ] `"detail view shows full unabridged script"` — detail rendering
- [ ] `"edl writes to nvim buffer when file is open"` — nvim buffer write interaction
- [ ] `"edl reads from buffer when buffer has unsaved changes"` — nvim buffer read interaction

Tests to **convert to unit tests** (new file: `node/tools/edl.unit.test.ts`):

- [ ] `"edl edit updates context manager agent view"` → unit test with mock FileIO + mock context

**`node/tools/bashCommand.test.ts`** (35 integration tests) — **NOT IN SCOPE**
Bash command permissions are not part of this change. These stay as-is.

#### New test files to create

- [ ] `node/tools/permission-file-io.test.ts` — unit tests for `PermissionCheckingFileIO`:
  - Given allowed path, `readFile` delegates to inner FileIO immediately
  - Given denied path, `readFile` blocks and adds to pending list
  - `approve(path)` resolves the blocked readFile Promise
  - `deny(path)` rejects the blocked readFile Promise
  - `writeFile` same pattern
  - `readBinaryFile` same pattern
  - `fileExists`, `mkdir`, `stat` pass through without permission check
  - Multiple concurrent permission requests tracked correctly
  - `getPendingPermissions()` returns correct list
  - Auto-allows magenta temp files
  - Auto-allows skills directory files for read
  - Respects `filePermissions` config (read, write, readSecret, writeSecret)
  - Tilde expansion in permission paths
  - `view()` renders YES/NO buttons for each pending permission

- [ ] `node/tools/getFile.unit.test.ts` — unit tests for GetFileTool with mock FileIO:
  - Tool calls FileIO.readFile and returns content as tool result
  - Tool calls FileIO.readBinaryFile for images
  - Tool calls FileIO.stat for existence check
  - Context manager early-return logic (no FileIO call)
  - Force flag bypasses context check
  - Line range slicing
  - Large file truncation
  - Long line abridging

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
