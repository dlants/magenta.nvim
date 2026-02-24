import { Sidebar } from "./sidebar.ts";
import * as TEA from "./tea/tea.ts";
import { BINDING_KEYS, type BindingKey } from "./tea/bindings.ts";
import { pos } from "./tea/view.ts";
import type { Nvim } from "./nvim/nvim-node/index.ts";
import { Lsp } from "./capabilities/lsp.ts";
import { getCurrentBuffer, getcwd, getpos, notifyErr } from "./nvim/nvim.ts";
import type { BufNr, Line } from "./nvim/buffer.ts";
import { pos1col1to0, type Row0Indexed } from "./nvim/window.ts";
import { getMarkdownExt } from "./utils/markdown.ts";
import * as os from "node:os";
import {
  parseOptions,
  loadUserSettings,
  loadProjectSettings,
  mergeOptions,
  type MagentaOptions,
  getActiveProfile,
} from "./options.ts";
import type { HomeDir } from "./utils/files.ts";
import type { RootMsg, SidebarMsg } from "./root-msg.ts";
import { Chat } from "./chat/chat.ts";
import type { Dispatch } from "./tea/tea.ts";
import { BufferTracker } from "./buffer-tracker.ts";
import {
  relativePath,
  resolveFilePath,
  type UnresolvedFilePath,
  type AbsFilePath,
  type NvimCwd,
  detectFileType,
} from "./utils/files.ts";
import { assertUnreachable } from "./utils/assertUnreachable.ts";
import { initializeMagentaHighlightGroups } from "./nvim/extmarks.ts";
import { MAGENTA_HIGHLIGHT_NAMESPACE } from "./nvim/buffer.ts";

// these constants should match lua/magenta/init.lua
const MAGENTA_COMMAND = "magentaCommand";
const MAGENTA_ON_WINDOW_CLOSED = "magentaWindowClosed";
const MAGENTA_KEY = "magentaKey";
const MAGENTA_LSP_RESPONSE = "magentaLspResponse";
const MAGENTA_BUFFER_TRACKER = "magentaBufferTracker";

export class Magenta {
  public sidebar: Sidebar;
  public chatApp: TEA.App<Chat>;
  public mountedChatApp: TEA.MountedApp | undefined;
  public chat: Chat;
  public dispatch: Dispatch<RootMsg>;
  public bufferTracker: BufferTracker;

  constructor(
    public nvim: Nvim,
    public lsp: Lsp,
    public cwd: NvimCwd,
    public homeDir: HomeDir,
    public options: MagentaOptions,
  ) {
    this.bufferTracker = new BufferTracker(this.nvim);

    this.dispatch = (msg: RootMsg) => {
      try {
        this.chat.update(msg);

        if (msg.type == "sidebar-msg") {
          this.handleSidebarMsg(msg.msg);
        }
        if (this.mountedChatApp) {
          this.mountedChatApp.render(msg);
        }

        this.sidebar.renderInputHeader().catch((e) => {
          this.nvim.logger.error(
            `Error rendering sidebar input header: ${e instanceof Error ? e.message + "\n" + e.stack : JSON.stringify(e)}`,
          );
        });
      } catch (e) {
        nvim.logger.error(e as Error);
      }
    };

    this.chat = new Chat({
      dispatch: this.dispatch,
      getDisplayWidth: () => {
        if (this.sidebar.state.state == "visible") {
          return this.sidebar.state.displayWidth;
        } else {
          // a placeholder value
          return 100;
        }
      },
      bufferTracker: this.bufferTracker,
      cwd: this.cwd,
      homeDir: this.homeDir,
      nvim: this.nvim,
      options: this.options,
      lsp: this.lsp,
    });

    this.sidebar = new Sidebar(
      this.nvim,
      () => this.getActiveProfile(),
      () => {
        // Thread may not be initialized yet during first sidebar show
        if (!this.chat.state.activeThreadId) {
          return 0;
        }
        const wrapper =
          this.chat.threadWrappers[this.chat.state.activeThreadId];
        if (!wrapper || wrapper.state !== "initialized") {
          return 0;
        }
        return wrapper.thread.getLastStopTokenCount();
      },
    );

    this.chatApp = TEA.createApp<Chat>({
      nvim: this.nvim,
      initialModel: this.chat,
      View: () => this.chat.view(),
    });
  }

  getActiveProfile() {
    return getActiveProfile(this.options.profiles, this.options.activeProfile);
  }
  private handleSidebarMsg(msg: SidebarMsg): void {
    switch (msg.type) {
      case "setup-resubmit":
        if (
          this.sidebar &&
          this.sidebar.state &&
          this.sidebar.state.inputBuffer
        ) {
          this.sidebar.state.inputBuffer
            .setLines({
              start: 0 as Row0Indexed,
              end: -1 as Row0Indexed,
              lines: msg.lastUserMessage.split("\n") as Line[],
            })
            .catch((error) => {
              this.nvim.logger.error(`Error updating sidebar input: ${error}`);
            });
        }
        break;
      case "scroll-to-last-user-message":
        if (this.mountedChatApp) {
          (async () => {
            await this.mountedChatApp?.waitForRender();
            await this.sidebar.scrollToLastUserMessage();
          })().catch((error: Error) =>
            this.nvim.logger.error(
              `Error scrolling to last user message: ${error.message + "\n" + error.stack}`,
            ),
          );
        }
        break;
      case "scroll-to-bottom":
        if (this.mountedChatApp) {
          (async () => {
            await this.mountedChatApp?.waitForRender();
            await this.sidebar.scrollToBottom();
          })().catch((error: Error) =>
            this.nvim.logger.error(
              `Error scrolling to bottom: ${error.message + "\n" + error.stack}`,
            ),
          );
        }
        break;
      default:
        assertUnreachable(msg);
    }
  }

  async command(input: string): Promise<void> {
    const [command, ...rest] = input.trim().split(/\s+/);
    this.nvim.logger.debug(`Received command ${command}`);
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
            id: this.chat.getActiveThread().id,
            msg: {
              type: "update-profile",
              profile: this.getActiveProfile(),
            },
          });
        } else {
          this.nvim.logger.error(`Profile "${profileName}" not found.`);
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          notifyErr(
            this.nvim,
            "profile command",
            new Error(`Profile "${profileName}" not found.`),
          );
        }
        break;
      }

      case "context-files": {
        if (!this.sidebar.isVisible()) {
          await this.command("toggle");
        }

        const thread = this.chat.getActiveThread();

        const parts = input.trim().match(/[^\s']+|'([^']*)'|\S+/g) || [];
        const paths = parts
          .slice(1)
          .map((str) => (str.startsWith("'") ? str.slice(1, -1) : str))
          .map((str) => str.trim());

        for (const filePath of paths) {
          const absFilePath = resolveFilePath(
            this.cwd,
            filePath as UnresolvedFilePath,
            this.homeDir,
          );
          const relFilePath = relativePath(this.cwd, absFilePath, this.homeDir);
          const fileTypeInfo = await detectFileType(absFilePath);
          if (!fileTypeInfo) {
            this.nvim.logger.error(`File ${filePath} does not exist.`);
            continue;
          }

          this.dispatch({
            type: "thread-msg",
            id: thread.id,
            msg: {
              type: "context-manager-msg",
              msg: {
                type: "add-file-context",
                absFilePath,
                relFilePath,
                fileTypeInfo,
              },
            },
          });
        }

        break;
      }

      case "toggle": {
        const buffers = await this.sidebar.toggle(
          this.options.sidebarPosition,
          this.options.sidebarPositionOpts,
        );
        if (buffers && !this.mountedChatApp) {
          this.mountedChatApp = await this.chatApp.mount({
            nvim: this.nvim,
            buffer: buffers.displayBuffer,
            startPos: pos(0 as Row0Indexed, 0),
            endPos: pos(-1 as Row0Indexed, -1),
          });
          this.nvim.logger.debug(`Chat mounted.`);
        }
        break;
      }

      case "send": {
        const text = await this.sidebar.getMessage();
        this.nvim.logger.debug(`current message: ${text}`);
        if (!text) return;

        this.dispatch({
          type: "thread-msg",
          id: this.chat.getActiveThread().id,
          msg: {
            type: "send-message",
            messages: [
              {
                type: "user",
                text,
              },
            ],
          },
        });

        break;
      }

      case "abort": {
        this.dispatch({
          type: "thread-msg",
          id: this.chat.getActiveThread().id,
          msg: {
            type: "abort",
          },
        });

        break;
      }

      case "new-thread": {
        if (!this.sidebar.isVisible()) {
          await this.command("toggle");
        }

        this.dispatch({
          type: "chat-msg",
          msg: {
            type: "new-thread",
          },
        });

        break;
      }

      case "threads-navigate-up": {
        this.dispatch({
          type: "chat-msg",
          msg: {
            type: "threads-navigate-up",
          },
        });

        // Scroll to bottom when navigating to threads overview
        // (The chat handler will determine if we go to overview or parent)
        this.dispatch({
          type: "sidebar-msg",
          msg: {
            type: "scroll-to-bottom",
          },
        });

        break;
      }

      case "threads-overview": {
        // Backward compatibility - force navigation to overview
        this.dispatch({
          type: "chat-msg",
          msg: {
            type: "threads-overview",
          },
        });

        this.dispatch({
          type: "sidebar-msg",
          msg: {
            type: "scroll-to-bottom",
          },
        });

        break;
      }

      case "paste-selection": {
        const [startPos, endPos, currentBuffer] = await Promise.all([
          getpos(this.nvim, "'<"),
          getpos(this.nvim, "'>"),
          getCurrentBuffer(this.nvim),
        ]);

        const lines = await currentBuffer.getText({
          startPos: pos1col1to0(startPos),
          endPos: pos1col1to0(endPos),
        });

        const absFilePath = resolveFilePath(
          this.cwd,
          await currentBuffer.getName(),
          this.homeDir,
        );
        const content = `
Here is a snippet from the file \`${absFilePath}\`, lines ${startPos.row}-${endPos.row}:
\`\`\`${getMarkdownExt(absFilePath)}
${lines.join("\n")}
\`\`\`
`;

        if (!this.sidebar.isVisible()) {
          await this.command("toggle");
        }

        const inputBuffer = this.sidebar.state.inputBuffer;
        if (!inputBuffer) {
          throw new Error(`Unable to init inputBuffer`);
        }

        await inputBuffer.setLines({
          start: -1 as Row0Indexed,
          end: -1 as Row0Indexed,
          lines: content.split("\n") as Line[],
        });

        break;
      }

      default:
        this.nvim.logger.error(`Unrecognized command ${command}\n`);
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        notifyErr(
          this.nvim,
          "unrecognized command",
          new Error(`Unrecognized command ${command}\n`),
        );
    }
  }

  onKey(args: string[]) {
    const key = args[0];
    if (this.mountedChatApp) {
      if (BINDING_KEYS.indexOf(key as BindingKey) > -1) {
        this.mountedChatApp.onKey(key as BindingKey).catch((err) => {
          this.nvim.logger.error(err);
          throw err;
        });
      } else {
        this.nvim.logger.error(`Unexpected MagentaKey ${JSON.stringify(key)}`);
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        notifyErr(
          this.nvim,
          "unexpected key",
          new Error(`Unexpected MagentaKey ${JSON.stringify(key)}`),
        );
      }
    }
  }

  async onWinClosed() {
    await this.sidebar.onWinClosed();
  }

  onBufferTrackerEvent(
    eventType: "read" | "write" | "close",
    absFilePath: AbsFilePath,
    bufnr: BufNr,
  ) {
    // Handle buffer events in our tracker
    switch (eventType) {
      case "read":
      case "write":
        this.bufferTracker.trackBufferSync(absFilePath, bufnr).catch((err) => {
          this.nvim.logger.error(
            `Error tracking buffer sync for ${absFilePath}: ${err}`,
          );
        });

        break;
      case "close":
        this.bufferTracker.clearFileTracking(absFilePath);
        break;
      default:
        assertUnreachable(eventType);
    }
  }

  destroy() {
    if (this.mountedChatApp) {
      this.mountedChatApp.unmount();
      this.mountedChatApp = undefined;
    }
  }

  static async start(nvim: Nvim, homeDir?: HomeDir) {
    const lsp = new Lsp(nvim);
    nvim.onNotification(MAGENTA_COMMAND, async (args: unknown[]) => {
      try {
        await magenta.command(args[0] as string);
      } catch (err) {
        nvim.logger.error(
          err instanceof Error
            ? `Error executing command ${args[0] as string}: ${err.message}\n${err.stack}`
            : JSON.stringify(err),
        );
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        notifyErr(nvim, `error processing command ${args[0] as string}`, err);
      }
    });

    nvim.onNotification(MAGENTA_ON_WINDOW_CLOSED, async () => {
      try {
        await magenta.onWinClosed();
      } catch (err) {
        nvim.logger.error(err as Error);
      }
    });

    nvim.onNotification(MAGENTA_KEY, (args) => {
      try {
        magenta.onKey(args as string[]);
      } catch (err) {
        nvim.logger.error(err as Error);
      }
    });

    nvim.onNotification(MAGENTA_LSP_RESPONSE, (...args) => {
      try {
        lsp.onLspResponse(args);
      } catch (err) {
        nvim.logger.error(JSON.stringify(err));
      }
    });

    nvim.onNotification(MAGENTA_BUFFER_TRACKER, (args) => {
      try {
        if (
          args.length < 3 ||
          typeof args[0] !== "string" ||
          typeof args[1] !== "string" ||
          typeof args[2] !== "number"
        ) {
          throw new Error(
            `Expected buffer tracker args to be [eventType, filePath, bufnr]`,
          );
        }

        const eventType = args[0];
        // Validate that eventType is one of the expected values
        if (
          eventType !== "read" &&
          eventType !== "write" &&
          eventType !== "close"
        ) {
          throw new Error(
            `Invalid eventType: ${eventType}. Expected 'read', 'write', or 'close'`,
          );
        }

        const absFilePath = args[1] as AbsFilePath;
        const bufnr = args[2] as BufNr;

        magenta.onBufferTrackerEvent(eventType, absFilePath, bufnr);
      } catch (err) {
        nvim.logger.error(
          `Error handling buffer tracker event for ${JSON.stringify(args)}: ${err instanceof Error ? err.message + "\n" + err.stack : JSON.stringify(err)}`,
        );
      }
    });

    const opts = await nvim.call("nvim_exec_lua", [
      `return require('magenta').bridge(${nvim.channelId})`,
      [],
    ]);

    // Parse base options from Lua
    const baseOptions = parseOptions(opts, nvim.logger);

    // Determine home directory - use provided value or fall back to os.homedir()
    const resolvedHomeDir = homeDir ?? (os.homedir() as HomeDir);

    // Load and merge user settings (~/.magenta/options.json)
    const userSettings = loadUserSettings(resolvedHomeDir, {
      warn: (msg) => nvim.logger.warn(`User settings: ${msg}`),
    });
    const optionsWithUser = userSettings
      ? mergeOptions(baseOptions, userSettings)
      : baseOptions;

    // Load and parse project settings (cwd/.magenta/options.json)
    const cwd = await getcwd(nvim);
    const projectSettings = loadProjectSettings(cwd, {
      warn: (msg) => nvim.logger.warn(`Project settings: ${msg}`),
    });

    // Merge project settings with user+base options
    const parsedOptions = projectSettings
      ? mergeOptions(optionsWithUser, projectSettings)
      : optionsWithUser;
    const magenta = new Magenta(nvim, lsp, cwd, resolvedHomeDir, parsedOptions);

    // Initialize highlight groups in the magenta namespace
    try {
      await nvim.call("nvim_create_namespace", [MAGENTA_HIGHLIGHT_NAMESPACE]);
      await initializeMagentaHighlightGroups(nvim);
    } catch (error) {
      nvim.logger.error(
        "Failed to initialize highlight groups:",
        error instanceof Error ? error.message : String(error),
      );
    }

    nvim.logger.info(`Magenta initialized. ${JSON.stringify(parsedOptions)}`);
    return magenta;
  }
}
