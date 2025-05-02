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

local snacks_files = function()
  local snacks = require("snacks")

  local completed = false
  snacks.picker.pick({
    source = "files",
    title = "Select context files for Magenta",
    confirm = function(picker)
      if completed then return end
      completed = true
      local items = picker:selected({ fallback = true })

      if #items > 0 then
        local escaped_files = {}
        for _, item in ipairs(items) do
          table.insert(escaped_files, vim.fn.shellescape(item.file))
        end
        vim.cmd("Magenta context-files " .. table.concat(escaped_files, " "))
      end

      picker:close()
    end,
    on_close = function()
      if completed then return end
      completed = true
    end,
  })
end


M.pick_context_files = function()
  if Options.options.picker == "fzf-lua" then
    fzf_files()
  elseif Options.options.picker == "telescope" then
    telescope_files()
  elseif Options.options.picker == "snacks" then
    snacks_files()
  else
    vim.notify("No supported picker (fzf-lua, telescope, or snacks) installed!", vim.log.levels.ERROR)
  end
end

M.pick_profile = function()
  local items = {}
  for _, profile in ipairs(Options.options.profiles) do
    table.insert(items, {
      display = profile.name .. " (" .. profile.provider .. " " .. profile.model .. ")",
      profile = profile.name
    })
  end

  vim.ui.select(items, {
    prompt = "Select Profile",
    format_item = function(item) return item.display end
  }, function(choice)
    if choice ~= nil then
      vim.cmd("Magenta profile " .. choice.profile)
    end
  end)
end

M.add_buffer_to_context = function()
  local current_file = vim.fn.expand("%:p")
  vim.cmd("Magenta context-files " .. vim.fn.shellescape(current_file))
end

return M
