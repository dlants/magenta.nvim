import { Sidebar } from "./sidebar.ts";
import * as Chat from "./chat/chat.ts";
import * as TEA from "./tea/tea.ts";
import { setContext, context } from "./context.ts";
import { BINDING_KEYS, type BindingKey } from "./tea/bindings.ts";
import { pos } from "./tea/view.ts";
import { Lsp } from "./lsp.ts";
import { attach, type LogLevel } from "bunvim";

// import { delay } from "./utils/async.ts";
// These values are set by neovim when starting the bun process
const ENV = {
  NVIM: process.env["NVIM"],
  LOG_LEVEL: process.env["LOG_LEVEL"] as LogLevel | undefined,
  DEV: Boolean(process.env["IS_DEV"]),
};

const MAGENTA_COMMAND = "magentaCommand";

export class Magenta {
  private sidebar: Sidebar;
  private chatApp: TEA.App<Chat.Msg, Chat.Model>;
  private mountedChatApp: TEA.MountedApp | undefined;

  constructor() {
    this.sidebar = new Sidebar();

    this.chatApp = TEA.createApp({
      initialModel: Chat.initModel(),
      // sub: {
      //   subscriptions: (model) => {
      //     if (model.messageInFlight) {
      //       return [{ id: "ticker" } as const];
      //     }
      //     return [];
      //   },
      //   subscriptionManager: {
      //     ticker: {
      //       subscribe(dispatch) {
      //         let running = true;
      //         const tick = async () => {
      //           while (running) {
      //             dispatch({ type: "tick" });
      //             await delay(100);
      //           }
      //         };
      //
      //         // eslint-disable-next-line @typescript-eslint/no-floating-promises
      //         tick();
      //
      //         return () => {
      //           running = false;
      //         };
      //       },
      //     },
      //   },
      // },
      update: Chat.update,
      View: Chat.view,
    });
  }

  async command(args: string[]): Promise<void> {
    context.nvim.logger?.debug(`Received command ${args[0]}`);
    switch (args[0]) {
      case "toggle": {
        const buffers = await this.sidebar.toggle();
        if (buffers && !this.mountedChatApp) {
          this.mountedChatApp = await this.chatApp.mount({
            buffer: buffers.displayBuffer,
            startPos: pos(0, 0),
            endPos: pos(-1, -1),
          });
          context.nvim.logger?.debug(`Chat mounted.`);
        }
        break;
      }

      case "send": {
        const message = await this.sidebar.getMessage();
        context.nvim.logger?.debug(`current message: ${message}`);
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
        context.nvim.logger?.error(`Unrecognized command ${args[0]}\n`);
    }
  }

  onKey(args: string[]) {
    const key = args[0];
    if (this.mountedChatApp) {
      if (BINDING_KEYS[key as BindingKey]) {
        this.mountedChatApp.onKey(key as BindingKey);
      } else {
        context.nvim.logger?.error(`Unexpected MagentaKey ${key}`);
      }
    }
  }

  async onWinClosed() {
    await this.sidebar.onWinClosed();
  }

  static async start() {
    if (!ENV.NVIM) throw Error("socket missing");
    const nvim = await attach({
      socket: ENV.NVIM,
      client: { name: "magenta" },
      logging: { level: ENV.LOG_LEVEL },
    });

    setContext({
      nvim,
      lsp: new Lsp(nvim),
    });

    process.on("uncaughtException", (error) => {
      nvim.logger?.error(error);
      process.exit(1);
    });

    const magenta = new Magenta();
    nvim.onNotification(MAGENTA_COMMAND, async (args: unknown[]) => {
      try {
        await magenta.command(args as string[]);
      } catch (err) {
        nvim.logger?.error(err as Error);
      }
    });

    await nvim.call("nvim_exec_lua", [
      `\
require('magenta').bridge(${nvim.channelId})
`,
      [],
    ]);
    nvim.logger?.info(`Magenta initialized.`);

    // plugin.registerCommand(
    //   "MagentaKey",
    //   (args: string[]) => {
    //     try {
    //       const magenta = init!.magenta;
    //       magenta.onKey(args);
    //     } catch (err) {
    //       init!.logger.error(err as Error);
    //     }
    //   },
    //   {
    //     nargs: "1",
    //   },
    // );
    //
    // plugin.registerAutocmd(
    //   "WinClosed",
    //   () => {
    //     init!.magenta
    //     .onWinClosed()
    //     .catch((err: Error) => context.logger.error(err));
    //   },
    //   {
    //     pattern: "*",
    //   },
    // );
    //
    // plugin.registerFunction(
    //   "Magenta_lsp_response",
    //   (result: unknown) => {
    //     context.lsp.onLspResponse(result as any);
    //   },
    //   {},
    // );
  }
}