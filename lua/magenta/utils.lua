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
      -- don't log the init message
      if #lines >=2 and lines[2]:match("magenta.nvim@.*start") then
        return
      end
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

M.fzf_files = function()
  local fzf = require("fzf")
  fzf.files(
    {
      raw = true, -- return just the raw path strings
      actions = {
        ["default"] = function(selected)
          local escaped_files = {}
          for _, entry in ipairs(selected) do
            table.insert(escaped_files, vim.fn.shellescape(fzf.path.entry_to_file(entry).path))
          end
          vim.cmd("Magenta context-files " .. table.concat(escaped_files, " "))
        end
      }
    }
  )
end

M.telescope_files = function()
  local builtin = require("telescope.builtin")
  local actions = require("telescope.actions")
  local action_state = require("telescope.actions.state")
  builtin.find_files({
    prompt_title = "Select context files",
    attach_mappings = function(prompt_bufnr)
      actions.select_default:replace(function()
        local picker = action_state.get_current_picker(prompt_bufnr)
        local selected_entries = picker:get_multi_selection()
        if vim.tbl_isempty(selected_entries) then
          selected_entries = { action_state.get_selected_entry() }
        end
        actions.close(prompt_bufnr)
        local escaped_files = {}
        for _, entry in ipairs(selected_entries) do
          table.insert(escaped_files, vim.fn.shellescape(entry.path))
        end
        if not vim.tbl_isempty(escaped_files) then
          vim.cmd("Magenta context-files " .. table.concat(escaped_files, " "))
        end
      end)
      return true
    end,
  })
end

return M
