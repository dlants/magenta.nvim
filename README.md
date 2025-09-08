# magenta.nvim

```
  ___ ___
/' __` __`\
/\ \/\ \/\ \
\ \_\ \_\ \_\
 \/_/\/_/\/_/
 magenta is for agentic flow
```

magenta seeks to provide transparent tools to empower ai workflows in neovim. It allows one to fluidly shift control between the developer and the AI, from targeted context-powered inline edits to ai automation and agent-led feature planning and development.

Developed by [dlants.me](https://dlants.me): I was tempted by other editors due to lack of high-quality agentic coding support in neovim. I missed neovim a lot, though, so I decided to go back and implement my own. I now happily code in neovim using magenta, and find that it's just as good as cursor, windsurf, ampcode & claude code.

I sometimes write about AI, neovim and magenta specifically:

- [AI whiplash, and neovim in the age of AI](https://dlants.me/ai-whiplash.html)
- [AI is not mid](https://dlants.me/ai-mid.html)

(Note - I mostly develop using the Anthropic provider, so claude sonnet 3.7 or 4 are recommended. The OpenAI provider is supported, however may be less stable since I am not using it day to day. Please report any issues you encounter. Contributions are also welcome.)

![next-edit-prediction July 2025](https://github.com/user-attachments/assets/2bebf6bb-9552-4396-94ce-f3f694b7265d)

![completion commands (July 2025)](https://github.com/user-attachments/assets/70eb1ddc-a592-47cb-a803-19414829c5d2)

[![June 2025 demo](https://img.youtube.com/vi/W_YctNT20NQ/0.jpg)](https://www.youtube.com/watch?v=W_YctNT20NQ)

# Roadmap

- gemini 2.5 pro provider
- local code embedding & indexing via chroma db, to support a semantic code search tool

# Updates

## August 2025

**PDF updates** - Large PDFs are too big to put into the agent in binary format. I initially worked around this by converting pdfs into text, however I was finding that quite limited as it caused a lot of relevant info - diagrams, images and typeset math - to be lost or risk corruption in the translation process. One of the ways that I use magenta is as a research/writing assistant, so this wasn't really working for me. So I updated the getFile tool to read PDFs one page at a time. When the file is added, we just get a summary of how many pages there are. When the agent reads a page, that page is sent to the agent in binary format.

**Claude Max Authentication** - Added full support for Anthropic's Claude Max OAuth2 authentication flow. You can now use your Anthropic account directly without needing an API key. Set `authType = "max"` in your profile configuration and Magenta will automatically handle the OAuth flow, including opening your browser for authentication and securely storing refresh tokens. This enables access to Claude models through your Anthropic account subscription rather than pay-per-token API usage. (h/t [opencode](https://github.com/sst/opencode) who actually reverse engineered the claude code API to make this possible)

**Configurable Chime Volume** - Added support for controlling the volume of notification chimes that play when the agent needs your attention. You can now set `chimeVolume` in your configuration (range: 0.0 to 1.0) to customize or disable the chime entirely. The chime plays when agents finish work requiring user input or when tool usage needs approval.

I improved the turn-taking behavior. Sending a message to the agent while it's streaming will now automatically abort the current request. You can also prepend your message with `@async` to enqueue the message. The message will be sent to the agent on the next opportunity (either with the next tool autoresponse, or when the agent ends its turn). I also fixed a bunch of edge cases around aborting messages.

I reworked `@compact` into `@fork`. Instead of a forced tool use, fork is now just like any other tool. Using @fork just sends a nice message with some extra instructions to the agent, which then uses fork_thread like any other tool. There are a few advantages of this:

- first, and most important, this allows for the reuse of the thread cache when forking. Since the fork tool is there from the beginning, we are not changing the prefix of the thread at all when requesting a fork (like we did with forceTooluse)
- the agent can now think before requesting the fork, which can result in better decisions about which files to include and a better summary
- the instructions for how to fork now appear at the end of the thread, which makes them more relevant and easier to follow than putting them into the tool declaration

## July 2025

**next edit prediction** - suggests the most likely next edit based on your recent changes and cursor context. Press `<S-C-l>` (Shift+Ctrl+L) in both insert and normal mode to trigger a prediction, and `<S-C-l>` again to accept it. Predictions appear as virtual text with strikethrough for removed text and highlighting for added text. Exit insert mode, or press `<Esc>` in normal mode to dismiss predictions. This feature adapts to your editing patterns and is perfect for completing repetitive edits.

**input buffer completion** - we now support @-command completion in the input buffer using nvim-cmp. We also have new @file:, @diff: and @staged: commands, which use fuzzy-find to autocomplete paths within your repo.

**thinking & reasoning support** - Added full support for Anthropic's thinking blocks and OpenAI's reasoning capabilities. Claude 3.7, Sonnet 4, and Opus 4 can now use extended thinking to show their step-by-step reasoning process before delivering answers.

**remote mcp support** - we now support streamable http transport, with fallback to sse transport for mcp. This means that mcphub now works via the /mcp endpoint (no lua integration yet).

**improved styling** - I was using markdown for the display buffer for a while, but it was unreliable (due to agent-generated code and file contents interfering with makrdown boundaries), and started crashing with the latest markdown grammar. So I added an extmark-based system for highlighting the display buffer instead. This means more consistent colors, and more control (like coloring the diffs of the replace & insert tools). This is all done via nvim's hl_groups so it should automatically be compatible with your colorscheme. I also made a small quality-of-life improvement that allows you to open search results and citations in the browser by pressing "Enter" over them.

**fast models** - Each profile now supports both a primary model and a fast model. The fast model is automatically used for lightweight tasks like generating thread titles, providing snappier UI interactions while reserving the primary model for substantive coding work. (defaults to haiku for anthropic).

**@fast modifier** for inline edits - Prefix your inline edit prompts with `@fast` to use the fast model instead of the primary model, perfect for simple refactoring tasks that don't require the full power of your main model.

**inline edit replay** functionality with `<leader>m.` - You can now quickly re-apply your last inline edit prompt to the current buffer or selection. Combined with @fast, this gives you a nice dot-repeat pattern for inline edits.

**enhanced input commands** - New `@diag`/`@diagnostics`, `@buf`/`@buffers`, and `@qf`/`@quickfix` commands add current LSP diagnostics, buffer lists, and quickfix entries in your prompts, making it easier to work with current editor state.

**spawn_foreach tool** - enables spawning multiple sub-agents in parallel to process arrays of elements, dramatically speeding up bulk operations like updating multiple files or fixing multiple locations. Combined with the existing `find_references` tool, and the new `@qf` command, this enables doing quick refactors across the codebase.

**fast agent type** - All sub-agent tools now support a "fast" agent type that uses the fast model (like Haiku) for quick transformations that don't require the full capabilities of the primary model. Perfect for simple refactoring tasks, batch operations, and lightweight processing.

**major stability improvements** - Fixed critical issues with buffer operations and file tools that were causing occasional misfires. The plugin now properly handles unloaded buffers and prevents spurious errors when buffers get unloaded. Additionally, improved buffer naming to prevent conflicts when creating scratch buffers. These changes make the plugin significantly more robust and reliable.

**test performance improvements** - Tests now run in parallel, significantly reducing test suite execution time and improving the developer experience.

**cache improvements** - Taking advantage of new anthropic [cache mechanisms](https://www.anthropic.com/news/token-saving-updates) for better performance and lower costs.

<details>
<summary>Previous updates</summary>

## June 2025

I implemented **sub-agents** - a powerful feature that allows the main agent to delegate specific tasks to specialized sub-agents. Sub-agents can work in parallel and have their own specialized system prompts for tasks like learning codebases, planning implementations, or performing focused work. This enables complex workflows where multiple agents collaborate on different aspects of a problem.

I added support for images and pdfs. Magenta can now read these using the get_file tool for image-compatible openai and anthropic models.

I added support for the copilot provider.

## May 2025

I implemented thread compaction that intelligently analyzes your next prompt and extracts only the relevant parts of the conversation history. This makes it easier to continue long conversations without hitting context limits while ensuring all important information is preserved. I also updated the magenta header to give you an estimate of the token count for your current conversation.

I updated the architecture around context following. We now track the state of the file on disk, and the buffer, as well as the current view that the agent has of the file. When these diverge, we send just the diff of the changes to the agent. This allows for better use of the cache, and more efficient communication since we do not have to re-send the full file contents when a small thing changes.

I updated the architecture around streaming, so we now process partial tool calls, which means we can preview Insert and Replace commands gradually as they stream in. This makes the tool feel a lot more responsive. I also added support for anthropic web search and citations!

I made a significant architectural shift in how magenta.nvim handles edits. Instead of merely proposing changes that require user confirmation, the agent can now directly apply edits to files with automatic snapshots for safety. Combined with the recent PR that implemented robust bash command execution, this creates a powerful iteration loop capability: agents can now modify files, run tests through bash, analyze results, and make further changes - all without user intervention.

## Jan 2025

[![video of Jan 2025 update](https://img.youtube.com/vi/BPnUO_ghMJQ/0.jpg)](https://www.youtube.com/watch?v=BPnUO_ghMJQ)

- inline mode
- context management
- prompt caching
- port to node

## Dec 2024

[![video demo of the plugin](https://img.youtube.com/vi/i4YYvZwCMxM/0.jpg)](https://www.youtube.com/watch?v=i4YYvZwCMxM)

- chat window
- tools
- context pinning
- architecture overview
</details>

# Installation

Make sure you have [node](https://nodejs.org/en/download) installed, at least `v20`:

```
node --version
```

The plugin uses profiles to configure provider access. Each profile specifies:

- name: identifier for the profile
- provider: "anthropic", "openai", "bedrock".
- model: the specific model to use.
- authType: (optional) authentication type - "key" (default) or "max" for Anthropic OAuth
- apiKeyEnvVar: environment variable containing the API key (not needed for authType = "max")
- baseUrl: (optional) custom API endpoint

## Prerequisites

Magenta includes smart completions for input commands that depend on [nvim-cmp](https://github.com/hrsh7th/nvim-cmp). Make sure you have nvim-cmp installed and configured in your setup.

### Recommended Tools

For optimal file discovery and completions that respect `.gitignore` files, install one of these tools:

- **fd** ([sharkdp/fd](https://github.com/sharkdp/fd)) - Fast alternative to `find`

  ```bash
  # macOS
  brew install fd
  # Ubuntu/Debian
  sudo apt install fd-find
  # Arch Linux
  sudo pacman -S fd
  ```

- **ripgrep** ([BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep)) - Fast text search tool
  ```bash
  # macOS
  brew install ripgrep
  # Ubuntu/Debian
  sudo apt install ripgrep
  # Arch Linux
  sudo pacman -S ripgrep
  ```

Without these tools, Magenta falls back to using `find`, which doesn't respect `.gitignore` files and may include unwanted files in completions.

## Using lazy.nvim

```lua
{
    "dlants/magenta.nvim",
    lazy = false, -- you could also bind to <leader>mt
    build = "npm install --frozen-lockfile",
    opts = {},
},
```

## Using vim-plug

```lua
local vim = vim
local Plug = vim.fn['plug#']

vim.call('plug#begin')
Plug('dlants/magenta.nvim', {
  ['do'] = 'npm install --frozen-lockfile',
})
vim.call('plug#end')

require('magenta').setup({})
```

# Config

<details>
<summary>Example options</summary>

```lua
require('magenta').setup({
  profiles = {
  {
    name = "claude-4",
    provider = "anthropic",
    model = "claude-4-sonnet-latest",
    fastModel = "claude-3-5-haiku-latest", -- optional, defaults provided
    apiKeyEnvVar = "ANTHROPIC_API_KEY",
    thinking = {
      enabled = true,
      budgetTokens = 1024 -- optional, defaults to 1024, must be >= 1024
    }
  },
  {
    name = "claude-max",
    provider = "anthropic",
    model = "claude-3-7-sonnet-latest",
    fastModel = "claude-3-5-haiku-latest",
    authType = "max" -- Use Anthropic OAuth instead of API key
    -- No apiKeyEnvVar needed for max auth
  },
  {
    name = "gpt-5",
    provider = "openai",
    model = "gpt-5",
    fastModel = "gpt-5-mini",
    apiKeyEnvVar = "OPENAI_API_KEY"
  },
  {
    name = "copilot-claude",
    provider = "copilot",
    model = "claude-3.7-sonnet",
    fastModel = "claude-3-5-haiku-latest", -- optional, defaults provided
    -- No apiKeyEnvVar needed - uses existing Copilot authentication
  },
  -- open chat sidebar on left or right side
  sidebarPosition = "left",
  -- can be changed to "telescope" or "snacks"
  picker = "fzf-lua",
  -- enable default keymaps shown below
  defaultKeymaps = true,
  -- maximum number of sub-agents that can run concurrently (default: 3)
  maxConcurrentSubagents = 3,
  -- volume for notification chimes (range: 0.0 to 1.0, default: 0.3)
  -- set to 0.0 to disable chimes entirely
  chimeVolume = 0.3,
  -- glob patterns for files that should be auto-approved for getFile tool
  -- (bypasses user approval for hidden/gitignored files matching these patterns)
  getFileAutoAllowGlobs = { "node_modules/*" }, -- default includes node_modules
  -- keymaps for the sidebar input buffer
  sidebarKeymaps = {
    normal = {
      ["<CR>"] = ":Magenta send<CR>",
    }
  },
  -- keymaps for the inline edit input buffer
  -- if keymap is set to function, it accepts a target_bufnr param
  inlineKeymaps =  {
    normal = {
      ["<CR>"] = function(target_bufnr)
        vim.cmd("Magenta submit-inline-edit " .. target_bufnr)
      end,
    },
  },
  -- configure edit prediction options
  editPrediction = {
    -- Use a dedicated profile for predictions (optional)
    -- If not specified, uses the current active profile's model
    profile = {
      provider = "anthropic",
      model = "claude-3-5-haiku-latest",
      apiKeyEnvVar = "ANTHROPIC_API_KEY"
    },
    -- Maximum number of changes to track for context (default: 10)
    changeTrackerMaxChanges = 20,
    -- Token budget for including recent changes (default: 1000)
    recentChangeTokenBudget = 1500,
    -- Customize the system prompt (optional)
    -- systemPrompt = "Your custom prediction system prompt here...",
    -- Add instructions to the default system prompt (optional)
    systemPromptAppend = "Focus on completing function calls and variable declarations."
  },
  -- configure MCP servers for external tool integrations
  mcpServers = {
    fetch = {
      command = "uvx",
      args = { "mcp-server-fetch" }
    },
    playwright = {
      command = "npx",
      args = {
        "@playwright/mcp@latest"
      }
    },
    -- HTTP-based MCP server example
    httpServer = {
      url = "http://localhost:8000/mcp",
      requestInit = {
        headers = {
          Authorization = "Bearer your-token-here",
        },
      },
    }
  }
})
```

</details>

## Profiles

The first profile in your `profiles` list is used as the default when the plugin starts. You can switch between profiles using `:Magenta pick-provider` (bound to `<leader>mp` by default).

Each profile supports both a primary model and a fast model. If not specified, sensible defaults are provided for each provider. The fast model is automatically used for lightweight tasks like generating thread titles and can be explicitly requested for inline edits using the `@fast` modifier.

### Thinking & Reasoning

Profiles can optionally enable thinking/reasoning capabilities for supported models:

**Anthropic thinking models:**

- Claude 3.7 Sonnet (`claude-3-7-sonnet-*`) - returns full thinking content
- Claude 4 Sonnet (`claude-4-sonnet-*`) - returns summarized thinking (billed for full tokens)
- Claude 4 Opus (`claude-4-opus-*`) - returns summarized thinking (billed for full tokens)

**OpenAI reasoning models:**

- o1 series models (`o1`, `o1-mini`, `o1-pro`) - show reasoning traces when available
- o3 series models (`o3`, `o3-mini`, `o3-pro`) - show reasoning traces when available
- o4 series models (`o4-mini`) - show reasoning traces when available
- o5 series models (`gpt-5`, `gpt-5-mini`, `gpt-5-nano`) - show reasoning traces when available

When thinking/reasoning is enabled:

- The model shows step-by-step reasoning process before delivering answers
- Thinking blocks are expandable/collapsible in the display buffer
- Input buffer title shows "thinking" status when enabled for Anthropic models
- For Anthropic: `budgetTokens` controls how many tokens the model can use for thinking (minimum 1024)
- For OpenAI: `effort` controls reasoning depth ("low", "medium", "high") and `summary` controls detail level ("auto", "concise", "detailed")

For example, you can set up multiple profiles for different providers or API endpoints:

```lua
profiles = {
  {
    name = "claude-3-7",
    provider = "anthropic",
    model = "claude-3-7-sonnet-latest",
    fastModel = "claude-3-5-haiku-latest", -- optional, defaults provided
    apiKeyEnvVar = "ANTHROPIC_API_KEY"
  },
  {
    name = "custom",
    provider = "anthropic",
    model = "claude-3-7-sonnet-latest",
    fastModel = "claude-3-5-haiku-latest",
    apiKeyEnvVar = "CUSTOM_API_KEY_ENV_VAR",
    baseUrl = "custom anthropic endpoint"
  }
}
```

Currently supported providers are `openai`, `anthropic`, `bedrock`, `ollama`, and `copilot`. The `model` parameter must be compatible with the SDK used for each provider:

- For `anthropic`: [Anthropic Node SDK](https://github.com/anthropics/anthropic-sdk-typescript) - supports models like `claude-3-7-sonnet-latest`, `claude-3-5-sonnet-20240620`
- For `openai`: [OpenAI Node SDK](https://github.com/openai/openai-node) - supports models like `gpt-5`, `gpt-5-mini`, `o1`
- For `bedrock`: [AWS SDK for Bedrock Runtime](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/clients/client-bedrock-runtime/) - supports models like `anthropic.claude-3-5-sonnet-20241022-v2:0`
- For `ollama`: [Ollama Node SDK](https://github.com/ollama/ollama-js) - supports models like `qwen3:14b` which have been insalled locally. ([Ollama models](https://ollama.com/search))
- For `copilot`: Uses GitHub Copilot authentication - No API key required, uses your existing Copilot subscription. See the [aider docs](https://aider.chat/docs/llms/github.html#discover-available-models) for how to discover available models.

Any provider that has a node SDK and supports tool use should be easy to add. Contributions are welcome.

## GitHub Copilot Provider

The Copilot provider leverages your existing GitHub Copilot subscription and doesn't require a separate API key. It automatically discovers your Copilot authentication from standard locations:

- `~/.config/github-copilot/hosts.json`
- `~/.config/github-copilot/apps.json`

**Prerequisites:**

- Active GitHub Copilot subscription
- GitHub Copilot CLI or VS Code extension installed and authenticated

**Setup:**

```lua
{
  name = "copilot",
  provider = "copilot",
  model = "claude-3.7-sonnet"  -- or "gpt-5"
}
```

The provider handles token refresh automatically and integrates with GitHub's Copilot API endpoints.

**NOTE:**

Copilot does this awkward thing where it gives you access to claude, but only through the openai chat completions api. As such they're really behind the ball on features. So for example, web_search for claude does not work [issue](https://github.com/microsoft/vscode-copilot-release/issues/6755). As such, I would not recommend it, though it is cheaper than paying for claude tokens directly.

## Claude Max Authentication

The Anthropic provider supports two authentication methods:

1. **API Key** (`authType = "key"` or omitted) - Uses your Anthropic API key for pay-per-token usage
2. **Claude Max** (`authType = "max"`) - Uses OAuth to connect with your Anthropic account subscription

**Claude Max Setup:**

```lua
{
  name = "claude-max",
  provider = "anthropic",
  model = "claude-3-7-sonnet-latest",
  authType = "max"
  -- No apiKeyEnvVar needed
}
```

**How Claude Max works:**

- On first use, Magenta automatically opens your browser to Anthropic's OAuth page
- After granting permission, you'll copy an authorization code back to Magenta
- Tokens are securely stored in `~/.local/share/magenta/auth.json` with 0600 permissions
- Refresh tokens are automatically managed - no manual re-authentication needed
- Access tokens are automatically refreshed when they expire

This allows you to use Claude models through your Anthropic account subscription rather than pay-per-token API usage, potentially offering cost savings for heavy users.

## Command allowlist

Magenta includes a security feature for the bash_command tool that requires user approval before running shell commands. To improve the workflow, you can configure a list of regex patterns that define which commands are pre-approved to run without confirmation.

The `commandAllowlist` option takes an array of regex patterns. When the LLM tries to execute a shell command, it's checked against these patterns. If any pattern matches, the command runs without approval. Otherwise, you'll be prompted to allow or deny it.

Regex patterns should be carefully designed to avoid security risks. You can find the default allowlist patterns in [lua/magenta/options.lua](lua/magenta/options.lua).

## Project-specific options

You can create project-specific configuration by adding a `.magenta/options.json` file to your project root. This allows you to customize Magenta settings per project while keeping your global configuration unchanged.

The plugin will automatically discover and load project settings by searching for `.magenta/options.json` starting from the current working directory and walking up the directory tree.

Common use cases include:

- Using different AI providers or API keys for work vs personal projects
- Adding project-specific commands to the allowlist (e.g., `make`, `cargo`, `npm` commands)
- Automatically including important project files in context (README, docs, config files)
- Customizing sidebar position or other UI preferences per project
- Configuring MCP servers for project-specific integrations (databases, services, etc.)

### Configuration precedence

The merging works as follows:

- **Profiles**: Project profiles completely replace global profiles if present
- **Command allowlist**: Project patterns are added to (not replace) the base allowlist
- **Auto context**: Project patterns are added to (not replace) the base auto context
- **MCP servers**: Project MCP servers are merged with global servers (project servers override global ones with the same name)
- **Other settings**: Project settings override global settings (like `sidebarPosition`)

### Example project settings

Create `.magenta/options.json` in your project root:

```json
{
  "profiles": [
    {
      "name": "project-claude",
      "provider": "anthropic",
      "model": "claude-3-7-sonnet-latest",
      "apiKeyEnvVar": "PROJECT_ANTHROPIC_KEY"
    }
  ],
  "commandAllowlist": [
    "^make( [^;&|()<>]*)?$",
    "^cargo (build|test|run)( [^;&|()<>]*)?$"
  ],
  "autoContext": ["README.md", "docs/*.md"],
  "maxConcurrentSubagents": 5,
  "mcpServers": {
    "postgres": {
      "command": "mcp-server-postgres",
      "args": ["--connection-string", "postgresql://localhost/mydb"],
      "env": {
        "DATABASE_URL": "postgresql://localhost/mydb"
      }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "httpServer": {
      "url": "http://localhost:8000/mcp",
      "requestInit": {
        "headers": {
          "Authorization": "Bearer your-token-here"
        }
      }
    }
  }
}
```

The project settings file supports all the same options as the global configuration, just in JSON format instead of Lua.

## Edit Prediction

Magenta includes an AI-powered edit prediction feature that can suggest the most likely next edit you'll make based on your recent changes and cursor context.

- Use `<S-C-l>` (Shift+Ctrl+L) in both insert and normal mode to trigger a prediction at your cursor position
- When a prediction is shown:
  - Press `<S-C-l>` again to accept and apply the prediction
  - Press `<Esc>` to dismiss the prediction

### Edit Prediction Configuration

You can customize the edit prediction feature using the `editPrediction` options:

```lua
editPrediction = {
  -- Use a dedicated profile for predictions (independent of main profiles)
  profile = {
    provider = "anthropic",
    model = "claude-4-sonnet-latest",
    apiKeyEnvVar = "ANTHROPIC_API_KEY",
    -- baseUrl = "custom-endpoint", -- optional
  },

  -- Maximum number of changes to track for context (default: 10)
  changeTrackerMaxChanges = 20,

  -- Token budget for including recent changes (default: 1000)
  -- Higher values include more history but use more tokens
  recentChangeTokenBudget = 1500,

  -- Replace the default system prompt entirely
  -- systemPrompt = "Your custom prediction system prompt here...",

  -- Append to the default system prompt instead of replacing it
  systemPromptAppend = "Additional instructions to improve predictions..."
}
```

**Note**: Initially, I thought about using the fastModel as the default for completions, like claude's haiku model.
Unfortunately, I wasn't able to get reliably good results for it. Bigger models like sonnet 4 are slower (though still
taking under a second for me), but the UI has good feedback, and the completion results are much much better, so the
tradeoff makes sense - especially since we are working with user-triggered completions.

I think hooking up a model specifically designed for completion, like supermaven or zeta, would be a lot nicer. If you
want, try it out and let us know in the discussion area.

## Chime Volume

Magenta plays notification chimes to alert you when the agent needs your attention, such as when it finishes work requiring user input or when tool usage needs approval.

You can configure the chime volume using the `chimeVolume` option:

```lua
require('magenta').setup({
  chimeVolume = 0.2, -- 20% volume (range: 0.0 to 1.0)
  -- ... other options
})
```

**Volume settings:**

- `0.0` - Disables chimes entirely (silent)
- `0.3` - Default volume (30%)
- `1.0` - Full system volume

**When chimes play:**

- Agent stops with `end_turn` (waiting for your response)
- Agent is blocked on a tool that requires user approval
- Any tool execution that needs user interaction

The chime volume can also be set per-project in `.magenta/options.json` files to customize notifications for different workflows.

## Keymaps

If `default_keymaps` is set to true, the plugin will configure the following global keymaps:

<details>
<summary>Default keymaps</summary>

```lua
local Actions = require("magenta.actions")

-- Chat and thread management
vim.keymap.set(
  "n",
  "<leader>mn",
  ":Magenta new-thread<CR>",
  {silent = true, noremap = true, desc = "Create new Magenta thread"}
)

vim.keymap.set(
  "n",
  "<leader>mc",
  ":Magenta clear<CR>",
  {silent = true, noremap = true, desc = "Clear Magenta state"}
)

vim.keymap.set(
  "n",
  "<leader>ma",
  ":Magenta abort<CR>",
  {silent = true, noremap = true, desc = "Abort current Magenta operation"}
)

vim.keymap.set(
  "n",
  "<leader>mt",
  ":Magenta toggle<CR>",
  {silent = true, noremap = true, desc = "Toggle Magenta window"}
)

-- Context management
vim.keymap.set(
  "n",
  "<leader>mb", -- like "magenta buffer"?
  Actions.add_buffer_to_context,
  { noremap = true, silent = true, desc = "Add current buffer to Magenta context" }
)

vim.keymap.set(
  "n",
  "<leader>mf",
  Actions.pick_context_files,
  { noremap = true, silent = true, desc = "Select files to add to Magenta context" }
)

vim.keymap.set(
  "v",
  "<leader>mp",
  ":Magenta paste-selection<CR>",
  {silent = true, noremap = true, desc = "Send selection to Magenta"}
)

-- Inline edit
vim.keymap.set(
  "n",
  "<leader>mi",
  ":Magenta start-inline-edit<CR>",
  {silent = true, noremap = true, desc = "Inline edit"}
)

vim.keymap.set(
  "v",
  "<leader>mi",
  ":Magenta start-inline-edit-selection<CR>",
  {silent = true, noremap = true, desc = "Inline edit selection"}
)

vim.keymap.set(
  "n",
  "<leader>mr",
  ":Magenta replay-inline-edit<CR>",
  {silent = true, noremap = true, desc = "Replay last inline edit"}
)

vim.keymap.set(
  "v",
  "<leader>mr",
  ":Magenta replay-inline-edit-selection<CR>",
  {silent = true, noremap = true, desc = "Replay last inline edit on selection"}
)

vim.keymap.set(
  "n",
  "<leader>m.",
  ":Magenta replay-inline-edit<CR>",
  {silent = true, noremap = true, desc = "Replay last inline edit"}
)

vim.keymap.set(
  "v",
  "<leader>m.",
  ":Magenta replay-inline-edit-selection<CR>",
  {silent = true, noremap = true, desc = "Replay last inline edit on selection"}
)

-- Provider selection
vim.keymap.set(
  "n",
  "<leader>mp",
  Actions.pick_provider,
  { noremap = true, silent = true, desc = "Select provider and model" }
)

-- Edit prediction
vim.keymap.set(
  "i",
  "<S-C-l>",
  "<Cmd>Magenta predict-edit<CR>",
  {silent = true, noremap = true, desc = "Predict/accept edit"}
)

vim.keymap.set(
  "n",
  "<S-C-l>",
  "<Cmd>Magenta predict-edit<CR>",
  {silent = true, noremap = true, desc = "Predict/accept edit"}
)
```

</details>

<details>
<summary>Set up fzf-lua as your selector</summary>

In order to use fzf-lua as your selector for certain commands, like `<leader>mp` for `:Magenta provider`, you should
set it as the default selector for neovim, by running `register_ui_select` at some point during initialization.

```lua
  {
    "ibhagwan/fzf-lua",
    lazy = false,
    config = function()
      require("fzf-lua").setup({
       -- ...
      })
      require("fzf-lua").register_ui_select()
    end,
  -- ...
    }
```

</details>

# Usage

### Chat

- `<leader>mt` is for `:Magenta toggle`. This will open a sidebar where you can chat with the model. You can add files to the context with `Magenta context-files` (`<leader>mf`), or paste your current visual selection with `Magenta paste-selection` (`<leader>mp`)

### Multi-threading

Magenta now supports multiple concurrent chat threads:

- `<leader>mn` is for `:Magenta new-thread`. This creates a new independent chat thread.
- When in the display buffer, press `-` to view the thread overview screen.
- Current active thread is highlighted with `*` in the thread list.
- Press `Enter` on any thread in the overview to make it active.

### Sub-agents

The LLM agent can now spawn specialized sub-agents to handle independent tasks more effectively. This allows the main agent to:

- **Focus context**: Each sub-agent gets only the files and context relevant to its specific task
- **Manage complexity**: Break down complex requests into focused, manageable subtasks
- **Work in parallel**: Multiple sub-agents can run simultaneously on different aspects of a problem
- **Specialize behavior**: Sub-agents use specialized system prompts optimized for specific types of work

**How it works:**
The main agent uses `spawn_subagent` and `wait_for_subagents` tools to create and coordinate sub-agents. Each sub-agent operates independently with its own context and toolset, then reports results back to the main agent using `yield_to_parent`.

**Sub-agent system prompts** ([see full prompts](node/providers/system-prompt.ts)):

- `learn`: System prompt focused on code discovery, understanding APIs, and analyzing existing implementations
- `plan`: System prompt specialized for strategic planning and breaking down complex implementations
- `fast`: Lightweight system prompt optimized for quick transformations using the fast model
- `default`: General-purpose system prompt with standard coding assistant behavior

**Example workflows:**

_Learning workflow:_

```
user: I want to refactor this interface
→ Main agent spawns a 'learn' sub-agent to analyze the interface and its usage
→ Sub-agent explores the codebase, finds all references, understands patterns
→ Sub-agent yields findings back to main agent
→ Main agent uses the focused analysis to safely perform the refactoring
```

_Planning workflow:_

```
user: I want to build a new authentication system
→ Main agent spawns a 'plan' sub-agent to create an implementation strategy
→ Sub-agent analyzes existing auth patterns, creates detailed plan in plans/auth-system.md
→ Sub-agent yields plan location back to main agent
→ Main agent responds: "Please review `plans/auth-system.md` and confirm before I proceed"
```

_Parallel processing workflow:_

```
user: Update all the imports in this project to use the new module path
→ Main agent uses bash_command to find all files with the old import
→ Main agent uses spawn_foreach with fast agent type and the file list
→ Multiple fast sub-agents process different files simultaneously
→ Main agent waits for all sub-agents to complete
→ Main agent reports: "Updated imports in 15 files"
```

This architecture enables more sophisticated problem-solving by allowing the agent to gather focused context and work on multiple independent tasks simultaneously.

### Edit prediction

- `<S-C-l>` (Shift+Ctrl+L) in both insert and normal mode triggers the edit prediction feature. This analyzes your recent changes and current cursor context to suggest what you're likely to type next.
- When a prediction appears:
  - Press `<S-C-l>` again to accept and apply the prediction
  - Press `<Esc>` to dismiss the prediction (when in normal mode)
  - Making any other edit automatically dismisses the prediction

The prediction is shown as virtual text:

- Text to be removed is displayed with strikethrough formatting
- Text to be added is highlighted in a different color

This feature is particularly useful for:

- Completing repetitive patterns
- Finishing function calls and imports
- Applying consistent formatting changes
- Repeating similar edits across a codebase

The AI model takes into account your recent editing history and the current context around your cursor to make intelligent suggestions.

### Inline edit

- `<leader>mi` is for `:Magenta start-inline-edit`, or `start-inline-edit-selection` in visual mode. This will bring up a new split where you can write a prompt to edit the current buffer. Magenta will force a find-and-replace tool use for normal mode, or force a replace tool use for the selection in visual mode.

- `<leader>mr` (or `<leader>m.`) is for `:Magenta replay-inline-edit`. This replays your last inline edit prompt on the current buffer or selection, creating a powerful iteration workflow where you can refine an edit and then quickly apply it to similar code sections.

Inline edit uses your chat history so far, so a great workflow is to build up context in the chat panel, and then use it to perform inline edits in a buffer.

#### Fast model for inline edits

You can prefix your inline edit prompts with `@fast` to use the fast model instead of the primary model. This is perfect for simple refactoring tasks that don't require the full power of your main model:

```
@fast Convert this function to use arrow syntax
```

### display buffer

The display buffer is not modifiable, however you can interact with some parts of the display buffer by pressing `<CR>`. For example, you can expand the tool request and responses to see their details, and you can trigger a diff to appear on file edits.

- hit `enter` on a [review] message to pull up the diff to try and edit init
- hit `enter` on a tool to see the details of the request & result. Enter again on any part of the expanded view to collapse it.
- hit `enter` on a context file to open it
- hit `d` on a context file to remove it
- hit `enter` on a diff to see a detailed side-by-side comparison between the original file snapshot and proposed changes
- hit `enter` on web search results or citations to open them in your default browser
- hit `t` on a running bash command to terminate it (SIGTERM)

### Input commands

Magenta supports several special commands that you can use in the input buffer to enhance your prompts with current editor state:

#### @fork - Thread forking

Thread forking allows you to retain relevant pieces of context as you shift focus to new tasks.

1. Type `@fork` followed by your next prompt in the input buffer
2. Press Enter to send the request
3. Magenta will:
   - Analyze your next prompt to understand what you're trying to achieve
   - Extract only the parts of the current thread directly relevant to your prompt
   - Identify which context files are still needed
   - Create a new thread with this focused context and your prompt

This ensures that only information specifically relevant to your next task is carried forward, while irrelevant parts of the conversation are removed.

Example usage:

```
@fork Now let's implement unit tests for the new feature we just discussed
```

#### @diag / @diagnostics - Include current diagnostics

Automatically includes the current LSP diagnostics (errors, warnings, etc.) from your workspace in your message.

Example usage:

```
@diag Can you help me fix these TypeScript errors?
```

#### @buf / @buffers - Include current buffer list

Includes a list of all currently open buffers in your message, showing their file paths and modification status.

Example usage:

```
@buf Which of these files should I focus on for the authentication feature?
```

#### @qf / @quickfix - Include current quickfix list

Includes the current quickfix list entries in your message, useful for working with search results, build errors, or other structured lists.

Example usage:

```
@qf Let's go through each of these search results and update the API calls
```

#### @file - Add files to context

Add files to your thread's context by referencing them with `@file:path`.

Example usage:

```
@file:src/main.ts @file:README.md Let me analyze these files
```

#### @diff - Include git diff

Include git diff for specific files showing unstaged changes.

Example usage:

```
@diff:src/main.ts Review my changes before I commit
```

#### @staged - Include staged diff

Include staged git diff for specific files showing changes ready to commit.

Example usage:

```
@staged:src/main.ts Review my staged changes
```

### Smart Completions

Magenta provides intelligent completions for input commands when using nvim-cmp:

#### File Path Completions

When typing `@file:`, you get intelligent file path completions that:

- **Prioritize open buffers** - Files currently open in buffers appear first
- **Support fuzzy finding** - Type partial matches like `@file:p3` to find `poem 3.txt`
- **Respect .gitignore** - Hidden and gitignored files are automatically excluded
- **Show project files** - All files in your current working directory and subdirectories

#### Git Diff Completions

When typing `@diff:` or `@staged:`, you get completions for:

- **Unstaged files** (`@diff:`) - Files with unstaged changes in your working directory
- **Staged files** (`@staged:`) - Files with changes staged for commit

All completions work seamlessly with nvim-cmp's fuzzy matching and selection interface.

## tools available to the LLM

See the most up-to-date list of implemented tools [here](https://github.com/dlants/magenta.nvim/tree/main/node/tools).

- [x] run bash command
- [x] list a directory (only in cwd, excluding hidden and gitignored files)
- [x] list current buffers (only buffers in cwd, excluding hidden and gitignored files)
- [x] get the contents of a file with **rich content support**:
  - **Text files** (source code, markdown, JSON, XML, etc.) - added to context for change tracking
  - **Images** (JPEG, PNG, GIF, WebP) - processed and sent as base64 content for visual analysis
  - **PDF documents** - processed and sent as base64 content for document analysis
  - Requires user approval if not in cwd or hidden/gitignored
- [x] get lsp diagnostics
- [x] get lsp references for a symbol in a buffer
- [x] get lsp "hover" info for a symbol in a buffer
- [x] insert or replace in a file with automatic file snapshots for comparison
- [x] spawn sub-agents with specialized system prompts and toolsets (supports `learn`, `plan`, `fast`, and `default` agent types)
- [x] spawn multiple parallel sub-agents to process arrays of elements (enables batch operations and concurrent workflows)
- [x] wait for multiple sub-agents to complete (enables parallel workflows)
- [x] yield results back to parent agent (for sub-agents)

## MCP (Model Context Protocol) Support

Magenta supports MCP servers through two transport methods:

1. **Standard I/O (stdio)** - The traditional way to run MCP servers as child processes
2. **Streamable HTTP** - Connect to MCP servers over HTTP, useful for remote servers or services

### Standard I/O MCP Servers

Configure stdio MCP servers by specifying a command and arguments:

```lua
mcpServers = {
  fetch = {
    command = "uvx",
    args = { "mcp-server-fetch" },
    env = {
      CUSTOM_VAR = "value"
    }
  }
}
```

### Streamable HTTP transport (with fallback to SSE transport)

Configure HTTP-based MCP servers by specifying a URL and optional authentication:

```lua
mcpServers = {
  httpServer = {
    url = "http://localhost:8000/mcp",
    requestInit = {
      headers = {
        Authorization = "Bearer your-token-here",
      },
    },
  }
}
```

The `requestInit` field accepts standard [Fetch API RequestInit options](https://developer.mozilla.org/en-US/docs/Web/API/fetch#options), allowing you to configure headers, authentication, and other request parameters as needed.

Magenta automatically handles protocol fallback for HTTP-based MCP servers. It first attempts to use the streamable HTTP transport, and if that fails, it falls back to Server-Sent Events (SSE) transport. This ensures compatibility with a wider range of MCP server implementations.

### MCPHub Support

Magenta now supports [MCPHub.nvim](https://github.com/ravitemer/mcphub.nvim).

Configure Magenta to connect to MCPHub:

```lua
mcpServers = {
  mcphub = {
    url = "http://localhost:37373/mcp"
  }
}
```

# Why it's cool

- It uses the new [rpc-pased remote plugin setup](https://github.com/dlants/magenta.nvim/issues/1). This means more flexible plugin development (can easily use both lua and typescript), and no need for `:UpdateRemotePlugins`! (h/t [wallpants](https://github.com/wallpants/bunvim)).
- The state of the plugin is managed via an elm-inspired architecture (The Elm Architecture or [TEA](https://github.com/evancz/elm-architecture-tutorial)) [code](https://github.com/dlants/magenta.nvim/blob/main/node/tea/tea.ts). I think this makes it fairly easy to understand and lays out a clear pattern for extending the feature set, as well as [eases testing](https://github.com/dlants/magenta.nvim/blob/main/node/chat/chat.spec.ts). It also unlocks some cool future features (like the ability to persist a structured chat state into a file).
- I spent a considerable amount of time figuring out a full end-to-end testing setup. Combined with typescript's async/await, it makes writing tests fairly easy and readable. The plugin is already fairly well-tested [code](https://github.com/dlants/magenta.nvim/blob/main/node/magenta.spec.ts#L8).
- In order to use TEA, I had to build a VDOM-like system for rendering text into a buffer. This makes writing view code declarative. [code](https://github.com/dlants/magenta.nvim/blob/main/node/tea/view.ts#L141) [example defining a tool view](https://github.com/dlants/magenta.nvim/blob/main/node/tools/getFile.ts#L139)
- We can leverage existing sdks to communicate with LLMs, and async/await to manage side-effect chains, which greatly speeds up development. For example, streaming responses was pretty easy to implement, and I think is typically one of the trickier parts of other LLM plugins. [code](https://github.com/dlants/magenta.nvim/blob/main/node/anthropic.ts#L49)
- Smart prompt caching. Pinned files only move up in the message history when they change, which means the plugin is more likely to be able to use caching. I also implemented anthropic's prompt caching [pr](https://github.com/dlants/magenta.nvim/pull/30) using an cache breakpoints.
- I made an effort to expose the raw tool use requests and responses, as well as the stop reasons and usage info from interactions with each model. This should make debugging your workflows a lot more straightforward.
- Robust file snapshots system automatically captures file state before edits, allowing for accurate before/after comparison and better review experiences.

# How is this different from other coding assistant plugins?

I think the closest plugins to this one are [avante.nvim](https://github.com/yetone/avante.nvim) and [codecompanion.nvim](https://github.com/olimorris/codecompanion.nvim)

## compared to codecompanion:

Codecompanion has a single buffer, while magenta.nvim has separate input & display buffers. This makes it easier to add some interactivity to the display buffer (since it's not directly editable). I think this makes it nicer for situations when the LLM uses multiple tools at once. So for example, in codecompanion when the LLM needs permission to open a file, or proposes a change, this takes over your editor, which isn't a nice workflow when the tool needs to edit multiple files.

## compared to avante:

I think it's fairly similar. However, magenta.nvim is written in typescript and uses the sdks to implement streaming, which I think makes it more stable. I think the main advantage is the architecture is very clean so it should be easy to extend the functionality. Between typescript, sdks and the architecture, I think my velocity is really high.

## compared to both:

magenta.nvim includes capabilities that neither plugin offers:

- **Web search tools**: Agents can search the internet for current information, documentation, and solutions, and cite these in their responses.
- **Sub-agents**: Complex tasks can be broken down and delegated to specialized agents that work in parallel with focused context and system prompts.
- **User-friendly, context-aware inline edits**: apply inline edits at a cursor position or to a selection. Dot-repeat to replay promtps against new locations.
- **Smart context tracking**: The plugin automatically tracks the state of files on disk, in buffers, and what the agent has seen, sending only diffs when files change. This enables better cache utilization and more efficient communication while sending only diffs to the agent.

# Contributions

See [the contributions guide](https://github.com/dlants/magenta.nvim/blob/main/CONTRIBUTING.md)
