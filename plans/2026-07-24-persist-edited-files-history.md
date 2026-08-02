# Objective and Context

> when showing "files changed this turn", I want that message to persist in the ui, instead of only showing for the latest turn. So we should keep a full snapshot history, and persist the snapshot when the turn ends, so we can show the before/after for *just this turn*

Today the edited-files summary is ephemeral: `ThreadCore.state.editedFilesThisTurn: { path: AbsFilePath; snapshot: string }[]` is cleared at the top of `sendMessage` (and on `reset-after-compaction`), appended to in the `onToolApplied` hook for `edl-edit` tools (storing `tool.previousContent` for the first edit of a file in the turn), and rendered once at the bottom of the thread by `editedFilesSummaryView`. The "after" side is not stored at all — it is read live from the buffer/disk (`Thread.readCurrentFileContent`) whenever the user expands a row, so once a later turn touches the same file the old summary would show a wrong diff even if it were kept.

Key entities:

- `ThreadCore` (`node/core/src/thread-core.ts`) — owns `state.editedFilesThisTurn`, the `onToolApplied` hook (~line 807), the reset in `sendMessage` (~line 1056) and `reset-after-compaction` (~line 533), and emits `turnEnded` (`end_turn` ~760, `error` ~926, `aborted` ~1019). Has `context.fileIO: FileIO` (`readFile(path): Promise<string>`) and `getProviderMessages(): ReadonlyArray<ProviderMessage>`.
- `Thread` (`node/chat/thread.ts`) — subscribes to `core.on("turnEnded")` and dispatches `{type: "turn-ended"}`; owns view state `editedFilesExpanded` keyed by file path, and handles `toggle-edited-file-expanded` / `open-edit-file-diff` / `open-edit-file`.
- `thread-view.ts` — `editedFilesSummaryView(editedFiles, thread, dispatch)` (~line 305) renders the summary; it's assembled into the trailing part of the thread view (~line 455). Messages are rendered by index in `messagesView`, and there is already precedent for anchoring extra UI to a message index (`forkedTo` / `forkedToAtIdx`, `messageViewState[messageIdx]`).
- `displaySnapshotDiff` (`node/nvim/displaySnapshotDiff.ts`) — opens the live file plus a scratch buffer holding `snapshot`, side by side.
- Tests: `node/chat/thread-edited-files.test.ts` (driver-level, asserts the summary text, `=` expansion diff, `<CR>` diffsplit, and reset on next turn); `node/core/src/thread-core.test.ts` `describe("ThreadCore.editedFilesThisTurn")`.

# Design

Turn the single mutable list into a history of finished turns plus the in-flight list.

Core state:

- `editedFilesThisTurn: { path: AbsFilePath; before: string }[]` — unchanged behavior, renamed field `snapshot` -> `before` for symmetry (in-flight turn only).
- `editedFilesHistory: EditedFilesRecord[]` where `EditedFilesRecord = { messageIdx: number; files: { path: AbsFilePath; before: string; after: string }[] }`.

On `turnEnded` (all three reasons), if `editedFilesThisTurn` is non-empty, ThreadCore reads each file's current content via `context.fileIO.readFile` (missing file -> `""`, i.e. deleted), pushes a record with `messageIdx = getProviderMessages().length - 1` (the last message of the just-finished turn), clears `editedFilesThisTurn`, and emits `update`. This snapshotting lives in core because that's where `fileIO` and the edit hook already are, and it makes the behavior testable in `thread-core.test.ts` without nvim.

Why capture `after` at turn end rather than reading live: it's the only way the historical entry stays a faithful before/after for *that* turn. The in-flight turn keeps the existing live-read behavior so the summary updates as edits land.

Ordering caveat: `turnEnded` for `end_turn` is emitted synchronously; the snapshot read is async, so the record is appended slightly later and a re-render is emitted when it lands. The `sendMessage` reset of `editedFilesThisTurn` stays as a safety net (a new turn must not inherit stale entries) but should become a no-op in the normal flow.

Nvim-side buffer content: core's `fileIO.readFile` hits disk, whereas `Thread.readCurrentFileContent` prefers an open buffer. Unsaved buffer contents would be missed at turn end. Accept this: edl writes to disk, and the historical record is defined as the on-disk state at turn end. The live (in-flight) row keeps using the buffer-aware read.

View:

- `editedFilesSummaryView` gains a record identity so expansion state can be per-record: `Thread.state.editedFilesExpanded` becomes keyed by `` `${recordKey}:${filePath}` `` where `recordKey` is the history index or `"current"`.
- Historical records are rendered inline after their `messageIdx` inside `messagesView` (next to the `forkedToAtIdx` hook), with header "Files edited this turn:". Any record whose `messageIdx >= messages.length` (shouldn't normally happen; possible after compaction truncation) is appended at the end, mirroring `trailingForkedToView`.
- For a historical row, the inline `=` patch is computed directly from stored `before`/`after` (no file read, synchronous), and `<CR>` opens a diff of the two stored snapshots. `displaySnapshotDiff` gains an optional `current?: string`; when provided it opens a second scratch buffer (named `<path>_after`) instead of the live file. Without it, behavior is unchanged for the in-flight row.
- Message deltas (`toggle-edited-file-expanded`, `open-edit-file-diff`) gain a `recordKey: number | "current"` field so the handler knows where to look up `before`/`after`.

Compaction: `reset-after-compaction` clears `editedFilesThisTurn` but must *keep* `editedFilesHistory` (the messages it anchors to are also rewritten, so records will fall into the trailing bucket — acceptable; alternatively drop history on compaction. Prefer keeping and letting them render trailing, since losing the record is the thing the user is complaining about).

Fork/clone: `ThreadCore.clone` should copy `editedFilesHistory` for records whose `messageIdx <= nativeMessageIdx` and start with an empty `editedFilesThisTurn`.

Invariants:

- A history record is immutable once written; later turns editing the same file never change an earlier record's before/after.
- Exactly one record per turn that had edits; turns with no edits produce no record.
- `before` for a file is the content prior to the first edit of that file *within that turn* (unchanged from today).
- The in-flight summary continues to show live-vs-snapshot and disappears (converted to a record) when the turn ends.
- Aborted and errored turns still persist their record.

# Stages

## core: history + turn-end snapshot

- Goal: `ThreadCore.state.editedFilesHistory` accumulates one immutable record per turn with before/after content; `editedFilesThisTurn` still reflects the in-flight turn only. Includes the `clone` handling and keeping history across compaction.
- Tests (in `node/core/src/thread-core.test.ts`, extending the existing `editedFilesThisTurn` describe):
  - After a turn that edits a file, `editedFilesThisTurn` is empty and history has one record whose `before` is the pre-edit content and `after` is the post-edit content on disk.
  - A second turn editing the same file produces a second record; the first record's `before`/`after` are unchanged.
  - A turn that edits nothing produces no record.
  - An aborted turn with an edit still produces a record.
  - A file deleted after being edited yields `after === ""` rather than throwing.

## view: render history inline and per-record expansion

- Goal: each finished turn's summary stays in the display buffer, anchored below that turn's last message, expandable independently; the in-flight summary still appears at the bottom.
- Tests (extend `node/chat/thread-edited-files.test.ts`):
  - After two turns each editing a different file, both summaries are visible simultaneously, and the older one appears above the second turn's user message.
  - Expanding the older record's row shows that turn's diff, not a diff against the current file state (concretely: turn 1 edits `a.txt` hello->bye, turn 2 edits `a.txt` bye->ciao; the turn-1 row still shows `-hello`/`+bye`).
  - Expanding both records at once keeps them independent (expansion state is not shared by path).
  - `<CR>` on a historical row opens a two-scratch-buffer diff showing the turn's before and after.
