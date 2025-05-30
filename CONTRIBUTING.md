# Contributions

## issues and discussions

I'd like to keep the issues down to just known bugs and things that I'm confident about implementing. Support questions and feature requests should go in the discussion board.

# Dev setup, etc...

## setup

Please run `scripts/setup-hooks` to set up precommit hooks which will typecheck, run eslint and prettier.

## how to use local version

I use lazy.nvim with the "dev" option [link](https://lazy.folke.io/configuration)

```lua
-- lazy config
require("lazy").setup {
...
  dev = {
    path = "~/src",
  }
}

-- magenta config
{
  "dlants/magenta.nvim",
  dev = true,
  lazy = false,
  build = "npm install --frozen-lockfile",
  config = function()
    require('magenta').setup()
  end
}
```

This will load the plugin from `~/src/magenta.nvim` instead of from git. You can toggle the `dev = true` option to go back to the official version in github.

## how to test

All significant changes should come with accompanying tests. There should go into `*.spec.ts` files placed adjacent to the code they are testing. So if the "meat" of the functionality you're testing is in `a.ts`, you should put the test for that in `a.spec.ts` in the same directory.

To run tests, use `npx vitest`. You can also mark certain tests to run via `describe.only` or `it.only` and then run `npx vitest filter` to just tests marked as only from test files matching `filter`.

Some test make use of the vitest snapshot feature. To update a snapshot, use `npx vitest -u`.

## how to see logs

Logs from magenta plugin are placed in `/tmp/magenta.log`. Logs from tests are placed in `/tmp/test.log`
These will contain all of the logs sent via `nvim.logger`. It will also log all of the RPC messages sent between neovim and the node process.

## how to debug

When invoking tests, you can run `npx vitest filter --inspect-wait`. This will print a url that you can open in your browser to bring up a debug console. This will stop on `debugger` statements encountered in the code, and will allow you to step through the code.

# Code orientation

## startup

When neovim starts, the `start` function is run in [init.lua](https://github.com/dlants/magenta.nvim/blob/main/lua/magenta/init.lua). This kicks off the node process. Neovim creates a socket and passes it to the node process via the `NVIM` env var.

The entrypoint for the node process is [index.ts](https://github.com/dlants/magenta.nvim/blob/main/node/index.ts). This checks for the presence of the env variable, establishes the nvim-node connection, and kicks off the static `Magenta.start` method.

The start function in [magenta.ts](https://github.com/dlants/magenta.nvim/blob/main/node/magenta.ts) sets up the notification listeners and calls the `require('magenta').bridge` method from `init.lua`. This passes the `channelId` back to the lua side, so that it can finish initializing the magenta lua module, which we can then invoke to communicate back to the plugin.

Most commands are defined in `init.lua`, though some are defined on the node side, like [sidebar.ts](https://github.com/dlants/magenta.nvim/blob/main/node/sidebar.ts).

## testing setup

The startup for tests is a little different, handled in [test/preamble.ts](https://github.com/dlants/magenta.nvim/blob/main/node/test/preamble.ts). Here, the node process starts first. In every tests, it creates an nvim socket, and then starts nvim with the `--listen` flag to attach to that socket. It then proceeds to init the magenta plugin against that socket, as in the normal startup sequence.

Each test gets a fresh neovim instance. Convenience methods for interacting with the nvim/plugin setup live in [test/driver.ts](https://github.com/dlants/magenta.nvim/blob/main/node/test/driver.ts).

## architecture

The project is inspired by the elm architecture, or [TEA](https://guide.elm-lang.org/architecture/), but uses a more flexible approach with controllers and a central dispatcher.

The core architectural components include:

- `Controllers` - Classes that manage specific parts of the application. Each controller maintains its own state and handles messages that are relevant to it.
- `Msg/RootMsg` - Messages that trigger state changes. There's a root message type that can be directed to specific controllers.
- `Dispatch/RootDispatch` - A function passed to controllers that allows them to send messages through the system. Each controller receives a root dispatcher that it can use to communicate with other parts of the system.
- `State` - The current state of a controller. Controllers manage their own internal state rather than returning new state from pure functions.
- `view` - A function that renders the current state as text. This is done in a declarative way using the `d` template literal. You can attach bindings to different parts of the text via `withBindings`.

The general flow is:

- Controllers initialize with their own state and receive a root dispatcher.
- When a user action occurs, it triggers a command or binding that dispatches a message.
- The message flows to the appropriate controller via the root dispatcher.
- The controller updates its internal state and may dispatch additional messages to other controllers.
- The view is rendered based on the updated state.

One key principle: **If you create a class, you're responsible for passing actions or messages to that class.**

The main architectural files are:

- [root-msg.ts](https://github.com/dlants/magenta.nvim/blob/main/node/root-msg.ts) - Defines the root message type that flows through the system
- [magenta.ts](https://github.com/dlants/magenta.nvim/blob/main/node/magenta.ts#L21) - Contains the central dispatching loop in the `dispatch` method of the Magenta class
- [tea/tea.ts](https://github.com/dlants/magenta.nvim/blob/main/node/tea/tea.ts) - Manages the rendering cycle
- [view.ts](https://github.com/dlants/magenta.nvim/blob/main/node/tea/view.ts) - Implements the VDOM-like declarative rendering template

## code organization

- [magenta.ts](https://github.com/dlants/magenta.nvim/blob/main/node/magenta.ts) - the entrypoint. Sets up the communication with the neovim process, initializes the app, receives commands from the neovim process.
- [sidebar.ts](https://github.com/dlants/magenta.nvim/blob/main/node/sidebar.ts) - manages the chat sidebar state. Mostly just for showing/hiding it, managing the keybindings, etc...
- [chat/chat.ts](https://github.com/dlants/magenta.nvim/blob/main/node/chat/chat.ts) - the top-level chat component that manages the overall chat state and initializes threads.
- [chat/thread.ts](https://github.com/dlants/magenta.nvim/blob/main/node/chat/thread.ts) - manages the message thread, handling sending messages, displaying responses, and coordinating with tool usage.
- [chat/message.ts](https://github.com/dlants/magenta.nvim/blob/main/node/chat/message.ts) - represents individual chat messages and manages their parts.
- [chat/part.ts](https://github.com/dlants/magenta.nvim/blob/main/node/chat/part.ts) - represents different parts of a message (text, tool requests, etc.).
- [context/context-manager.ts](https://github.com/dlants/magenta.nvim/blob/main/node/context/context-manager.ts) - manages file context that can be added to conversations.
- [tools/toolManager.ts](https://github.com/dlants/magenta.nvim/blob/main/node/tools/toolManager.ts) - manages tool executions and rendering. Each tool execution has an id, and this contains the state mapping that id to the execution state.
- [providers/provider.ts](https://github.com/dlants/magenta.nvim/blob/main/node/providers/provider.ts) - abstraction around an LLM provider. Creates general ways of declaring tools, messages and other interactions with various providers.
- [inline-edit/inline-edit-manager.ts](https://github.com/dlants/magenta.nvim/blob/main/node/inline-edit/inline-edit-manager.ts) - manages inline editing functionality for making code changes directly in buffers.
