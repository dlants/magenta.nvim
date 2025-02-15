local M = {}

-- Structure: {
--   bufnr = {
--     initial = Lines[],
--     snapshot of the buffer to capture the last edit
--     delta = Lines[],
--     last_edit = {
--       start_line = number,
--       end_line = number,
--       previous_lines = Lines[],
--       lines = Lines[]
--     },
--     pending_edits = { { firstline = number, lastline = number, new_lastline = number }[] },
--     debounce_timer = number|nil
--   }
-- }
local snapshots = {}

local function get_buffer_lines(bufnr)
  return vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
end

local function deep_copy_lines(lines)
  local copy = {}
  for i, line in ipairs(lines) do
    copy[i] = line
  end
  return copy
end

function M.rebase_pending_edits(pending_edits)
  -- the start of the edit. Since nothing above this point was edited, this coordinate will be the same in pre and
  -- post-edit systems.
  local firstline = math.huge

  -- the end line of the edit in the pre-edit coordinate system
  local lastline = -1

  -- the end line of the edit in the post-edit coordinate system
  local new_lastline = -1

  for _, edit in ipairs(pending_edits) do
    firstline = math.min(firstline, edit.firstline)
    -- lastline should be in the coordinate system of the initial file (before *any* edits have been applied)
    -- new_lastline - lastline is the line adjustment of the edits we've seen so far, so edit.lastline should be
    -- reversed by this much.
    lastline = math.max(lastline, edit.lastline - (new_lastline - lastline))

    -- new_lastline and edit.firstline are in the same coordinate system (all previous edits having been applied)
    if (new_lastline > edit.firstline) then
      -- after this edit, new_lastline should move if the edit is before it
      new_lastline = new_lastline + (edit.new_lastline - edit.lastline)
    end
    new_lastline = math.max(new_lastline, edit.new_lastline)


  end
  return { firstline = firstline, lastline = lastline, new_lastline = new_lastline}
end


local function attach_to_buffer(bufnr)
  if snapshots[bufnr] then return end

  local lines = get_buffer_lines(bufnr)
  snapshots[bufnr] = {
    initial = lines,
    delta = deep_copy_lines(lines),
    pending_edits = {},
    debounce_timer = nil
  }

  vim.api.nvim_buf_attach(bufnr, false, {
    on_lines = function(_, _, _, firstline, lastline, new_lastline)
      if not snapshots[bufnr] then return false end

      table.insert(snapshots[bufnr].pending_edits, {
        firstline = firstline,
        lastline = lastline,
        new_lastline = new_lastline
      })

      if snapshots[bufnr].debounce_timer then
        vim.fn.timer_stop(snapshots[bufnr].debounce_timer)
      end

      snapshots[bufnr].debounce_timer = vim.fn.timer_start(500, function()
        if not snapshots[bufnr] then return end

        local edit_bounds = M.rebase_pending_edits(snapshots[bufnr].pending_edits)

        local previous_lines = {}
        for i = edit_bounds.firstline + 1, edit_bounds.lastline do
          table.insert(previous_lines, snapshots[bufnr].delta[i])
        end

        local new_lines = vim.api.nvim_buf_get_lines(bufnr, edit_bounds.firstline, edit_bounds.new_lastline, false)

        snapshots[bufnr].last_edit = {
          start_line = edit_bounds.firstline,
          end_line = edit_bounds.new_lastline,
          previous_lines = previous_lines,
          lines = new_lines
        }

        for i = edit_bounds.lastline, edit_bounds.firstline + 1, -1 do
          table.remove(snapshots[bufnr].delta, i)
        end

        for i, line in ipairs(new_lines) do
          table.insert(snapshots[bufnr].delta, edit_bounds.firstline + i, line)
        end

        snapshots[bufnr].pending_edits = {}
        snapshots[bufnr].debounce_timer = nil
      end)

      return false
    end,
    on_detach = function()
      snapshots[bufnr] = nil
    end
  })
end

function M.get_initial_diff(bufnr)
  if not snapshots[bufnr] then return nil end
  return {
    initial = snapshots[bufnr].initial,
    current = snapshots[bufnr].current
  }
end

function M.get_last_edit(bufnr)
  if not snapshots[bufnr] then return nil end
  return {
    before = snapshots[bufnr].last_edit,
    after = snapshots[bufnr].current
  }
end

local function setup_autocmds()
  local group = vim.api.nvim_create_augroup('MagentaSnapshots', { clear = true })
  vim.api.nvim_create_autocmd('BufReadPost', {
    group = group,
    callback = function(args)
      attach_to_buffer(args.buf)
    end
  })
end

function M.setup()
  setup_autocmds()
  vim.keymap.set('n', '<leader>m?', M.show_snapshot_window, { noremap = true, silent = true })
end

function M.show_snapshot_window()
  local bufnr = vim.api.nvim_get_current_buf()
  if not snapshots[bufnr] then
    vim.api.nvim_echo({{"No snapshot for current buffer", "WarningMsg"}}, true, {})
    return
  end

  -- Create content for the floating window
  local content = {"=== Initial Buffer Content ==="}
  for _, line in ipairs(snapshots[bufnr].initial) do
    table.insert(content, line)
  end

  if snapshots[bufnr].delta then
    table.insert(content, "")
    table.insert(content, "=== Current Delta Content ===")
    for _, line in ipairs(snapshots[bufnr].delta) do
      table.insert(content, line)
    end
  end

  if snapshots[bufnr].last_edit then
    table.insert(content, "")
    table.insert(content, "=== Last Edit ===")
    table.insert(content, string.format("Lines %d-%d",
      snapshots[bufnr].last_edit.start_line,
      snapshots[bufnr].last_edit.end_line))

    table.insert(content, "Previous content:")
    for _, line in ipairs(snapshots[bufnr].last_edit.previous_lines or {}) do
      table.insert(content, line)
    end

    table.insert(content, "New content:")
    for _, line in ipairs(snapshots[bufnr].last_edit.lines or {}) do
      table.insert(content, line)
    end
  end

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
