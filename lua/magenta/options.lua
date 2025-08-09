local M = {}

local defaults = {
  profiles = {
    {
      name = "claude-sonnet-3.7",
      provider = "anthropic",
      model = "claude-3-7-sonnet-latest",
      apiKeyEnvVar = "ANTHROPIC_API_KEY"
    },
    {
      name = "claude-sonnet-4",
      provider = "anthropic",
      model = "claude-sonnet-4-20250514",
      apiKeyEnvVar = "ANTHROPIC_API_KEY"
    },
    {
      name = "claude-opus-4",
      provider = "anthropic",
      model = "claude-opus-4-20250514",
      apiKeyEnvVar = "ANTHROPIC_API_KEY"
    },
    {
      name = "gpt-4o",
      provider = "openai",
      model = "gpt-4o",
      apiKeyEnvVar = "OPENAI_API_KEY"
    },
    {
      name = "copilot-claude-sonnet",
      provider = "copilot",
      model = "claude-3-5-sonnet-20241022"
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
      widthPercentage = 0.3,
      displayHeightPercentage = 0.8,
    },
    right = {
      widthPercentage = 0.3,
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
  editPrediction = {
    -- profile = {
    --   provider = "anthropic",
    --   model = "claude-3-5-haiku-latest",
    --   apiKeyEnvVar = "ANTHROPIC_API_KEY"
    -- },
    -- changeTrackerMaxChanges = 20,
    -- recentChangeTokenBudget = 1500,
    -- systemPrompt = "Your custom prediction system prompt here...",
    -- systemPromptAppend = "Focus on completing function calls and variable declarations."
  },
  inlineKeymaps = {
    normal = {
      ["<CR>"] = function(target_bufnr)
        vim.cmd("Magenta submit-inline-edit " .. target_bufnr)
      end,
    },
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
  commandAllowlist = {
    "^ls( [^;&|()<>]*)?$",
    "^pwd$",
    "^echo( [^;&|()<>]*)?$",
    "^git (status|log|diff|show|add|commit|push|reset|restore|branch|checkout|switch|fetch|pull|merge|rebase|tag|stash)( [^;&|()<>]*)?$",
    "^ls [^;&()<>]* | grep [^;&|()<>]*$",
    "^echo [^;&|()<>]* > [a-zA-Z0-9_\\-.]+$",
    "^grep( -[A-Za-z]*)? [^;&|()<>]*$"
  },
  maxConcurrentSubagents = 3,
  getFileAutoAllowGlobs = {
    "node_modules/**/*"
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
