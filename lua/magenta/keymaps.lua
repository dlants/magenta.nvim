local M = {}

local function scroll_up_visual()
  local count = math.floor(vim.fn.winheight(0) / 2)
  for _ = 1, count do
    vim.cmd("normal! gk")
  end
  vim.cmd("normal! zz")
end

local function scroll_down_visual()
  local count = math.floor(vim.fn.winheight(0) / 2)
  for _ = 1, count do
    vim.cmd("normal! gj")
  end
  vim.cmd("normal! zz")
end

-- Apply soft-wrap + visual-line movement (mirrors the markdown setup in the
-- user's dotfiles) so the display buffer wraps and j/k/$/0 respect wraps.
local function set_wrapped_line_mode(bufnr)
  vim.bo[bufnr].textwidth = 0
  vim.api.nvim_buf_call(bufnr, function()
    vim.opt_local.wrap = true
    vim.opt_local.linebreak = true
    vim.opt_local.breakindent = true
    vim.opt_local.formatoptions:remove({ "t", "c" })
  end)
  local opts = { buffer = bufnr, noremap = true, silent = true }
  vim.keymap.set({ "n", "v" }, "j", "gj", opts)
  vim.keymap.set({ "n", "v" }, "k", "gk", opts)
  vim.keymap.set({ "n", "v" }, "$", "g$", opts)
  vim.keymap.set({ "n", "v" }, "0", "g0", opts)
  vim.keymap.set("n", "<C-u>", scroll_up_visual, opts)
  vim.keymap.set("n", "<C-d>", scroll_down_visual, opts)
end

local Actions = require("magenta.actions")
local Options = require("magenta.options")

M.default_keymaps = function()
  vim.keymap.set(
    "n",
    "<leader>mc",
    function()
      require("magenta.keymaps").comment()
    end,
    { silent = true, noremap = true, desc = "Comment on the line under the cursor" }
  )

  vim.keymap.set(
    "v",
    "<leader>mc",
    function()
      require("magenta.keymaps").comment_visual()
    end,
    { silent = true, noremap = true, desc = "Comment on the visual selection" }
  )

  vim.keymap.set(
    "n",
    "<leader>mD",
    function()
      require("magenta.keymaps").comment_delete()
    end,
    { silent = true, noremap = true, desc = "Delete the Magenta comment under the cursor" }
  )

  vim.keymap.set(
    "n",
    "<leader>ma",
    ":Magenta abort<CR>",
    { silent = true, noremap = true, desc = "Abort current Magenta operation" }
  )

  vim.keymap.set(
    "n",
    "<leader>mt",
    ":Magenta toggle<CR>",
    { silent = true, noremap = true, desc = "Toggle Magenta window" }
  )

  vim.keymap.set(
    "v",
    "<leader>mp",
    ":Magenta paste-selection<CR>",
    { silent = true, noremap = true, desc = "Send selection to Magenta" }
  )

  -- Global paste binding — routes clipboard (image or text) into the
  -- active thread's input buffer. Matches :Magenta paste; sidebar is
  -- auto-opened by node if it isn't already visible.
  vim.keymap.set("n", "<leader>mp", function()
    require("magenta.keymaps").do_paste()
  end, { silent = true, noremap = true, desc = "Magenta: paste clipboard into input buffer" })

  -- macOS/GUI-only convenience binding for the same action.
  vim.keymap.set({ "i", "n" }, "<D-v>", function()
    require("magenta.keymaps").do_paste()
  end, { silent = true, noremap = true, desc = "Magenta: paste clipboard into input buffer" })

  vim.keymap.set(
    "n",
    "<leader>mb", -- like "magenta buffer"?
    Actions.add_buffer_to_context,
    { silent = true, noremap = true, desc = "Add current buffer to Magenta context" }
  )

  vim.keymap.set(
    "n",
    "<leader>mf",
    Actions.pick_context_files,
    { silent = true, noremap = true, desc = "Select files to add to Magenta context" }
  )

  vim.keymap.set(
    "n",
    "<leader>mP",
    Actions.pick_profile,
    { silent = true, noremap = true, desc = "Pick Magenta profile" }
  )

  vim.keymap.set(
    "n",
    "<leader>mn",
    ":Magenta new-thread<CR>",
    { silent = true, noremap = true, desc = "Create a new thread" }
  )
  vim.keymap.set(
    "n",
    "<leader>mw",
    ":Magenta agent worktree<CR>",
    { silent = true, noremap = true, desc = "Create a new worktree orchestrator thread" }
  )

  vim.keymap.set(
    "n",
    "<leader>ms",
    ":Magenta sandbox-bypass<CR>",
    { silent = true, noremap = true, desc = "Toggle sandbox bypass for the thread/script under the cursor" }
  )

end

local mode_to_keymap = {
  normal = "n",
  visual = "v",
  insert = "i",
  command = "c",
}

M.set_sidebar_buffer_keymaps = function(bufnr)
  for mode, values in pairs(Options.options.sidebarKeymaps) do
    for key, action in pairs(values) do
      vim.keymap.set(
        mode_to_keymap[mode],
        key,
        action,
        { buffer = bufnr, noremap = true, silent = true }
      )
    end
  end
end

-- Tracks display buffers so we can detect when clipboard text was yanked from
-- one of them. When the user yanks (into the unnamed/+ register) inside a
-- display buffer, we stash the text here; M.do_paste compares against it to
-- decide whether to quote the pasted content.
local display_bufnrs = {}
local last_display_yank = nil

-- Module-scoped state for paste handlers. We wrap vim.paste once (globally),
-- but only transform input in buffers we've registered here. This lets
-- multiple per-thread input buffers share the same wrapper.
local paste_input_bufnrs = {}
local original_paste = nil

-- Strip one pair of surrounding single/double quotes if present.
local function strip_outer_quotes(s)
  if #s >= 2 then
    local first = s:sub(1, 1)
    local last = s:sub(#s, #s)
    if (first == '"' and last == '"') or (first == "'" and last == "'") then
      return s:sub(2, #s - 1)
    end
  end
  return s
end

-- Shell-unescape: turn every `\<char>` into `<char>` literal. Not a full shell
-- parser, just enough to undo the escaping terminals apply when delivering a
-- dragged file path.
local function shell_unescape(s)
  local out = {}
  local i = 1
  while i <= #s do
    local ch = s:sub(i, i)
    if ch == "\\" and i < #s then
      out[#out + 1] = s:sub(i + 1, i + 1)
      i = i + 2
    else
      out[#out + 1] = ch
      i = i + 1
    end
  end
  return table.concat(out)
end

-- Produce an `@file:` reference using the same rules as node's formatFileRef.
local function format_file_ref(p)
  local has_ws = p:find("%s") ~= nil
  local has_tick = p:find("`") ~= nil
  if not has_ws and not has_tick then
    return "@file:" .. p
  end
  if not has_tick then
    return "@file:`" .. p .. "`"
  end
  local escaped = p:gsub("\\", "\\\\"):gsub("`", "\\`")
  return "@file:``" .. escaped .. "``"
end

local function try_detect_dropped_path(lines)
  if type(lines) ~= "table" or #lines == 0 then
    return nil
  end
  local joined = table.concat(lines, "\n")
  -- Trim surrounding whitespace.
  joined = joined:gsub("^%s+", ""):gsub("%s+$", "")
  if joined == "" then
    return nil
  end
  joined = strip_outer_quotes(joined)
  local unescaped = shell_unescape(joined)
  local stat = (vim.uv or vim.loop).fs_stat(unescaped)
  if stat and stat.type == "file" then
    return unescaped
  end
  return nil
end

-- Module-level channel_id. Stashed by the first set_paste_handlers call so
-- M.do_paste (invoked from the :Magenta dispatcher) can reach node.
local magenta_channel_id = nil

-- Shared paste routine used by :Magenta paste and the <D-v>/<leader>mp
-- keymaps. Probes the clipboard for an image and routes to node for
-- `@file:` insertion; otherwise forwards the clipboard text to node so it
-- can be appended to the active thread's input buffer (opening the sidebar
-- first if needed). Callable from any buffer — the node side addresses
-- `activeBuffers.inputBuffer` directly.
M.do_paste = function()
  if not magenta_channel_id then
    vim.api.nvim_err_writeln(
      "Magenta: input buffer not ready yet — is the node process running?")
    return
  end
  if vim.fn.has("mac") == 1 then
    local ok, result = pcall(vim.fn.system, "osascript -e 'clipboard info'")
    if ok and type(result) == "string" and result:find("class PNGf", 1, true) then
      vim.rpcnotify(magenta_channel_id, "magentaClipboardImagePaste", {})
      return
    end
  end
  local text = vim.fn.getreg("+")
  if text == nil or text == "" then
    return
  end
  local from_display = last_display_yank ~= nil and text == last_display_yank
  vim.rpcnotify(magenta_channel_id, "magentaClipboardTextPaste", { text = text, fromDisplay = from_display })
end

M.set_paste_handlers = function(bufnr, channel_id)
  paste_input_bufnrs[bufnr] = true
  magenta_channel_id = channel_id

  if not original_paste then
    original_paste = vim.paste
    vim.paste = function(lines, phase)
      local cur = vim.api.nvim_get_current_buf()
      if paste_input_bufnrs[cur] then
        local detected = try_detect_dropped_path(lines)
        if detected then
          return original_paste({ format_file_ref(detected) }, phase)
        end
      end
      return original_paste(lines, phase)
    end
  end

  vim.api.nvim_create_autocmd("BufWipeout", {
    buffer = bufnr,
    once = true,
    callback = function()
      paste_input_bufnrs[bufnr] = nil
    end,
  })
end

--- Jump the cursor to the next/previous message header in the display buffer.
--- `filter` is "any" for user+assistant headers, or "user" for user headers only.
local function jump_to_header(direction, filter)
  local bufnr = vim.api.nvim_get_current_buf()
  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  local cursor_row = vim.api.nvim_win_get_cursor(0)[1]
  local function is_header(line)
    return line == "# user:" or (filter == "any" and line == "# assistant:")
  end
  local target = nil
  if direction == "next" then
    for row = cursor_row + 1, #lines do
      if is_header(lines[row]) then
        target = row
        break
      end
    end
  else
    for row = cursor_row - 1, 1, -1 do
      if is_header(lines[row]) then
        target = row
        break
      end
    end
  end
  if target then
    vim.api.nvim_win_set_cursor(0, { target, 0 })
  end
end


local message_jump_keymaps = {
  ["]m"] = function() jump_to_header("next", "any") end,
  ["[m"] = function() jump_to_header("prev", "any") end,
  ["]u"] = function() jump_to_header("next", "user") end,
  ["[u"] = function() jump_to_header("prev", "user") end,
}

M.setArchiveBufferKeymap = function(bufnr, channelId, threadId, logPath)
  vim.keymap.set("n", "<CR>", function()
    if vim.api.nvim_get_current_line() == logPath then
      vim.rpcnotify(channelId, "magentaOpenArchivedThreadLog", { threadId = threadId })
      return
    end

    local encoded = vim.api.nvim_replace_termcodes("<CR>", true, false, true)
    vim.api.nvim_feedkeys(encoded, "nx", false)
  end, {
    buffer = bufnr,
    noremap = true,
    silent = true,
  })
end

M.set_display_buffer_keymaps = function(bufnr)
  display_bufnrs[bufnr] = true
  set_wrapped_line_mode(bufnr)

  vim.api.nvim_create_autocmd("TextYankPost", {
    buffer = bufnr,
    callback = function()
      local ev = vim.v.event
      if ev.regname == "" or ev.regname == "+" or ev.regname == "*" then
        last_display_yank = table.concat(ev.regcontents or {}, "\n")
      end
    end,
  })

  vim.api.nvim_create_autocmd("BufWipeout", {
    buffer = bufnr,
    once = true,
    callback = function()
      display_bufnrs[bufnr] = nil
    end,
  })

  for key, action in pairs(message_jump_keymaps) do
    vim.keymap.set(
      { "n", "v" },
      key,
      action,
      { buffer = bufnr, noremap = true, silent = true }
    )
  end

  for mode, values in pairs(Options.options.displayKeymaps) do
    for key, action in pairs(values) do
      vim.keymap.set(
        mode_to_keymap[mode],
        key,
        action,
        { buffer = bufnr, noremap = true, silent = true }
      )
    end
  end
end

M.set_channel_id = function(channel_id)
  magenta_channel_id = channel_id
end

local function notify(event, payload)
  if not magenta_channel_id then
    vim.api.nvim_err_writeln("Magenta: not connected — is the node process running?")
    return
  end
  vim.rpcnotify(magenta_channel_id, event, payload)
end

--- Comment on the line under the cursor (or follow up on the comment there).
M.comment = function()
  local row = vim.api.nvim_win_get_cursor(0)[1] - 1
  notify("magentaComment", {
    bufnr = vim.api.nvim_get_current_buf(),
    winid = vim.api.nvim_get_current_win(),
    startRow = row,
    endRow = row,
  })
end

--- Comment on the current visual selection.
M.comment_visual = function()
  local esc = vim.api.nvim_replace_termcodes("<Esc>", true, false, true)
  vim.api.nvim_feedkeys(esc, "x", false)
  local startRow = vim.fn.getpos("'<")[2] - 1
  local endRow = vim.fn.getpos("'>")[2] - 1
  notify("magentaComment", {
    bufnr = vim.api.nvim_get_current_buf(),
    winid = vim.api.nvim_get_current_win(),
    startRow = math.min(startRow, endRow),
    endRow = math.max(startRow, endRow),
  })
end

M.comment_delete = function()
  notify("magentaCommentDelete", {
    bufnr = vim.api.nvim_get_current_buf(),
    row = vim.api.nvim_win_get_cursor(0)[1] - 1,
  })
end

--- `]c` / `[c` on a buffer that carries comments.
M.set_comment_navigation_keymaps = function(bufnr)
  for key, direction in pairs({ ["]c"] = "next", ["[c"] = "prev" }) do
    vim.keymap.set("n", key, function()
      notify("magentaCommentJump", {
        bufnr = bufnr,
        row = vim.api.nvim_win_get_cursor(0)[1] - 1,
        direction = direction,
      })
    end, { buffer = bufnr, noremap = true, silent = true, desc = "Jump to Magenta comment" })
  end
end

--- Scroll `winid` if the commented extent, its transcript and the input float
--- (`needed` screen lines below the anchor) would not all fit on screen.
M.fit_comment_input = function(winid, anchor_row, needed)
  if not vim.api.nvim_win_is_valid(winid) then
    return
  end
  local win_height = vim.api.nvim_win_get_height(winid)
  local topline = vim.fn.line("w0", winid)
  local ok, height = pcall(vim.api.nvim_win_text_height, winid, {
    start_row = topline - 1,
    end_row = anchor_row,
  })
  local used = ok and height.all or (anchor_row + 2 - topline)
  if used + needed <= win_height then
    return
  end
  vim.api.nvim_win_call(winid, function()
    local view = vim.fn.winsaveview()
    -- put the anchor high enough that the whole unit has room below it
    view.topline = math.max(1, anchor_row + 1 - math.max(0, win_height - needed - 1))
    vim.fn.winrestview(view)
  end)
end

--- Wire up the authoring float: keymaps, submit-on-write, grow-with-content,
--- and cancel when the anchor scrolls out of view or focus leaves.
M.setup_comment_input = function(bufnr, float_win, target_win, max_height, channel_id)
  magenta_channel_id = channel_id
  local group = vim.api.nvim_create_augroup("MagentaCommentInput" .. bufnr, { clear = true })

  for mode, values in pairs(Options.options.commentKeymaps or {}) do
    for key, action in pairs(values) do
      vim.keymap.set(
        mode_to_keymap[mode],
        key,
        action,
        { buffer = bufnr, noremap = true, silent = true }
      )
    end
  end
  vim.keymap.set("n", "<Esc><Esc>", ":MagentaCommentCancel<CR>",
    { buffer = bufnr, noremap = true, silent = true })

  vim.api.nvim_create_autocmd("BufWriteCmd", {
    group = group,
    buffer = bufnr,
    callback = function()
      vim.bo[bufnr].modified = false
      notify("magentaCommentInput", { action = "submit" })
    end,
  })

  local function resize()
    if not vim.api.nvim_win_is_valid(float_win) then
      return
    end
    local ok, height = pcall(vim.api.nvim_win_text_height, float_win, { max_height = max_height })
    local lines = ok and height.all or math.min(max_height, vim.api.nvim_buf_line_count(bufnr))
    vim.api.nvim_win_set_height(float_win, math.max(1, math.min(max_height, lines)))
  end

  vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, {
    group = group,
    buffer = bufnr,
    callback = resize,
  })

  vim.api.nvim_create_autocmd({ "WinScrolled", "WinClosed" }, {
    group = group,
    pattern = tostring(target_win),
    callback = function()
      notify("magentaCommentInput", { action = "cancel" })
    end,
  })

  vim.api.nvim_create_autocmd("BufWipeout", {
    group = group,
    buffer = bufnr,
    once = true,
    callback = function()
      pcall(vim.api.nvim_del_augroup_by_id, group)
    end,
  })
end

return M
