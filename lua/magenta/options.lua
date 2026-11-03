local M = {}

local defaults = {
  picker = "fzf-lua",
  sidebarPosition = "left",
  sidebarPositionOpts = {
    above = {
      displayHeightPercentage = 0.3,
      inputHeightPercentage = 0.1,
    },
    below = {
      displayHeightPercentage = 0.3,
      inputHeightPercentage = 0.1,
    },
    tab = {
      displayHeightPercentage = 0.8,
    },
    left = {
      displayHeightPercentage = 0.8,
    },
    right = {
      displayHeightPercentage = 0.8,
    }
  },
  defaultKeymaps = true,
  sidebarKeymaps = {
    normal = {
      ["<CR>"] = ":Magenta send<CR>",
      ["-"] = ":Magenta threads-navigate-up<CR>",
    }
  },
  displayKeymaps = {
    normal = {
      ["-"] = ":Magenta threads-navigate-up<CR>",
    }
  },
  chimeVolume = 0.3,
  bellOnNotify = true,
  autoReloadBuffers = true
}

M.options = defaults
-- Server configuration lives in ~/.magenta/options.json; the node process
-- mirrors what lua needs (profile picker, command completion) here.
M.serverOptions = { profiles = {}, customCommands = {} }
M.setServerOptions = function(serverOptions)
  M.serverOptions = serverOptions
end

M.set_options = function(opts)
  M.options = vim.tbl_deep_extend("force", defaults, opts or {})
  if opts.picker == nil then
    local pickers = { "fzf-lua", "telescope", "snacks" }
    for _, picker in ipairs(pickers) do
      local success, _ = pcall(require, picker)
      if success then
        M.options.picker = picker
        break
      end
    end
  end
end

return M
