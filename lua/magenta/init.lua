local Utils = require("magenta.utils")
local M = {}

M.defaults = {
  provider = "anthropic",
  openai = {
    model = "gpt-4o"
  },
  anthropic = {
    model = "claude-3-5-sonnet-20241022"
  },
  bedrock = {
    model = "anthropic.claude-3-5-sonnet-20241022-v2:0",
    promptCaching = false
  }
}

M.setup = function(opts)
  M.options = vim.tbl_deep_extend("force", M.defaults, opts or {})
  if (M.options.picker == nil) then
    local success, _ = pcall(require, "fzf-lua")
    if success then
      M.options.picker = "fzf-lua"
    else
      success, _ = pcall(require, "telescope")
      if success then
        M.options.picker = "telescope"
      end
    end
  end

  M.start(true)
  vim.api.nvim_set_keymap(
    "n",
    "<leader>mc",
    ":Magenta clear<CR>",
    {silent = true, noremap = true, desc = "Clear Magenta state"}
  )
  vim.api.nvim_set_keymap(
    "n",
    "<leader>ma",
    ":Magenta abort<CR>",
    {silent = true, noremap = true, desc = "Abort current Magenta operation"}
  )
  vim.api.nvim_set_keymap(
    "n",
    "<leader>mt",
    ":Magenta toggle<CR>",
    {silent = true, noremap = true, desc = "Toggle Magenta window"}
  )
  vim.api.nvim_set_keymap(
    "n",
    "<leader>mi",
    ":Magenta start-inline-edit<CR>",
    {silent = true, noremap = true, desc = "Inline edit"}
  )
  vim.api.nvim_set_keymap(
    "v",
    "<leader>mi",
    ":Magenta start-inline-edit-selection<CR>",
    {silent = true, noremap = true, desc = "Inline edit selection"}
  )
  vim.api.nvim_set_keymap(
    "v",
    "<leader>mp",
    ":Magenta paste-selection<CR>",
    {silent = true, noremap = true, desc = "Send selection to Magenta"}
  )
  vim.api.nvim_set_keymap(
    "n",
    "<leader>mb", -- like "magenta buffer"?
    "",
    {
      noremap = true,
      silent = true,
      desc = "Add current buffer to Magenta context",
      callback = function()
        local current_file = vim.fn.expand("%:p")
        vim.cmd("Magenta context-files " .. vim.fn.shellescape(current_file))
      end
    }
  )

  vim.api.nvim_set_keymap(
    "n",
    "<leader>mf",
    "",
    {
      noremap = true,
      silent = true,
      desc = "Select files to add to Magenta context",
      callback = function()
        if M.options.picker == "fzf-lua" then
          Utils.fzf_files()
        elseif M.options.picker == "telescope" then
          Utils.telescope_files()
        else
          vim.notify("Neither fzf-lua nor telescope are installed!", vim.log.levels.ERROR)
        end
      end
    }
  )

  vim.api.nvim_set_keymap(
    "n",
    "<leader>mp",
    "",
    {
      noremap = true,
      silent = true,
      desc = "Select provider and model",
      callback = function()
        local items = {
            'openai gpt-4o',
            'openai o1',
            'openai o1-mini',
            'anthropic claude-3-5-sonnet-latest'
        }
        vim.ui.select(items, { prompt = "Select Model", }, function (choice)
          if choice ~= nil then
            vim.cmd("Magenta provider " .. choice )
          end
        end)
      end
    }
  )

end

M.testSetup = function()
  -- do not start. The test runner will start the process for us.
  vim.api.nvim_set_keymap(
    "n",
    "<leader>m",
    ":Magenta toggle<CR>",
    {silent = true, noremap = true, desc = "Toggle Magenta window"}
  )
end

M.start = function(silent)
  if not silent then
    vim.notify("magenta: init", vim.log.levels.INFO)
  end

  local __filename = debug.getinfo(1, "S").source:sub(2)
  local plugin_root = vim.fn.fnamemodify(__filename, ":p:h:h:h") .. "/"

  local env = {
    IS_DEV = false,
    LOG_LEVEL = "debug"
  }

  local job_id =
    vim.fn.jobstart(
    "npm run start",
    {
      cwd = plugin_root,
      stdin = "null",
      on_exit = Utils.log_exit(env.LOG_LEVEL),
      on_stdout = Utils.log_job(env.LOG_LEVEL, false),
      on_stderr = Utils.log_job(env.LOG_LEVEL, true),
      env = env
    }
  )

  if job_id <= 0 then
    vim.api.nvim_err_writeln("Failed to start magenta server. Error code: " .. job_id)
    return
  end
end

M.bridge = function(channelId)
  vim.api.nvim_create_user_command(
    "Magenta",
    function(opts)
      vim.rpcnotify(channelId, "magentaCommand", opts.args)
    end,
    {
      nargs = "+",
      range = true,
      desc = "Execute Magenta command"
    }
  )

  vim.api.nvim_create_autocmd(
    "WinClosed",
    {
      pattern = "*",
      callback = function()
        vim.rpcnotify(channelId, "magentaWindowClosed", {})
      end
    }
  )

  M.listenToBufKey = function(bufnr, vimKey)
    vim.keymap.set(
      "n",
      vimKey,
      function()
        vim.rpcnotify(channelId, "magentaKey", vimKey)
      end,
      {buffer = bufnr, noremap = true, silent = true}
    )
  end

  M.lsp_response = function(requestId, response)
    vim.rpcnotify(channelId, "magentaLspResponse", {requestId, response})
  end

  return M.options
end

M.wait_for_lsp_attach = function(bufnr, capability, timeout_ms)
  -- Default timeout of 1000ms if not specified
  timeout_ms = timeout_ms or 1000

  return vim.wait(
    timeout_ms,
    function()
      local clients = vim.lsp.get_active_clients({bufnr = bufnr})
      for _, client in ipairs(clients) do
        if client.server_capabilities[capability] then
          return true
        end
      end
      return false
    end
  )
end

M.lsp_hover_request = function(requestId, bufnr, row, col)
  local success = M.wait_for_lsp_attach(bufnr, "hoverProvider", 1000)
  if not success then
    M.lsp_response(requestId, "Timeout waiting for LSP client with hoverProvider to attach")
    return
  end

  vim.lsp.buf_request_all(
    bufnr,
    "textDocument/hover",
    {
      textDocument = {
        uri = vim.uri_from_bufnr(bufnr)
      },
      position = {
        line = row,
        character = col
      }
    },
    function(responses)
      M.lsp_response(requestId, responses)
    end
  )
end

M.lsp_references_request = function(requestId, bufnr, row, col)
  local success = M.wait_for_lsp_attach(bufnr, "referencesProvider", 1000)
  if not success then
    M.lsp_response(requestId, "Timeout waiting for LSP client with referencesProvider to attach")
    return
  end

  vim.lsp.buf_request_all(
    bufnr,
    "textDocument/references",
    {
      textDocument = {
        uri = vim.uri_from_bufnr(bufnr)
      },
      position = {
        line = row,
        character = col
      },
      context = {
        includeDeclaration = true
      }
    },
    function(responses)
      M.lsp_response(requestId, responses)
    end
  )
end

return M
