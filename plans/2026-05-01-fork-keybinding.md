# context

The goal is to replace the current `@fork` command flow with a key-binding-based fork mechanism on individual **messages** in the display buffer, with cut points identified by the underlying native message index:

- **Normal mode `F` on a message** — fork the thread, keeping every message up to and including the one under the cursor (with tool-use extension forward) and dropping everything after. Switch to the new fork, place the cursor in the input buffer. The input buffer is empty.
- **Visual mode `F` on a message** — same as normal mode, but pre-populate the input buffer with the visually-selected text wrapped as a markdown blockquote (`> ` prefix on each line).

The new fork retains the conversation state up to the chosen point. The user composes their next message in the input buffer; nothing is auto-sent.

## Stable indexing via `nativeMessageIdx`

Native messages (`Anthropic.MessageParam[]` inside `AnthropicAgent`) are append-only — the agent only pushes new messages, mutates the trailing in-progress assistant message during streaming, or slices off a tail during truncate/cleanup. Lower indices never shift. This makes the **native message index** a stable identifier we can use to refer to a logical position in the conversation across re-renders and clones. The existing `NativeMessageIdx` branded integer type (`number & { __nativeMessageIdx: true }` in `provider-types.ts`) is reused throughout to keep this index distinct from raw numeric indices in the type system.

We tag each emitted `ProviderMessageContent` (each individual content block — text, thinking, tool_use, tool_result, etc.) with a `nativeMessageIdx: NativeMessageIdx` field set to the native index of the message that produced that block (today, all content blocks within a provider message share the same `nativeMessageIdx` because the mapping is 1:1; this design is forward-compatible if content from multiple natives ever folds into a single provider message — each block still points back to its own native source). The view captures the block's `nativeMessageIdx` at the binding callsite; the agent's truncate API takes the same index back. No content-level IDs and no parallel storage are needed.

## Truncation semantics

`F` at `nativeMessageIdx = N` means "keep `messages[0..N]` (inclusive) in the new fork; drop everything after." The agent then ensures the resulting state is a valid input for the next request — no orphan tool calls (a `tool_use` or `server_tool_use` without its corresponding result). Two strategies are applied per-block in the kept tail of `messages[N]`:

- **Extend forward when the result exists.** If `messages[N]` is an assistant message containing a `tool_use` AND `messages[N+1]` exists and contains the matching `tool_result`, also keep `messages[N+1]` so the pair is preserved. This is the common case (cut at a completed tool turn).
- **Drop the orphan when the result does not exist.** If `messages[N]` is an assistant message containing a `tool_use` and there is no `messages[N+1]` (or `messages[N+1]` does not contain the matching `tool_result` — e.g. cut at an assistant message that is still waiting for tool execution), drop the orphan `tool_use` block from `messages[N]` instead of extending. Same rule applies to `server_tool_use` paired with `web_search_tool_result` (drop the `server_tool_use` if no matching `web_search_tool_result` follows).
- **Drop empty assistant messages after orphan removal.** If dropping orphan `tool_use` / `server_tool_use` blocks leaves the assistant message with no content, also drop the message itself (no empty assistant turn in the kept history).

The end goal: the cloned agent's state must be valid input for the next provider call — every `tool_use` has a `tool_result`, every `server_tool_use` has a `web_search_tool_result`, no empty messages.

## Relevant entities

- `ProviderMessageContent` (`node/core/src/providers/provider-types.ts`) — discriminated union of content types (text, thinking, tool_use, tool_result, system_reminder, context_update, image, document, server_tool_use, web_search_tool_result, redacted_thinking). We will add a new required field `nativeMessageIdx: NativeMessageIdx` to every variant — the index in the native `Anthropic.MessageParam[]` array of the native message that produced this content block (today, all blocks in a provider message share the same value).
- `Agent.truncateMessages(messageIdx: NativeMessageIdx)` (`node/core/src/providers/provider-types.ts`, impl in `anthropic-agent.ts`) — current message-level truncate. **Will be repurposed**: keep the same signature/name but extend the implementation to perform the tool-pairing extension (if the kept tail message has a `tool_use`, also keep `messages[messageIdx + 1]` so the matching `tool_result`s are retained).
- `AnthropicAgent.cleanupClonedMessages` (`node/core/src/providers/anthropic-agent.ts`) — currently drops dangling `tool_use` blocks or synthesizes error `tool_result`s when cloning mid-stream. Unchanged. The truncate path now extends forward to keep real tool_results, so it doesn't need synthetic blocks.
- `convertAnthropicMessagesToProvider` — produces `ProviderMessage[]` from native messages. Updated to stamp each emitted `ProviderMessageContent` block with `nativeMessageIdx: msgIndex` (the iteration index of the containing native message). Computed every call; no caching is needed.
- `Agent.clone()` (`node/core/src/providers/anthropic-agent.ts`) — deep-copies messages and resets to `stopped/end_turn`. No changes needed for indexing because the clone preserves the native messages array in the same order.
- `Chat.handleForkThread({sourceThreadId})` (`node/chat/chat.ts`) — current fork primitive (clones agent, makes a new thread). We will extend it to accept an optional `truncateAtMessageIdx: NativeMessageIdx`.
- `Magenta.forkAndSwitchToThread(sourceThreadId)` (`node/magenta.ts`) — wraps `handleForkThread` + thread registration + switch. We will replace its callers and add a variant `forkAtMessageAndSwitch(sourceThreadId, nativeMessageIdx, prepopulate?)`.
- `Magenta.preprocessAndSend` (`node/magenta.ts`) — currently detects `@fork` at the start of input text. We will remove the `@fork` branch.
- `forkCommand` (`node/chat/commands/fork.ts`) and its registration (`node/chat/commands/registry.ts`) — to be deleted.
- `BINDING_KEYS` and `Bindings` (`node/tea/bindings.ts`) — list of keys forwarded from the display buffer to the node side. We will add `"F"`. Bindings are looked up by cursor position via `getBindings`.
- `tea.ts onKey` — receives a `BindingKey` from the lua side, looks up bindings at the cursor position and invokes them. We will extend this to support an optional payload (the visual selection text) so the same binding can be invoked from visual mode with extra context.
- `lua/magenta/init.lua listenToBufKey` — registers a per-buffer normal-mode key map that forwards a key press as `magentaKey`. We will register `F` in both normal and visual mode for display buffers. The visual variant will additionally read the visual selection and pass it as a payload.
- `lua/magenta/options.lua displayKeymaps` — default per-buffer key maps applied to display buffers via `setDisplayKeymaps`. Used here only as a reference for the existing display-buffer keymap setup.
- `thread-view.ts renderMessageContent` — renders each content block. We will wrap each rendered block in `withBindings({ F: ... })`, dispatching `{ type: "fork-message", nativeMessageIdx, prepopulate? }` (where `nativeMessageIdx` is the block's own `nativeMessageIdx`).
- `Thread.Msg` and `ThreadMsg` (`node/chat/thread.ts`, `node/root-msg.ts`) — discriminated message unions. We will add a new variant `{ type: "fork-message", nativeMessageIdx: NativeMessageIdx, prepopulate?: string[] }` that flows up through dispatch to `Magenta`.
- `Sidebar.scrollToBottom` and `Sidebar.scrollToLastUserMessage` (`node/sidebar.ts`) — model for cursor placement. Switching focus to the input window uses `nvim_set_current_win(inputWindow.id)` (already used in tests/sidebar driver).
- `magenta.activeBuffers.inputBuffer` and the `setup-resubmit` SidebarMsg (`node/magenta.ts handleSidebarMsg`) — the existing pattern for writing into the input buffer from a dispatched message. We will reuse the same buffer-write pattern.

## Existing tests that reference @fork (will be updated/removed)

- `node/chat/thread.test.ts` — `it("forks a thread with multiple messages into a new thread")` uses `@fork` text input. Replace with a key-binding-driven equivalent.
- `node/chat/thread-abort.test.ts` — two tests that fork while streaming or while waiting for tool use using `@fork`. Replace with the key-binding-driven flow.
- `node/chat/thread-compact.test.ts` — `it("forks a thread with @compact ...")` exercises `@fork @compact`. With `@fork` removed, replace with: press `F` to fork at the latest user message, then send `@compact ...` in the input buffer.

## Behavior for the truncation point

`F` at `nativeMessageIdx = N` invokes `agent.truncateMessages(N as NativeMessageIdx)`. The algorithm has to handle the fact that the agent supports parallel tool calls in a single assistant message: a single assistant message at `messages[N]` may contain several `tool_use` blocks `{A, B, C, ...}`, and their `tool_result`s land in *consecutive user messages* one per `toolResult` call (each call pushes a fresh user message via `convertToolResultToNative`). So the set of "tool_result messages" associated with `messages[N]` is the run of consecutive user messages immediately following `messages[N]`.

Compute `endIdx` and any in-place trim of `messages[N]` first, then slice once:

1. **If `messages[N]` is a user message:** `endIdx = N`, no trim.
2. **If `messages[N]` is an assistant message:**
    - Collect the set of `tool_use` block ids in `messages[N]`: call this `toolUseIds`.
    - Walk forward from index `M = N + 1` while `messages[M]?.role === "user"`, collecting every `tool_result.tool_use_id` found in `messages[M].content`. Let `lastResultIdx` be the highest `M` reached (i.e. the last consecutive user message), and `foundResultIds` be the union of collected `tool_use_id`s.
    - **Tool-result completeness check:**
        - If `toolUseIds` is non-empty AND `foundResultIds ⊇ toolUseIds` (every parallel tool call has a matching result somewhere in the consecutive user messages): set `endIdx = lastResultIdx`. No trim. By the invariant, server_tool_use blocks in `messages[N]` are also complete (paired in the same message).
        - Else (some `tool_use` is unmatched, OR `messages[N]` had no tool_use blocks at all): drop all `tool_use` blocks from `messages[N].content` (per the user's spec — partial results are not preserved; the entire tool_use group is dropped). Also drop any `server_tool_use` block that is not immediately followed by a `web_search_tool_result` in the same message.
            - If the resulting trimmed content is empty: `endIdx = N - 1` (drop the assistant message entirely).
            - Else: `endIdx = N` and replace `messages[N].content` with the trimmed content (in-place).
3. **Slice once:** `this.messages.length = endIdx + 1`.
4. Clean up `messageStopInfo` for any indices `> endIdx`.
5. Set `this.status = { type: "stopped", stopReason: "end_turn" }` and rebuild `cachedProviderMessages` via `updateCachedProviderMessages()`.
6. **Source thread mid-stream.** If the source thread is mid-stream or in `tool_use` stop reason, `abortAndWait()` is called first by the caller (`Chat.handleForkThread`), matching existing fork behavior. The cloned agent's `cleanupClonedMessages` then runs, and only after that the truncate executes — so the truncate always operates on a clean, stopped state.

Edge case: `F` on the very first message (`N === 0`): `endIdx` is `-1`, `0`, or `K` (for some `K ≥ 1` = `lastResultIdx`) depending on orphan-drop and extension.

## Visual selection formatting

When `F` is pressed in visual mode, the lua side captures the visually selected text from the display buffer using the `'<` and `'>` marks (the same approach as the existing `paste-selection` command). The selected text is forwarded to node as an array of lines. Node formats each line with `> ` prefix and writes it (followed by a trailing blank line) into the input buffer before placing focus there.

### Selection data flow (where prepopulate lives)

The selection text never enters `Chat.handleForkThread` or the agent. It rides alongside the fork dispatch and is consumed by `Magenta.forkAtMessageAndSwitch` after the new thread exists:

1. **Lua → Magenta**: `safe_rpcnotify(channelId, "magentaKey", "F", { selection = lines })`. In normal mode, the second arg is omitted (no selection captured), so `ctx.selection` is `undefined`.
2. **Magenta.onKey → mountedApp.onKey**: parses `selection` out of args into `ctx: BindingCtx = { selection?: string[] }` and forwards it.
3. **getBindings → binding callback**: the callback in `thread-view.ts` is `(ctx) => dispatch({ type: "fork-message", nativeMessageIdx: content.nativeMessageIdx, prepopulate: ctx?.selection })`. The `prepopulate` is `string[] | undefined`.
4. **Thread.Msg → ThreadMsg → RootMsg**: the dispatch wraps the msg in a `thread-msg` envelope.
5. **Magenta.dispatch interception**: detects `msg.type === "thread-msg" && msg.msg.type === "fork-message"` and calls `Magenta.forkAtMessageAndSwitch(sourceThreadId, nativeMessageIdx, prepopulate)` instead of forwarding to `chat.update`.
6. **Magenta.forkAtMessageAndSwitch**: calls `chat.handleForkThread({ sourceThreadId, truncateAtMessageIdx: nativeMessageIdx })` (no `prepopulate` argument — that level of the API is concerned only with agent/thread state). Once the new thread is registered and active, if `prepopulate` is defined the same function builds the `> ` quoted body and writes it into `this.activeBuffers.inputBuffer`, then moves focus.

Normal mode `F` follows the same path with `prepopulate === undefined`; the input buffer is left empty.

# implementation

- [ ] **Add `F` to the binding key list and allow optional context.**
  - `node/tea/bindings.ts`: add `"F"` to `BINDING_KEYS`. Change the `Bindings` value type from `() => void` to `(ctx?: BindingCtx) => void`, where `BindingCtx = { selection?: string[] }`. Existing handlers ignore `ctx`.
  - `node/tea/tea.ts onKey`: accept an optional `ctx?: BindingCtx` parameter and forward it to the looked-up binding.
  - `Magenta.onKey` (`node/magenta.ts`): accept the lua-supplied args of shape `[key]` or `[key, { selection }]`, parse the optional selection, and pass the context through to `mountedApp.onKey(key, ctx)`.

- [ ] **Register `F` in normal AND visual mode for display buffers.**
  - `lua/magenta/init.lua listenToBufKey`: change the signature to take a `mode` (default `"n"`). Keep existing call sites at normal mode. For `F`, register both `n` and a `v`/`x` variant that:
    - Captures `getpos("'<")` and `getpos("'>")` (or `vim.fn.getpos("v")` and `getpos(".")` if needed for live visual mode), reads the buffer text between them, and exits visual mode.
    - Calls `safe_rpcnotify(channelId, "magentaKey", "F", { selection = lines })`.
  - `node/tea/tea.ts mount`: iterate over a per-mode key map defined in `bindings.ts` like `BINDING_MODES = { n: [...all keys...], v: ["F"] }`, calling `listenToBufKey` with each mode and its keys.

- [ ] **Tag each `ProviderMessageContent` with `nativeMessageIdx`.**
  - In `node/core/src/providers/provider-types.ts`: add `nativeMessageIdx: NativeMessageIdx` as a required field on every variant of the `ProviderMessageContent` discriminated union (text, image, document, tool_use, server_tool_use, web_search_tool_result, tool_result, thinking, redacted_thinking, system_reminder, context_update). Document it as "the index of the native message that produced this content block — used as a stable cut point for truncation."
  - In `node/core/src/providers/anthropic-agent.ts` `convertAnthropicMessagesToProvider` (and its block-conversion helpers): stamp each emitted `ProviderMessageContent` with `nativeMessageIdx: msgIndex` (the iteration index of the containing native message). No caching is needed — the index is recomputed every call, which is fine because native messages are append-only so the index for any given logical block is stable.

- [ ] **Update `truncateMessages` to preserve provider invariants.**
  - The `Agent.truncateMessages(messageIdx: NativeMessageIdx)` interface signature is unchanged.
  - In `AnthropicAgent.truncateMessages`, implement the algorithm from "Behavior for the truncation point", which handles parallel tool calls by walking the run of consecutive user messages following the cut point. Compute `endIdx` first, then slice once:
    1. **Determine `endIdx` and any in-place trim of `messages[messageIdx].content`:**
        - If `messages[messageIdx]` is a user message → `endIdx = messageIdx`, no trim.
        - If `messages[messageIdx]` is an assistant message:
          - Collect `toolUseIds` = set of `tool_use` block ids in `messages[messageIdx]`.
          - Walk forward `M = messageIdx + 1, messageIdx + 2, ...` while `messages[M]?.role === "user"`, collecting `foundResultIds` (the union of `tool_result.tool_use_id` across these messages) and tracking `lastResultIdx = M`.
          - If `toolUseIds` is non-empty AND `foundResultIds ⊇ toolUseIds`: `endIdx = lastResultIdx`, no trim.
          - Else: build trimmed content for `messages[messageIdx]` — drop every `tool_use` block; drop every `server_tool_use` block not immediately followed by a `web_search_tool_result`. If the trimmed content is empty → `endIdx = messageIdx - 1`. Else → `endIdx = messageIdx` and replace `messages[messageIdx].content` with the trimmed content.
    2. **Slice once**: `this.messages.length = endIdx + 1` (handles the `endIdx === -1` case naturally as `length = 0`).
    3. Clean up `messageStopInfo` entries for indices `> endIdx`. Set `stopped/end_turn`. Call `updateCachedProviderMessages()` and `emitAsync("stopped", "end_turn", undefined)`.
  - Tests for `truncateMessages`:
    - **Behavior**: truncate at an assistant text-only message keeps `[0..N]` only.
    - **Behavior**: truncate at an assistant message with completed `tool_use` extends to keep `[0..N+1]` (the matching `tool_result` user message).
    - **Behavior**: truncate at an assistant message with a `tool_use` whose `tool_result` is missing (no following user message, or following user message has unrelated tool_results) drops the orphan `tool_use`. The assistant message keeps any other (text/thinking) content.
    - **Behavior**: truncate at an assistant message that contains ONLY an orphan `tool_use` drops the entire assistant message after orphan removal.
    - **Behavior**: truncate at an assistant message with an orphan `server_tool_use` (no immediately-following `web_search_tool_result`) drops the `server_tool_use` block.
    - **Behavior**: truncate at index 0 on a single-message assistant turn with an orphan tool call drops the message entirely (resulting in zero kept native messages).
    - **Setup**: `AnthropicAgent` populated programmatically with diverse turn shapes (text, tool_use+tool_result pair, dangling tool_use, server_tool_use+web_search_tool_result pair, dangling server_tool_use).
    - **Assertions**: `getState().messages.length` matches expected; specific block presence/absence; `messageStopInfo` has no stale entries; status is `stopped/end_turn`.

- [ ] **Add `F` binding on each content block in `thread-view.ts`.**
  - In `renderMessageContent`, every returned `VDOMNode` is wrapped in `withBindings(..., { F: (ctx) => dispatch({ type: "fork-message", nativeMessageIdx: content.nativeMessageIdx, prepopulate: ctx?.selection }) })`. The wrapper is added at the outer return for each switch-case branch (text, thinking, redacted_thinking, system_reminder, tool_use, image, document, server_tool_use, web_search_tool_result, context_update). Existing `<CR>` / `t` / `=` bindings on inner nodes continue to take precedence per `getBindings` (most-specific wins), which is the desired behavior.
  - Empty/skipped renders (`tool_result`, empty `image`) need no F binding — there's nothing visible to put the cursor on.

- [ ] **Add a new `Thread.Msg` variant: `{ type: "fork-message"; nativeMessageIdx: NativeMessageIdx; prepopulate?: string[] }`.**
  - Define in `node/chat/thread.ts`. The thread itself doesn't handle it (it's metadata about the source thread); it bubbles up through `dispatch` and is handled by `Magenta.dispatch`.
  - In `Magenta.dispatch` (`node/magenta.ts`), intercept `msg.type === "thread-msg" && msg.msg.type === "fork-message"` and route to a new `Magenta.forkAtMessageAndSwitch(sourceThreadId, nativeMessageIdx, prepopulate)` helper. Don't forward this msg to the controllers.

- [ ] **Implement `Chat.handleForkThread` extension.**
  - Change signature to `handleForkThread({ sourceThreadId, truncateAtMessageIdx? }: { sourceThreadId: ThreadId; truncateAtMessageIdx?: NativeMessageIdx })`. When `truncateAtMessageIdx` is provided, after `sourceAgent.clone()` and before constructing the new `Thread`, call `clonedAgent.truncateMessages(truncateAtMessageIdx)`. The cloned agent's `cleanupClonedMessages` runs first as today (handles mid-stream cancellation in the source); the subsequent `truncateMessages` then performs the deterministic message-level cut (with tool extension) on a clean cloned state.

- [ ] **Implement `Magenta.forkAtMessageAndSwitch`.**
  - Mirror `forkAndSwitchToThread`, but also accept `nativeMessageIdx: NativeMessageIdx` and optional `prepopulate?: string[]`.
  - Steps: `await chat.handleForkThread({ sourceThreadId, truncateAtMessageIdx: nativeMessageIdx })`, `await bufferManager.registerThread(threadId)`, dispatch `chat-msg / set-active-thread`, `await syncActiveView()`.
  - If `prepopulate` is provided, build the quoted body: `prepopulate.map(line => "> " + line).join("\n") + "\n\n"`. Write it into `this.activeBuffers.inputBuffer` starting at row 0 to -1 (replacing existing content).
  - Move focus to the input window: if the sidebar is visible, `nvim_set_current_win(inputWindow.id)`; if hidden, call `this.command("toggle")` first to show it. Then place cursor at the end of the input buffer (one row past the prepopulated quote, col 0) so the user types into a clean line.

- [ ] **Wire the new dispatch path from `thread-view.ts` to `Magenta`.**
  - The `F` binding in the view dispatches `{ type: "thread-msg", id: thread.id, msg: { type: "fork-message", nativeMessageIdx, prepopulate? } }` (the `thread.ts` `dispatch` wrapper already wraps Msg into the thread-msg variant; we just need to define the Msg variant).
  - In `Magenta.dispatch`, before/after `chat.update(msg)`, intercept `msg.type === "thread-msg" && msg.msg.type === "fork-message"` and call `forkAtMessageAndSwitch`. Ensure the underlying `chat.update` does NOT also route this into `thread.update` (skip via early return or by not adding it to the inner `Msg` switch in `Thread.myUpdate`). Easiest: add to `Thread.Msg` and have `Thread.myUpdate` no-op on this variant, while `Magenta.dispatch` is the actual handler — keeps the existing flow without needing to invent a new RootMsg variant.

- [ ] **Remove the `@fork` text-command flow.**
  - Delete `node/chat/commands/fork.ts`.
  - Remove `forkCommand` import and registration from `node/chat/commands/registry.ts`.
  - In `Magenta.preprocessAndSend`, drop the `if (text.trim().startsWith("@fork")) { ... }` branch and its associated comments. Keep the `@compact` and `@async` branches intact.
  - Keep `Magenta.forkAndSwitchToThread` (the parameterless / "fork-the-whole-thread" variant) only if anyone still uses it; otherwise delete it. Search for other call sites and remove.

- [ ] **Update existing fork tests to use the new key-binding flow.**
  - Add a driver helper `driver.pressOnDisplayMessage(textSnippet: string, key: BindingKey)` that finds the buffer position of `textSnippet` (a substring of any rendered content within the target message), positions the cursor inside that message, then sends `magentaKey` via the existing display-buffer key path. Also a `driver.pressOnDisplayMessageVisual(textSnippet, range, key)` that visually selects within the message and triggers `F` in visual mode.
  - Note on test cut points: `F` on a message keeps that message and everything before it. Forking at the previous assistant turn is the analogue of the old "fork at the next user message" — both produce a fork ending right before the new user message would be sent.
  - Update `node/chat/thread.test.ts` "forks a thread with multiple messages into a new thread":
    - Behavior: pressing `F` on the assistant's response text "Paris is the capital of France." creates a new thread that ends with that assistant text and drops all subsequent messages. The user can then type a new follow-up.
    - Setup: same as today — create thread, send "What is the capital of France?", respond, send "What about Germany?", respond.
    - Actions: `driver.pressOnDisplayMessage("Paris is the capital of France.", "F")`. After fork is active, type "Tell me about Italy" into the input buffer and `:Magenta send`.
    - Expected output: the new thread's first request to the mock provider has the first round-trip ("What is the capital of France?" + "Paris is the capital of France.") followed by "Tell me about Italy" as the new user message. Snapshot the messages.
    - Assertions: `expect(driver.magenta.chat.state.activeThreadId).not.toBe(originalThreadId)`; snapshot matches.
  - Update `node/chat/thread-abort.test.ts` (both fork-while-streaming and fork-while-tool-use tests):
    - Behavior: pressing `F` on a message from the most recently completed turn while the source thread is streaming/awaiting a tool use aborts the source thread, then forks.
    - Setup: same setup as today.
    - Actions: send `F` on a stable message from a previously completed turn (e.g. the prior assistant message).
    - Expected output: source thread becomes `stopped/aborted`; new thread is created and active; input buffer is empty; no automatic send.
    - Assertions: original `stream.aborted === true`; new active thread id differs; mock provider has no pending streams immediately after fork.
  - Update `node/chat/thread-compact.test.ts` "forks a thread with @compact ...":
    - Replace `@fork @compact ...` with: press `F` on the appropriate message to fork, then `inputMagentaText("@compact Now help me with multiplication")` and `send`.
    - All other assertions remain.

- [ ] **Add new tests for the F binding flows.**
  - **Normal mode F on the previous assistant message creates a fork ending there.**
    - Behavior: `F` on an assistant message creates a fork keeping all messages up to and including that one. Drops everything after. Switches focus to the input buffer (empty).
    - Setup: thread with two user/assistant exchanges (as in the existing test).
    - Actions: `driver.pressOnDisplayMessage("Paris is the capital of France.", "F")`.
    - Expected output: new active thread; sidebar input buffer is empty; current window is the input window; new thread's `getProviderMessages()` length is 2 (the first user message + the first assistant message).
    - Assertions: `expect(currentWindowId).toBe(inputWindow.id)`; `expect(inputLines).toEqual([""])`; `expect(newThread.getMessages().length).toBe(2)`; original thread id !== active thread id.
  - **Normal mode F on a user message keeps that user message.**
    - Behavior: `F` on a user message creates a fork ending with that user message (so the user can submit a follow-up that appends after it).
    - Setup: same two-turn thread.
    - Actions: `driver.pressOnDisplayMessage("What about Germany?", "F")`.
    - Expected output: new thread's last message is the user message containing "What about Germany?"; subsequent assistant response is dropped.
    - Assertions: last message in `newThread.getMessages()` is `role: "user"` with that text; total message count is 3.
  - **Normal mode F on an assistant message containing a `tool_use` keeps the matching tool_result message.**
    - Behavior: `F` on an assistant message that contains a `tool_use` block extends forward to also keep the next user message containing the matching `tool_result`. Later assistant turns are dropped.
    - Setup: thread with: user message, assistant message containing a `tool_use`, user message with the corresponding `tool_result`, assistant follow-up text. Use a mock tool to populate this naturally or build messages directly.
    - Actions: `driver.pressOnDisplayMessage("<tool name or input snippet>", "F")` targeting the assistant message that holds the `tool_use`.
    - Expected output: new thread has 3 messages (user / assistant-with-tool_use / user-with-tool_result); the post-tool assistant follow-up is dropped.
    - Assertions: `newThread.getMessages().length === 3`; last block of message[1] is `tool_use`; message[2] contains a `tool_result` with matching id.
  - **Visual mode F on a message creates a fork with the selection quoted in the input buffer.**
    - Behavior: selecting some text inside a message and pressing `F` truncates at that message and pre-populates the input buffer with each selected line prefixed by `> `, plus a trailing blank line, with the cursor placed after the quote.
    - Setup: same two-turn thread.
    - Actions: position cursor inside the second assistant message ("The capital of Germany is Berlin."), enter visual mode covering "capital of Germany", press `F`. Use a driver helper that runs the vim sequence `v` + motion + `F`.
    - Expected output: new active thread; input buffer contains `["> capital of Germany", "", ""]` (or equivalent quoted form); current window is input window; cursor row is on the trailing empty line.
    - Assertions: `expect(inputLines[0]).toBe("> capital of Germany")`; `expect(inputLines[inputLines.length-1]).toBe("")`; cursor is in input window; new thread truncated to include both turns.
  - **Multi-line visual selection produces a multi-line quote.**
    - Behavior: visually selecting two consecutive lines within a message and pressing `F` produces a quote with both lines prefixed.
    - Setup: thread with an assistant message spanning two lines (e.g. respond with "Line 1\nLine 2").
    - Actions: visually select both lines and press `F`.
    - Expected output: input buffer starts with `["> Line 1", "> Line 2", "", ""]`.
    - Assertions: input buffer matches.
  - **F on the very first message keeps just that message.**
    - Behavior: pressing `F` on the first user message yields a fork with one message, empty input buffer.
    - Setup: thread with one user message + assistant response.
    - Actions: press `F` on the first user message.
    - Expected output: new thread with `getMessages().length === 1`, message[0].role === "user"; input buffer is empty.
    - Assertions: as stated.

- [ ] **Type-check, lint, and run the full test suite.**
  - `npx tsgo -b`
  - `npx biome check .`
  - `tests-in-sandbox` for the local quick pass.
  - `tests-in-docker` (full suite) once the sandbox pass is green.
