local M = {}

local defaults = {
  profiles = {
    {
      name = "claude-opus-4-6",
      provider = "anthropic",
      model = "claude-opus-4-6",
      apiKeyEnvVar = "ANTHROPIC_API_KEY"
    },
    {
      name = "claude-sonnet-4-5",
      provider = "anthropic",
      model = "claude-sonnet-4-5",
      apiKeyEnvVar = "ANTHROPIC_API_KEY"
    },
    {
      name = "claude-max",
      provider = "anthropic",
      model = "claude-opus-4-6",
      authType = "max"
    },
    {
      name = "claude-keychain",
      provider = "anthropic",
      model = "claude-opus-4-6",
      authType = "keychain"
    },
    {
      name = "gpt-4o",
      provider = "openai",
      model = "gpt-4o",
      apiKeyEnvVar = "OPENAI_API_KEY"
    },
    {
      name = "copilot-claude-opus",
      provider = "copilot",
      model = "claude-opus-4-6"
    }
  },
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
      widthPercentage = 0.4,
      displayHeightPercentage = 0.8,
    },
    right = {
      widthPercentage = 0.4,
      displayHeightPercentage = 0.8,
    }
  },
  defaultKeymaps = true,
  sidebarKeymaps = {
    normal = {
      ["<CR>"] = ":Magenta send<CR>",
    }
  },
  displayKeymaps = {
    normal = {
      ["-"] = ":Magenta threads-navigate-up<CR>",
    }
  },

  -- note: some OSs are case sensitive, and some are not.
  -- to make this work cross-platform, we will run all globs
  -- in case-insensitive mode.
  -- So you only need to add lowercase versions of each file.
  -- So for example, you do not need both context.md and CONTEXT.MD
  autoContext = {
    "context.md",
    "claude.md",
    ".magenta/*.md"
  },
  skillsPaths = {
    "~/.magenta/skills",
    "~/.claude/skills",
    ".magenta/skills",
    ".claude/skills"
  },
  suppressProjectSkills = {},
  maxConcurrentSubagents = 3,
  chimeVolume = 0.3,
  bellOnNotify = true,
  getFileAutoAllowGlobs = {
    "node_modules/**/*"
  },
  customCommands = {
    {
      name = "@nedit",
      text =
      "DO NOT MAKE ANY EDITS TO CODE. Do not use any tools that allow you to edit code. Do not execute bash commands which edit code. NO EDITING WHATSOEVER.",
      description = "Disable all code editing functionality"
    },
    -- {
    --   name = "@careful",
    --   text = "Be extra careful and double-check your work before making any changes.",
    --   description = "Request extra caution"
    -- }
  }
}

M.options = defaults

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
