# Objective and Context

> I want to add a new affordance - "dd" on a message should delete the message and everything after, in effect "resetting" the thread up to that point in time. The inference manager should drop the messages from context, let's make sure we update all stores and supervisors to that same point in time, etc... If we delete inside a tool result, that should also delete the tool_use preceding it.

Key entities:

- `NativeInferenceManager` (`node/server/src/providers/provider-types.ts`) — owns the native array; has `truncateMessages(idx)` which keeps `[0, idx]` *inclusive* and, when `idx` is an assistant tool_use message, extends *forward* to keep its results (fork semantics). Rewind needs `[0, idx)` with orphaned tool_use dropped, so `truncateMessages(idx - 1)` alone would wrongly keep the results when `idx` is a tool-result message. We split the forward extension out so one truncation primitive serves both.
- `ThreadCore.clone` (`node/server/src/thread-core.ts`) — already snapshots every supervisor (`FileSupervisor`, `GitSupervisor`, `EditedFilesSupervisor`, `SystemInfoSupervisor`, `SystemReminderSupervisor`), `contextDeliveries` and EDL registers at a native index. This is exactly "update all stores and supervisors to that point in time".
- `Thread.replaceCore` (`node/server/src/thread.ts`) — the existing core-swap path used by compaction (dispose old core, install new, reset opening/status, `onCoreReplaced`, re-render).
- `ThreadLogger` (`node/server/src/thread-logger.ts`) — append-only archive with a `persistedCount` cursor.
- Protocol `Operation`s (`protocol/operations.ts`, handled in `protocol/server.ts`) — e.g. `thread.fork`.
- Client: `thread-view.ts` wraps each content block with `F` (fork) binding carrying `content.nativeMessageIdx`; `dd` is already a supported key in `tea/bindings.ts`. `Chat.handleForkThread` shows how per-message view state (`messageViewState`, keyed by idx) is copied/filtered.

Files:

- `node/server/src/providers/anthropic-inference.ts`, `openai-inference.ts` — add rewind truncation.
- `node/server/src/thread-core.ts` — add in-place-rewind core construction (clone without fork notice).
- `node/server/src/thread.ts` — `Thread.rewind(idx)`.
- `node/server/src/thread-logger.ts` — record a `rewind` entry, move cursor.
- `node/server/src/protocol/operations.ts`, `protocol/server.ts` — `thread.rewind` op.
- `node/nvimclient/chat/thread-view.ts`, `chat/thread.ts` (NvimThread msgs), `chat/chat.ts` — `dd` binding, view-state pruning.

# Design

Rewind = replace the thread's core with a clone of itself truncated to just before the target message. Reusing `ThreadCore.clone` guarantees every supervisor and store is cut at the same index the fork path already uses, so there is one definition of "state at idx".

1. Client: `dd` on any content block dispatches `{ type: "rewind-message", nativeMessageIdx }`. NvimThread executes `thread.rewind` op, then prunes `messageViewState` / expansion entries with idx >= the cut.
2. Server op → `Thread.rewind(nativeMessageIdx)`:
   - If busy: abort the live submission and await it (same as `destroy`'s unwind), and await any in-flight `reset`. Rewinding while queued mailbox content exists: clear the mailbox (queued content was composed against the dropped future).
   - New core = `ThreadCore.clone(..., { source: this.core, nativeMessageIdx: idx, mode: "rewind" })`. Rewind mode clones the manager, calls `truncateMessages(idx - 1)`, then cuts every supervisor at `manager.getNativeMessageIdx()` (the last kept message, which may be < idx - 1 if an orphaned tool_use message was dropped entirely). It skips the fork notification and `forkSeamIdx`.
   - Swap via a generalized `replaceCore` that accepts the prebuilt core and an `onCoreReplaced` reason, so disposal/status/opening logic stays in one place.
3. One truncation primitive. `truncateMessages(idx)` keeps `messages[0, idx]` and then strips orphaned tool_use/server_tool_use blocks in the last kept message (dropping the message if it becomes empty) — the existing orphan-stripping half of `computeTruncateEndIdx`. It no longer extends forward. The forward extension moves into `getTurnEndIdx(idx)`: if `messages[idx]` is an assistant tool_use message whose results all appear in the following consecutive user messages, it returns the last of those; otherwise `idx`. Fork calls `truncateMessages(getTurnEndIdx(idx))` (unchanged behavior); rewind calls `truncateMessages(idx - 1)`, so cutting at a tool-result message orphans and strips the preceding tool_use. OpenAI: same split; with `idx - 1` landing on a `function_call` item whose output is dropped, the strip walks back over that turn's contiguous `function_call` items (and the `reasoning` item tied to them) and removes them.
4. Archive: `ThreadLogger` appends `{ type: "rewind", nativeMessageIdx }` and sets `persistedCount = getMessages().length` after the swap, so future messages append after the marker. Archive readers/renderers (`archive-renderer.ts`) treat it like a seam.
5. `resultArchive` (completed tool results keyed by request id) is left alone: it is shared immutably across forks/resets and dropped ids are simply unreferenced.

Compaction: only messages in the current core are addressable; rows from pre-compaction history (compactor observable history) get no `dd` binding.

## Interfaces

```ts
// provider-types.ts
interface NativeInferenceManager {
  /** Keep messages [0, messageIdx] and strip any tool_use whose results were
   * dropped. Never extends forward. */
  truncateMessages(messageIdx: NativeMessageIdx): void;
  /** For an assistant tool_use message whose results all follow it, the idx
   * of the last result message; otherwise `messageIdx`. Used by fork. */
  getTurnEndIdx(messageIdx: NativeMessageIdx): NativeMessageIdx;
}

// thread-core.ts
static clone(id, context, callbacks, completedTools,
  fork: { source: ThreadCore; nativeMessageIdx: NativeMessageIdx; mode: "fork" | "rewind" }): ThreadCore;

// thread.ts
rewind(nativeMessageIdx: NativeMessageIdx): Promise<void>;
// ThreadCallbacks.onCoreReplaced gains a discriminated arg:
onCoreReplaced?: (reason:
  | { type: "compaction"; summary: string; chunkCount: number }
  | { type: "reset" }
  | { type: "rewind"; nativeMessageIdx: NativeMessageIdx }) => void;

// protocol/operations.ts
{ type: "thread.rewind"; threadId: ThreadId; nativeMessageIdx: NativeMessageIdx } // success: ok

// thread-logger.ts
| { type: "rewind"; timestamp: string; nativeMessageIdx: number }

// client Msg
{ type: "rewind-message"; nativeMessageIdx: NativeMessageIdx }
```

Supervisors are cut at `cut - 1` (the last kept message) using the same `<= idx` filter `clone` already applies, so a delivery recorded on a dropped message is forgotten and will be re-sent on the next request.

## Invariants

- After rewind the native array is valid for the provider: no tool_use without a tool_result, no tool_result without a tool_use, and the array may end on any role (next submit appends a user message; if it ends on a user message, `appendUserMessage` merges).
- Every supervisor/delivery record keyed > last kept idx is gone; keyed <= it is retained. Files read only in dropped turns are no longer considered "in context" and will be re-delivered.
- Rewind at idx 0 yields an empty conversation but keeps the thread id, title, and system info re-injection (SystemInfoSupervisor clone at -1 must report "not injected").
- Rewind never runs concurrently with a submission or another core replacement.
- Native objects never leave the manager; the client only passes `nativeMessageIdx` it already received on `ProviderMessageContent`.
- Rewinding a compact thread or a subagent thread that is mid-yield is allowed only for root/user-facing threads; reject for `threadType === "compact"`.
- Edited-files and git state reflect conversation knowledge only; rewind does not revert files on disk.

# Stages

## Consolidate truncation

- Goal: `truncateMessages` loses its forward extension; `getTurnEndIdx` added on both Anthropic and OpenAI managers; `ThreadCore.clone` (fork) calls `truncateMessages(getTurnEndIdx(idx))`.
- Tests (server, tier A, against real managers with mock clients):
  - Existing fork/truncate tests pass unchanged when routed through `getTurnEndIdx` (forking at a tool_use message still keeps its results).
  - Rewind (`truncateMessages(idx - 1)`) at a plain user text message drops it and everything after; `log.messages` matches.
  - Cut at a user message holding tool_results drops the preceding assistant tool_use block; assistant text/thinking in that message before the tool_use survives; message dropped if empty.
  - Parallel tool batch: cut at the 2nd result message removes all tool_use blocks of that turn (Anthropic) / all function_call items (OpenAI).
  - Cut at an assistant message drops it; cut at 0 empties the log.
  - A subsequent `sendRequest` produces a request body with no orphan ids (assert on the mock client's received params).

## Core + Thread rewind

- Goal: `Thread.rewind` swaps in a rewind-mode clone; all supervisors cut consistently.
- Tests (harness with `InMemoryFileIO`, `FakeGitClient`):
  - Read file A in turn 1, B in turn 2; rewind to turn 2's user message; next request re-delivers B's context but not A; `getContextDelivery` for dropped idx is undefined.
  - Edited-files supervisor forgets edits made in dropped turns; git supervisor re-sends state.
  - Rewind while streaming / mid tool batch aborts the submission, then the thread is idle with the truncated log; queued mailbox content is cleared.
  - Rewind to 0 re-injects system info on next request.
  - No fork-notification message present; `forkSeamIdx` undefined.

## Protocol + archive

- Goal: `thread.rewind` op; archive records the rewind.
- Tests: op through `MagentaServer.execute` updates thread topic state; `ThreadLogger` writes a `rewind` entry and then only post-rewind messages; archive renderer shows the seam.

## Client binding

- Goal: `dd` on a message block rewinds; view state pruned.
- Tests (tier C, `withDriver`): render a thread with two exchanges, place cursor on the second user message, press `dd`; buffer shows only the first exchange; `messageViewState` has no keys >= cut; pressing `dd` inside a tool result row removes that tool row and the tool_use header. `dd` on pre-compaction history is a no-op.
