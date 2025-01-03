import { Sidebar } from "./sidebar.ts";
import * as Chat from "./chat/chat.ts";
import * as TEA from "./tea/tea.ts";
import { BINDING_KEYS, type BindingKey } from "./tea/bindings.ts";
import { pos } from "./tea/view.ts";
import type { Nvim } from "bunvim";
import { Lsp } from "./lsp.ts";
import { PROVIDER_NAMES, type ProviderName } from "./providers/provider.ts";
import { getcwd } from "./nvim/nvim.ts";
import path from "node:path";

// these constants should match lua/magenta/init.lua
const MAGENTA_COMMAND = "magentaCommand";
const MAGENTA_ON_WINDOW_CLOSED = "magentaWindowClosed";
const MAGENTA_KEY = "magentaKey";
const MAGENTA_LSP_RESPONSE = "magentaLspResponse";

export class Magenta {
  public sidebar: Sidebar;
  public chatApp: TEA.App<Chat.Msg, Chat.Model>;
  public mountedChatApp: TEA.MountedApp | undefined;

  constructor(
    public nvim: Nvim,
    public lsp: Lsp,
  ) {
    this.sidebar = new Sidebar(this.nvim, "anthropic");

    const chatModel = Chat.init({ nvim, lsp });
    this.chatApp = TEA.createApp({
      nvim: this.nvim,
      initialModel: chatModel.initModel(),
      update: (model, msg) => chatModel.update(model, msg, { nvim }),
      View: chatModel.view,
    });
  }

  async setOpts(opts: unknown) {
    if (typeof opts == "object" && opts != null) {
      const optsObj = opts as { [key: string]: unknown };
      if (optsObj["provider"]) {
        await this.command(`provider ${optsObj["provider"] as string}`);
      }
    }
  }

  async command(input: string): Promise<void> {
    const [command, ...rest] = input.trim().split(/\s+/);
    this.nvim.logger?.debug(`Received command ${command}`);
    switch (command) {
      case "provider": {
        const provider = rest[0];
        if (PROVIDER_NAMES.indexOf(provider as ProviderName) !== -1) {
          this.chatApp.dispatch({
            type: "choose-provider",
            provider: provider as ProviderName,
          });
          await this.sidebar.updateProvider(provider as ProviderName);
        } else {
          this.nvim.logger?.error(`Provider ${provider} is not supported.`);
        }
        break;
      }

      case "context-file": {
        const filePath = rest[0];
        if (typeof filePath != "string") {
          throw new Error(`context-file must be followed by a file path`);
        }

        let absFilePath;
        let relFilePath;
        const cwd = await getcwd(this.nvim);
        if (path.isAbsolute(filePath)) {
          absFilePath = filePath;
          relFilePath = path.relative(cwd, filePath);
        } else {
          absFilePath = path.resolve(cwd, filePath);
          relFilePath = filePath;
        }

        this.chatApp.dispatch({
          type: "context-manager-msg",
          msg: {
            type: "add-file-context",
            absFilePath,
            relFilePath,
          },
        });

        break;
      }

      case "toggle": {
        const buffers = await this.sidebar.toggle();
        if (buffers && !this.mountedChatApp) {
          this.mountedChatApp = await this.chatApp.mount({
            nvim: this.nvim,
            buffer: buffers.displayBuffer,
            startPos: pos(0, 0),
            endPos: pos(-1, -1),
          });
          this.nvim.logger?.debug(`Chat mounted.`);
        }
        break;
      }

      case "send": {
        const message = await this.sidebar.getMessage();
        this.nvim.logger?.debug(`current message: ${message}`);
        if (!message) return;

        this.chatApp.dispatch({
          type: "add-message",
          role: "user",
          content: message,
        });

        this.chatApp.dispatch({
          type: "send-message",
        });

        if (this.mountedChatApp) {
          await this.mountedChatApp.waitForRender();
        }
        await this.sidebar.scrollToLastUserMessage();

        break;
      }

      case "clear":
        this.chatApp.dispatch({ type: "clear" });
        break;

      default:
        this.nvim.logger?.error(`Unrecognized command ${command}\n`);
    }
  }

  onKey(args: string[]) {
    const key = args[0];
    if (this.mountedChatApp) {
      if (BINDING_KEYS.indexOf(key as BindingKey) > -1) {
        this.mountedChatApp.onKey(key as BindingKey);
      } else {
        this.nvim.logger?.error(`Unexpected MagentaKey ${JSON.stringify(key)}`);
      }
    }
  }

  async onWinClosed() {
    await this.sidebar.onWinClosed();
  }

  destroy() {
    if (this.mountedChatApp) {
      this.mountedChatApp.unmount();
      this.mountedChatApp = undefined;
    }
  }

  static async start(nvim: Nvim) {
    const lsp = new Lsp(nvim);
    const magenta = new Magenta(nvim, lsp);
    nvim.onNotification(MAGENTA_COMMAND, async (args: unknown[]) => {
      try {
        await magenta.command(args[0] as string);
      } catch (err) {
        nvim.logger?.error(
          err instanceof Error
            ? `Error executing command ${args[0] as string}: ${err.message}\n${err.stack}`
            : JSON.stringify(err),
        );
      }
    });

    nvim.onNotification(MAGENTA_ON_WINDOW_CLOSED, async () => {
      try {
        await magenta.onWinClosed();
      } catch (err) {
        nvim.logger?.error(err as Error);
      }
    });

    nvim.onNotification(MAGENTA_KEY, (args) => {
      try {
        magenta.onKey(args as string[]);
      } catch (err) {
        nvim.logger?.error(err as Error);
      }
    });

    nvim.onNotification(MAGENTA_LSP_RESPONSE, (...args) => {
      try {
        lsp.onLspResponse(args);
      } catch (err) {
        console.error(err);
        nvim.logger?.error(JSON.stringify(err));
      }
    });

    const opts = await nvim.call("nvim_exec_lua", [
      `return require('magenta').bridge(${nvim.channelId})`,
      [],
    ]);
    await magenta.setOpts(opts);
    nvim.logger?.info(`Magenta initialized. ${JSON.stringify(opts)}`);
    return magenta;
  }
}
