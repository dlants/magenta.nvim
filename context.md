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

For comprehensive view system documentation and templating patterns, use `get_file` to access the `doc-views` skill at `.claude/skills/doc-views/skill.md`.

**Important**: This is NOT React - it's a TUI templating system for neovim buffers.

# Putting it all together

Here's a minimal example of a controller with just one message type and two states:

```typescript
// make sure to grab appropriate imports relative to the file path

// Define a simple message type for toggling
export type Msg = { type: "toggle" } | { type: "request-finished" };

// this should be imported from node/root-msg.ts
export type ToggleRootMsg = {
  type: "toggle-msg";
  id: ToggleId;
  msg: Msg;
};

export type ToggleId = number & { __toggleId: true };

export class Toggle {
  public state: {
    isOn: boolean;
  };

  private myDispatch: Dispatch<Msg>;

  constructor(
    public id: ToggleId,
    private context: { dispatch: Dispatch<RootMsg>; nvim: Nvim },
  ) {
    this.myDispatch = (msg) =>
      this.context.dispatch({
        type: "toggle-msg",
        id: this.id,
        msg,
      });

    this.state = {
      isOn: false,
    };
  }

  update(msg: RootMsg): void {
    if (msg.type === "toggle-msg" && msg.id === this.id) {
      this.myUpdate(msg.msg);
    }
  }

  private myUpdate(msg: Msg): void {
    switch (msg.type) {
      case "toggle":
        this.state.isOn = !this.state.isOn;

        if (this.state.isOn) {
          this.notifyServer().catch((error) => {
            this.context.nvim.logger.error("Failed to notify server:", error);
          });
        }
        return;
      case "request-finished":
        this.context.nvim.logger.info("Server notification completed");
        return;
      default:
        assertUnreachable(msg);
    }
  }

  private async notifyServer(): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 500);
    });
    // Dispatch the request-finished message when done
    this.myDispatch({ type: "request-finished" });
  }

  view() {
    return d`
Current state: ${this.state.isOn ? "ON" : "OFF"}

${withBindings(d`[Toggle]`, {
  "<CR>": () => this.myDispatch({ type: "toggle" }),
})}`;
  }
}
```

# Testing

For comprehensive testing documentation, patterns, and best practices, use `get_file` to access the `doc-testing` skill at `.claude/skills/doc-testing/skill.md`.

Quick reference:

- Run tests: `npx vitest run` (from project root)
- Run specific test: `npx vitest run <file>`
- Use `withDriver()` helper for integration tests
- Prefer realistic nvim interactions over internal API access for integration tests
- Prefer unit tests over core classes for things that don't require neovim / UX interaction

# Type checks

Use `npx tsgo -b` to run type checking, from the project root. This uses build mode which handles the workspace project references (building `node/core` declarations first, then checking the root project). You do not need to cd into any subdirectory.

To type-check just the core package: `npx tsgo -p node/core/tsconfig.json --noEmit`

To run just the core tests: `npx vitest run node/core/`

# Development Workflow

When given a task:

1. **Create a branch** — Create a new branch for the task if one doesn't already exist.
2. **Ask about planning** — Ask the user whether a planning step is needed before implementation.
3. **Work in docker subagents** — All work should be done using `docker_unsupervised` subagents, unless otherwise requested:
   - If a planning step is requested, spawn a separate docker subagent to produce the plan, then present it to the user for feedback before proceeding.
   - All implementation work must be done in `docker_unsupervised` subagents.
   - Pass the branch name and have the prompt include the plan location to the docker subagent so it checks out the correct branch.

# Notes

To avoid complexity, keep variable names on the lua side camelCase, to match the variables defined in typescript.

We only want to use a single bottom value, so use undefined whenever you can and avoid null. When external libraries use null, only use null at the boundary, and convert to undefined as early as possible, so the internals of the plugin only use undefined.

You must **NEVER** introduce new `any` types. Always check with the user if you're thinking about doing so.
