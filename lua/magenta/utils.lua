local M = {}

---@param log_level string
M.log_exit = function(log_level)
  if not log_level then
    return
  end
  return function(job_id, exit_code)
    vim.print("++++++++++++++++")
    vim.print("job# " .. job_id .. ":")
    vim.print("exit_code: " .. exit_code)
  end
end

---@param log_level string
M.log_job = function(log_level, is_stderr)
  if not log_level then
    return
  end

  local lines = {""}
  return function(job_id, data)
    local eof = #data > 0 and data[#data] == ""
    lines[#lines] = lines[#lines] .. data[1]
    for i = 2, #data do
      table.insert(lines, data[i])
    end
    if eof then
      local prefix = is_stderr and "[ERROR]" or "[INFO]"
      vim.print("----------------")
      vim.print(string.format("%s job# %d:", prefix, job_id))
      for _, line in ipairs(lines) do
        vim.print(line)
      end
      lines = {""}
    end
  end
end

local normal_commands = {
  "abort",
  "clear",
  "context-files",
  "provider",
  "start-inline-edit",
  "toggle",
}

local visual_commands = {
  "start-inline-edit-selection",
  "paste-selection",
}

M.command_complete = function(_, line)
  local commands = normal_commands
  local parts = vim.split(vim.trim(line), "%s+")
  if vim.startswith("'<,'>Magenta", parts[1]) then
    commands = visual_commands
    table.remove(parts, 1)
  elseif vim.startswith("Magenta", parts[1]) then
    table.remove(parts, 1)
  end
  if line:sub(-1) == " " then
    parts[#parts + 1] = ""
  end
  local prefix, args = table.remove(parts, 1) or "", parts
  if #args > 0 then
    return nil
  end
  return vim.tbl_filter(function(key)
    return key:find(prefix, 1, true) == 1
  end, commands)
end

return M
