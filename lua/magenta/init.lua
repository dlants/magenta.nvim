local Utils = require("magenta.utils")
local Options = require("magenta.options")
local Timings = require("magenta.timings")
require("magenta.actions")
local M = {}

-- Tear down everything registered by `bridge`: autocmds, the :Magenta
-- user command, and the cached channel id. Idempotent — safe to call more
-- than once. Invoked when the node job exits or when we detect the channel
-- has gone invalid (e.g. rpcnotify throws "Invalid channel"), so that
-- orphaned autocmds/commands don't keep firing against a dead channel and
-- spamming errors (issue: BufEnter/WinClosed/:Magenta would otherwise
-- continue invoking rpcnotify against an invalid channel indefinitely).
-- Prints the debug recipe to :messages so that, when the bridge is torn
-- down unexpectedly (node process still alive but :Magenta gone), the
-- user has the commands handy to investigate next time.
local function log_teardown_debug_hint()
  vim.notify(table.concat({
    "magenta: bridge torn down. To debug:",
    "  :lua local m=require('magenta') print('channel_id='..tostring(m.channel_id), 'job_id='..tostring(m.job_id))",
    "  :lua print(vim.inspect(vim.fn.jobwait({require('magenta').job_id}, 0)))  -- -1 = node still running",
    "  :messages  -- look for the teardown reason + stack trace above",
    "To recover without restarting nvim:",
    "  :lua local m=require('magenta'); if m.job_id then pcall(vim.fn.jobstop, m.job_id) end; m.start(true)",
  }, "\n"), vim.log.levels.WARN)
end

-- `reason` describes who triggered the teardown. `expected` marks routine
-- teardowns (nvim exiting, re-registering a fresh bridge) that should not
-- emit the noisy debug hint. Unexpected teardowns (channel death/mismatch,
-- node crash) log a stack trace and the debug recipe.
M.teardown_bridge = function(reason, expected)
  local had_bridge = M.channel_id ~= nil or M.bridge_augroup ~= nil
  if M.bridge_augroup then
    pcall(vim.api.nvim_del_augroup_by_id, M.bridge_augroup)
    M.bridge_augroup = nil
  end
  pcall(vim.api.nvim_del_user_command, "Magenta")
  M.channel_id = nil

  if had_bridge and not expected then
    vim.notify(
      "magenta: tearing down bridge (reason: " .. tostring(reason or "unknown") .. ")\n"
        .. debug.traceback("", 2),
      vim.log.levels.WARN
    )
    log_teardown_debug_hint()
  end
end

-- Guarded rpcnotify: returns true on success, false if the channel is
-- missing/dead. On failure (e.g. the node process has exited but an
-- autocmd is still firing), tears down the bridge so we stop producing
-- noisy "Invalid channel" errors on every subsequent event.
-- True if the node job is still running (jobwait returns -1 for live jobs).
local function node_job_alive()
  if not M.job_id then
    return false
  end
  local ok, result = pcall(vim.fn.jobwait, { M.job_id }, 0)
  return ok and result[1] == -1
end

local function safe_rpcnotify(channel_id, method, ...)
  if not channel_id or M.channel_id ~= channel_id then
    M.teardown_bridge("channel mismatch in safe_rpcnotify (method=" .. tostring(method) .. ")")
    return false
  end
  local ok, err = pcall(vim.rpcnotify, channel_id, method, ...)
  if not ok then
    -- A single rpcnotify failure is not necessarily fatal: it can be raised
    -- from an unrelated context (e.g. an nvim-notify window-close handler
    -- firing during a transient error) while the node process is still alive
    -- and the bridge is otherwise healthy. Only tear down when the node job
    -- has actually exited; otherwise warn and keep the bridge so we don't
    -- kill a working session over a spurious "Invalid channel" error.
    if node_job_alive() then
      vim.notify(
        "magenta: rpcnotify failed but node job is alive; keeping bridge"
          .. " (method=" .. tostring(method) .. ", err=" .. tostring(err) .. ")",
        vim.log.levels.WARN
      )
      return false
    end
    M.teardown_bridge("rpcnotify failed (method=" .. tostring(method) .. ", err=" .. tostring(err) .. ")")
  end
  return ok
end

M.setup = function(opts)
  Timings.init()
  Timings.record("lua: setup start")

  Options.set_options(opts)

  M.start(true)
  Timings.record("lua: after M.start (node job spawned)")

  require("magenta.keymaps").default_keymaps()
  Timings.record("lua: setup complete (keymaps registered)")
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

  local env = vim.fn.environ()
  env.IS_DEV = "false"
  env.LOG_LEVEL = "info"
  env.MAGENTA_TIMINGS = vim.env.MAGENTA_TIMINGS
  if Timings.enabled then
    local start_ms = Timings.get_nvim_start_time_ms()
    if start_ms then
      env.MAGENTA_NVIM_START_TIME_MS = tostring(start_ms)
    end
  end

  if vim.env.MAGENTA_NODE_INSPECT then
    env.NODE_OPTIONS = "--inspect=" .. vim.env.MAGENTA_NODE_INSPECT
  end

  -- Invoke node directly (skipping `npm run`) to avoid npm's significant
  -- startup overhead.
  --
  -- Default: run the pre-built bundle at dist/magenta.mjs (a single file,
  -- so the OS only needs to open one file instead of thousands - this
  -- eliminates macOS scanner-gated startup stalls).
  --
  -- Dev mode: if MAGENTA_DEV=1, or if the bundle is missing, fall back to
  -- running the TypeScript source directly. --import loads boot.mjs
  -- before index.ts so we can capture a pre-TS-transform timestamp for
  -- the timing summary.
  local bundle_path = plugin_root .. "dist/magenta.mjs"
  local use_source = vim.env.MAGENTA_DEV == "1"
  if not use_source and vim.loop.fs_stat(bundle_path) == nil then
    vim.notify(
      "magenta: dist/magenta.mjs missing; falling back to source mode (did you run `npm run build`?)",
      vim.log.levels.WARN
    )
    use_source = true
  end

  local cmd
  if use_source then
    cmd = {
      "node",
      "--disable-warning=ExperimentalWarning",
      "--experimental-transform-types",
      "--import", plugin_root .. "node/boot.mjs",
      plugin_root .. "node/index.ts",
    }
  else
    cmd = { "node", bundle_path }
  end

  M.job_id =
      vim.fn.jobstart(
        cmd,
        {
          cwd = plugin_root,
          stdin = "null",
          on_exit = (function()
            local log_exit = Utils.log_exit(env.LOG_LEVEL)
            return function(job_id, exit_code, event)
              -- Clean up autocmds/user command bound to the now-dead
              -- channel so nvim stays usable after a node crash.
              M.teardown_bridge("node job exited (code=" .. tostring(exit_code) .. ")")
              if log_exit then
                log_exit(job_id, exit_code, event)
              end
            end
          end)(),
          on_stdout = Utils.log_job(env.LOG_LEVEL, false),
          on_stderr = Utils.log_job(env.LOG_LEVEL, true),
          env = env
        }
      )

  if M.job_id <= 0 then
    vim.api.nvim_err_writeln("Failed to start magenta server. Error code: " .. M.job_id)
    return
  end
end

local normal_commands = {
  "abort",
  "agent",
  "clear",
  "context-files",
  "paste",
  "profile",
  "toggle",
  "new-thread",
  "threads-overview",
}

local visual_commands = {
  "paste-selection",
}

M.bridge = function(channelId)
  Timings.record("lua: bridge called (node process connected)")

  -- If a previous node process was running, clear its autocmds and
  -- command before we register new ones with the fresh channel id.
  M.teardown_bridge("re-registering bridge", true)

  -- Store the channel ID for later use by other functions
  M.channel_id = channelId

  -- All autocmds registered here go into a named augroup so they can be
  -- cleared on node exit / channel death.
  M.bridge_augroup = vim.api.nvim_create_augroup("MagentaBridge", { clear = true })

  -- Initialize nvim-cmp completion support (no-op when nvim-cmp isn't installed)
  local completion_source = require('magenta.completion.source')
  if completion_source.setup then
    completion_source.setup()
  end

  -- Auto-register the blink.cmp source when blink.cmp is installed. The source's
  -- own `enabled()` gate keeps it scoped to magenta input buffers.
  local has_blink, blink = pcall(require, 'blink.cmp')
  if has_blink and type(blink.add_source_provider) == 'function' then
    pcall(function()
      blink.add_source_provider('magenta', {
        name = 'magenta',
        module = 'magenta.completion.blink',
      })
      blink.add_filetype_source('markdown', 'magenta')
    end)
  end

  vim.api.nvim_create_user_command(
    "Magenta",
    function(opts)
      if opts.args == "paste" then
        require("magenta.keymaps").do_paste()
        return
      end
      safe_rpcnotify(channelId, "magentaCommand", opts.args)
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

  -- Stop the node job early in nvim's shutdown so we're not waiting on
  -- the SIGTERM->SIGKILL timeout while nvim tries to exit. Combined with
  -- the SIGTERM handler in node/index.ts, this makes :qa near-instant.
  vim.api.nvim_create_autocmd(
    "VimLeavePre",
    {
      group = M.bridge_augroup,
      callback = function()
        if M.job_id then
          pcall(vim.fn.jobstop, M.job_id)
        end
        M.teardown_bridge("VimLeavePre", true)
      end
    }
  )

  vim.api.nvim_create_autocmd(
    "WinClosed",
    {
      group = M.bridge_augroup,
      pattern = "*",
      callback = function()
        safe_rpcnotify(channelId, "magentaWindowClosed", {})
      end
    }
  )

  vim.api.nvim_create_autocmd(
    "BufEnter",
    {
      group = M.bridge_augroup,
      pattern = "*",
      callback = function()
        local bufnr = vim.api.nvim_get_current_buf()
        local winid = vim.api.nvim_get_current_win()
        safe_rpcnotify(channelId, "magentaBufEnter", { bufnr = bufnr, winid = winid })
      end
    }
  )

  vim.api.nvim_create_autocmd(
    { "BufDelete", "BufWipeout" },
    {
      group = M.bridge_augroup,
      pattern = "*",
      callback = function(args)
        safe_rpcnotify(channelId, "magentaBufDelete", { bufnr = args.buf })
      end
    }
  )

  M.listenToBufKey = function(bufnr, vimKey, mode)
    mode = mode or "n"
    if mode == "v" or mode == "x" then
      -- Visual mode: capture the current visual selection (using marks set
      -- when visual mode exits via <Esc>) and forward as `selection` arg.
      vim.keymap.set(
        mode,
        vimKey,
        function()
          -- Exit visual mode so '< and '> marks are populated.
          local esc = vim.api.nvim_replace_termcodes("<Esc>", true, false, true)
          vim.api.nvim_feedkeys(esc, "x", false)

          local startPos = vim.fn.getpos("'<")
          local endPos = vim.fn.getpos("'>")
          local startRow = startPos[2] - 1
          local startCol = startPos[3] - 1
          local endRow = endPos[2] - 1
          local endCol = endPos[3]

          local lines = vim.api.nvim_buf_get_text(bufnr, startRow, startCol, endRow, endCol, {})
          safe_rpcnotify(channelId, "magentaKey", vimKey, { selection = lines })
        end,
        { buffer = bufnr, noremap = true, silent = true }
      )
    else
      vim.keymap.set(
        mode,
        vimKey,
        function()
          safe_rpcnotify(channelId, "magentaKey", vimKey)
        end,
        { buffer = bufnr, noremap = true, silent = true }
      )
    end
  end

  M.lsp_response = function(requestId, response)
    safe_rpcnotify(channelId, "magentaLspResponse", { requestId, response })
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

-- Called by the node process at the end of its startup sequence to report
-- accumulated timings. Merges with lua-side timings and prints a single
-- summary to :messages.
M.report_timings = function(entries)
  Timings.add_entries(entries)
  Timings.report()
end

return M
