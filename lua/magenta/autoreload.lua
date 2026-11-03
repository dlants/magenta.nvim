local M = {}

-- Applies on-disk content to a clean buffer as a minimal diff, preserving undo
-- history and extmarks. When content is omitted it is read from disk.
function M.reload(bufnr, content)
  if not vim.api.nvim_buf_is_loaded(bufnr) then return end
  if vim.bo[bufnr].modified then return end

  if content == nil then
    local f = io.open(vim.api.nvim_buf_get_name(bufnr), "rb")
    if not f then return end
    content = f:read("*a") or ""
    f:close()
  end

  local hasEol = content == "" or content:sub(-1) == "\n"
  if hasEol then
    content = content:sub(1, -2)
  end
  local new = vim.split(content, "\n", { plain = true })

  local old = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  local hunks = vim.diff(
    table.concat(old, "\n") .. "\n",
    table.concat(new, "\n") .. "\n",
    { result_type = "indices" }
  )
  if #hunks == 0 and vim.bo[bufnr].endofline == hasEol then return end

  -- apply back-to-front so earlier hunk indices stay valid
  for i = #hunks, 1, -1 do
    local startA, countA, startB, countB = unpack(hunks[i])
    -- countA == 0 is a pure insertion after line startA
    local from = countA == 0 and startA or startA - 1
    local replacement = {}
    for j = startB, startB + countB - 1 do
      replacement[#replacement + 1] = new[j]
    end
    vim.api.nvim_buf_set_lines(bufnr, from, from + countA, false, replacement)
  end

  vim.bo[bufnr].fixendofline = hasEol
  vim.bo[bufnr].endofline = hasEol
  -- Write the already-matching buffer back so nvim records the new mtime.
  -- checktime would reload it and discard the undo entry on older nvim.
  vim.api.nvim_buf_call(bufnr, function()
    vim.cmd("silent! noautocmd write!")
  end)
end

local DEBOUNCE_MS = 100
local augroup = nil
-- dir -> { handle = uv_fs_event, files = { [basename] = bufnr }, count = n }
M._dirs = {}
-- bufnr -> { path, dir, name, timer, stat }
M._bufs = {}

local function statKey(st)
  if not st then return nil end
  return st.mtime.sec .. ":" .. st.mtime.nsec .. ":" .. st.size
end

local function readAsync(path, cb)
  vim.uv.fs_open(path, "r", 438, function(err, fd)
    if err or not fd then return end
    vim.uv.fs_fstat(fd, function(serr, st)
      if serr or not st then
        vim.uv.fs_close(fd)
        return
      end
      vim.uv.fs_read(fd, st.size, 0, function(rerr, data)
        vim.uv.fs_close(fd)
        if rerr then return end
        cb(data or "", st)
      end)
    end)
  end)
end

local function recordStat(bufnr)
  local entry = M._bufs[bufnr]
  if not entry then return end
  vim.uv.fs_stat(entry.path, function(_, st)
    if st then entry.stat = statKey(st) end
  end)
end

local function reloadAsync(bufnr)
  local entry = M._bufs[bufnr]
  if not entry then return end
  readAsync(entry.path, function(data, st)
    vim.schedule(function()
      if M._bufs[bufnr] ~= entry then return end
      entry.stat = statKey(st)
      if vim.bo[bufnr].modified then return end
      M.reload(bufnr, data)
      -- our own write! changes the mtime; record it so the event is a no-op
      recordStat(bufnr)
    end)
  end)
end

local function onChange(bufnr)
  local entry = M._bufs[bufnr]
  if not entry then return end
  vim.uv.fs_stat(entry.path, function(err, st)
    -- deleted files are ignored
    if err or not st then return end
    if statKey(st) == entry.stat then return end
    vim.schedule(function()
      if M._bufs[bufnr] ~= entry or not vim.api.nvim_buf_is_loaded(bufnr) then return end
      if vim.bo[bufnr].modified then return end
      if #vim.fn.win_findbuf(bufnr) > 0 then
        reloadAsync(bufnr)
      else
        vim.b[bufnr].magentaStale = true
      end
    end)
  end)
end

local function detach(bufnr)
  local entry = M._bufs[bufnr]
  if not entry then return end
  M._bufs[bufnr] = nil
  if entry.timer then
    entry.timer:stop()
    entry.timer:close()
  end
  local d = M._dirs[entry.dir]
  if not d then return end
  if d.files[entry.name] == bufnr then d.files[entry.name] = nil end
  d.count = d.count - 1
  if d.count <= 0 then
    d.handle:stop()
    d.handle:close()
    M._dirs[entry.dir] = nil
  end
end

local function arm(target)
  local e = M._bufs[target]
  if not e then return end
  if not e.timer then e.timer = vim.uv.new_timer() end
  e.timer:stop()
  e.timer:start(DEBOUNCE_MS, 0, function() onChange(target) end)
end

local function attach(bufnr)
  if not vim.api.nvim_buf_is_loaded(bufnr) or vim.bo[bufnr].buftype ~= "" then return end
  local path = vim.api.nvim_buf_get_name(bufnr)
  if path == "" then return end
  path = vim.fn.fnamemodify(path, ":p")
  if vim.fn.isdirectory(path) == 1 then return end
  local existing = M._bufs[bufnr]
  if existing and existing.path == path then return end
  detach(bufnr)
  local dir = vim.fn.fnamemodify(path, ":h")
  local name = vim.fn.fnamemodify(path, ":t")
  if vim.fn.isdirectory(dir) == 0 then return end
  local d = M._dirs[dir]
  if not d then
    local handle = vim.uv.new_fs_event()
    if not handle then return end
    d = { handle = handle, files = {}, count = 0 }
    -- Watch the directory: rename-replace (sed -i, formatters, git) would kill a per-file watch.
    -- Runs on the libuv loop, so only table lookups and timers here.
    local ok = handle:start(dir, {}, function(err, filename)
      if err then return end
      if filename then
        local target = d.files[vim.fs.basename(filename)]
        if target then arm(target) end
      else
        for _, target in pairs(d.files) do arm(target) end
      end
    end)
    if not ok then
      handle:close()
      return
    end
    M._dirs[dir] = d
  end
  d.files[name] = bufnr
  d.count = d.count + 1
  M._bufs[bufnr] = { path = path, dir = dir, name = name }
  recordStat(bufnr)
end

function M.teardown()
  for bufnr, _ in pairs(M._bufs) do detach(bufnr) end
  if augroup then
    vim.api.nvim_del_augroup_by_id(augroup)
    augroup = nil
  end
end

function M.setup()
  M.teardown()
  if not require("magenta.options").options.autoReloadBuffers then
    return
  end
  augroup = vim.api.nvim_create_augroup("MagentaAutoreload", { clear = true })
  vim.api.nvim_create_autocmd({ "BufReadPost", "BufNewFile", "BufFilePost" }, {
    group = augroup,
    callback = function(ev) attach(ev.buf) end,
  })
  vim.api.nvim_create_autocmd({ "BufUnload", "BufWipeout" }, {
    group = augroup,
    callback = function(ev) detach(ev.buf) end,
  })
  vim.api.nvim_create_autocmd("BufWritePost", {
    group = augroup,
    callback = function(ev) recordStat(ev.buf) end,
  })
  vim.api.nvim_create_autocmd("BufWinEnter", {
    group = augroup,
    callback = function(ev)
      if vim.b[ev.buf].magentaStale then
        vim.b[ev.buf].magentaStale = nil
        reloadAsync(ev.buf)
      end
    end,
  })
  for _, bufnr in ipairs(vim.api.nvim_list_bufs()) do attach(bufnr) end
end

return M
