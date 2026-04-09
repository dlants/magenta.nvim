local Utils = require("magenta.utils")
local Options = require("magenta.options")
require("magenta.actions")
local M = {}

M.setup = function(opts)
  Options.set_options(opts)
  M.start(true)
  require("magenta.keymaps").default_keymaps()
end

M.testSetup = function()
  -- do not start. The test runner will start the process for us.
  vim.api.nvim_set_keymap(
    "n",
    "<leader>m",
    ":Magenta toggle<CR>",
    { silent = true, noremap = true, desc = "Toggle Magenta window" }
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
    LOG_LEVEL = "info",
    -- Forward X11 display for GUI applications (e.g., browser automation)
    DISPLAY = vim.env.DISPLAY,
    XAUTHORITY = vim.env.XAUTHORITY,
  }

  if vim.env.MAGENTA_NODE_INSPECT then
    env.NODE_OPTIONS = "--inspect=" .. vim.env.MAGENTA_NODE_INSPECT
  end

  local job_id =
      vim.fn.jobstart(
        "npm run start -s",
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

local normal_commands = {
  "abort",
  "agent",
  "clear",
  "context-files",
  "profile",
  "toggle",
  "new-thread",
  "threads-overview",
}

local visual_commands = {
  "paste-selection",
}

M.bridge = function(channelId)
  -- Store the channel ID for later use by other functions
  M.channel_id = channelId

  -- Initialize completion support
  local completion_source = require('magenta.completion.source')
  if completion_source.setup then
    completion_source.setup()
  end

  vim.api.nvim_create_user_command(
    "Magenta",
    function(opts)
      vim.rpcnotify(channelId, "magentaCommand", opts.args)
    end,
    {
      nargs = "+",
      range = true,
      desc = "Execute Magenta command",
      complete = function(ArgLead, CmdLine)
        local commands = CmdLine:match("^'<,'>") and visual_commands or normal_commands

        if ArgLead == '' then
          return commands
        end
        -- Filter based on ArgLead
        return vim.tbl_filter(function(cmd)
          return cmd:find('^' .. ArgLead)
        end, commands)
      end
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

  vim.api.nvim_create_autocmd(
    "FocusGained",
    {
      callback = function()
        vim.rpcnotify(channelId, "magentaFocusChanged", { focused = true })
      end
    }
  )

  vim.api.nvim_create_autocmd(
    "FocusLost",
    {
      callback = function()
        vim.rpcnotify(channelId, "magentaFocusChanged", { focused = false })
      end
    }
  )

  vim.api.nvim_create_autocmd(
    "BufEnter",
    {
      pattern = "*",
      callback = function()
        local bufnr = vim.api.nvim_get_current_buf()
        local winid = vim.api.nvim_get_current_win()
        vim.rpcnotify(channelId, "magentaBufEnter", { bufnr = bufnr, winid = winid })
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
      { buffer = bufnr, noremap = true, silent = true }
    )
  end

  M.lsp_response = function(requestId, response)
    vim.rpcnotify(channelId, "magentaLspResponse", { requestId, response })
  end

  local opts = Options.options

  if _G.magenta_test_options then
    for k, v in pairs(_G.magenta_test_options) do
      opts[k] = v
    end
  end

  -- Filter out functions for RPC serialization
  local function serialize_table(tbl)
    local result = {}
    for k, v in pairs(tbl) do
      if type(v) == "table" then
        result[k] = serialize_table(v)
      elseif type(v) ~= "function" then
        result[k] = v
      end
    end
    return result
  end

  return serialize_table(opts)
end

M.wait_for_lsp_attach = function(bufnr, capability, timeout_ms)
  -- Default timeout of 1000ms if not specified
  timeout_ms = timeout_ms or 1000

  return vim.wait(
    timeout_ms,
    function()
      local clients = vim.lsp.get_clients({ bufnr = bufnr })
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

M.lsp_definition_request = function(requestId, bufnr, row, col)
  local success = M.wait_for_lsp_attach(bufnr, "definitionProvider", 1000)
  if not success then
    M.lsp_response(requestId, "Timeout waiting for LSP client with definitionProvider to attach")
    return
  end

  vim.lsp.buf_request_all(
    bufnr,
    "textDocument/definition",
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

M.lsp_type_definition_request = function(requestId, bufnr, row, col)
  local success = M.wait_for_lsp_attach(bufnr, "typeDefinitionProvider", 1000)
  if not success then
    M.lsp_response(requestId, "Timeout waiting for LSP client with typeDefinitionProvider to attach")
    return
  end

  vim.lsp.buf_request_all(
    bufnr,
    "textDocument/typeDefinition",
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

return M
