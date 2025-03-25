local M = {}

local defaults = {
  provider = "anthropic",
  openai = {
    model = "gpt-4o"
  },
  anthropic = {
    model = "claude-3-7-sonnet-latest"
  },
  bedrock = {
    model = "anthropic.claude-3-5-sonnet-20241022-v2:0",
    prompt_caching = false
  },
  picker = "fzf-lua",
  sidebar_position = "left",
  default_keymaps = true,
  sidebar_keymaps = {
    normal = {
      ["<CR>"] = ":Magenta send<CR>",
    }
  },
  inline_keymaps = {
    normal = {
      ["<CR>"] = function(target_bufnr)
        vim.cmd("Magenta submit-inline-edit " .. target_bufnr)
      end,
    },
  },
  models = {
    openai = {
      { model = "gpt-4o" },
      { model = "o1" },
      { model = "o1-mini" },
    },
	anthropic = {
	  { model = "claude-3-7-sonnet-latest" },
	  { model = "claude-3-5-sonnet-latest" },
	},
	bedrock = {
	  { model = "anthropic.claude-3-5-sonnet-20241022-v2:0", prompt_caching = false },
	},
  },
}

M.options = defaults

M.set_options = function(opts)
  M.options = vim.tbl_deep_extend("force", defaults, opts or {})
  if (opts.picker == nil) then
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
end

M.get_model_strings = function()
	local result = {}
	local models = M.options.models or {}
	for provider, entries in pairs(models) do
		for _, entry in ipairs(entries) do
			if entry.model then
				table.insert(result, provider .. " " .. entry.model)
			end
		end
	end
	return result
end

return M
