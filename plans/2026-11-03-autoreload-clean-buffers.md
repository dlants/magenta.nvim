# Objective and Context

"Right now I'm hitting some friction around situations where the agent uses the bash command to edit files that I have open in a buffer. I think what I want to do is (I don't know if this is right or not, I guess so): when I have a file loaded in a buffer, I want to check if the buffer is clean and I can reload without losing any work. I want to refresh it, so reread it from disk whenever the file on disk is touched."

Today only writes that go through the server `FileIO` are synced: `SandboxFileIO` calls `onFileWritten` → `clientFileWritten` sends a `fileWritten` client request → `nvim-client.ts` `fileWritten` → `reloadBufferIfOpen` (`utils/buffers.ts`) → `NvimBuffer.reloadFromDisk` (`nvim/buffer.ts`), which applies the on-disk content as a minimal `vim.diff` patch (keeps undo + extmarks), skipping modified buffers. Bash (`sed -i`, `git checkout`, formatters, codegen) bypasses this, so buffers go stale until nvim's own `checktime`, which uses `:edit` semantics (loses extmarks, prompts on conflicts).

Files:
- `node/nvimclient/nvim/buffer.ts` — `reloadFromDisk` with the inline lua diff-apply.
- `node/nvimclient/utils/buffers.ts` — `reloadBufferIfOpen`.
- `node/nvimclient/chat/nvim-client.ts` — `fileWritten` client request handler.
- `lua/magenta/init.lua` — plugin setup; where the watcher is enabled.
- `lua/magenta/options.lua` — client options (toggle).

# Design

Do it entirely in nvim lua, independent of which tool wrote the file: watch the files of loaded buffers with libuv and, when one changes on disk and the buffer is clean, apply the existing diff-reload. This covers bash, external editors, git, etc., without the server needing to know which files a shell command touched.

- New module `lua/magenta/autoreload.lua`:
  - `reload(bufnr)`: the diff-apply currently inlined in `reloadFromDisk`, moved here verbatim (bail if unloaded / `modified` / content identical). `NvimBuffer.reloadFromDisk` becomes `require("magenta.autoreload").reload(bufnr)`, so there is one implementation.
  - Watching: one `vim.uv.new_fs_event()` per *directory* containing a loaded normal file buffer (`buftype == ""`, name is a real file), refcounted by buffers. Directory watching is required because `sed -i`, formatters and git replace files via rename, which kills a per-file inode watch.
  - Lifecycle via an augroup: `BufReadPost`/`BufNewFile`/`BufFilePost` → attach; `BufUnload`/`BufWipeout` → detach (stop the dir watcher at refcount 0).
  - Cost / non-blocking: `fs_event` is kernel-notified (FSEvents/inotify), never `fs_poll`. The libuv callback only does a table lookup on the filename (dropping events for files with no buffer) and arms a per-buffer debounce timer (~100ms). Disk I/O (`fs_stat`, `fs_open`/`fs_read`) uses the async `vim.uv` callback forms, which run on libuv's threadpool, so the UI thread never waits on the filesystem. Only the final `vim.diff` (C) + `nvim_buf_set_lines` of the changed hunks runs on the main loop, via `vim.schedule`.
  - Visibility gating: on a debounced change for `bufnr`, async-stat; if mtime/size equal the last recorded stat, ignore. Otherwise:
    - buffer shown in some window (`#vim.fn.win_findbuf(bufnr) > 0`) → async-read and `reload(bufnr, content)`.
    - hidden → set `vim.b[bufnr].magenta_stale = true` and do nothing else.
  - `BufWinEnter` autocmd: if `magenta_stale`, clear it and reload (async read, then apply). So hidden buffers cost nothing until they are shown.
  - Self-writes: `reload` ends with `noautocmd write!` and user `:w` both trigger events; recording the stat after `reload` and on `BufWritePost` makes those no-ops.
  - Modified buffer + disk change: do nothing (leave nvim's normal `FileChangedShell` behavior on next `checktime`). Optionally `vim.notify` once at WARN, mirroring `reloadBufferIfOpen`.
  - Deleted file: ignore (no reload).
- Enable from `setup()` behind a client option `autoReloadBuffers` (default true).
- Keep the `fileWritten` path: it is synchronous with the tool result (the agent's next `@buf`/LSP request sees fresh content), whereas the watcher is async. Both call the same `reload`, which is idempotent.

## Interfaces

```lua
-- lua/magenta/autoreload.lua
M.setup()            -- create augroup, attach existing loaded buffers
M.reload(bufnr, content?) -- diff-apply disk content into clean buffer; no-op if modified/unchanged. If content is omitted it is read async first.
M.teardown()         -- stop all watchers, clear augroup (for tests / re-setup)
```

Client option: `autoReloadBuffers: boolean` in `lua/magenta/options.lua`.

## Invariants

- Never touches a buffer with `modified` set; never loses user edits.
- Reload preserves undo history (single `u` reverts) and extmark anchoring.
- Our own `write!` inside `reload` and user `:w` do not trigger a reload loop.
- Watchers are released when the last buffer in a directory unloads; no leak across `setup()` re-runs.
- libuv callbacks never call nvim API directly (always `vim.schedule`).
- No synchronous filesystem I/O on the main loop in the watcher path.
- Hidden buffers are never reloaded in the background; they are marked stale and reloaded on `BufWinEnter`.
- No polling (`fs_poll`) anywhere.
- Non-file buffers (magenta chat/input, terminals, `nofile`) are never watched.

# Stages

## Extract reload into lua module

- Goal: `reloadFromDisk` delegates to `magenta.autoreload.reload`; behavior unchanged.
- Tests: existing `reloadFromDisk`/`fileWritten` tests (tier C) keep passing; `u` after a reload restores prior content.
- [x] Done. `lua/magenta/autoreload.lua` `reload(bufnr, content?)`; `reloadFromDisk` calls it. Deviation: when `content` is omitted, `reload` reads synchronously (the `fileWritten` path needs the result before returning); the watcher (stage 2) will do its async read and pass `content`. The undo check already existed in `buffer-reload.test.ts` ("an agent edit is undone in a single undo"). Some nvim UI tests (spawn-subagents, two-column, pull-requests, display-open-target) are flaky and also fail on the base commit.

## Directory watcher + autocmds

- Goal: with a clean buffer open, an external write (e.g. `fs.writeFile` from the test, and a rename-replace like `sed -i`) updates the buffer within the debounce window.
- Tests (tier C, `withDriver`):
  - `autoreload.reload(bufnr, content)` with explicit `content` (no disk read) in `buffer-reload.test.ts` — deferred from stage 1 review, since the watcher is the first caller.
  - Clean buffer, write file from node → buffer content matches disk; one `u` restores old content; an extmark placed below the edited region stays on its line.
  - Rename-replace (write tmp + `rename`) → still reloads, and a second subsequent write also reloads (watcher survives).
  - Modified buffer + external write → buffer content unchanged, `modified` still set.
  - Hidden clean buffer + external write → content unchanged and `b:magenta_stale` set; showing it in a window → content matches disk and stale flag cleared.
  - Buffer wiped → its dir watcher stopped (inspect module state via `nvim_lua`).
  - `:w` from the user does not cause a reload/extra undo entry.
- [x] Done. Watcher in `lua/magenta/autoreload.lua` (`_dirs`/`_bufs` exposed for tests); 7 tests in `buffer-reload.test.ts` "autoreload watcher". Decisions: `reload` now bails before `write!` when there are no hunks and eol is unchanged, so self-writes and user `:w` terminate even if a stat race slips through. `setup()` calls `autoreload.setup()` unconditionally for now (option gating is stage 3); tests call `require("magenta.autoreload").setup()` explicitly since the test harness does not run `setup()`. Pre-existing flaky tests (spawn-subagents, pull-requests, display-open-target, chat-view-adapter under full-suite load) still flake.

## Option + bash end-to-end

- Goal: `autoReloadBuffers = false` disables watching; with it on, a bash tool call (`sed -i`) through a mock provider updates an open buffer.
- Tests: tier C end-to-end via mock provider issuing a `bash_command` that edits an open file; assert buffer content after the tool completes.
