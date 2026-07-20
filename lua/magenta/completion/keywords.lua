local M = {}

local constants = require('magenta.completion.constants')
local kinds = require('magenta.completion.kinds')

-- Keywords completion source
local source = {}

local BUILTIN_KEYWORDS = {
  { label = '@qf',          kind = kinds.Keyword, documentation = 'Add quickfix entries to context' },
  { label = '@diag',        kind = kinds.Keyword, documentation = 'Add diagnostics to context' },
  { label = '@buf',         kind = kinds.Keyword, documentation = 'Add current buffer to context' },
  { label = '@buffers',     kind = kinds.Keyword, documentation = 'Add all open buffers to context' },
  { label = '@quickfix',    kind = kinds.Keyword, documentation = 'Add quickfix entries to context' },
  { label = '@diagnostics', kind = kinds.Keyword, documentation = 'Add diagnostics to context' },
  { label = '@compact',       kind = kinds.Keyword, documentation = 'Compact the conversation thread and continue with a new prompt' },
  { label = '@implementplan', kind = kinds.Keyword, documentation = 'Instruct the agent to implement the current plan' },
  { label = '@fork',        kind = kinds.Keyword, documentation = 'Fork the thread' },
  { label = '@async',       kind = kinds.Keyword, documentation = 'Process message asynchronously without interrupting current operation' },
  { label = '@next',       kind = kinds.Keyword, documentation = 'Queue message to send when the agent next stops' },
  { label = '@file:',       kind = kinds.Keyword, documentation = 'Add file to context (supports fuzzy path completion)' },
  { label = '@staged:',     kind = kinds.Keyword, documentation = 'Add staged file to context (supports file completion)' },
  { label = '@diff:',       kind = kinds.Keyword, documentation = 'Add unstaged/untracked file to context (supports file completion)' },
}

local function get_all_keywords()
  local Options = require('magenta.options')
  local keywords = vim.deepcopy(BUILTIN_KEYWORDS)
  
  if Options.options.customCommands then
    for _, command in ipairs(Options.options.customCommands) do
      table.insert(keywords, {
        label = command.name,
        kind = kinds.Keyword,
        documentation = command.description or 'Custom command'
      })
    end
  end
  
  return keywords
end

function source:is_available()
  local bufnr = vim.api.nvim_get_current_buf()
  local buf_name = vim.api.nvim_buf_get_name(bufnr)
  return constants.is_magenta_input_buffer(buf_name)
end

function source:get_debug_name()
  return 'magenta_keywords'
end

function source:get_trigger_characters()
  return { '@' }
end

function source:get_keyword_pattern()
  return [[@\w*]]
end

function source:complete(params, callback)
  local cursor_before_line = params.context.cursor_before_line
  local filter_text = cursor_before_line:sub(params.offset)

  -- Only complete when user types standalone @ or @word (no colon)
  if not filter_text:match('^@%w*$') then
    callback({ items = {}, isIncomplete = false })
    return
  end

  local keywords = get_all_keywords()
  callback({
    items = vim.tbl_map(function(item)
      return vim.tbl_extend('force', item, {
        filterText = filter_text
      })
    end, keywords),
    isIncomplete = false
  })
end

function M.create_source()
  return source
end

return M
