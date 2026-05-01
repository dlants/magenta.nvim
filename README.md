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

Developed by [dlants.me](https://dlants.me?ref=magenta.nvim): I was tempted by other editors due to lack of high-quality agentic coding support in neovim. I missed neovim a lot, though, so I decided to go back and implement my own. I now happily code in neovim using magenta, and find that it's just as good as cursor, windsurf, ampcode & claude code.

I sometimes write about AI, neovim and magenta specifically:

- [With AI, you barely need a frontend framework](https://dlants.me/vamp.html?ref=magenta.nvim)
- [How does AI change software engineering?](https://dlants.me/ai-se.html?ref=magenta.nvim)
- [Why I don't think AGI is imminent](https://dlants.me/agi-not-imminent.html?ref=magenta.nvim)
- [AI whiplash, and neovim in the age of AI](https://dlants.me/ai-whiplash.html?ref=magenta.nvim)
- [AI is not mid](https://dlants.me/ai-mid.html?ref=magenta.nvim)

🔍 **Also check out [pkb](https://github.com/dlants/pkb)**: A CLI for building a local knowledge base with LLM-based context augmentation and embeddings for semantic search. Can be used as a claude skill.

**Note**: I mostly develop using the Anthropic provider, so Claude Opus is recommended. I decided to drop support for other providers for now, since I am more interested in exploring the features space. If another provider becomes significantly better or cheaper, I'll probably add it.

📖 **Documentation**: Run `:help magenta.nvim` or ask magenta for complete documentation.

## Demos

![completion commands (July 2025)](https://github.com/user-attachments/assets/70eb1ddc-a592-47cb-a803-19414829c5d2)

[![June 2025 demo](https://img.youtube.com/vi/W_YctNT20NQ/0.jpg)](https://www.youtube.com/watch?v=W_YctNT20NQ)

# Why would I use this instead of claude code / another cli agent harness?

It's neovim, baby! Use your muscle memory to browse agent output, gather context, and edit your prompt. Jump into a buffer to fix errors or redirect the agent — the diff of your edits will be sent to the agent in the next message.

Magenta is fully transparent: you see everything the agent sees — prompts, reminders, tool descriptions — and can customize all of it. Edits use [EDL](https://github.com/dlants/magenta.nvim/blob/main/node/core/src/tools/edl-description.md), a purpose-built DSL that's far more token-efficient than claude code's str_replace. The useful parts of claude code (context management, sub-agents, skills, custom agents) are all present, so you won't miss anything.

And also apparently the code quality is a lot better?

# Why would I use this instead of other neovim AI plugins?

I haven't actually used other neovim AI plugins in a while, so take this with a grain of salt. My feeling is that magenta provides a richer set of features, nicer UI and more customizability than other plugins. Using a typescript core means we can leverage the anthropic sdk and libraries like anthropic's sandbox-runtime, which greatly speeds up development. The distinguishing features:

- **Edit Description Language (EDL)**: A [small DSL](https://github.com/dlants/magenta.nvim/blob/main/node/core/src/tools/edl-description.md) that's more expressive than string match/replace and often uses far fewer tokens to express edits, since it doesn't have to accurately re-type large swaths of text when making large edits.
- **OS-level sandboxing**: By default we use anthropic's sandbox-runtime to run the agent in an OS sandbox (seatbelt on macOS, bubblewrap on Linux) with configurable filesystem and network policies. Fewer operations require manual approval, leading to less alert fatigue.
- **Docker sub-agents**: Spawn isolated agents in Docker containers for parallel, unsupervised work.
- **Per-thread buffers**: Each thread is its own buffer, so you can use buffer navigation, jump lists, and pickers to jump between threads.
- **Declarative TUI rendering**: A VDOM-like / react-like system ([code](https://github.com/dlants/magenta.nvim/blob/main/node/tea/view.ts)) for rendering text into neovim buffers supports a rich display with expanding sections, navigation UI, and in-display-window approval dialogues.
- **UX polish**: Chimes and terminal bells integrate nicely with things like multiplexing neovim sessions in tmux.
- **Customizable agents**: Agent system prompts are markdown files on disk (`~/.magenta/agents/` or `.magenta/agents/`). Override or create new agent personalities without touching code.
- **Auto-compaction**: Chunked incremental summarization with accurate token counting keeps long threads manageable without losing important context.
- **TEA architecture**: State is managed via an [elm-inspired architecture](https://github.com/evancz/elm-architecture-tutorial) ([code](https://github.com/dlants/magenta.nvim/blob/main/node/tea/tea.ts)), making the plugin easy to understand, extend, and [test](https://github.com/dlants/magenta.nvim/blob/main/node/chat/chat.test.ts).
- **Full end-to-end testing**: A complete [integration test setup](https://github.com/dlants/magenta.nvim/blob/main/node/magenta.test.ts) with TypeScript async/await makes writing readable tests easy. The plugin is well-tested across unit, integration, and docker levels.
- **TypeScript + official SDKs**: Using the Anthropic SDK directly means streaming, tool use, and caching just work. Async/await makes side-effect chains straightforward.
- **Smart prompt caching**: Pinned files only move up in message history when they change, maximizing Anthropic's prompt cache hit rate. Cache breakpoints are placed strategically.
- **Transparency**: Raw tool use requests/responses, stop reasons, and token usage are all visible. You can see everything the agent sees and manipulate it.
- **File snapshots**: Automatic file state capture before edits enables accurate before/after diffs and better review.

# Updates

## Apr 2026

- Per-thread buffers: each thread now gets its own chat and input buffer. Switching threads swaps buffers in place, preserving scroll position and unsent input.
- Thread overview improvements: collapsible subtrees, sort by recent activity, sandbox violation indicators, and `dd` binding to delete thread subtrees.
- Terminal bell notifications: ring terminal bell on agent completion and when agent pauses for user permission, so you can work in another window.
- Customizable agents: agent system prompts are now markdown files on disk (`~/.magenta/agents/` or `.magenta/agents/`), making them easy to customize and override.
- `docs` tool: renamed from `learn`, now surfaces built-in `:help magenta` docs and discovers user-created documentation.
- Docker skills loading: skills now load inside Docker subagents via the FileIO interface.
- Sandbox improvements:
  - Per-thread-tree sandbox bypass toggle for trusted threads.
  - `requireApprovalPatterns`: regex patterns (e.g. `git\s+push`) that trigger approval prompts before running a command. Defaults to `["git\\s+push"]`.
  - Configurable bwrap violation patterns, hot-reloadable.
  - OS-level sandboxing via `@anthropic-ai/sandbox-runtime` (seatbelt on macOS, bubblewrap on Linux) with sensible defaults protecting credentials and dotfiles.
- Security: `.magenta/options.json` is now protected from agent tampering.
- Branchless docker: simplified container provisioning to directory-based (no git branches), with rsync-based file sync on teardown. Docker config is now specified inline in `spawn_subagents` tool calls instead of `.magenta/options.json`.
- Agent tier system: agents have `leaf`, `thread`, or `orchestrator` tiers that control spawn permissions. New `worktree` orchestrator agent replaces the conductor. New `:Magenta agent <name>` command.
- Abort improvements: partial stdout/stderr included in bash tool abort responses; user abort message appended to thread.
- Exponential backoff retry for Anthropic 429/529 rate limit errors.
- Simplified file I/O: disk-first approach, removed BufferTracker complexity.
- Expand/collapse for subagent progress and result rows in the chat view.
- Test segmentation: `TEST_MODE` env var splits tests into sandbox (local) and full-capabilities (docker) modes. New `tests-in-sandbox` subagent for fast local feedback.
- Renamed the `docs` tool to `learn` tool.
- Claude Code keychain auth: new `authType = "keychain"` profile option (macOS) reuses the Anthropic Console API key that Claude Code stores in the login Keychain, for users on the "Anthropic Console Account (API usage billing)" sign-in mode.

<details>
<summary>Older updates (click to expand)</summary>

## Mar 2026

- Dev containers: spawn Docker sub-agents that work on isolated branches in containers. Dockerfile-based, no bind mounts, Docker layer caching for fast startup.

## Feb 2026

- Type-checking now uses `tsgo` (TypeScript native Go compiler from `@typescript/native-preview`) for ~5x faster checks.
- Refactored tool architecture: separated tool execution from rendering, extracted shared capabilities (permissions, file I/O, shell) into a `capabilities/` layer. This decouples tools from neovim, moving towards being able to run it via server/client architecture, and dev container support.
- New sandbox permission system: OS-level sandboxing via `@anthropic-ai/sandbox-runtime` for shell commands, with application-level pre-flight checks for file I/O. Configurable via `sandbox` config (filesystem and network restrictions). Graceful fallback on unsupported platforms.
- Auto-compaction with chunked incremental summarization and accurate token counting via `countTokens` API.
- Introduced the edit description language (edl) tool, which subsumes the insert and replace tools.
- Introduced explore subagent, blocking subagents for better token economy and exploration speed.
- I decided to drop next edit prediciton and inline edits. I think I'm going to pivot this in a slightly different direction - for more power around unsupervised agent mode and managing teams of agents.

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

**Requirements:** Neovim 0.12.1+, Node.js v24+ (`node --version`), [nvim-cmp](https://github.com/hrsh7th/nvim-cmp)

**Recommended:** [fd](https://github.com/sharkdp/fd) and [ripgrep](https://github.com/BurntSushi/ripgrep) for better file discovery

## Using lazy.nvim

```lua
{
    "dlants/magenta.nvim",
    lazy = false,
    build = "npm run build",
    opts = {},
},
```

## Using vim.pack (Neovim 0.12.1+)

Neovim 0.12.1 includes a built-in package manager. Add to your `init.lua`:

```lua
vim.api.nvim_create_autocmd("PackChanged", {
  callback = function(ev)
    if ev.data.spec.name == "magenta.nvim" and ev.data.kind ~= "delete" then
      vim.system({ "npm", "run", "build" }, { cwd = ev.data.path }):wait()
    end
  end,
})

vim.pack.add({ "https://github.com/dlants/magenta.nvim" })

require('magenta').setup({})
```

# Configuration

## Quick Setup

```lua
require('magenta').setup({
  profiles = {
    {
      name = "claude-opus",
      provider = "anthropic",
      model = "claude-opus-4-7",
      fastModel = "claude-haiku-4-5",
      apiKeyEnvVar = "ANTHROPIC_API_KEY"
    }
  }
})
```

## Key Features

For any of the below, you can also just ask magenta to explain.

- **Profiles & providers** — configure models, API keys, and provider options. [docs](https://github.com/dlants/magenta.nvim/blob/main/doc/magenta-providers.txt) · `:help magenta-providers`
- **Project settings** — per-project `.magenta/options.json` for profiles, auto-context, skills paths, and MCP servers. [docs](https://github.com/dlants/magenta.nvim/blob/main/doc/magenta-config.txt) · `:help magenta-config`
- **Skills** — markdown files in `~/.magenta/skills/`, `.magenta/skills/`, `~/.claude/skills/`, or `.claude/skills/` that teach the agent project-specific knowledge. Supports suppressing project-level skills by name when shared configs collide with personal ones. [docs](https://github.com/dlants/magenta.nvim/blob/main/doc/magenta-skills.txt) · `:help magenta-skills`
- **Sandbox** — OS-level sandboxing (seatbelt/bubblewrap) with configurable filesystem, network, and approval policies. [docs](https://github.com/dlants/magenta.nvim/blob/main/doc/magenta-permissions.txt) · `:help magenta-sandbox`
- **MCP servers** — connect to local or remote MCP servers for additional tools. [docs](https://github.com/dlants/magenta.nvim/blob/main/doc/magenta-tools.txt) · `:help magenta-mcp`
- **Docker subagents** — spawn isolated agents in Docker containers for parallel, unsupervised work. [docs](https://github.com/dlants/magenta.nvim/blob/main/doc/magenta-docker.txt) · `:help magenta-docker`

# Usage

| Keymap       | Description                  |
| ------------ | ---------------------------- |
| `<leader>mt` | Toggle chat sidebar                     |
| `<leader>mf` | Pick files to add to context            |
| `<leader>mn` | Create new thread                       |
| `<leader>mp` | Paste clipboard image (in input buffer) |

**Input commands:** `@fork`, `@file:`, `@diff:`, `@diag`, `@buf`, `@qf`, `@fast`

For complete documentation:

- `:help magenta-commands` - All commands and keymaps
- `:help magenta-input-commands` - Input buffer @ commands
- `:help magenta-tools` - Tools and sub-agents
- `:help magenta-mcp` - MCP server configuration

# Development

The install hooks above run `npm run build` to produce a single-file bundle at `dist/magenta.mjs`. Neovim invokes this bundle directly, which keeps startup fast by avoiding thousands of file opens through the TypeScript source tree.

When hacking on the plugin, set `MAGENTA_DEV=1` in your shell (or your neovim launcher) to skip the bundle and run the TypeScript source directly via `node --experimental-transform-types`:

```sh
MAGENTA_DEV=1 nvim
```

If `dist/magenta.mjs` is missing (e.g. you cloned the repo without running the build), the plugin automatically falls back to source mode and prints a one-line warning.

# Contributions

See [the contributions guide](https://github.com/dlants/magenta.nvim/blob/main/CONTRIBUTING.md)
