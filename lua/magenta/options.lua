local M = {}

local defaults = {
  profiles = {
    {
      name = "claude-opus-4-5",
      provider = "anthropic",
      model = "claude-opus-4-5",
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
      model = "claude-opus-4-5",
      authType = "max"
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
      model = "claude-opus-4-5"
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
  skillsPaths = {
    "~/.magenta/skills",
    "~/.claude/skills",
    ".magenta/skills",
    ".claude/skills"
  },
  commandConfig = {
    ls = { allowAll = true },
    pwd = { args = { {} } },
    echo = { allowAll = true },
    cat = { args = { { { file = true } } } },
    head = { args = { { "-n", { any = true } }, { { pattern = "-[0-9]+" } } } },
    tail = { args = { { "-n", { any = true } }, { { pattern = "-[0-9]+" } } } },
    wc = { args = { { { file = true } }, { "-l", { file = true } } } },
    git = {
      subCommands = {
        status = { allowAll = true },
        log = { allowAll = true },
        diff = { allowAll = true },
        show = { allowAll = true },
        add = { allowAll = true },
        commit = { allowAll = true },
        push = { allowAll = true },
        reset = { allowAll = true },
        restore = { allowAll = true },
        branch = { allowAll = true },
        checkout = { allowAll = true },
        switch = { allowAll = true },
        fetch = { allowAll = true },
        pull = { allowAll = true },
        merge = { allowAll = true },
        rebase = { allowAll = true },
        tag = { allowAll = true },
        stash = { allowAll = true },
      }
    },
    -- ripgrep for searching file contents
    rg = {
      args = {
        { { any = true } },                                                  -- rg "pattern"
        { { any = true }, { file = true } },                                 -- rg "pattern" <dir>
        { { any = true }, { restFiles = true } },                            -- rg "pattern" <file1> <file2> ...
        { "-l",           { any = true } },                                  -- rg -l "pattern"
        { "-l",           { any = true },      { file = true } },            -- rg -l "pattern" <dir>
        { { any = true }, { file = true },     "--type",        { any = true } }, -- rg "pattern" <dir> --type <ext>
        { "-l",           { any = true },      { file = true }, "--type",      { any = true } }, -- rg -l "pattern" <dir> --type <ext>
        { { any = true }, "--type",            { any = true } },             -- rg "pattern" --type <ext>
        { "-l",           { any = true },      "--type",        { any = true } }, -- rg -l "pattern" --type <ext>
        { "-l",           { any = true },      { file = true }, "--type",      { any = true } }, -- rg -l "pattern" <dir> --type <ext>
      }
    },
    -- fd for finding files by name (skips hidden/gitignored by default)
    fd = {
      args = {
        {},                                                                  -- fd (list all files)
        { { any = true } },                                                  -- fd "pattern"
        { { any = true }, { file = true } },                                 -- fd "pattern" <dir>
        { "-e",           { any = true } },                                  -- fd -e <ext>
        { "-e",           { any = true }, { file = true } },                 -- fd -e <ext> <dir>
        { "-t",           "f" },                                             -- fd -t f (files only)
        { "-t",           "d" },                                             -- fd -t d (dirs only)
        { "-t",           "f",            { any = true } },                  -- fd -t f "pattern"
        { "-t",           "d",            { any = true } },                  -- fd -t d "pattern"
        { "-t",           "f",            { any = true }, { file = true } }, -- fd -t f "pattern" <dir>
        { "-t",           "d",            { any = true }, { file = true } }, -- fd -t d "pattern" <dir>
      }
    },
  },
  maxConcurrentSubagents = 3,
  chimeVolume = 0.3,
  getFileAutoAllowGlobs = {
    "node_modules/**/*"
  },
  customCommands = {
    -- Example custom commands (commented out by default)
    -- {
    --   name = "@nedit",
    --   text = "DO NOT MAKE ANY EDITS TO CODE. Do not use any tools that allow you to edit code. Do not execute bash commands which edit code. NO EDITING WHATSOEVER OR ELSE.",
    --   description = "Disable all code editing functionality"
    -- },
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
