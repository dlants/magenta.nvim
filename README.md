# magenta.nvim

```
   ________
  ╱        ╲
 ╱         ╱
╱         ╱
╲__╱__╱__╱
Magenta is for agents.
```

`magenta.nvim` is a plugin for leveraging LLM agents in neovim. It provides a chat window where you can talk to your AI coding assistant, as well as tools to populate context and perform inline edits. It's similar to copilot agent, claude code, cursor compose, ampcode or windsurf.

(Developed by [dlants.me](https://dlants.me). I was tempted by other editors due to lack of high-quality agentic coding support in neovim. I missed neovim a lot, though, so I decided to go back and implement my own. I now happily code in neovim using magenta, and find that it's just as good!)

(Note - I mostly develop using the Anthropic provider, so claude sonnet 3.7 or 4 are recommended. The OpenAI provider is supported, but with limitations. Contributions are welcome! See for example https://github.com/dlants/magenta.nvim/issues/82 and https://github.com/dlants/magenta.nvim/issues/84 )

[![June 2025 demo](https://img.youtube.com/vi/W_YctNT20NQ/0.jpg)](https://www.youtube.com/watch?v=W_YctNT20NQ)

# Roadmap

- openai provider reasoning, to allow use of the o models, ability to configure reasoning for claude models
- findDefinition tool / improved discovery of project types and docs
- gemini 2.5 pro provider
- @quickfix command to place quickfix into input buffer
- fast/cheap provider configuration
- foreach tool to spawn multiple (fast) subagents (like to do the same operation to many files)
- @file completion for input buffer
- local code embedding & indexing via chroma db, to support a semantic code search tool

# Updates

## June 2025

I implemented **sub-agents** - a powerful feature that allows the main agent to delegate specific tasks to specialized sub-agents. Sub-agents can work in parallel and have their own specialized system prompts for tasks like learning codebases, planning implementations, or performing focused work. This enables complex workflows where multiple agents collaborate on different aspects of a problem.

I added support for images and pdfs. Magenta can now read these using the get_file tool for image-compatible openai and anthropic models.

I implemented **MCP (Model Context Protocol) support** - You can now configure local mcp servers (for now stdio transport only) via the plugin config or via the project `.magenta/options.json` file.

I added support for the copilot provider.

## May 2025

I implemented thread compaction that intelligently analyzes your next prompt and extracts only the relevant parts of the conversation history. This makes it easier to continue long conversations without hitting context limits while ensuring all important information is preserved. I also updated the magenta header to give you an estimate of the token count for your current conversation.

I updated the architecture around context following. We now track the state of the file on disk, and the buffer, as well as the current view that the agent has of the file. When these diverge, we send just the diff of the changes to the agent. This allows for better use of the cache, and more efficient communication since we do not have to re-send the full file contents when a small thing changes.

I updated the architecture around streaming, so we now process partial tool calls, which means we can preview Insert and Replace commands gradually as they stream in. This makes the tool feel a lot more responsive. I also added support for anthropic web search and citations!

I made a significant architectural shift in how magenta.nvim handles edits. Instead of merely proposing changes that require user confirmation, the agent can now directly apply edits to files with automatic snapshots for safety. Combined with the recent PR that implemented robust bash command execution, this creates a powerful iteration loop capability: agents can now modify files, run tests through bash, analyze results, and make further changes - all without user intervention.

<details>
<summary>Previous updates</summary>

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
Plug('dlants/magenta.vim', {
  ['do'] = 'npm install --frozen-lockfile',
})
vim.call('plug#end')

require('magenta').setup()
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
      apiKeyEnvVar = "ANTHROPIC_API_KEY"
    },
    {
      name = "gpt-4.1",
      provider = "openai",
      model = "gpt-4.1",
      apiKeyEnvVar = "OPENAI_API_KEY"
    },
    {
      name = "copilot-claude",
      provider = "copilot",
      model = "claude-3.7-sonnet",
      -- No apiKeyEnvVar needed - uses existing Copilot authentication
    }
  },
  -- open chat sidebar on left or right side
  sidebarPosition = "left",
  -- can be changed to "telescope" or "snacks"
  picker = "fzf-lua",
  -- enable default keymaps shown below
  defaultKeymaps = true,
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
    }
  }
})
```

</details>

## Profiles

The first profile in your `profiles` list is used as the default when the plugin starts. You can switch between profiles using `:Magenta pick-provider` (bound to `<leader>mp` by default).

For example, you can set up multiple profiles for different providers or API endpoints:

```lua
profiles = {
  {
    name = "claude-3-7",
    provider = "anthropic",
    model = "claude-3-7-sonnet-latest",
    apiKeyEnvVar = "ANTHROPIC_API_KEY"
  },
  {
    name = "custom",
    provider = "anthropic",
    model = "claude-3-7-sonnet-latest",
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

This architecture enables more sophisticated problem-solving by allowing the agent to gather focused context and work on multiple independent tasks simultaneously.

### Inline edit

- `<leader>mi` is for `:Magenta start-inline-edit`, or `start-inline-edit-selection` in visual mode. This will bring up a new split where you can write a prompt to edit the current buffer. Magenta will force a find-and-replace tool use for normal mode, or force a replace tool use for the selection in visual mode.

Inline edit uses your chat history so far, so a great workflow is to build up context in the chat panel, and then use it to perform inline edits in a buffer.

### display buffer

The display buffer is not modifiable, however you can interact with some parts of the display buffer by pressing `<CR>`. For example, you can expand the tool request and responses to see their details, and you can trigger a diff to appear on file edits.

- hit `enter` on a [review] message to pull up the diff to try and edit init
- hit `enter` on a tool to see the details of the request & result. Enter again on any part of the expanded view to collapse it.
- hit `enter` on a context file to open it
- hit `d` on a context file to remove it
- hit `enter` on a diff to see a detailed side-by-side comparison between the original file snapshot and proposed changes
- hit `t` on a running bash command to terminate it (SIGTERM)

### Thread compaction

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

#### terminating running commands

When a bash command is running, you can press the `t` key in the display buffer while your cursor is over the executing command to terminate it immediately. This is useful for long-running commands or commands that have entered an undesired state. When terminated, the command will display a message indicating it was terminated by user with SIGTERM.

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
- [x] spawn sub-agents with specialized system prompts and toolsets
- [x] wait for multiple sub-agents to complete (enables parallel workflows)
- [x] yield results back to parent agent (for sub-agents)

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

I think it's fairly similar. However, magenta.nvim is written in typescript and uses the sdks to implement streaming, which I think makes it more stable. I think the main advantage is the architecture is very clean so it should be easy to extend the functionality. Between typescript, sdks and the architecture, I think my velocity is pretty high.

## compared to both:

magenta.nvim includes capabilities that neither plugin offers:

- **Web search tools**: Agents can search the internet for current information, documentation, and solutions, and cite these in their responses
- **Sub-agents**: Complex tasks can be broken down and delegated to specialized agents that work in parallel with focused context and system prompts
- **Smart context tracking**: The plugin automatically tracks the state of files on disk, in buffers, and what the agent has seen, sending only diffs when files change. This enables better cache utilization and more efficient communication without re-sending full file contents for small changes.

# Contributions

See [the contributions guide](https://github.com/dlants/magenta.nvim/blob/main/CONTRIBUTING.md)
