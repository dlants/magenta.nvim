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

return M
