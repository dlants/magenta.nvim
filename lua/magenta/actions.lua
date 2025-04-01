local M = {}

local Options = require("magenta.options")

local fzf_files = function()
  local fzf = require("fzf-lua")
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

local telescope_files = function()
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


M.pick_context_files = function()
  if Options.options.picker == "fzf-lua" then
    fzf_files()
  elseif Options.options.picker == "telescope" then
    telescope_files()
  else
    vim.notify("Neither fzf-lua nor telescope are installed!", vim.log.levels.ERROR)
  end
end

M.pick_provider = function()
  local items = Options.get_model_strings()
  local display_items = {}
  local command_map = {}
  for _, item in ipairs(items) do
    table.insert(display_items, item.display)
    command_map[item.display] = item.command
  end
  vim.ui.select(display_items, { prompt = "Select Model", }, function (choice)
    if choice ~= nil then
      vim.cmd("Magenta provider " .. command_map[choice])
    end
  end)
end

M.add_buffer_to_context = function()
  local current_file = vim.fn.expand("%:p")
  vim.cmd("Magenta context-files " .. vim.fn.shellescape(current_file))
end

return M
