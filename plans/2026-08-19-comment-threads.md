# Objective and Context

> I want to develop a new feature that allows magenta to have "side" conversations. The flow will be as follows:
>
> - the user positions the cursor in any buffer, or performs a visual selection in any buffer
> - they use <leader>mc to start the "comment" flow. This pops up an input buffer directly below the selection (I guess a floating window / temporary buffer). <CR> in normal mode, :w submits. esc in normal mode (if the buffer is empty) or :q! cancels
> - when the comment is submitted
>   - we attach it to the buffer as an extmark (so it moves with edits)
>   - we display the user's comment as newline virtual text below the line it's attached to
>   - we use a comment manager (like context manager) to keep track of the comment state, and attach any changes to the next user message
>
>   From the pov of the thread, the comment is two things - the message that goes to the agent - which is basically plaintext that gives the comment's buffer, current location, selected text and comment id, as well as the user's text.
>
>   The nvimthread also creats a piece of state - structured data - that it hangs on to. this is similar to how contextmanager and similar messages work.
>
>   We will then also create a new tool - "reply", that allows the agent to reply to the comment. This appears as just a tool use in the main thread text, but also attaches the reply to the virtual text for the comment thread in the nvim buffer.
>
>   The main idea is that for side-conversations, followup questions, etc... we can have a more structured conversation and keep things organized and localized to the buffer for the user, while the agent still just sees a linear stream of comment messages and uses the reply tool linealry.
>
>   Some other details:
>
> - let's just drop the "magenta clear" command to free up <leader>mc
> - the agent should be able to reply multiple times to the user, and the user should be able to continue the conversation. So each comment should have an array of messages attached to it. These can just be strings and be a lot less rich than a standard user message.
>   - we need an affordance for the user to send another message into the comment thread. I think just <leader>mc on a thread that already contains a comment
> - an affordance to delete a comment thread (this should also append a notification to the thread)
>   - I think architecturally, let's actually just create a CommentManager, like ContextManager, which monitors the state of comments and automatically attaches
> - comments are attached to a root thread. They should be visible whenever that thread is visible (let's just punt on subthreads for now). So we need to show/hide them as threads become selected
> - comments should try and follow changes in the buffer, including agent's changes in and around the comment... we should try and do our best to do that. I think attaching the extmark to the buffer is one attempt, but what happens when the agent makes an edit to the file? (I think we write the edit to disk and then reload the buffer from disk?) Let's verify that.

## Verified ground truth

**Agent edits reload the buffer with `:edit`, and that breaks extmark anchoring.** `SandboxFileIO.writeFile` (`node/capabilities/sandbox-file-io.ts:96-110`) writes to disk and fire-and-forgets `reloadBufferIfOpen` (111-127), which skips modified buffers and otherwise calls `NvimBuffer.attemptEdit` (`node/nvim/buffer.ts:207-219`) — `silent! edit` inside `nvim_buf_call`. Verified in a live nvim: an extmark _survives_ that reload but stays at row 2 even though a line was inserted above it on disk, so after an agent edit the mark points at the wrong text. A second experiment showed that replacing the reload with a `vim.diff`-driven in-place update (`vim.diff(old, new, {result_type="indices"})` + `nvim_buf_set_lines` per hunk, applied back-to-front) moves the same mark 2 -> 3 correctly; the buffer ends up `modified` and must be reset to `nomodified` (its content matches disk by construction). This is a prerequisite for comments following agent edits, and it independently improves undo history.

**`NvimBuffer` already wraps everything else we need.** `setExtmark`/`updateExtmark`/`deleteExtmark`/`getExtmarkById` (`node/nvim/buffer.ts:250-387`) exist but hardcode the `magenta-highlights` namespace via `getMagentaNamespace()`. `ExtmarkOptions` (`node/nvim/extmarks.ts:119-127`) already types `virt_lines`, `virt_lines_above`, `virt_text` — declared but not yet used anywhere.

**Floating windows are not used anywhere yet.** All `nvim_open_win` calls in the repo (`node/sidebar.ts:246-279`, `node/nvim/openFileInNonMagentaWindow.ts:41`, `node/nvim/displaySnapshotDiff.ts:48`) use `split`, not `relative`. The comment input is the first float. Verified live for it: a `relative="win"` + `bufpos` float tracks the window's scrolling, but `row=1` positions it over the first `virt_lines` row rather than below the block, and the float is not auto-closed when its anchor scrolls out of view.

**`NvimBuffer.setInlineKeymaps` (`node/nvim/buffer.ts:160`) is dead code** — it calls `require("magenta.keymaps").set_inline_buffer_keymaps`, which no longer exists in `lua/magenta/keymaps.lua`. Delete it.

**`clear` is lua-only.** `lua/magenta/init.lua:208-222` lists it in `normal_commands` and `keymaps.lua:45` binds `<leader>mc` to it, but `Magenta.command()` (`node/magenta.ts:652-861`) has no `clear` case — it falls through to the error default. Removing it is a two-line deletion.

## Key entities

- `ContextManager` (`node/core/src/context/context-manager.ts:157-902`) — the model to imitate: an `Emitter`, owns a map of tracked state, exposes `getContextUpdate()` (375-407) which _consumes_ pending updates, plus `contextUpdatesToContent()`. Constructed and started by core `Thread` (`node/core/src/thread.ts:126`); the agent drains it in `getAndPrepareContextUpdates` (`node/core/src/agent.ts:1232-1267`).
- `Agent.getAndPrepareContextUpdates()` (`node/core/src/agent.ts:1232-1267`) and its two call sites, `handleSend` (1125-1150) and `buildContinuationContent` (1315-1390) — the exact place comment text gets prepended too, plus the `ContextUpdateSink` (`agent.ts:148`) commit notification next to them.
- `Thread.send(messages: InputMessage[], { queue?: "async" | "next" })` — `InputMessage` is `{type:"user"|"system", text}` (`node/core/src/agent.ts:89-97`). The root reaches it via `{type:"thread-msg", msg:{type:"send-message", messages, queue}}` (`node/chat/thread.ts:713-729`), produced by `Magenta.preprocessAndSend` (`node/magenta.ts:1399`).
- `LuaExecutor` (`node/core/src/capabilities/lua-executor.ts`) — the template for a neovim-backed tool capability: an interface in core, an implementation in `node/capabilities/nvim-lua-executor.ts`, threaded through `AgentContext` -> `CreateToolContext` -> `create-tool.ts:165-171`.
- Tool registration surface: `STATIC_TOOL_NAMES` / `CHAT_STATIC_TOOL_NAMES` / `TOOL_CAPABILITIES` / `TOOL_REQUIRED_CAPABILITIES` (`node/core/src/tools/tool-registry.ts:1-60`), `StaticToolMap` + `TOOL_SPEC_MAP` (`node/core/src/tools/toolManager.ts:43-80`), `createTool` (`create-tool.ts:57-181`), `validateInput` (`helpers.ts:14-50`), and the four render dispatchers in `node/render-tools/index.ts`.
- `Chat` state (`node/chat/chat.ts:107-115`) is `thread-overview | thread-selected | archive*`; `Magenta.selectThreadEffect` (`node/magenta.ts:391-402`) dispatches `set-active-thread` then `syncActiveView()`. `getRootAncestorId` (`chat.ts:871-880`) walks to the root thread.

## Files

- `node/core/src/context/comment-store.ts` (new) — core-side comment state: messages, locations-as-data, the pending queue, the agent-facing text, and the `reply` entry point. No neovim.
- `node/comments/comment-controller.ts` (new) — the neovim half: extmark anchors, rendering, input, keymaps, autocmds, and pushing fresh locations into the store.
- `node/comments/comment-render.ts` (new) — the sign / extent highlight / inline virt_lines rendering of a comment into its buffer (any buffer, not just file-backed ones).
- `node/comments/comment-update-view.ts` (new) — the collapsible `💬` ledger lines in the display buffer, modeled on `renderContextUpdate`.
- `node/comments/comment-input.ts` (new) — the authoring split.
- `node/core/src/tools/reply.ts` (new) — the tool.
- `node/render-tools/reply.ts` (new) — its display in the thread.
- `node/nvim/buffer.ts` — namespaced extmark helpers; diff-based `reloadFromDisk`; delete the dead `setInlineKeymaps`.
- `node/capabilities/sandbox-file-io.ts` — use the diff reload.
- `node/chat/thread.ts` — owns the root thread's `CommentStore` and `CommentController`, wires the capability, the injection and the display ledger.
- `node/magenta.ts` — `comment` command, comment visibility on thread switch.
- `lua/magenta/keymaps.lua`, `lua/magenta/init.lua`, `lua/magenta/options.lua` — `<leader>mc`, drop `clear`, comment-buffer keymaps.

# Design

## Model

A **comment** is a threaded side-conversation anchored to a range of a **buffer**, owned by one root thread:

- `Comment` = id + bufnr + anchor (an extmark) + an ordered array of `CommentMessage` = `{from: "user" | "agent", text}`.
- The anchor is a buffer, not a file, so anything visible in neovim can be commented on: a normal file, the magenta display buffer, an `oil://` listing, a glean diff. The agent is handed the bufnr and bufname and left to read the content however it likes (`get_file`, or lua for a non-file buffer).
- Comments are ephemeral, like threads. Unloading the buffer closes the comment (the agent is told); there is no re-anchoring on reopen and no persistence across sessions.
- The manager is the single source of truth for content; the extmark is the single source of truth for position. Everything drawn — sign, extent highlight, virt_lines — is derived and recomputed on every refresh.
- Comments belong to the root thread. Subagents and subthreads neither see nor can reply to them (`reply` is in `CHAT_STATIC_TOOL_NAMES` only, and only the root `NvimThread` constructs a `CommentStore`).

The feature splits across the two layers along the usual line, and the split is load-bearing:

- **`CommentStore` (core)** holds the conversation: which comments exist, their messages, their pending queue, and a `CommentLocation` per comment that is _plain data_ — a buffer label, a bufnr, a line range, the selected text. Core never touches a buffer, never sets or reads an extmark, never renders, and never asks neovim anything. It builds the agent-facing content part and services `reply`, and it is unit-testable with no neovim at all.
- **`CommentController` (root)** is everything neovim: it resolves a visual range into a location, owns the anchor extmark and the two namespaces, draws the signs and virtual lines, runs the input float and the keymaps, and listens to the buffer autocmds. When an anchor moves or goes invalid it pushes a refreshed `CommentLocation` into the store.

The direction of the dependency is one-way: the controller calls into the store, and reacts to the store's `changed` event to redraw. The store has no reference to the controller and no idea one exists.

## Two views of one comment

The agent sees **one block per request**, shaped exactly like a context update. `contextUpdatesToContent` (`context-manager.ts:407-492`) emits a single `<context_update>` text part containing a `<file_paths>` manifest of every affected path with a one-word status, a prose header explaining what the block is, and then the per-file bodies. `commentUpdatesToContent` mirrors that structure so the agent has one stable place to look rather than n freestanding tags:

The manifest carries the status of every comment touched since the last flush — new messages, deletion, unload — so terminal events live in the manifest instead of as their own tags. Each body identifies the buffer by `bufnr` plus `bufname` (a cwd-relative path when file-backed, `magenta://display` or `oil:///tmp/` when not). The agent already has `get_file` and lua, so it can read the file when there is one and `nvim_buf_get_lines` when there isn't — we don't classify the buffer for it or decide how much content to inline. The `<selection>` is a convenience, not the agent's only view.

```
<comment_update>
These are comments the user has left on ranges of buffers. Use the `reply` tool to answer. You will be notified if comments change.
<summary>
c3 node/foo.ts:41-47 (1 new message)
c4 magenta://display:12-12 (deleted)
c5 node/bar.ts (closed: buffer unloaded)
</summary>
- `c3`
<selection>
  const x = compute();
</selection>
<user>why is this recomputed every render?</user>
</comment_update>
```

The user sees a **localized thread** in the buffer: a sign on the commented range and the whole exchange as virtual lines beneath it, always visible.

`reply` closes the loop. Like `get_files` and `edl` it takes a **batch** — `{replies: [{commentId, text}, ...]}` — so an agent answering three comments does it in one tool use instead of three round trips. The capability applies each reply independently, appends an agent message to each named comment and re-renders its decoration; the tool result reports per-reply success, so one bad id doesn't discard the good replies. The thread view shows it as a one-line tool use listing the ids replied to.

## Delivery

Delivery works exactly like a context update: the manager observes comment state, and whatever request goes out next carries the pending comment text. There is no separate "send a comment" path.

The manager holds `pendingEntries: {commentId, status, text?}[]`. A new comment, a follow-up, a deletion or an unload appends an entry; `commentUpdatesToContent` turns the queue into the manifest plus the bodies, in order:

- `(deleted)` in the manifest — the user deleted the comment.
- `(closed: buffer unloaded)` — the buffer the comment was anchored to went away. It reads the same as a deletion because it means the same thing to the agent: the conversation is over and `reply` on that id will now fail.

Both are terminal. The comment is dropped from the manager as soon as the notice is queued, so it stops rendering and stops appearing in `listOpenCommentIds`, but the queued entry keeps enough of it (id, buffer, range) to render its manifest line on the next request.

The queue is drained where `ContextManager` is drained. `ContextManager` is _not_ a supervisor: the agent holds it in `deps` and calls `getAndPrepareContextUpdates()` from exactly two places, prepending the resulting content to `contentToSend` and then notifying a sink that the update went out:

- `handleSend` (`agent.ts:1125-1150`) — the opening request of a submission;
- `buildContinuationContent` (`agent.ts:1315-1390`) — every continuation, including the pending-messages branch.

`CommentStore` is plumbed the same way — it lives in core, so it goes straight into `AgentDeps` and is consulted at those same two sites, no interface indirection needed. That gives comments the ContextManager delivery semantics for free: mid-turn comments land in the next continuation of the current turn, idle comments ride out with the user's next submission, and neither one starts a turn. No hook, no supervisor, no new call site.

Two consequences:

- The drain must be committed only when the request is actually issued. The agent's `!hasContent && contextContent.length === 0` early settle (`agent.ts:1131`) is the one path that builds content and then abandons it — so the store splits `getPendingUpdate()` (pure) from `commitPending()` (called next to `onContextUpdatesSent`, i.e. only past that guard), and pending comment text counts toward `hasContent` so a lone comment is not thrown away.
- An idle-thread comment is genuinely not delivered until the user sends. The decoration therefore renders undelivered user messages in a `pending` style, which clears on commit. That marker is the user's feedback that the agent has not seen the comment yet.

When `plans/2026-08-16-context-git-hooks.md` lands and converts `ContextManager` into a `ContextSupervisor` driven by `onBeforeRequest` + `onSent`, `CommentStore` converts with it, for the same reasons and with the same `getPendingUpdate`/`commitPending` split mapping onto `inject`/`onSent`.

## Display in the thread

The `<comment_update>` text part is what the agent reads; the user must never see it verbatim in the display buffer. Context updates already solve this exactly: `onContextUpdatesSent` (`node/chat/thread.ts:421-427`) stashes the _structured_ `FileUpdates` into `messageViewState[messageCount].contextUpdates`, and `renderContextUpdate` (`node/context/context-manager.ts:180-266`) draws one collapsible line per file — ``- `path` [ +3/-1 ]`` — with `=` toggling the body and `<CR>` opening the file. The provider text itself is suppressed.

Comments mirror that:

- `commitPending()` hands the committed, structured entries to a `onCommentUpdatesSent` callback on `ThreadCallbacks`, which stashes them as `messageViewState[messageCount].commentUpdates` next to `contextUpdates` and `gitUpdate`.
- `renderCommentUpdate` (`node/comments/comment-update-view.ts`, new) draws one line per entry — ``💬 `node/foo.ts:41-47` [ 1 new message ]``, `[ deleted ]`, `[ closed ]` — with `=` expanding to the message text and `<CR>` jumping to the comment's buffer and range. Collapsed by default, like `expandedUpdates`.
- The `reply` tool renders through the normal tool path (`node/render-tools/reply.ts`), as one line naming the ids replied to, expandable to the reply text.

So the display buffer shows a running `💬` ledger of the side conversation without ever repeating the plaintext, and the full exchange stays where it belongs — inline in the commented buffer.

## Anchoring and following edits

The extmark is the anchor, and the only thing that positions a comment. Comments are ephemeral and belong to a live thread, so there is nothing to re-derive across sessions and no reason to keep a text snapshot around. Three mechanisms:

1. **The extmark.** Set over the commented range with `end_row`/`end_col`, `right_gravity=false`, `end_right_gravity=true`, `invalidate=true`, so user edits inside and around the range move it and an edit that deletes the range marks it invalid. Position is read back with `getExtmarkById` whenever we render or build agent-facing text.
2. **Diff-based reload.** `NvimBuffer.reloadFromDisk()` replaces `attemptEdit()`, so an agent write moves the anchor instead of stranding it. Without this, mechanism 1 silently fails for exactly the edits comments exist to discuss. Only file-backed buffers (`buftype == ""`) are ever reloaded; a comment on a scratch or plugin buffer is never touched by this path.
3. **Invalidation.** When the commented range is deleted outright, `invalidate=true` marks the extmark invalid. The comment then renders `(stale)` at the mark's remaining position and its agent-facing text says the range was deleted. There is no content search and no re-anchoring: the extmark is the position, and when neovim can no longer say where the text went, we say so rather than guessing.
4. **Unload.** A `BufDelete`/`BufWipeout` autocmd closes every comment on that buffer: each queues a `closed: buffer unloaded` entry and is removed. The agent finds out on the next request, exactly as it does for a user deletion, instead of silently holding an id it can no longer reply to. Reopening the file does not bring the comment back; that is the accepted cost of anchoring to a buffer rather than a path.

Both comment namespaces are **long-lived and disjoint from the TEA render loop**. `magenta-highlights` (`node/nvim/buffer.ts:25`) is the namespace every existing extmark helper defaults to via `getMagentaNamespace()`, and `tea.ts:134,321` bulk-wipes it with `clearAllExtmarks()` on every re-render and unmount. A comment anchor in that namespace would be destroyed by an unrelated redraw. So:

- `magenta-comment-anchors` holds the anchor extmarks. Nothing bulk-clears it; a mark leaves only when its comment is deleted, its buffer is unloaded, or the manager is destroyed. This is the namespace whose lifetime actually matters — it is the position of the comment.
- `magenta-comments` holds the rendering (sign, `line_hl_group`, `virt_lines`). It is cleared per buffer with `nvim_buf_clear_namespace` and re-stamped only by `CommentController.refreshBuffer` / `show` / `hide`, never by the TEA loop, which does not know these buffers exist.

The disposability of `magenta-comments` is therefore a property of the manager's own refresh, not of anything external: nothing else may clear it, and clearing it can never lose comment content because the manager is authoritative. The extmark helpers gain an explicit `namespace?` parameter (defaulting to today's behavior) precisely so comments can opt out of the shared, bulk-wiped namespace.

## Rendering

Modeled on diagnostics rather than on a chat window: a commented buffer is still the user's working surface. Refresh runs from `BufReadPost` / `FileChangedShellPost` / `BufWritePost` autocmds and after the agent writes the file, and is disposable — `nvim_buf_clear_namespace` on the render namespace, then re-stamp from the manager. Non-file buffers see none of those autocmds; they are re-stamped on `show()` and whenever their comment changes, which is enough since nothing external rewrites them under us. Comments are **always fully visible, inline**. There is no toggle, no summary line, and no float — a comment is a conversation you are having right now, and hiding it behind a keypress would make it easy to forget you are waiting on a reply. Per comment:

- a `💬` sign and `line_hl_group` across the commented extent, so the range being discussed is obvious;
- `virt_lines` below the extent carrying the whole exchange, one message per line group, `you:` / `agent:` prefixed and highlighted differently, with `(stale)` and `(pending)` markers where they apply.

This means the buffer visibly grows a conversation where a comment sits, which is the intent. The only display state is which thread is active — there is nothing per-buffer to remember.

**At most one comment per line.** A new comment whose range overlaps an existing comment of the active thread becomes a follow-up message on that comment instead of a second comment. That is the whole disambiguation story: every "the comment here" operation resolves to exactly one comment, so there is no `vim.ui.select`, no grouping, and no `(+N more)`.

Decorations live in buffers the user is working in, so they must be scoped to the active root thread. `CommentController.show()` / `hide()` stamp and clear all decorations for their thread. `Magenta.syncActiveView()` (`node/magenta.ts:604-647`) — already the single place that reacts to a thread switch — hides the outgoing root thread's controller and shows the incoming one. Note this is purely a nvim-side concern: the store keeps its comments either way and would happily keep delivering, which is why `hide()` is a controller method and not a store one. A buffer opened after the switch gets stamped from the `BufReadPost` handler; a comment does not survive its buffer being unloaded, so re-stamping only ever applies to a buffer that stayed loaded.

Namespaces are covered under "Anchoring and following edits" above: anchors in `magenta-comment-anchors`, disposable rendering in `magenta-comments`, neither touched by the TEA render loop.

## UI: authoring

Authoring is a **float anchored under the commented lines**, so the input appears where you are looking instead of displacing the window layout.

`<leader>mc` (normal or visual) resolves the target and opens the editor:

- the cursor line or visual range overlaps an existing comment of the active root thread -> a follow-up message on that comment;
- otherwise -> a new comment on the range, or on the cursor line.

The editor is a scratch buffer with `buftype=acwrite`, `bufhidden=wipe`, `filetype=markdown`, named `magenta-comment://<n>`, shown in a float opened with `relative="win"`, `win=<target window>`, `bufpos={lastCommentedRow, 0}`, `col=0`, `border="rounded"`, a `title` naming the comment (`new comment` / `reply to #c3`), width matching the target window's text width up to 80, height growing with the content from 1 to 15 (re-set on `TextChanged`/`TextChangedI`). It is entered and starts in insert mode; a follow-up starts empty.

### Positioning

Verified in a live nvim: with a 3-line `virt_lines` block on line 3, line 3 renders at screen row 4, the virtual lines occupy rows 5-7 and line 4 lands at row 8; a float opened at `bufpos={2,0}, row=1` was positioned at screen row 5 — **on top of the first message**. `row=1` is therefore wrong for a follow-up. The float opens at `row = 1 + <virt lines currently stamped for this comment>`, a count the controller knows exactly because it stamped them. For a new comment there are none and the offset is 1.

Also verified: the float *does* track scrolling (`relative="win"` + `bufpos` moved the float from screen row 4 to 2 when the window scrolled), but when the anchor scrolls out of view the float does not close — it clamps to the window edge and hangs over unrelated text. So a `WinScrolled` / `WinLeave` autocmd on the target window closes the float (a cancel).

### Seeing what you are replying to

The point of anchoring here is that the thing you are responding to is on screen while you type. Three things make that hold:

- **Fit the unit before opening.** Treat the commented extent + the virt block + the input + its border as one unit of height `H`. If the anchor's screen row plus `H` exceeds the window height, `winrestview` the target window first so the unit fits. Without this, a comment near the bottom of the screen gets a float that nvim shoves above the anchor or clamps to the edge, and you type with the conversation off screen.
- **Cap the transcript while the input is open.** Render only the last ~6 message lines plus a `… 3 earlier messages` line for the duration of the input, restoring the full block on submit or cancel. This bounds `H`, and it keeps the most recent agent reply adjacent to where the cursor is — which is the message you are actually answering.
- **Stamp the selection decoration before opening, for a new comment.** A brand new comment has nothing rendered yet, so the `line_hl_group` over the range is stamped provisionally as the float opens and removed on cancel. Otherwise the first-comment case is the one case where you cannot see what you selected.

`col=0` keeps the input aligned with the virtual lines, so it reads as the next message in the conversation rather than as a popup over the buffer.

`BufWriteCmd` (`:w`) and `<CR>` in normal mode submit; `q`, `<C-c>` and `<Esc><Esc>` cancel, as does submitting whitespace-only text. Submitting closes the float and appends the message.

Keys, all `<leader>m`-prefixed to match the plugin's existing convention:

- `<leader>mc` — comment / follow up (normal + visual)
- `<leader>md` — delete the comment here
- `clear` is removed from `normal_commands` and from `default_keymaps` to free `<leader>mc`.

## Interfaces

### Core: `node/core/src/context/comment-store.ts`

Plain state. No `Nvim`, no buffers, no extmarks, no rendering. A location is a value the nvim side hands in and refreshes; core never computes or resolves one. The `BufNr` in it is an opaque identifier core only echoes back to the agent — core re-declares the brand (`number & {__bufnr: true}`, today in `node/nvim/buffer.ts:13`) the same way it re-declares `Row0Indexed` (`node/core/src/utils/string-position.ts:3` vs `node/nvim/window.ts:4`), so the two stay structurally assignable across the project boundary.

```ts
export type CommentId = string & { __commentId: true };

export type CommentMessage = { from: "user" | "agent"; text: string };

/** Everything core knows about where a comment lives: strings and numbers
 * the nvim layer resolved for it. Core never derives this. */
export type CommentLocation = {
  /** How the buffer is named to the agent: a cwd-relative path when
   * file-backed, otherwise the bufname. */
  bufferLabel: string;
  bufnr: BufNr;
  /** 1-indexed inclusive, as shown to the agent. Absent when stale. */
  lines?: { start: number; end: number };
  /** The commented text, for the `<selection>` body. */
  selection: string;
  state: "anchored" | "stale";
};

export type Comment = {
  id: CommentId;
  location: CommentLocation;
  messages: CommentMessage[];
};

export type CommentStoreEvents = {
  /** Something the nvim layer needs to redraw changed. */
  changed: [];
};

export class CommentStore extends Emitter<CommentStoreEvents> {
  constructor();

  readonly comments: { [id: CommentId]: Comment };

  /** The nvim layer creates the comment once it has resolved a location. */
  addComment(location: CommentLocation, text: string): CommentId;
  addUserMessage(id: CommentId, text: string): void;
  /** The `reply` tool's entry point. Errors on an unknown id. */
  addAgentMessage(id: CommentId, text: string): Result<void>;
  /** Refresh a location after the nvim layer re-read its extmark. */
  setLocation(id: CommentId, location: CommentLocation): void;
  /** Terminal. Queues the manifest entry, then drops the comment. */
  closeComment(id: CommentId, reason: "deleted" | "buffer-unloaded"): void;

  /** The single `<comment_update>` content part for undelivered messages,
   * built like `contextUpdatesToContent`. Empty array when nothing is
   * pending. Pure. */
  getPendingUpdate(): ProviderMessageContent[];
  /** Marks everything returned by the last `getPendingUpdate` as delivered.
   * Emits the structured entries for the thread's display ledger. */
  commitPending(): CommentUpdateEntry[];
  /** Ids with undelivered user messages — the `pending` render style. */
  pendingCommentIds(): CommentId[];
  /** Ids the agent may reply to right now. */
  listOpenCommentIds(): CommentId[];
}
```

The agent's `AgentDeps` holds this object directly; the drain sites use only `getPendingUpdate` / `commitPending`, and the `reply` tool capability uses only `listOpenCommentIds` / `addAgentMessage`. There is no separate `CommentSource` file — the store *is* the source, exactly as `ContextManager` is.

### Nvim: `node/comments/comment-controller.ts`

Everything neovim. Owns the bufnr-to-extmark mapping, the two namespaces, the rendering, the input float, the keymaps and the autocmds. It is the only thing that knows a comment has an extmark at all, and it keeps core's `CommentLocation` up to date.

```ts
export type CommentAnchor =
  | { state: "anchored"; bufnr: BufNr; extmarkId: ExtmarkId }
  | { state: "stale"; bufnr: BufNr; lastRow: Row0Indexed };

export class CommentController {
  constructor(nvim: Nvim, cwd: NvimCwd, store: CommentStore);

  /** The comment whose extent covers `row`, if any. At most one. */
  at(bufnr: BufNr, row: Row0Indexed): CommentId | undefined;

  /** Resolves the range to a location, sets the anchor extmark, then
   * `store.addComment`. Appends a follow-up instead when `rows` overlaps
   * an existing comment. */
  addComment(args: {
    bufnr: BufNr;
    /** Inclusive line range; a bare cursor is a one-line range. */
    rows: { start: Row0Indexed; end: Row0Indexed };
    text: string;
  }): Promise<CommentId>;

  deleteComment(id: CommentId): Promise<void>;

  /** Read back every anchor in this buffer, push the resulting locations
   * into the store (marking `stale` where the extmark went invalid),
   * clear the render namespace and re-stamp. */
  refreshBuffer(bufnr: BufNr): Promise<void>;

  show(): Promise<void>;
  hide(): Promise<void>;
  destroy(): Promise<void>;
}
```

Before a drain, locations must be current — the controller refreshes the anchors of every commented buffer whenever the buffer changes, so `getPendingUpdate` reads locations that are already fresh and stays synchronous and pure.


The `reply` tool talks to that same object; ids arrive from the model as plain strings and are narrowed to `CommentId` by `validateInput` against `listOpenCommentIds()`.

`node/core/src/tools/reply.ts`:

```ts
/** Like `get_files` / `edl`, a batch: the agent answers every comment it
 * has something to say about in one tool use. */
export type Input = { replies: { commentId: CommentId; text: string }[] };
export type ToolRequest = GenericToolRequest<"reply", Input>;
export type PerReplyResult = { commentId: CommentId; isError: boolean };
export type StructuredResult = {
  toolName: "reply";
  replies: PerReplyResult[];
};

export const spec: ProviderToolSpec; // name "reply"
export function execute(
  request: ToolRequest,
  context: { commentStore: CommentStore },
): ToolInvocation;
export function validateInput(input: { [key: string]: unknown }): Result<Input>;
```

Registry deltas: `"reply"` added to `STATIC_TOOL_NAMES` and `CHAT_STATIC_TOOL_NAMES`; `"comments"` added to `TOOL_CAPABILITIES`; `TOOL_REQUIRED_CAPABILITIES.reply = new Set(["comments"])`. `AgentContext` gains `commentStore?: CommentStore`, plumbed to `CreateToolContext` exactly as `luaExecutor` is.

`node/nvim/buffer.ts` deltas:

```ts
export const MAGENTA_COMMENT_NAMESPACE = "magenta-comments";

// existing extmark methods gain an optional namespace, defaulting to the
// current magenta-highlights behavior
export const MAGENTA_COMMENT_ANCHOR_NAMESPACE = "magenta-comment-anchors";
setExtmark(args: { startPos; endPos; options; namespace?: string }): Promise<ExtmarkId>;
deleteExtmark(extmarkId: ExtmarkId, namespace?: string): Promise<void>;
getExtmarkById(extmarkId: ExtmarkId, namespace?: string): Promise<{...} | undefined>;

/** Replace `attemptEdit`. Applies the on-disk content as a minimal diff so
 * extmarks and undo history survive. No-op if the buffer is modified. */
reloadFromDisk(): Promise<void>;

```

Lua: `<leader>mc` -> `magentaComment` rpcnotify with `{bufnr, rows}` (visual variant reads `'<`/`'>`); `<leader>mD` -> `:Magenta comment-delete`; `M.set_comment_buffer_keymaps(bufnr)` for the authoring split, reading a new `commentKeymaps` option defaulting to `{normal = {["<CR>"] = ":MagentaCommentSubmit<CR>", ["q"] = ":MagentaCommentCancel<CR>"}}`; `]c`/`[c` installed buffer-locally on commented buffers; `clear` removed from `normal_commands` and from `default_keymaps`.

## Invariants

- The manager is authoritative: extmarks and virtual lines are derived and may be recomputed from scratch at any time without losing comment content.
- The agent-facing `<comment_update>` text is never rendered verbatim in the display buffer; the thread shows the structured ledger instead.
- A queued comment message is delivered exactly once, and stays queued (and renders as `pending`) until a request that carries it is actually issued.
- Comment delivery has exactly one path: the agent's `CommentStore` drain, at the same two sites as the context update. Nothing else calls `send`, `prependToNextTurn`, or otherwise pushes comment text into the thread.
- Core never sees a buffer, an extmark or a window. Everything positional reaches `CommentStore` as a `CommentLocation` the controller resolved; if a location is stale, that is because the controller said so.
- Pending comment text counts as content for the agent's early-settle guard: a submission carrying only a comment must still issue a request.
- `reply` is a batch and partially succeeds: an unknown or deleted comment id fails only its own entry, the sibling replies still land, and nothing throws out of `execute`.
- Rendering is idempotent and disposable: clearing the render namespace and re-stamping from the manager must reproduce the identical display. No display state lives in extmarks; the anchor extmark is never cleared by a re-stamp.
- The extmark is the only source of position. A comment is never re-pointed by searching the buffer for matching text; a comment whose extmark is invalid is `stale` and says so.
- A comment is anchored to a bufnr, and any buffer qualifies — file-backed or not. Unloading that buffer closes the comment; the comment is never re-anchored by reopening the path.
- Every terminal event — user deletion, buffer unload — queues a notice through the same pending path before the comment is dropped, so the agent's set of open comment ids never shrinks without it being told.
- `reloadFromDisk` must not clobber unsaved user changes: if the buffer is `modified`, it does nothing, exactly like today's `reloadBufferIfOpen` guard.
- After `reloadFromDisk`, the buffer's `modified` flag is false and its content equals the on-disk content byte for byte (including the trailing-newline / `noeol` case).
- Comments survive compaction — they live in `NvimThread`, not in the provider message history. After a compaction the agent no longer has the comment text in context, so the flush text must be self-contained (file, lines, selection, id) every time, not a delta.

# Stages

## Diff-based buffer reload — DONE

Implemented in `node/nvim/buffer.ts` (`reloadFromDisk`, replacing `attemptEdit`) and
`node/capabilities/sandbox-file-io.ts`. Tests in `node/nvim/buffer-reload.test.ts`.

Notes / deviations:

- `reloadFromDisk` reads the file itself in lua (`io.open` on the buffer's name) rather than
  relying on `:edit`, diffs against the current lines with `vim.diff(..., {result_type="indices"})`
  and applies hunks back-to-front with `nvim_buf_set_lines`.
- Trailing-newline handling: `endofline`/`fixendofline` are set from whether the on-disk content
  ends in `\n`, so a later `:write` reproduces the file byte for byte. The test asserts the options
  rather than round-tripping through `:write` (writing from a `nvim_buf_call` in the test harness hung).
- The `modified` guard now lives in both `reloadFromDisk` and `SandboxFileIO.reloadBufferIfOpen`
  (the latter keeps its warning log).
- `setInlineKeymaps` was left in place here; deleted in stage 2.
- Review follow-up: added `reloadFromDisk` tests for multi-hunk reloads, a pure deletion hunk,
  truncation to an empty file, and a missing file (silent no-op, buffer left intact).


- Goal: agent edits update open buffers as a minimal diff instead of `:edit`, so extmarks (and undo) survive. `NvimBuffer.attemptEdit` is replaced by `reloadFromDisk`; `SandboxFileIO.reloadBufferIfOpen` calls it.
- Tests:
  - An extmark over line 3 of an open file, followed by an `edl` edit that inserts a line above it, still covers the same _text_ afterwards. (The exact case that fails today — assert on the mark's resolved text, not its row.)
  - After an agent edit to an open, unmodified buffer: buffer content equals disk content, and `modified` is false.
  - An open buffer with unsaved user changes is left untouched by an agent write (existing behavior preserved).
  - An agent edit to a file whose buffer is open undoes back to the pre-edit content in one `u`.

## Comment state and rendering — DONE

Implemented in `node/core/src/context/comment-store.ts` (+ `comment-store.test.ts`),
`node/comments/comment-render.ts`, `node/comments/comment-controller.ts`
(+ `comment-controller.test.ts`), with namespace support added to the extmark helpers in
`node/nvim/buffer.ts`. `setInlineKeymaps` deleted.

Notes / deviations:

- `CommentController.at()` is **async** (the plan showed it sync): resolving "the comment here"
  requires reading the anchor extmark back, which is an nvim round trip.
- `CommentStore.addAgentMessage` returns `Result<undefined>`; agent messages are marked delivered
  immediately (the agent wrote them, so they never queue).
- Added `CommentStore.hasPendingUpdates()` for stage 4's early-settle guard, and
  `CommentUpdateEntry` carries the location + the undelivered messages so the display ledger
  needs nothing else.
- `CommentLocation.lines` is typed `| undefined` because of `exactOptionalPropertyTypes`.
- The controller serializes all refreshes through a single promise chain and suppresses its own
  `changed` handler while stamping — otherwise the `setLocation` calls a refresh makes would
  schedule a redundant, interleaving refresh and duplicate/erase stamps.
- `CommentController.closeBuffer(bufnr)` exists for the unload path; the autocmd that calls it is
  stage 3 work.
- Extent highlight is stamped one extmark per line (`line_hl_group` + `sign_text` on the first
  line) rather than one ranged extmark, since `line_hl_group` is a per-mark-line property.
- Rendering already supports the `maxMessages` elision the stage-3 input UI needs.

Review follow-ups (stage 2):

- `CommentLocation` is now a discriminated union on `state`: `anchored` carries `lines` and
  `selection`, `stale` carries neither, so a stale location can no longer fabricate
  `selection: ""`.
- `CommentUpdateEntry` is likewise a union: `new-messages` carries a non-empty
  `[CommentMessage, ...CommentMessage[]]`, close entries carry no messages.
- Closing a comment that still has undelivered user messages now queues those messages as a
  `new-messages` entry *before* the terminal notice, so a delete never silently swallows what the
  user wrote. Covered by a test.
- `CommentController.at()` no longer falls back to the cached extent: a stale comment covers no
  rows, so a new comment on those rows is a new comment rather than a follow-up. Tested.
- Extmark namespace parameters are typed `MagentaNamespace` (a union of the three exported
  constants) instead of bare `string`; `ExtmarkOptions` gained the read-only `invalid` flag so the
  stale check is type-checked rather than cast.
- `commentVirtLines`'s `maxMessages` elision is covered by a neovim-free unit test
  (`node/comments/comment-render.test.ts`), including the singular/plural boundary.

- Goal: `CommentStore` and `CommentController` exist and work end-to-end from a programmatic API — add a comment over a range, anchor it with an extmark, stamp the sign, extent highlight and inline `virt_lines`, add messages, delete, show/hide. No keymaps, no agent involvement yet. Also delete the dead `setInlineKeymaps`.
- The store's tests need no neovim at all: locations go in as data, `<comment_update>` text comes out. Only the controller's tests drive a real buffer.
- Tests:
  - Adding a comment over a two-line range stamps a sign, `line_hl_group` across both lines, and one virtual line per message below the range — with no keypress in between.
  - Adding a message to an existing comment adds a virtual line in order, and every message stays visible.
  - After the user inserts lines above the range, the stamp follows the text on the next refresh (the extmark moved).
  - After an `edl` edit that inserts a line above the commented range, the anchor moves with it (this is what stage 1 buys).
  - After an `edl` edit that deletes the commented lines, the comment goes `stale`, renders the marker at its last known row, and reports the deletion in its agent-facing text.
  - `addComment` over a range that overlaps an existing comment appends a follow-up to it and creates no second comment; the buffer never carries two comments on one line.
  - `hide()` leaves zero extmarks in the render namespace; `show()` restores them; the highlight namespace is untouched.
  - `refreshBuffer` on a buffer opened after the comment was created stamps it.
  - A comment on a non-file scratch buffer (`buftype=nofile`) renders identically and its agent-facing text carries that buffer's bufnr and bufname.
  - Wiping a commented buffer removes the comment and its rendering, and reopening the same file does not restore it.

## Comment input UI and keymaps — DONE

Implemented in `node/comments/comment-input.ts` (+ `comment-input.test.ts`), with controller
support (`setTranscriptCap`, `virtLineCount`, `setPreview`, `extentsInBuffer`, `inRange`) in
`node/comments/comment-controller.ts`, `renderPreview` in `node/comments/comment-render.ts`,
notification handlers + `CommentInput`/`CommentController` ownership in `node/magenta.ts`,
`Chat.getActiveRootThreadId` in `node/chat/chat.ts`, and the lua half in
`lua/magenta/keymaps.lua`, `lua/magenta/init.lua`, `lua/magenta/options.lua`.

Notes / deviations:

- `clear` is gone: dropped from `normal_commands` and from `default_keymaps`. `<leader>mc`
  (normal + visual) now opens the comment input; `<leader>mD` deletes the comment under the cursor.
- **Stage-3 ownership is temporary.** `Magenta` holds a `CommentStore` + `CommentController` per
  root thread (`Magenta.getCommentController()`), because nothing drains the store yet. Stage 4
  moves the store into `NvimThread`; this map is what it replaces.
- Submit/cancel are routed through `:MagentaCommentSubmit` / `:MagentaCommentCancel` user commands
  (registered by the bridge, torn down with it) plus a `magentaCommentInput` rpcnotify. That keeps
  the `commentKeymaps` option a plain table of `key -> command string`, matching `sidebarKeymaps`
  and `displayKeymaps`. `<Esc><Esc>` is bound unconditionally in addition to the option.
- Everything that is purely geometric lives in lua: `fit_comment_input` (scroll the target window
  so the extent + transcript + float unit fits, via `nvim_win_text_height` with a fallback) and the
  `TextChanged`/`TextChangedI` resize inside `setup_comment_input`. Node only supplies the anchor
  row, the virt-line offset and the unit height.
- The transcript cap is 3 messages (`INPUT_TRANSCRIPT_MESSAGES`), not "~6 message lines" — a message
  can wrap to several lines, and capping by message is what `commentVirtLines` already supports.
- `]c` / `[c` are installed buffer-locally only after a comment is submitted in that buffer, and
  resolve through node (`magentaCommentJump`) since node owns the extents.
- New `<leader>mc` on a buffer that already has a comment at the cursor is routed through
  `CommentController.inRange`, so the follow-up path and the "at most one comment per line" rule
  share one implementation with `addComment`.
- Tests drive the lua entry points (`require("magenta.keymaps").comment()` / `comment_visual()` /
  `comment_delete()`, `:MagentaCommentSubmit`) rather than feeding `<leader>mc` keystrokes, which
  exercises the same rpcnotify path without depending on leader-key timing.
- Not covered by an automated test: `q` / `<C-c>` specifically (the cancel *path* is covered via
  `:MagentaCommentCancel`, which is what those keys are bound to).

- Goal: `<leader>mc` in normal and visual mode opens the authoring float; `<CR>`/`:w` submit, `q`/`<C-c>`/empty cancel; `<leader>mc` over an existing comment adds a follow-up; `<leader>mD` deletes; `]c`/`[c` jump. `clear` is gone.
- Tests:
  - Visual-select two lines, `<leader>mc`, type text, `<CR>`: the float closes and the comment renders over those lines with its text inline.
  - The float is positioned below the last selected line and grows as the text wraps past one line.
  - Opening a follow-up on a comment with three messages puts the float *below* all three virtual lines, not over the first one.
  - Opening the input near the bottom of the window scrolls the target window so that the commented extent, the transcript and the input are all on screen.
  - While the input is open on a comment with ten messages, only the last few render plus an `… N earlier messages` line; cancelling restores the full transcript.
  - Opening the input for a new comment highlights the selected range before anything is typed, and cancelling removes that highlight.
  - Scrolling the anchor out of view closes the float without creating a comment.
  - `q` in the float creates no comment and restores the cursor to the original window; submitting whitespace-only text creates no comment.
  - `<leader>mc` with the cursor inside an existing comment's range appends a follow-up rather than creating a second comment.
  - `<leader>mD` on a comment removes it and its rendering.
  - `]c` from above the first comment lands on it; `[c` from below returns.
  - `:Magenta clear` is no longer offered in completion and `<leader>mc` no longer resolves to it.

## Delivery to the agent

- Goal: `AgentDeps.commentStore` exists and is drained alongside the context update in `handleSend` and `buildContinuationContent`; the root `NvimThread` constructs the store and hands it to the agent. Pending messages render as `pending` until committed.
- Tests:
  - Submitting a comment on an idle thread issues no provider request and shows the message as pending. The user then sends a sidebar message, and that request carries a `<comment_update>` part (right id in the manifest, buffer, line range, selection) ahead of the user's text; the pending marker clears.
  - Submitting a comment mid-turn does not preempt the turn; the block appears in the next request of that same turn.
  - Two comments submitted before a request goes out arrive in a single `<comment_update>` part, both listed in the manifest in submission order, and are not repeated on the following request.
  - The display buffer shows one collapsible `💬` line per delivered comment entry and nowhere shows the raw `<comment_update>` text; `=` expands it to the message text.
  - Deleting a comment delivers a `(deleted)` manifest line through the same path, in order relative to other comment messages.
  - Wiping a commented buffer delivers a `(closed: buffer unloaded)` manifest line on the next request, even though the comment no longer exists in the manager, and `reply` on that id afterwards is a tool error.
  - The reported line range reflects the comment's _current_ position after intervening edits, not the position at creation.
  - After a compaction, a new comment still delivers a self-contained block (the `CommentStore` is re-bound to the swapped-in agent, as the context manager is).

## The reply tool

- Goal: `reply` is registered, gated on the new `comments` capability, available only to root chat threads; the root `NvimThread` supplies its `CommentStore` as the capability; replies append to the decoration (via the store's `changed` event) and render as a tool use in the thread.
- Tests:
  - A mocked `reply` tool use with two replies appends an `agent:` virtual line under each of the two comments and shows a one-line tool entry in the display buffer.
  - A batch mixing a valid id with an unknown one applies the valid reply and reports an error for just the unknown one; it does not throw.
  - A subagent's tool specs do not include `reply`; a root thread's do.
  - Full round trip: user comments -> agent replies -> user follows up on the same comment with `<leader>mc` -> the follow-up block carries the same comment id and the decoration shows all three messages in order.

## Visibility across threads

- Goal: comments are scoped to their root thread and shown/hidden on thread switch and on buffer enter.
- Tests:
  - Comment on thread A, switch to thread B: the decoration disappears; switch back: it returns with its full message history.
  - Opening a file in a new window after switching threads shows only the active thread's comments.
  - Deleting a thread destroys its manager and leaves no extmarks behind.
