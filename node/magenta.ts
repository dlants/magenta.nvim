import { Sidebar } from "./sidebar.ts";
import * as TEA from "./tea/tea.ts";
import { BINDING_KEYS, type BindingKey } from "./tea/bindings.ts";
import { pos } from "./tea/view.ts";
import type { Nvim } from "nvim-node";
import { Lsp } from "./lsp.ts";
import { getProvider } from "./providers/provider.ts";
import { getCurrentBuffer, getcwd, getpos, notifyErr } from "./nvim/nvim.ts";
import path from "node:path";
import type { BufNr, Line } from "./nvim/buffer.ts";
import { pos1col1to0 } from "./nvim/window.ts";
import { getMarkdownExt } from "./utils/markdown.ts";
import { parseOptions, type MagentaOptions, type Profile } from "./options.ts";
import { InlineEditManager } from "./inline-edit/inline-edit-manager.ts";
import type { RootMsg } from "./root-msg.ts";
import { Chat } from "./chat/chat.ts";
import type { Dispatch } from "./tea/tea.ts";
import type { MessageId } from "./chat/message.ts";

// these constants should match lua/magenta/init.lua
const MAGENTA_COMMAND = "magentaCommand";
const MAGENTA_ON_WINDOW_CLOSED = "magentaWindowClosed";
const MAGENTA_KEY = "magentaKey";
const MAGENTA_LSP_RESPONSE = "magentaLspResponse";

export class Magenta {
  public sidebar: Sidebar;
  public chatApp: TEA.App<Chat>;
  public mountedChatApp: TEA.MountedApp | undefined;
  public inlineEditManager: InlineEditManager;
  public chat: Chat;
  public dispatch: Dispatch<RootMsg>;

  constructor(
    public nvim: Nvim,
    public lsp: Lsp,
    public options: MagentaOptions,
  ) {
    this.dispatch = (msg: RootMsg) => {
      try {
        this.chat.update(msg);

        if (msg.type == "sidebar-setup-resubmit") {
          if (
            this.sidebar &&
            this.sidebar.state &&
            this.sidebar.state.inputBuffer
          ) {
            this.sidebar.state.inputBuffer
              .setLines({
                start: 0,
                end: -1,
                lines: msg.lastUserMessage.split("\n") as Line[],
              })
              .catch((error) => {
                this.nvim.logger?.error(
                  `Error updating sidebar input: ${error}`,
                );
              });
          }
        }
        if (this.mountedChatApp) {
          this.mountedChatApp.render();
        }
      } catch (e) {
        nvim.logger?.error(e as Error);
      }
    };

    this.chat = new Chat({
      dispatch: this.dispatch,
      nvim: this.nvim,
      options: this.options,
      lsp: this.lsp,
    });

    this.sidebar = new Sidebar(this.nvim, this.getActiveProfile());

    this.chatApp = TEA.createApp<Chat>({
      nvim: this.nvim,
      initialModel: this.chat,
      View: () => this.chat.view(),
    });

    this.inlineEditManager = new InlineEditManager({ nvim });
  }

  getActiveProfile() {
    return getActiveProfile(this.options.profiles, this.options.activeProfile);
  }

  async command(input: string): Promise<void> {
    const [command, ...rest] = input.trim().split(/\s+/);
    this.nvim.logger?.debug(`Received command ${command}`);
    switch (command) {
      case "profile": {
        const profileName = rest.join(" ");
        const profile = this.options.profiles.find(
          (p) => p.name === profileName,
        );

        if (profile) {
          this.options.activeProfile = profile.name;

          this.dispatch({
            type: "thread-msg",
            msg: {
              type: "update-profile",
              profile: this.getActiveProfile(),
            },
          });
          await this.sidebar.updateProfile(this.getActiveProfile());
        } else {
          this.nvim.logger?.error(`Profile "${profileName}" not found.`);
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          notifyErr(this.nvim, `Profile "${profileName}" not found.`);
        }
        break;
      }

      case "context-files": {
        if (this.chat.state.state !== "initialized") {
          return;
        }
        const messages = this.chat.state.thread.state.messages;
        const message = messages[messages.length - 1];
        const messageId = message?.state.id || (0 as MessageId);

        const parts = input.trim().match(/[^\s']+|'([^']*)'|\S+/g) || [];
        const paths = parts
          .slice(1)
          .map((str) => (str.startsWith("'") ? str.slice(1, -1) : str))
          .map((str) => str.trim());

        for (const filePath of paths) {
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

          this.dispatch({
            type: "context-manager-msg",
            msg: {
              type: "add-file-context",
              absFilePath,
              relFilePath,
              messageId,
            },
          });
        }

        break;
      }

      case "toggle": {
        const buffers = await this.sidebar.toggle(this.options.sidebarPosition);
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

        this.dispatch({
          type: "thread-msg",
          msg: {
            type: "add-message",
            role: "user",
            content: message,
          },
        });

        this.dispatch({
          type: "thread-msg",
          msg: {
            type: "send-message",
          },
        });

        if (this.mountedChatApp) {
          await this.mountedChatApp.waitForRender();
        }
        await this.sidebar.scrollToLastUserMessage();

        break;
      }

      case "clear":
        this.dispatch({
          type: "thread-msg",
          msg: {
            type: "clear",
            profile: this.getActiveProfile(),
          },
        });
        break;

      case "abort": {
        const chat = this.chatApp.getState();
        if (chat.status !== "running") {
          this.nvim.logger?.error(`Chat is not running.`);
          return;
        }

        const provider = getProvider(this.nvim, this.getActiveProfile());
        provider.abort();

        break;
      }

      case "paste-selection": {
        const [startPos, endPos, cwd, currentBuffer] = await Promise.all([
          getpos(this.nvim, "'<"),
          getpos(this.nvim, "'>"),
          getcwd(this.nvim),
          getCurrentBuffer(this.nvim),
        ]);

        const lines = await currentBuffer.getText({
          startPos: pos1col1to0(startPos),
          endPos: pos1col1to0(endPos),
        });

        const relFileName = path.relative(cwd, await currentBuffer.getName());
        const content = `
Here is a snippet from the file \`${relFileName}\`
\`\`\`${getMarkdownExt(relFileName)}
${lines.join("\n")}
\`\`\`
`;

        let inputBuffer;
        inputBuffer = this.sidebar.state.inputBuffer;
        if (!inputBuffer) {
          await this.command("toggle");
        }

        inputBuffer = this.sidebar.state.inputBuffer;
        if (!inputBuffer) {
          throw new Error(`Unable to init inputBuffer`);
        }

        await inputBuffer.setLines({
          start: -1,
          end: -1,
          lines: content.split("\n") as Line[],
        });

        break;
      }

      case "start-inline-edit-selection": {
        const [startPos, endPos] = await Promise.all([
          getpos(this.nvim, "'<"),
          getpos(this.nvim, "'>"),
        ]);

        await this.inlineEditManager.initInlineEdit({ startPos, endPos });
        break;
      }

      case "start-inline-edit": {
        await this.inlineEditManager.initInlineEdit();
        break;
      }

      case "submit-inline-edit": {
        if (rest.length != 1 || typeof rest[0] != "string") {
          this.nvim.logger?.error(
            `Expected bufnr argument to submit-inline-edit`,
          );
          return;
        }

        const bufnr = Number.parseInt(rest[0]) as BufNr;
        const chat = this.chatApp.getState();
        if (chat.status !== "running") {
          this.nvim.logger?.error(`Chat is not running.`);
          return;
        }

        const provider = getProvider(this.nvim, this.getActiveProfile());

        const messages = await this.chat.getMessages();
        await this.inlineEditManager.submitInlineEdit(
          bufnr,
          provider,
          messages,
        );
        break;
      }

      default:
        this.nvim.logger?.error(`Unrecognized command ${command}\n`);
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        notifyErr(this.nvim, `Unrecognized command ${command}\n`);
    }
  }

  onKey(args: string[]) {
    const key = args[0];
    if (this.mountedChatApp) {
      if (BINDING_KEYS.indexOf(key as BindingKey) > -1) {
        this.mountedChatApp.onKey(key as BindingKey);
      } else {
        this.nvim.logger?.error(`Unexpected MagentaKey ${JSON.stringify(key)}`);
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        notifyErr(this.nvim, `Unexpected MagentaKey ${JSON.stringify(key)}`);
      }
    }
  }

  async onWinClosed() {
    await Promise.all([
      this.sidebar.onWinClosed(),
      this.inlineEditManager.onWinClosed(),
    ]);
  }

  destroy() {
    if (this.mountedChatApp) {
      this.mountedChatApp.unmount();
      this.mountedChatApp = undefined;
    }
    this.inlineEditManager.destroy();
  }

  static async start(nvim: Nvim) {
    const lsp = new Lsp(nvim);
    nvim.onNotification(MAGENTA_COMMAND, async (args: unknown[]) => {
      try {
        await magenta.command(args[0] as string);
      } catch (err) {
        nvim.logger?.error(
          err instanceof Error
            ? `Error executing command ${args[0] as string}: ${err.message}\n${err.stack}`
            : JSON.stringify(err),
        );
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        notifyErr(nvim, err);
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
        nvim.logger?.error(JSON.stringify(err));
      }
    });

    const opts = await nvim.call("nvim_exec_lua", [
      `return require('magenta').bridge(${nvim.channelId})`,
      [],
    ]);

    const parsedOptions = parseOptions(opts);
    const magenta = new Magenta(nvim, lsp, parsedOptions);
    nvim.logger?.info(`Magenta initialized. ${JSON.stringify(parsedOptions)}`);
    return magenta;
  }
}

function getActiveProfile(profiles: Profile[], activeProfile: string) {
  const profile = profiles.find((p) => p.name == activeProfile);
  if (!profile) {
    throw new Error(`Profile ${activeProfile} not found.`);
  }
  return profile;
}
