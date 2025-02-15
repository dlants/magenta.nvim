import { Sidebar } from "./sidebar.ts";
import * as Chat from "./chat/chat.ts";
import * as TEA from "./tea/tea.ts";
import { BINDING_KEYS, type BindingKey } from "./tea/bindings.ts";
import { pos } from "./tea/view.ts";
import type { Nvim } from "nvim-node";
import { Lsp } from "./lsp.ts";
import {
  getProvider,
  PROVIDER_NAMES,
  type ProviderName,
  type ProviderSetting,
} from "./providers/provider.ts";
import { getCurrentBuffer, getcwd, getpos, notifyErr } from "./nvim/nvim.ts";
import path from "node:path";
import type { BufNr, Line } from "./nvim/buffer.ts";
import { pos1col1to0, type Position1Indexed } from "./nvim/window.ts";
import { getMarkdownExt } from "./utils/markdown.ts";
import {
  DEFAULT_OPTIONS,
  parseOptions,
  type MagentaOptions,
} from "./options.ts";
import { InlineEditManager } from "./inline-edit/inline-edit-manager.ts";

// these constants should match lua/magenta/init.lua
const MAGENTA_COMMAND = "magentaCommand";
const MAGENTA_ON_WINDOW_CLOSED = "magentaWindowClosed";
const MAGENTA_KEY = "magentaKey";
const MAGENTA_LSP_RESPONSE = "magentaLspResponse";

export class Magenta {
  public sidebar: Sidebar;
  public chatApp: TEA.App<Chat.Msg, Chat.Model>;
  public mountedChatApp: TEA.MountedApp | undefined;
  public chatModel;
  public inlineEditManager: InlineEditManager;
  public providerSetting: ProviderSetting;
  public options: MagentaOptions;

  constructor(
    public nvim: Nvim,
    public lsp: Lsp,
  ) {
    this.options = DEFAULT_OPTIONS;
    if (this.options.provider === "bedrock") {
      this.providerSetting = {
        provider: "bedrock",
        model: this.options.bedrock.model,
        promptCaching: this.options.bedrock.promptCaching,
      };
    } else {
      this.providerSetting = {
        provider: this.options.provider,
        model: this.options[this.options.provider].model,
      };
    }
    this.sidebar = new Sidebar(this.nvim, {
      provider: "anthropic",
      model: "claude-3-5-sonnet-latest",
    });

    this.chatModel = Chat.init({ nvim, lsp });
    this.chatApp = TEA.createApp({
      nvim: this.nvim,
      initialModel: this.chatModel.initModel(),
      update: (msg, model) => {
        if (msg.type === "prepend-input-buffer") {
          const text = msg.text;
          prependInputBufferHandler(text, this.sidebar, nvim).catch((err) => {
            nvim.logger?.debug("error appending input buffer: ", err);
          });
        }
        return this.chatModel.update(msg, model, { nvim });
      },
      View: this.chatModel.view,
    });

    this.inlineEditManager = new InlineEditManager({ nvim });
  }

  async command(input: string): Promise<void> {
    const [command, ...rest] = input.trim().split(/\s+/);
    this.nvim.logger?.debug(`Received command ${command}`);
    switch (command) {
      case "provider": {
        const [providerName, model] = rest;
        const provider = providerName as ProviderName;
        if (provider === "bedrock") {
          this.providerSetting = {
            provider,
            model: model || this.options[provider].model,
            promptCaching: this.options[provider].promptCaching,
          };
        } else {
          this.providerSetting = {
            provider,
            model: model || this.options[provider].model,
          };
        }
        if (PROVIDER_NAMES.indexOf(provider) !== -1) {
          this.chatApp.dispatch({
            type: "choose-provider",
            provider: this.providerSetting,
          });
          await this.sidebar.updateProvider(this.providerSetting);
        } else {
          this.nvim.logger?.error(`Provider ${provider} is not supported.`);
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          notifyErr(this.nvim, `Provider ${provider} is not supported.`);
        }
        break;
      }

      case "context-files": {
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

          this.chatApp.dispatch({
            type: "add-file-context",
            absFilePath,
            relFilePath,
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

      case "abort": {
        const chat = this.chatApp.getState();
        if (chat.status !== "running") {
          this.nvim.logger?.error(`Chat is not running.`);
          return;
        }

        const provider = getProvider(this.nvim, this.providerSetting);
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

        const provider = getProvider(this.nvim, this.providerSetting);

        const messages = await this.chatModel.getMessages(chat.model);
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
    magenta.options = parseOptions(opts);
    const provider = magenta.options["provider"];
    await magenta.command(
      `provider ${provider} ${magenta.options[provider].model}`,
    );
    nvim.logger?.info(`Magenta initialized. ${JSON.stringify(opts)}`);
    return magenta;
  }
}

async function prependInputBufferHandler(
  text: string,
  sidebar: Sidebar,
  nvim: Nvim,
) {
  const inputBuffer = sidebar.state.inputBuffer;
  if (!inputBuffer) {
    nvim.logger?.debug(`unable to init inputBuffer`);
    return;
  }
  const lines = text.split("\n");
  const lastLine = await inputBuffer.getLineCount();
  const firstLineText = await inputBuffer.getLines({
    start: lastLine - 1,
    end: lastLine,
  });

  //Prepend the text to input bufer. If there is a content separate with a new line.
  if (lastLine === 1 && firstLineText[0].trim() === "") {
    await inputBuffer.setLines({ start: 0, end: -1, lines: lines as Line[] });
  } else {
    lines.push("");
    await inputBuffer.setLines({ start: 0, end: 0, lines: lines as Line[] });
  }

  if (sidebar.state.state !== "visible") {
    nvim.logger?.debug(`sidebar state is not in 'visible' state`);
    return;
  }
  await sidebar.state.inputWindow.setWindowAsCurrent();
  await sidebar.state.inputWindow.setCursor({
    row: lastLine,
    col: 0,
  } as Position1Indexed);
}
