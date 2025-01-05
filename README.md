# magenta.nvim

<img width="1376" alt="Screenshot 2024-12-22 at 3 40 02 PM" src="https://github.com/user-attachments/assets/df372c55-8c30-468d-8bd2-47047534fe92" />
<img width="1658" alt="Screenshot 2024-12-22 at 4 22 44 PM" src="https://github.com/user-attachments/assets/45c0e90a-0944-4e9e-8f2b-c0d779542d45" />

magenta.nvim is a plugin for leveraging LLM agents in neovim. Think cursor-compose, cody or windsurf.

Rather than writing complex code to compress your repo and send it to the LLM (like a repomap, etc...), magenta is built around the idea that the LLM can ask for what it needs to via tools.
Flagship models will continue to get better at tools use, and as this happens, the gap between tools like magenta and other agentic tools will grow smaller.

# Installation (lazy.nvim)

Install [bun](https://bun.sh/)

```lua
{
    "dlants/magenta.nvim",
    lazy = false, -- you could also bind to <leader>m
    build = "bun install --frozen-lockfile",
    config = function()
      require('magenta').setup()
    end
},
```

The plugin will look for credentials for providers in the following env variables:

- anthropic: ANTHROPIC_API_KEY
- openai: OPENAI_API_KEY

# Usage

## keymaps
Global keymaps are set [here](https://github.com/dlants/magenta.nvim/blob/main/lua/magenta/init.lua#L12).
Input and display buffer keymaps are set [here](https://github.com/dlants/magenta.nvim/blob/main/bun/sidebar.ts#L87)
Commands are all nested under `:Magenta <cmd>`, and can be found [here](https://github.com/dlants/magenta.nvim/blob/main/bun/magenta.ts#L54)

TLDR:

- `<leader>mt` is for `:Magenta toggle`, will toggle the sidebar on and off.
- `<leader>mp` is for `:Magenta paste-selection`. In visual mode it will take the current selection and paste it into the input buffer.
- `<leader>mc` is for `:Magenta context-files` with your _current_ file. It will pin the current file to your context.
- `<leader>mf` is for `:Magenta context-files` it allows you to select files via fzf-lua, and will pin those files to your context. This requires that fzf-lua is installed.

In the input buffer or the display buffer:

- `<leader>a` is for `:Magenta abort`, which will abort the current in-flight request.
- `<leader>c` is for `:Magenta clear`, which will clear the current chat.

The display buffer is not modifiable, however you can interact with some parts of the display buffer by pressing `<CR>`. For example, you can expand the tool request and responses to see their details, and you can trigger a diff to appear on file edits.

- hit enter on a [review] message to pull up the diff to try and edit init
- hit enter on a tool to see the details of the request & result. Enter again on any part of the expanded view to collapse it.
- hit enter on a piece of context to remove it

## tools available to the LLM
See the most up-to-date list of implemented tools [here](https://github.com/dlants/magenta.nvim/tree/main/bun/tools).

- [x] list a directory (only in cwd, excluding hidden and gitignored files)
- [x] list current buffers (only buffers in cwd, excluding hidden and gitignored files)
- [x] get the contents of a file (requires user approval if not in cwd or hidden/gitignored)
- [x] get lsp diagnostics
- [x] get lsp "hover" info for a symbol in a buffer
- [x] insert or replace in a file (the user can then review the changes via neovim's [diff mode](https://neovim.io/doc/user/diff.html))

# Why it's cool

- It uses [bun](https://bun.sh/) for faster startup, a lower memory footprint, and ease of development with Typescript.
- It uses the new [rpc-pased remote plugin setup](https://github.com/dlants/magenta.nvim/issues/1). This means more flexible plugin development (can easily use both lua and typescript), and no need for `:UpdateRemotePlugins`! (h/t [wallpants](https://github.com/wallpants/bunvim)).
- The state of the plugin is managed via an elm-inspired architecture (The Elm Architecture or [TEA](https://github.com/evancz/elm-architecture-tutorial)) [code](https://github.com/dlants/magenta.nvim/blob/main/bun/tea/tea.ts). I think this makes it fairly easy to understand and lays out a clear pattern for extending the feature set, as well as [eases testing](https://github.com/dlants/magenta.nvim/blob/main/bun/chat/chat.spec.ts). It also unlocks some cool future features (like the ability to persist a structured chat state into a file).
- I spent a considerable amount of time figuring out a full end-to-end testing setup. Combined with typescript's async/await, it makes writing tests fairly easy and readable. The plugin is already fairly well-tested [code](https://github.com/dlants/magenta.nvim/blob/main/bun/magenta.spec.ts#L8).
- In order to use TEA, I had to build a VDOM-like system for rendering text into a buffer. This makes writing view code declarative. [code](https://github.com/dlants/magenta.nvim/blob/main/bun/tea/view.ts#L141) [example defining a tool view](https://github.com/dlants/magenta.nvim/blob/main/bun/tools/getFile.ts#L139)
- we can leverage existing sdks to communicate with LLMs, and async/await to manage side-effect chains, which greatly speeds up development. For example, streaming responses was pretty easy to implement, and I think is typically one of the trickier parts of other LLM plugins. [code](https://github.com/dlants/magenta.nvim/blob/main/bun/anthropic.ts#L49)

If you'd like to contribute, please reach out to me. My email is listed at my blog: dlants.me
