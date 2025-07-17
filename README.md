[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/dlants-magenta-nvim-badge.png)](https://mseep.ai/app/dlants-magenta-nvim)

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

(Note - I mostly develop using the Anthropic provider, so claude sonnet 3.7 or 4 are recommended. The OpenAI provider is supported, but with limitations. Contributions are welcome! See for example https://github.com/dlants/magenta.nvim/issues/82 and https://github.com/dlants/magenta.nvim/issues/84 )

[![June 2025 demo](https://img.youtube.com/vi/W_YctNT20NQ/0.jpg)](https://www.youtube.com/watch?v=W_YctNT20NQ)

# Roadmap

- openai provider reasoning, to allow use of the o models, ability to configure reasoning for claude models
- findDefinition tool / improved discovery of project types and docs
- gemini 2.5 pro provider
- @file completion for input buffer
- local code embedding & indexing via chroma db, to support a semantic code search tool

# Updates

## July 2025

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
- apiKeyEnvVar: environment variable containing the API key
- baseUrl: (optional) custom API endpoint

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
<summary>Default options</summary>

```lua
require('magenta').setup({
  profiles = {
    {
      name = "claude-4",
      provider = "anthropic",
      model = "claude-4-sonnet-latest",
      fastModel = "claude-3-5-haiku-latest", -- optional, defaults provided
      apiKeyEnvVar = "ANTHROPIC_API_KEY"
    },
    {
      name = "gpt-4.1",
      provider = "openai",
      model = "gpt-4.1",
      fastModel = "gpt-4o-mini", -- optional, defaults provided
      apiKeyEnvVar = "OPENAI_API_KEY"
    },
    {
      name = "copilot-claude",
      provider = "copilot",
      model = "claude-3.7-sonnet",
      fastModel = "claude-3-5-haiku-latest", -- optional, defaults provided
      -- No apiKeyEnvVar needed - uses existing Copilot authentication
    }
  },
  -- open chat sidebar on left or right side
  sidebarPosition = "left",
  -- can be changed to "telescope" or "snacks"
  picker = "fzf-lua",
  -- enable default keymaps shown below
  defaultKeymaps = true,
  -- maximum number of sub-agents that can run concurrently (default: 3)
  maxConcurrentSubagents = 3,
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
- For `openai`: [OpenAI Node SDK](https://github.com/openai/openai-node) - supports models like `gpt-4.1`, `o1`
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
  model = "claude-3.7-sonnet"  -- or "gpt-4.1"
}
```

The provider handles token refresh automatically and integrates with GitHub's Copilot API endpoints.

**NOTE:**

Copilot does this awkward thing where it gives you access to claude, but only through the openai chat completions api. As such they're really behind the ball on features. So for example, web_search for claude does not work [issue](https://github.com/microsoft/vscode-copilot-release/issues/6755). As such, I would not recommend it, though it is cheaper than paying for claude tokens directly.

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

## Keymaps

If `default_keymaps` is set to true, the plugin will configure the following global keymaps:

<details>
<summary>Default keymaps</summary>

```lua
local Actions = require("magenta.actions")

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
  "v",
  "<leader>mp",
  ":Magenta paste-selection<CR>",
  {silent = true, noremap = true, desc = "Send selection to Magenta"}
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
  "n",
  "<leader>mp",
  Actions.pick_provider,
  { noremap = true, silent = true, desc = "Select provider and model" }
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

#### @compact - Thread compaction

Thread compaction allows you to retain relevant pieces of context as you shift focus to new tasks.

1. Type `@compact` followed by your next prompt in the input buffer
2. Press Enter to send the compaction request
3. Magenta will:
   - Analyze your next prompt to understand what you're trying to achieve
   - Extract only the parts of the current thread directly relevant to your prompt
   - Identify which context files are still needed
   - Create a new thread with this focused context and your prompt

This smart compaction ensures that only information specifically relevant to your next task is carried forward, while irrelevant parts of the conversation are summarized or removed.

Example usage:

```
@compact Now let's implement unit tests for the new feature we just discussed
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
