# Objective and Context

The requested improvements are:

- the archive page and each individual thread archive should be separate buffers, so they can participate in the jump list
- the archive page for a thread should contain a link to the file location, so it's easy to jump to the actual file. Let's put it in the header, and just show the absPath. <CR> on that should open that in the editor.
- each thread, in the header, should have a link to its archive page. Just an [Archive] that then opens the archive page in a buffer (not the raw file, but the magenta archive display)

Today `ChatState` treats the archive list as another rendering mode of the single overview buffer, while selecting an archive row reads `conversation.jsonl`, renders it to markdown, and opens an unmanaged scratch buffer in a non-Magenta window. `BufferManager` only knows the overview buffer pair and live-thread buffer pairs; `Magenta.getActiveKey()`, buffer synchronization, and `BufEnter` handling use that identity to keep the sidebar state and display/input buffers aligned. The live thread header is rendered by `thread-view.ts`, while `Chat.renderSingleThread()` supplies its dependencies. Archive file paths are produced by `threadConversationLogPath(threadId)`. Individual archive displays should remain plain markdown scratch buffers rather than TEA views; their one interactive header path will be wired directly with a buffer-local mapping.

Relevant files:

- `node/buffer-manager.ts` — owns Magenta buffer identities, TEA mounts, reverse buffer lookup, switching, naming, and cleanup.
- `node/magenta.ts` — handles navigation effects, computes the active view, switches sidebar buffers, and reacts to `BufEnter`/`BufDelete`.
- `node/root-msg.ts` — declares root-level effects dispatched by interactive views.
- `node/chat/chat.ts` — owns archive list/detail state, loading, archive rendering, and archive-row bindings.
- `node/chat/thread-view.ts` — renders the live-thread header that will expose `[Archive]`.
- `node/nvim/openFileInNonMagentaWindow.ts` — existing helper for opening the raw absolute archive path outside Magenta windows.
- `node/chat/archive-view.test.ts` — existing archive list, deletion, hydration, and archive-detail integration coverage.
- `node/buffer-manager.test.ts` and `node/buf-enter.test.ts` — buffer lifecycle and cross-buffer navigation coverage.

# Design

Extend the existing `BufferManager` model rather than introducing a parallel archive-buffer system. Model the archive list after the current overview entry: a persistent registered entry, a dedicated display buffer, the shared read-only overview input buffer, lazy TEA mounting, reverse lookup, switching, and recreation after deletion. Model each archived-thread display after the current per-thread entries: a map keyed by `ThreadId`, lazy registration, a stable listed display buffer, reverse lookup, switching/reuse, and explicit removal. The only intentional difference is that an archived-thread entry has manually populated markdown content instead of a mounted TEA app and shares the read-only overview input buffer instead of owning a writable thread input buffer.

Repeat the existing navigation flow used by overview and live-thread buffers. Root-level archive actions update the selected Chat view, then call the same active-view synchronization path that selects the registered display/input pair. `BufEnter` uses `BufferManager.lookupBuffer()` and the existing Magenta-buffer-open handling to restore the archive list or archived-thread selection and coerce the display/input windows into the correct roles. Preserve the existing display-buffer `-` mapping to `threads-navigate-up` and extend that single command's state handling: from an archived thread it selects/synchronizes the archive overview; from the archive overview it selects/synchronizes the thread overview; live-thread parent/overview behavior remains unchanged. Header/back links should dispatch through these same transitions rather than implementing a separate back path.

Keep archive details as plain markdown buffers, but create and manage them through the same `BufferManager` registration/switching lifecycle as live-thread display buffers. Whenever an archived-thread buffer is entered—whether through a link, `-`/back-forward navigation, `<C-o>`/`<C-i>`, or another buffer command—re-read the log and replace the buffer contents with a simple header containing the archived thread heading and absolute `threadConversationLogPath(threadId)`, followed by the current `renderThreadLogToMarkdown()` output. Temporarily make the buffer modifiable only for that refresh, then restore it to read-only. Manually install a buffer-local normal-mode `<CR>` mapping: when the cursor is on the path header, open the real `conversation.jsonl` in a normal editor window; otherwise preserve normal `<CR>` behavior. Archive list rows dispatch the archived-thread selection action, and Magenta switches the sidebar to that registered plain display buffer just as it switches to a live thread.

Add `[Archive]` to the live-thread title line in `thread-view.ts`. Use the root dispatch already available through the thread view context (`thread.context.dispatch`) to dispatch the same archive-opening root action as an archive-list row, carrying the live thread's id. Handle that action at the Magenta/root layer by invoking the plain archive-buffer helper; do not pass an imperative callback through `Chat.renderSingleThread()`. The link opens the rendered markdown archive buffer, while the manually mapped absolute-path line opens the raw file.

Do not add a separate archive navigation mechanism for jump handling. The archive list and archived threads participate for the same reason the existing overview and per-thread views do: they are distinct persistent buffers switched through `BufferManager`, and `BufEnter` synchronizes application state when Neovim jump navigation enters one of them. Opening the raw JSONL path remains the one transition into a normal editor window.

Invariants:

- The overview, archive list, every plain archive detail, and every live thread have distinct stable buffer ids while they exist.
- The archive list and archived-thread displays are recognized as Magenta display buffers in the sidebar; only the raw log opens in a non-Magenta editor window.
- `<C-o>` and `<C-i>` restore overview, archive-list, archived-thread, and live-thread state through the same `BufEnter` synchronization path, with the corresponding writable or shared read-only input buffer.
- The existing `-` display key remains the hierarchical back action: archived thread → archive overview → thread overview, without changing live-thread navigation semantics.
- Entering an archived-thread buffer always refreshes it from the current on-disk log without initializing a live `Thread`, mutating its conversation, or opening the raw archive file until `<CR>` is used on the header path.
- Deleting an archive row removes its files and safely wipes any cached plain detail buffer for that id.
- Wiping the archive-list buffer recreates only that UI buffer; wiping a plain detail buffer drops it from the cache and never deletes archive data.
- Existing archive pagination, title hydration, corrupt-line tolerance, and multi-row deletion behavior remain intact.

# Stages

## Extend the existing buffer model

- Goal: Add archive-list and archived-thread identities to `BufferManager` using the same entry maps, reverse lookup, registration, switching, active-view synchronization, `BufEnter`, and deletion/recovery patterns already used by overview and live-thread buffers. The archive list mirrors the overview TEA entry; each archived thread mirrors a per-thread display entry while sharing the read-only overview input.
- Tests:
  - Opening the archive list replaces the overview display buffer with a different listed Magenta buffer while retaining the read-only overview input buffer.
  - Opening two archived threads creates two registered listed Magenta display buffers, and reopening either id reuses its existing buffer.
  - Actual `<C-o>`/`<C-i>` navigation traverses live thread, overview, archive list, and archived-thread buffers and leaves Chat state plus both sidebar windows synchronized.
  - Pressing `-` in an archived-thread display switches to the archive overview buffer; pressing `-` there switches to the thread overview buffer; pressing `-` in live threads retains the current parent/thread-overview behavior.
  - Wiping archive UI buffers does not remove live threads or archive files, and each view follows the corresponding existing recreation/unregistration behavior.

### Stage 1 completion (2026-08-05)

- [x] Added a persistent, listed archive-list display entry with its own lazy TEA mount and the overview's shared read-only input buffer.
- [x] Added stable, listed per-archive display identities keyed by `ThreadId`, including reverse lookup, reuse, explicit cache removal, and shared-input switching.
- [x] Extended active-view keys, sidebar synchronization, `BufEnter`, and buffer deletion recovery for overview, archive list, archived-thread, and live-thread views.
- [x] Preserved hierarchical `-` behavior: archived thread → archive list → thread overview; existing live-thread parent/overview behavior is unchanged.
- [x] Added actual `<C-o>`/`<C-i>` integration coverage across live thread, overview, archive list, and archived-thread buffers, including corresponding input-window synchronization.
- [x] Added lifecycle coverage proving archive UI buffer wipes do not delete live threads or archive files, archive-list buffers recreate, and archived-thread buffers unregister.

Decisions and stage boundaries:

- The shared read-only input has a dedicated `shared-input` reverse-lookup identity. Entering it preserves an active archive/archive-detail view and otherwise resolves to the thread overview.
- Display-buffer `<C-o>`/`<C-i>` mappings temporarily lift `winfixbuf` only while executing Neovim's native jump. This is not a parallel navigation mechanism; it allows the existing native jumplist to switch persistent Magenta buffers while retaining `winfixbuf` protection at all other times.
- `BufEnter` preserves a correctly entered display buffer and synchronizes only its counterpart input window. Dispatch rendering is suppressed during that state restoration because re-rendering/resetting the entered display invalidates Neovim's forward jumplist.
- Added an internal `archive-restore` chat message for `BufEnter` restoration without triggering the archive-link's full asynchronous switch. The root archive-row/header selection effect remains Stage 2/3 work.
- Archived-thread display buffers are intentionally registered but otherwise unpopulated in this stage. Markdown refresh, read-only display options, archive-row selection, and deletion-driven archive-buffer removal remain Stage 2 work.

### Stage 1 review follow-up (2026-08-05)

- [x] Renamed the Lua native-jump helper and locals to camelCase, and extended the real `<C-o>`/`<C-i>` coverage to verify `winfixbuf` is enabled before and restored after every mapped jump attempt.
- [x] Replaced string/prefix buffer identities with discriminated keys carrying branded `ThreadId` payloads. Reverse lookup is now a disjoint union that permits live-thread display/input, shared input-only, and overview/archive/archive-detail display-only states.
- [x] Made all TEA app factories required at `BufferManager.create()` time. Startup supplies fully initialized factory closures, so mounting APIs are never exposed on a manager with missing factories.
- [x] Added shared-input deletion recovery coverage and strengthened active archive/detail wipe coverage to assert Chat state plus both sidebar buffer roles are synchronized after recovery.

Review testing uses `noautocmd` buffer swaps immediately before wiping active identities so Neovim does not close the sidebar split as a side effect of wiping a buffer currently displayed in that split. The application state remains active, so the tests still exercise the active deletion-recovery branches and verify they reinstall the correct registered buffers.

## Plain archive-detail buffers

- Goal: Populate each registered archived-thread display buffer directly from the archive log, without mounting a TEA app, and refresh its contents on every `BufEnter`. Add a root archived-thread selection action and use it from both archive rows and live-thread views; its handler follows the existing select-thread effect pattern to update state and synchronize the registered buffers. Preserve list loading/deletion behavior and remove a deleted archive's registered buffer through `BufferManager`.
- Tests:
  - `<CR>` on an archive row selects that row's registered Magenta markdown display buffer and renders known user/assistant content from its JSONL log.
  - After the JSONL changes while its archive buffer is inactive, re-entering via direct selection and via `<C-o>`/`<C-i>` replaces the display with the newly rendered content while preserving the header mapping and read-only options.
  - Empty, missing, and partially corrupt logs produce a usable plain detail buffer without crashing or replacing the archive-list buffer.
  - Deleting an archive whose detail buffer was previously opened removes it from disk/list state and unregisters/wipes its display buffer.

## Header links and raw-file opening

- Goal: Add `[Archive]` to every initialized live-thread header and add the absolute conversation log path to each plain archive-detail header. Bind the former by dispatching the root archive-opening action through `thread.context.dispatch`, and manually map the latter inside that buffer.
- Tests:
  - `<CR>` on a live thread's `[Archive]` selects the matching registered Magenta archive buffer, not the raw JSONL file.
  - The detail header displays exactly the absolute `threadConversationLogPath(threadId)` value.
  - `<CR>` while the cursor is on the path opens the real `conversation.jsonl` in a non-Magenta editor window, while `<CR>` elsewhere retains its normal behavior.
  - The archive display remains registered and reachable through sidebar jump navigation after opening the raw file.
  - Existing unhandled `<CR>` target detection and TEA `withBindings` handlers continue to work without intercepting either archive link.

## Regression verification

- Goal: Validate the integrated navigation model and existing archive behavior after the buffer split.
- Tests:
  - Run the focused archive, buffer-manager, BufEnter, thread-view, and display-open-target test files.
  - Run `npx tsgo -b` and `npx biome check .`.
  - Run the full `npx vitest run` suite if the focused checks pass.
