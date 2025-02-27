local M = {}
local rebase_pending_edits = require("magenta.rebase_pending_edits").rebase_pending_edits

-- we will keep track of the last N edits across files
local MAX_EDITS = 3
local DEBOUNCE_MS = 200

-- watcher: {
--   bufnr = string,
--   bufName = string,
--   prev = {
--     start_line_0idx = number,
--     lines = string[]
--   },
--   pending_edits = { { firstline_0idx, lastline_0idx_excl, new_lastline_0idx_excl } },
--   debounce_timer = vim.loop timer
--   }
-- }
local watcher = nil

-- edit: {
--   previous_lines = string[],
--   lines = string[]
--   context_above = string[]
--   context_below = string[]
-- }
local edits = {}

local function get_visible_window_range(bufnr)
  local win = vim.fn.bufwinid(bufnr)
  if win == -1 then return 0, -1 end

  -- Vim's line() function returns 1-indexed line numbers
  local start_line_1idx = vim.fn.line('w0', win)
  local end_line_1idx = vim.fn.line('w$', win)

  -- Convert to 0-indexed for nvim_buf functions
  local start_line_0idx = start_line_1idx - 1
  local end_line_0idx_exl = end_line_1idx     -- nvim_buf_get_lines end is exclusive

  return start_line_0idx, end_line_0idx_exl
end

local function deep_copy_lines(lines)
  local copy = {}
  for i, line in ipairs(lines) do
    copy[i] = line
  end
  return copy
end

local function update_watcher_prev()
  if (not watcher) then
    return false
  end

  local start_line_0idx, end_line_0idx_exl = get_visible_window_range(watcher.bufnr)

  -- get_lines is 0-based, end-exclusive
  local lines = vim.api.nvim_buf_get_lines(watcher.bufnr, start_line_0idx, end_line_0idx_exl, false)
  watcher.prev = {
    start_line_0idx = start_line_0idx,
    lines = deep_copy_lines(lines)
  }
end

local function process_edit(firstline_0idx, lastline_0idx_excl, new_lastline_0idx_excl)
  if not (watcher and watcher.prev) then
    return
  end

  local bufnr = watcher.bufnr
  local prev = watcher.prev

  local previous_lines = {}
  -- Convert to 1-indexed for array access (prev.lines is a 1-indexed Lua array)
  local prev_start_1idx = (firstline_0idx - prev.start_line_0idx) + 1
  local prev_end_1idx_excl = (lastline_0idx_excl - prev.start_line_0idx) + 1
  for i = prev_start_1idx, prev_end_1idx_excl-1 do
    if prev.lines[i] then
      table.insert(previous_lines, prev.lines[i])
    end
  end

  -- Get context and new_lines in a single call (2 lines above and 2 lines below)
  local context_above_start = math.max(0, firstline_0idx - 2)
  local context_below_end = new_lastline_0idx_excl + 2 -- going past the end is OK since strictIndexing = false

  -- Get context and new lines in one call
  local all_lines = vim.api.nvim_buf_get_lines(bufnr, context_above_start, context_below_end, false)

  -- Calculate indices for splitting the array
  local above_count = firstline_0idx - context_above_start
  local edit_count = new_lastline_0idx_excl - firstline_0idx

  -- Extract the parts
  local context_above = {}
  local new_lines = {}
  local context_below = {}

  for i = 1, #all_lines do
    if i <= above_count then
      table.insert(context_above, all_lines[i])
    elseif i <= above_count + edit_count then
      table.insert(new_lines, all_lines[i])
    else
      table.insert(context_below, all_lines[i])
    end
  end

  local noop_edit = false
  if #previous_lines == #new_lines then
    noop_edit = true
    for i = 1, #previous_lines do
      if previous_lines[i] ~= new_lines[i] then
        noop_edit = false
        break
      end
    end
  end

  if not noop_edit then
    -- Create a hunk header like "@@ -start,oldcount +start,newcount @@"
    local hunk_header = string.format("@@ -%d,%d +%d,%d @@",
      firstline_0idx + 1, #previous_lines,
      firstline_0idx + 1, #new_lines)

    local edit = {
      bufName = watcher.bufName,
      hunk_header = hunk_header,
      previous_lines = previous_lines,
      lines = new_lines,
      context_above = context_above,
      context_below = context_below
    }

    table.insert(edits, 1, edit)
    while #edits > MAX_EDITS do
      table.remove(edits)
    end
  end

  update_watcher_prev()
end

local function process_pending_edits()
  if not watcher or not watcher.pending_edits or #watcher.pending_edits == 0 then
    return
  end

  -- Combine all pending edits using rebase_pending_edits
  local combined = rebase_pending_edits(watcher.pending_edits)

  -- Process the combined edit
  process_edit(combined.firstline_0idx, combined.lastline_0idx_excl, combined.new_lastline_0idx_excl)

  -- Clear pending edits
  watcher.pending_edits = {}
end

local function attach_to_buffer(bufnr)
  local bufName = vim.api.nvim_buf_get_name(bufnr)

  -- Clean up any existing timer
  if watcher and watcher.debounce_timer then
    watcher.debounce_timer:stop()
    watcher.debounce_timer:close()
  end

  watcher = {
    bufnr = bufnr,
    bufName = bufName,
    prev = nil,
    pending_edits = {},
    debounce_timer = vim.loop.new_timer()
  }
  update_watcher_prev()

  vim.api.nvim_buf_attach(bufnr, false, {
    -- on_lines is 0-indexed. Lastline is inclusive
    on_lines = function(_, _, _, firstline_0idx, lastline_0idx_excl, new_lastline_0idx_excl)
      -- All line numbers from nvim_buf_attach callback are 0-indexed
      if not (watcher and watcher.bufnr == bufnr) then
        return true -- returning true detaches this on_lines listener
      end

      if watcher.prev then
        -- Add this edit to pending edits
        table.insert(watcher.pending_edits, {
          firstline_0idx = firstline_0idx,
          lastline_0idx_excl = lastline_0idx_excl,
          new_lastline_0idx_excl = new_lastline_0idx_excl
        })

        -- Reset the debounce timer
        watcher.debounce_timer:stop()
        watcher.debounce_timer:start(DEBOUNCE_MS, 0, vim.schedule_wrap(process_pending_edits))
      end

      return nil -- returning nil keeps the buffer attached
    end
  })
end

local function setup_autocmds()
  local group = vim.api.nvim_create_augroup('MagentaSnapshots', { clear = true })
  vim.api.nvim_create_autocmd({ 'BufEnter', 'BufReadPost' }, {
    group = group,
    callback = function(args)
      attach_to_buffer(args.buf)
    end
  })

  vim.api.nvim_create_autocmd('WinScrolled', {
    group = group,
    callback = function()
      update_watcher_prev()
    end
  })
end

function M.setup()
  setup_autocmds()
  vim.keymap.set('n', '<leader>m?', M.show_snapshot_window, { noremap = true, silent = true })
end

local function construct_prompt()
  if not watcher then return "" end

  local content = {
    "You are a code completion assistant and your task is to analyze user edits and then rewrite an excerpt that the user provides, suggesting the appropriate edits within the excerpt, taking into account the cursor location.",
    "### User Edits:"
  }

  for i, edit in ipairs(edits) do
    table.insert(content, "")
    table.insert(content, string.format("Edit #%d:", i))
    table.insert(content, "```diff")

    -- Display the hunk header if available
    if edit.hunk_header then
      table.insert(content, edit.hunk_header)
    end

    if edit.context_above then
      for _, line in ipairs(edit.context_above) do
        table.insert(content, line)
      end
    end

    for _, line in ipairs(edit.previous_lines) do
      table.insert(content, "- " .. line)
    end
    for _, line in ipairs(edit.lines) do
      table.insert(content, "+ " .. line)
    end

    if edit.context_below then
      for _, line in ipairs(edit.context_below) do
        table.insert(content, line)
      end
    end

    table.insert(content, "```")
  end

  -- Get current buffer name
  local bufname = vim.api.nvim_buf_get_name(watcher.bufnr)
  table.insert(content, "### User Excerpt:")
  table.insert(content, string.format("File: %s", bufname))
  table.insert(content, "```")

  -- Get visible contents of the active buffer (0-indexed)
  local start_line_0idx, end_line_0idx = get_visible_window_range(watcher.bufnr)
  local lines = vim.api.nvim_buf_get_lines(watcher.bufnr, start_line_0idx, end_line_0idx, false)

  -- Get cursor position (nvim_win_get_cursor returns {row, col} where row is 1-indexed and col is 0-indexed)
  local cursor_pos = vim.api.nvim_win_get_cursor(0)
  local cursor_row_1idx = cursor_pos[1]
  local cursor_col_0idx = cursor_pos[2]

  -- Convert cursor row to 0-indexed and relative to visible window
  local cursor_row_0idx_relative = cursor_row_1idx - 1 - start_line_0idx

  -- Insert lines with cursor marker
  for i, line in ipairs(lines) do
    -- i is 1-indexed (Lua arrays start at 1)
    if i-1 == cursor_row_0idx_relative then
      -- Insert cursor marker at the proper position
      -- cursor_col_0idx is 0-indexed, which matches the string.sub indexing
      local prefix = string.sub(line, 1, cursor_col_0idx)
      local suffix = string.sub(line, cursor_col_0idx + 1)
      table.insert(content, prefix .. "<|user_cursor_is_here|>" .. suffix)
    else
      table.insert(content, line)
    end
  end

  table.insert(content, "```")

  return content
end

function M.show_snapshot_window()
  local bufnr = vim.api.nvim_get_current_buf()
  if not (watcher and watcher.bufnr == bufnr) then
    vim.api.nvim_echo({ { "No snapshot for current buffer", "WarningMsg" } }, true, {})
    return
  end

  local content = construct_prompt()


  -- Create a scratch buffer for the snapshot
  local float_bufnr = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(float_bufnr, 0, -1, false, content)

  -- Calculate window size (80% of editor width/height)
  local width = math.floor(vim.o.columns * 0.8)
  local height = math.floor(vim.o.lines * 0.8)
  local row = math.floor((vim.o.lines - height) / 2)
  local col = math.floor((vim.o.columns - width) / 2)

  -- Set up window options
  local opts = {
    relative = 'editor',
    row = row,
    col = col,
    width = width,
    height = height,
    style = 'minimal',
    border = 'rounded'
  }

  -- Create the floating window
  vim.api.nvim_open_win(float_bufnr, true, opts)

  -- Set buffer options
  vim.api.nvim_buf_set_option(float_bufnr, 'modifiable', false)
  vim.api.nvim_buf_set_option(float_bufnr, 'bufhidden', 'wipe')

  -- Add a keymap to close the window
  vim.keymap.set('n', 'q', '<cmd>close<CR>', { buffer = float_bufnr, noremap = true, silent = true })
end

return M
