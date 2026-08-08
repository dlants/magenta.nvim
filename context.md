# Overview

This is a neovim plugin for agentic tool use. The entrypoint is `lua/magenta/init.lua`, which kicks off the `node/magenta.ts` node process. That process establishes a bidirectional bridge, grabbing options from lua and enabling communication between the two halves.

The node code is organized as npm workspaces:

- `node/core/` (`@magenta/core`) — standalone logic with no neovim dependency (tools, providers, agents, thread-core, EDL, etc.)
- Root project — neovim-specific code (sidebar, TEA rendering, buffer-tracker, nvim bindings)

The root `tsconfig.json` uses TypeScript project references to enforce the boundary: core cannot import from the root project.

Key entry points:

- `lua/magenta/options.lua` — plugin options
- `lua/magenta/keymaps.lua` — neovim keymaps
- `node/sidebar.ts` — manages the sidebar (chat/input buffers, keymaps)

# Semantic search (pkb)

This repo has a semantic search index over its code and docs, built with [pkb](https://github.com/dlants/pkb). For exploratory / orientation questions ("where is X handled?", "how does Y work?"), use `pkb search` rather than grepping. Reserve `grep` for exact symbol/string lookups.

```bash
pkb search "<natural language query>"   # -k N sets result count (default 5)
```

Each result is a snippet with its file path — treat it as a pointer and open the file to read the real code. The index reflects the last indexed commit on `main`, not your working tree. The `plans/` dir is excluded from the index (see `pkb.toml`).

<system_reminder>
Prefer `pkb search <query>` to grep for exploratory queries.
</system_reminder>

# Architecture

## Core layer (`@magenta/core`)

Core classes like `ThreadCore` and `AnthropicAgent` are **event emitters**. They extend a custom type-safe `Emitter<Events>` class (`node/core/src/emitter.ts`) that provides `on()`, `off()`, and `emit()` methods parameterized on a typed event map.

- **`Agent`** (`node/core/src/providers/provider-types.ts`) — emits `didUpdate`, `stopped`, and `error` events as it streams responses.
- **`ThreadCore`** (`node/core/src/thread-core.ts`) — orchestrates agents and tools. Emits `update`, `playChime`, `scrollToLastMessage`, `setupResubmit`, `aborting`, and `contextUpdatesSent`.

ThreadCore subscribes to Agent events internally. This means the root project only needs to subscribe to ThreadCore — all core events are routed through a single point rather than requiring the root to subscribe to multiple emitters.

## Root layer (neovim-specific)

The root project uses a **single-dispatch TEA architecture**:

- **`RootMsg`** (`node/root-msg.ts`) — a discriminated union of all message types (`ThreadMsg`, `ChatMsg`, `SidebarMsg`).
- **`dispatch`** (`node/magenta.ts`) — the single state update point. Every message flows through `dispatch`, which forwards it to controllers and triggers a re-render.
- **Controllers** (e.g. `Chat`, `Thread`) — each maintains its own state and filters `RootMsg` for messages relevant to it. Each controller has a `myDispatch` that wraps local messages into the appropriate `RootMsg` variant.
- **`view`** — declarative TUI rendering using the `d` template literal, with `withBindings` for interactive elements.

## Core → Root bridge

The root `Thread` class (`node/chat/thread.ts`) bridges the two layers. In its constructor, it subscribes to `ThreadCore` events and converts them into dispatches:

- `core.on("update")` → dispatches `{ type: "tool-progress" }` to trigger re-renders
- `core.on("scrollToLastMessage")` → dispatches a `sidebar-msg` to scroll the view
- `core.on("setupResubmit")` → dispatches a `sidebar-msg` to populate the input buffer

This is the key pattern: **core emits events, the root subscribes at a single point (Thread), and converts them into RootMsg dispatches** that flow through the central update loop.

## Message flow

1. User action → binding or command dispatches a `RootMsg`
2. `dispatch` forwards the message to all controllers
3. Each controller filters for its own messages and updates internal state
4. Controllers may dispatch additional messages to other controllers
5. The view re-renders based on updated state

Key files:

- [root-msg.ts](https://github.com/dlants/magenta.nvim/blob/main/node/root-msg.ts) — root message union
- [magenta.ts](https://github.com/dlants/magenta.nvim/blob/main/node/magenta.ts) — central dispatch loop
- [tea/tea.ts](https://github.com/dlants/magenta.nvim/blob/main/node/tea/tea.ts) — render cycle
- [tea/view.ts](https://github.com/dlants/magenta.nvim/blob/main/node/tea/view.ts) — declarative TUI template

# View System

For comprehensive view system documentation and templating patterns, use `get_file` to access the `doc-views` skill at `.magenta/skills/doc-views/skill.md`.

**Important**: This is NOT React - it's a TUI templating system for neovim buffers.

# Testing

See `.magenta/skills/doc-testing/skill.md`.

Quick reference:

- Run tests: `npx vitest run` (from project root, for local development)
- Run specific test: `npx vitest run <file>`

# Type checks

Use `npx tsc -b` to run type checking, from the project root. This uses build mode which handles the workspace project references (building `node/core` declarations first, then checking the root project). You do not need to cd into any subdirectory.

To type-check just the core package: `npx tsc -p node/core/tsconfig.json --noEmit`

To run just the core tests: `npx vitest run node/core/`

# Linting and Formatting

Use `npx biome check .` to run linting and formatting checks. Use `npx biome check --write .` to auto-fix issues.
