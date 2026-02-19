# magenta.nvim

```
  ___ ___
/' __` __`\
/\ \/\ \/\ \
\ \_\ \_\ \_\
 \/_/\/_/\/_/
 magenta is for agentic flow
```

Magenta provides transparent tools to empower AI workflows in neovim. It allows fluid shifting of control between the developer and the AI, from AI automation and agent-led feature planning and development.

Developed by [dlants.me](https://dlants.me): I was tempted by other editors due to lack of high-quality agentic coding support in neovim. I missed neovim a lot, though, so I decided to go back and implement my own. I now happily code in neovim using magenta, and find that it's just as good as cursor, windsurf, ampcode & claude code.

I sometimes write about AI, neovim and magenta specifically:

- [Why I don't think AGI is imminent](https://dlants.me/agi-not-imminent.html)
- [AI whiplash, and neovim in the age of AI](https://dlants.me/ai-whiplash.html)
- [AI is not mid](https://dlants.me/ai-mid.html)

🔍 **Also check out [pkb](https://github.com/dlants/pkb)**: A CLI for building a local knowledge base with LLM-based context augmentation and embeddings for semantic search. Can be used as a claude skill.

**Note**: I mostly develop using the Anthropic provider, so Claude Opus is recommended. I decided to drop support for other providers for now, since I am more interested in exploring the features space. If another provider becomes significantly better or cheaper, I'll probably add it.

📖 **Documentation**: Run `:help magenta.nvim` in Neovim for complete documentation.

## Demos

![completion commands (July 2025)](https://github.com/user-attachments/assets/70eb1ddc-a592-47cb-a803-19414829c5d2)

[![June 2025 demo](https://img.youtube.com/vi/W_YctNT20NQ/0.jpg)](https://www.youtube.com/watch?v=W_YctNT20NQ)

## Features

- Multi-threading support, forks and compaction
- Sub-agents for parallel task processing
- Web search server_tool_use with citations
- MCP (Model Context Protocol) tools
- Smart context tracking with automatic diffing
- Claude skills
- Progressive disclosure for large files and bash outputs
- Prompt caching

## Roadmap

- Local code embedding & indexing for semantic code search

# Updates

<details>
<summary>Recent updates (click to expand)</summary>

## Feb 2026

- Introduced the edit description language (edl) tool, which subsumes the insert and replace tools.
- Introduced explore subagent, blocking subagents for better token economy and exploration speed.
- I decided to drop next edit prediction and inline edits. I think I'm going to pivot this in a slightly different direction - for more power around unsupervised agent mode and managing teams of agents.

## Jan 2026

- Major provider refactor: messages now stored in native format, eliminating lossy round-trip conversions and improving cache reliability
- Reworked `@fork`: it now clones the thread. Can now fork while streaming or pending tool use, and continue the original thread afterward
- Bash command output now streams to temp files (`/tmp/magenta/threads/...`) with abbreviated results sent to the model
- New `@compact` command for manual thread compaction
- Tree-sitter minimap: large files now show structural overview (functions, classes) instead of just first 100 lines
- Improved abort handling: cleaner tool lifecycle management
- README split into `:help magenta` documentation
- **Breaking**: Dropped support for non-Anthropic providers (openai, bedrock, ollama, copilot). I don't use them and maintaining them slowed me down in exploring new features. The new provider architecture is simpler - contributions to re-add providers welcome!

## Dec 2025

- Enhanced command permissions system with argument validation and path checking
- Improved file discovery with `rg` and `fd` support

## Nov 2025

- System reminders for persistent context
- Skills support (`.claude/skills` directory)

## Aug 2025

- PDF page-by-page reading
- Claude Max OAuth authentication
- Configurable chime volume
- `@fork` for thread forking with context retention

## Jul 2025

- Input buffer completions with nvim-cmp
- Thinking/reasoning support
- Remote MCP support (HTTP/SSE)
- Fast models and `@fast` modifier

- `spawn_foreach` for parallel sub-agents

## Jun 2025

- Sub-agents for parallel task delegation
- Image and PDF support
- Copilot provider

## May 2025

- Thread compaction/forking
- Smart context diffing
- Streaming tool previews
- Web search and citations

## Earlier

- [![Jan 2025 demo](https://img.youtube.com/vi/BPnUO_ghMJQ/0.jpg)](https://www.youtube.com/watch?v=BPnUO_ghMJQ)
- [![Dec 2024 demo](https://img.youtube.com/vi/i4YYvZwCMxM/0.jpg)](https://www.youtube.com/watch?v=i4YYvZwCMxM)

</details>

# Installation

**Requirements:** Node.js v20+ (`node --version`), [nvim-cmp](https://github.com/hrsh7th/nvim-cmp)

**Recommended:** [fd](https://github.com/sharkdp/fd) and [ripgrep](https://github.com/BurntSushi/ripgrep) for better file discovery

## Using lazy.nvim

```lua
{
    "dlants/magenta.nvim",
    lazy = false,
    build = "npm ci --production",
    opts = {},
},
```

## Using vim-plug

```lua
local vim = vim
local Plug = vim.fn['plug#']

vim.call('plug#begin')
Plug('dlants/magenta.nvim', {
  ['do'] = 'npm ci --production',
})
vim.call('plug#end')

require('magenta').setup({})
```

# Configuration

For complete configuration documentation, run `:help magenta-config` in Neovim.

## Quick Setup

```lua
require('magenta').setup({
  profiles = {
    {
      name = "claude-sonnet",
      provider = "anthropic",
      model = "claude-sonnet-4-5",
      fastModel = "claude-haiku-4-5",
      apiKeyEnvVar = "ANTHROPIC_API_KEY"
    }
  }
})
```

## Supported Providers

- **anthropic** - Claude models via [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript)

See `:help magenta-providers` for detailed provider configuration.

_Note: Other providers (openai, bedrock, ollama, copilot) were removed in Jan 2026. The new provider architecture is simpler - contributions welcome!_

## Project Settings

Create `.magenta/options.json` for project-specific configuration:

```json
{
  "profiles": [...],
  "autoContext": ["README.md", "docs/*.md"],
  "skillsPaths": [".claude/skills"],
  "mcpServers": { ... }
}
```

See `:help magenta-project-settings` for details.

# Usage

| Keymap       | Description                  |
| ------------ | ---------------------------- |
| `<leader>mt` | Toggle chat sidebar          |
| `<leader>mf` | Pick files to add to context |
| `<leader>mn` | Create new thread            |

**Input commands:** `@fork`, `@file:`, `@diff:`, `@diag`, `@buf`, `@qf`, `@fast`

For complete documentation:

- `:help magenta-commands` - All commands and keymaps
- `:help magenta-input-commands` - Input buffer @ commands
- `:help magenta-tools` - Tools and sub-agents
- `:help magenta-mcp` - MCP server configuration

# Why it's cool

- The [Edit Description Language](https://github.com/dlants/magenta.nvim/blob/main/node/tools/edl-description.md) is a small DSL that allows the agent to be more flexible and expressive about how it mutates files. This speeds up coding tasks dramatically as the agent can express the edits in a lot fewer tokens, since it doesn't have to re-type nearly identical content to what's already in the file twice!
- It uses the new [rpc-pased remote plugin setup](https://github.com/dlants/magenta.nvim/issues/1). This means more flexible plugin development (can easily use both lua and typescript), and no need for `:UpdateRemotePlugins`! (h/t [wallpants](https://github.com/wallpants/bunvim)).
- The state of the plugin is managed via an elm-inspired architecture (The Elm Architecture or [TEA](https://github.com/evancz/elm-architecture-tutorial)) [code](https://github.com/dlants/magenta.nvim/blob/main/node/tea/tea.ts). I think this makes it fairly easy to understand and lays out a clear pattern for extending the feature set, as well as [eases testing](https://github.com/dlants/magenta.nvim/blob/main/node/chat/chat.test.ts). It also unlocks some cool future features (like the ability to persist a structured chat state into a file).
- I spent a considerable amount of time figuring out a full end-to-end testing setup. Combined with typescript's async/await, it makes writing tests fairly easy and readable. The plugin is already fairly well-tested [code](https://github.com/dlants/magenta.nvim/blob/main/node/magenta.test.ts#L8).
- In order to use TEA, I had to build a VDOM-like system for rendering text into a buffer. This makes writing view code declarative. [code](https://github.com/dlants/magenta.nvim/blob/main/node/tea/view.ts#L141) [example defining a tool view](https://github.com/dlants/magenta.nvim/blob/main/node/tools/getFile.ts#L139)
- We can leverage existing sdks to communicate with LLMs, and async/await to manage side-effect chains, which greatly speeds up development. For example, streaming responses was pretty easy to implement, and I think is typically one of the trickier parts of other LLM plugins. [code](https://github.com/dlants/magenta.nvim/blob/main/node/anthropic.ts#L49)
- Smart prompt caching. Pinned files only move up in the message history when they change, which means the plugin is more likely to be able to use caching. I also implemented anthropic's prompt caching [pr](https://github.com/dlants/magenta.nvim/pull/30) using an cache breakpoints.
- I made an effort to expose the raw tool use requests and responses, as well as the stop reasons and usage info from interactions with each model. This should make debugging your workflows a lot more straightforward.
- Robust file snapshots system automatically captures file state before edits, allowing for accurate before/after comparison and better review experiences.

# How is this different from other coding assistants (Jan 2026)?

## claude code

It's neovim baby! Use your hard-won muscle memory to browse the agent output, explore files, gather context, and hand-edit when the agent can't swing it!

I've taken care to implement the best parts of claude code (context management, subagents, skills), so you shouldn't miss anything terribly.

Another thing is that magenta is a lot more transparent about what is happening to your context. For example, one major aspect of claude skills is that claude secretly litters the context with system reminders, to get the agent to actually use skills defined early in the context window. In magenta you can see everything the agent sees, and manipulate it to customize to your use case.

## other neovim plugins

The closest plugins are [avante.nvim](https://github.com/yetone/avante.nvim) and [codecompanion.nvim](https://github.com/olimorris/codecompanion.nvim). I haven't used either in a while, so take this with a grain of salt—both are actively developed and may have added features since I last checked.

That said, I've spent a lot of time building magenta's abstractions around agentic coding. Here's what I think sets it apart:

**Context management**

- **Sub-agents with parallelization**: Spawn multiple agents that work in parallel with focused contexts (`spawn_subagent`, `spawn_foreach`), then coordinate results
- **Thread forking and compaction**: Fork conversations to explore alternatives, compact long threads to manage context size
- **System reminders**: Automatic reminders injected after each message to keep the agent on track with skills and project conventions
- **Progressive disclosure**: Tree-sitter minimaps for large files, bash summarization, claude skills, context tracking that only sends diffs of changed files

**Permissions system**

- Configurable file permissions via `filePermissions` option—control which directories can be read/written without confirmation, including support for hidden/secret files
- Fine-grained bash command permissions with argument validation, subcommand support, and path checking
- Per-command configuration rather than just approve/deny-all

**Provider features**

- Native support for Anthropic's server-side web search tool with citations
- Messages stored in native provider format for more confident cache utilization

**Architecture**

- Written in TypeScript using official SDKs, making streaming and tool use more robust
- Separate input & display buffers for better interactivity during multi-tool operations

# Contributions

See [the contributions guide](https://github.com/dlants/magenta.nvim/blob/main/CONTRIBUTING.md)
