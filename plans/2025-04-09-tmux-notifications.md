# context

## Objective
When magenta.nvim's node process is running inside a tmux pane, update the tmux pane title to show a count of threads waiting for approval and stopped threads. This gives the user visibility into thread status from their tmux session switcher without needing to look at the neovim buffer.

## Key types and interfaces

**`Chat`** (`node/chat/chat.ts`): Manages all threads via `threadWrappers: { [ThreadId]: ThreadWrapper }`. Has `getThreadSummary(threadId)` which returns a status object with types: `"missing" | "pending" | "running" | "stopped" | "yielded" | "error"`. The `"running"` status includes an `activity` field that can be `"waiting for approval"`.

**`Magenta`** (`node/magenta.ts`): Root controller. Owns the `dispatch` function and the `Chat` instance. The dispatch function is called on every state change and triggers re-renders.

**`RootMsg`** (`node/root-msg.ts`): Discriminated union of all message types flowing through the system.

**`ThreadWrapper`** (`node/chat/chat.ts`): Tracks thread lifecycle (`pending | initialized | error`) with parent/depth info.

## Relevant files
- `node/magenta.ts` — central dispatch loop, ideal place to hook tmux updates
- `node/chat/chat.ts` — thread state, `getThreadSummary()`, `threadHasPendingApprovals()`
- `node/root-msg.ts` — message types

## Approach: Tmux interaction from Node

Tmux can be detected via the `TMUX` environment variable (set when running inside tmux). The current pane can be identified via `TMUX_PANE` env var (e.g. `%3`).

To set a tmux pane title: `tmux select-pane -t <pane> -T "title"`. This can be run via `child_process.execSync` or `execFile`.

The approach:
1. Create a `TmuxNotifier` class in `node/tmux-notifier.ts`
2. On construction, detect tmux by checking `process.env.TMUX` and `process.env.TMUX_PANE`
3. Expose an `update(chat: Chat)` method that computes notification counts from thread summaries and sets the pane title
4. Call `update()` from the dispatch function in `Magenta`, so notifications update on every state change
5. On teardown, restore the original pane title

## Design considerations

- **Title caching**: Cache the last title string we set. Only spawn a `tmux select-pane` process if the new title differs from the cached one. This naturally avoids redundant calls during rapid dispatch without needing a debounce timer.
- **Original title preservation**: On init, read the current pane title (`tmux display-message -t <pane> -p "#{pane_title}"`) and restore it on cleanup.
- **Title format**: Something like `🔴 2 approval · 1 stopped` when there are notifications, or restore the original title when counts are zero.
- **No-op when not in tmux**: If `TMUX` env var is not set, the notifier is a no-op.

# implementation

- [ ] Create `node/tmux-notifier.ts` with `TmuxNotifier` class
  - [ ] Constructor: check `process.env.TMUX` and `process.env.TMUX_PANE`. If not in tmux, set a flag to no-op all operations.
  - [ ] If in tmux, read the original pane title via `tmux display-message -t $TMUX_PANE -p "#{pane_title}"` and store it.
  - [ ] `update(chat: Chat)` method:
    - Iterate over all `chat.threadWrappers`
    - For each initialized thread, call `chat.getThreadSummary(threadId)`
    - Count threads where status is `"running"` with activity `"waiting for approval"`
    - Count threads where status is `"stopped"`
    - If both counts are 0, set pane title to original title
    - Otherwise, format a title string like `🔴 2 approval · 1 stopped` (omitting zero-count segments)
    - Execute `tmux select-pane -t $TMUX_PANE -T "<title>"` to set the title
  - [ ] Cache the last-set title string. In `update()`, compare the computed title to the cache and skip the exec if unchanged.
  - [ ] `cleanup()` method: restore original pane title

- [ ] Wire `TmuxNotifier` into `Magenta`
  - [ ] Add `tmuxNotifier: TmuxNotifier` field to `Magenta` class
  - [ ] Instantiate in `Magenta` constructor
  - [ ] Call `this.tmuxNotifier.update(this.chat)` at the end of the `dispatch` function (after state updates)
  - [ ] Call `this.tmuxNotifier.cleanup()` in any teardown/shutdown path

- [ ] Unit test for `TmuxNotifier`
  - **Behavior**: Correctly computes notification counts from thread summaries
  - **Setup**: Mock `Chat` with a few `threadWrappers` in various states (pending, running with approval, stopped, streaming)
  - **Actions**: Call `update()` with the mock chat
  - **Expected output**: The title string contains the correct counts
  - **Assertions**: Capture the command passed to exec and verify the title argument

  - **Behavior**: No-op when not in tmux
  - **Setup**: Ensure `TMUX` env var is unset
  - **Actions**: Call `update()`
  - **Expected output**: No exec calls made
  - **Assertions**: Verify exec was never called

  - **Behavior**: Restores original title when counts go to zero
  - **Setup**: Mock exec, set initial title to "my-pane"
  - **Actions**: Call `update()` with non-zero counts, then with zero counts
  - **Expected output**: Title is restored to "my-pane"
  - **Assertions**: Last exec call sets title to "my-pane"
