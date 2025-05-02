local M = {}

local Actions = require("magenta.actions")
local Options = require("magenta.options")

M.default_keymaps = function()
  vim.keymap.set(
    "n",
    "<leader>mc",
    ":Magenta clear<CR>",
    {silent = true, noremap = true, desc = "Clear Magenta state"}
  )

  vim.keymap.set(
    "n",
    "<leader>ma",
    ":Magenta abort<CR>",
    {silent = true, noremap = true, desc = "Abort current Magenta operation"}
  )

  vim.keymap.set(
    "n",
    "<leader>mt",
    ":Magenta toggle<CR>",
    {silent = true, noremap = true, desc = "Toggle Magenta window"}
  )

  vim.keymap.set(
    "n",
    "<leader>mi",
    ":Magenta start-inline-edit<CR>",
    {silent = true, noremap = true, desc = "Inline edit"}
  )

  vim.keymap.set(
    "v",
    "<leader>mi",
    ":Magenta start-inline-edit-selection<CR>",
    {silent = true, noremap = true, desc = "Inline edit selection"}
  )

  vim.keymap.set(
    "v",
    "<leader>mp",
    ":Magenta paste-selection<CR>",
    {silent = true, noremap = true, desc = "Send selection to Magenta"}
  )

  vim.keymap.set(
    "n",
    "<leader>mb", -- like "magenta buffer"?
    Actions.add_buffer_to_context,
    {silent = true, noremap = true, desc = "Add current buffer to Magenta context"}
  )

  vim.keymap.set(
    "n",
    "<leader>mf",
    Actions.pick_context_files,
    {silent = true, noremap = true, desc = "Select files to add to Magenta context"}
  )

  vim.keymap.set(
    "n",
    "<leader>mp",
    Actions.pick_profile,
    {silent = true, noremap = true, desc = "Select profile"}
  )
end

local mode_to_keymap = {
  normal = "n",
  visual = "v",
  insert = "i",
  command = "c",
}

M.set_inline_buffer_keymaps = function(bufnr, target_bufnr)
  for mode, values in pairs(Options.options.inlineKeymaps) do
    for key, _action in pairs(values) do
      local action = _action
      if type(_action) == "function" then
        action = function()
          _action(target_bufnr)
        end
      end
      vim.keymap.set(
        mode_to_keymap[mode],
        key,
        action,
        {buffer = bufnr, noremap = true, silent = true}
      )
    end
  end
end


M.set_sidebar_buffer_keymaps = function(bufnr)
  for mode, values in pairs(Options.options.sidebarKeymaps) do
    for key, action in pairs(values) do
      vim.keymap.set(
        mode_to_keymap[mode],
        key,
        action,
        {buffer = bufnr, noremap = true, silent = true}
      )
    end
  end
end


return M
