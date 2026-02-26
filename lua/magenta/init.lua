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
  "clear",
  "context-files",
  "profile",
  "toggle",
  "new-thread",
  "threads-overview",
  "docker",
  "docker-stop",
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

  -- Helper function to check if a buffer is a real file
  local function is_real_file(file_path, bufnr, strict_mode)
    -- Basic path check
    if not file_path or file_path == "" then
      return false
    end

    -- Buffer validity check
    if not bufnr or not vim.api.nvim_buf_is_valid(bufnr) then
      return false
    end

    -- Check buffer type (must be empty for real files)
    if vim.bo[bufnr].buftype ~= "" then
      return false
    end

    -- For strict mode, perform additional checks
    if strict_mode then
      -- Check if buffer is listed
      if not vim.bo[bufnr].buflisted then
        return false
      end

      -- Check if file exists or has a filetype
      if vim.fn.filereadable(file_path) ~= 1 and vim.fn.getftype(file_path) == "" then
        return false
      end
    else
      -- For non-strict mode, just verify the path format
      if not (file_path:match("^%a:[\\/]") or file_path:match("^/")) then
        return false
      end
    end

    return true
  end

  -- Setup buffer event tracking
  vim.api.nvim_create_autocmd(
    "BufWritePost",
    {
      pattern = "*",
      callback = function()
        local file_path = vim.fn.expand("<afile>:p")
        local bufnrString = vim.fn.expand("<abuf>")
        local bufnr = tonumber(bufnrString)

        -- For write events, we need to verify readability
        if is_real_file(file_path, bufnr, true) and vim.fn.filereadable(file_path) == 1 then
          vim.rpcnotify(channelId, "magentaBufferTracker", "write", file_path, bufnr)
        end
      end
    }
  )

  vim.api.nvim_create_autocmd(
    "BufReadPost",
    {
      pattern = "*",
      callback = function()
        local file_path = vim.fn.expand("<afile>:p")
        local bufnrString = vim.fn.expand("<abuf>")
        local bufnr = tonumber(bufnrString)

        if is_real_file(file_path, bufnr, true) then
          vim.rpcnotify(channelId, "magentaBufferTracker", "read", file_path, bufnr)
        end
      end
    }
  )

  vim.api.nvim_create_autocmd(
    "BufDelete",
    {
      pattern = "*",
      callback = function()
        local file_path = vim.fn.expand("<afile>:p")
        local bufnrString = vim.fn.expand("<abuf>")
        local bufnr = tonumber(bufnrString)

        -- For delete events, we use less strict checks
        if is_real_file(file_path, bufnr, false) then
          vim.rpcnotify(channelId, "magentaBufferTracker", "close", file_path, bufnr)
        end
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
