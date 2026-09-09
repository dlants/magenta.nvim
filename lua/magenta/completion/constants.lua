-- Must match MAGENTA_INPUT_BUFFER_PREFIX in node/nvimclient/buffer-manager.ts
local M = {
  INPUT_BUFFER_PREFIX = 'Magenta Input',
}

function M.is_magenta_input_buffer(buf_name)
  return buf_name:find(M.INPUT_BUFFER_PREFIX, 1, true) ~= nil
end

-- Matches any magenta-managed buffer (input, display, threads, overview).
-- These should never be offered as @file: completion candidates.
function M.is_magenta_buffer(buf_name)
  return buf_name:find('[Magenta', 1, true) ~= nil
end

return M
