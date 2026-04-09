import * as os from "node:os";
import type { InputMessage, ThreadId } from "@magenta/core";
import { type BufferInfo, BufferManager } from "./buffer-manager.ts";
import { Lsp } from "./capabilities/lsp.ts";
import { Chat } from "./chat/chat.ts";
import { CommandRegistry } from "./chat/commands/registry.ts";
import {
  type BufNr,
  type Line,
  MAGENTA_HIGHLIGHT_NAMESPACE,
  NvimBuffer,
} from "./nvim/buffer.ts";
import { initializeMagentaHighlightGroups } from "./nvim/extmarks.ts";
import { getCurrentBuffer, getcwd, getpos, notifyErr } from "./nvim/nvim.ts";
import type { Nvim } from "./nvim/nvim-node/index.ts";
import { findOrCreateNonMagentaWindow } from "./nvim/openFileInNonMagentaWindow.ts";
import {
  NvimWindow,
  pos1col1to0,
  type Row0Indexed,
  type WindowId,
} from "./nvim/window.ts";
import {
  getActiveProfile,
  type MagentaOptions,
  parseOptions,
} from "./options.ts";
import { DynamicOptionsLoader } from "./options-loader.ts";
import type { RootMsg, SidebarMsg } from "./root-msg.ts";
import { initializeSandbox, type Sandbox } from "./sandbox-manager.ts";
import { Sidebar } from "./sidebar.ts";
import { BINDING_KEYS, type BindingKey } from "./tea/bindings.ts";
import type { Dispatch } from "./tea/tea.ts";
import * as TEA from "./tea/tea.ts";
import {
  createTmuxInterface,
  type ThreadSource,
  type TmuxInterface,
  TmuxNotifier,
} from "./tmux-notifier.ts";
import { assertUnreachable } from "./utils/assertUnreachable.ts";
import type { HomeDir } from "./utils/files.ts";
import {
  detectFileType,
  type NvimCwd,
  relativePath,
  resolveFilePath,
  type UnresolvedFilePath,
} from "./utils/files.ts";
import { getMarkdownExt } from "./utils/markdown.ts";

// these constants should match lua/magenta/init.lua
const MAGENTA_COMMAND = "magentaCommand";
const MAGENTA_ON_WINDOW_CLOSED = "magentaWindowClosed";
const MAGENTA_KEY = "magentaKey";
const MAGENTA_LSP_RESPONSE = "magentaLspResponse";
const MAGENTA_BUF_ENTER = "magentaBufEnter";
const MAGENTA_FOCUS_CHANGED = "magentaFocusChanged";

export class Magenta {
  public sidebar: Sidebar;
  public bufferManager: BufferManager;
  public chat: Chat;
  public dispatch: Dispatch<RootMsg>;
  public commandRegistry: CommandRegistry;
  public optionsLoader: DynamicOptionsLoader;
  public tmuxNotifier: TmuxNotifier;
  public activeBuffers: { displayBuffer: NvimBuffer; inputBuffer: NvimBuffer };

  constructor(
    public nvim: Nvim,
    public lsp: Lsp,
    public cwd: NvimCwd,
    public homeDir: HomeDir,
    optionsLoader: DynamicOptionsLoader,
    private sandbox: Sandbox,
    bufferManager: BufferManager,
  ) {
    this.optionsLoader = optionsLoader;
    this.commandRegistry = new CommandRegistry();
    if (this.options.customCommands) {
      for (const customCommand of this.options.customCommands) {
        this.commandRegistry.registerCustomCommand(customCommand);
      }
    }

    this.dispatch = (msg: RootMsg) => {
      try {
        // select-thread-effect: update chat state + fire-and-forget buffer sync.
        // Used by view bindings that need to trigger thread navigation.
        if (msg.type === "select-thread-effect") {
          this.selectThreadEffect(msg.id).catch((e) => {
            nvim.logger.error(
              `Error syncing active view: ${e instanceof Error ? `${e.message}\n${e.stack}` : JSON.stringify(e)}`,
            );
          });
        }

        this.chat.update(msg);

        if (msg.type === "sidebar-msg") {
          this.handleSidebarMsg(msg.msg);
        }

        // Render only the active buffer's mounted app
        const activeMountedApp = this.bufferManager.getMountedApp(
          this.getActiveKey(),
        );
        if (activeMountedApp) {
          activeMountedApp.render();
        }

        this.sidebar.renderInputHeader().catch((e) => {
          this.nvim.logger.error(
            `Error rendering sidebar input header: ${e instanceof Error ? `${e.message}\n${e.stack}` : JSON.stringify(e)}`,
          );
        });

        this.tmuxNotifier.update(this.threadSource);
      } catch (e) {
        nvim.logger.error(e as Error);
      }
    };

    this.chat = new Chat({
      dispatch: this.dispatch,
      getDisplayWidth: () => {
        if (this.sidebar.state.state === "visible") {
          return this.sidebar.state.displayWidth;
        } else {
          return 100;
        }
      },
      cwd: this.cwd,
      homeDir: this.homeDir,
      nvim: this.nvim,
      getOptions: () => this.options,
      lsp: this.lsp,
      sandbox: this.sandbox,
    });

    this.bufferManager = bufferManager;
    this.activeBuffers = bufferManager.getOverviewBuffers();
    this.bufferManager.setAppFactories(
      (threadId: ThreadId) =>
        TEA.createApp<Chat>({
          nvim: this.nvim,
          initialModel: this.chat,
          View: () => this.chat.renderSingleThread(threadId),
        }),
      () =>
        TEA.createApp<Chat>({
          nvim: this.nvim,
          initialModel: this.chat,
          View: () => this.chat.renderThreadOverview(),
        }),
    );

    this.tmuxNotifier = new TmuxNotifier(createTmuxInterface());
    this.sidebar = new Sidebar(
      this.nvim,
      () => this.getActiveProfile(),
      () => {
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
      this.bufferManager,
      () => this.getActiveKey(),
    );
  }

  get threadSource(): ThreadSource {
    return {
      threadIds: () =>
        Object.keys(
          this.chat.threadWrappers,
        ) as import("@magenta/core").ThreadId[],
      getThreadSummary: (id) => this.chat.getThreadSummary(id),
    };
  }

  get options(): MagentaOptions {
    return this.optionsLoader.getOptions();
  }

  getActiveProfile() {
    return getActiveProfile(this.options.profiles, this.options.activeProfile);
  }

  getActiveKey(): ThreadId | "overview" {
    return this.chat.state.state === "thread-selected"
      ? this.chat.state.activeThreadId
      : "overview";
  }

  async selectThreadEffect(id: ThreadId): Promise<void> {
    this.dispatch({
      type: "chat-msg",
      msg: { type: "set-active-thread", id },
    });
    await this.syncActiveView();
    this.dispatch({
      type: "sidebar-msg",
      msg: { type: "scroll-to-bottom" },
    });
  }

  async createAndSwitchToNewThread(): Promise<ThreadId> {
    const threadId = await this.chat.createNewThread();
    await this.bufferManager.registerThread(threadId);
    this.dispatch({
      type: "chat-msg",
      msg: { type: "set-active-thread", id: threadId },
    });
    await this.syncActiveView();
    return threadId;
  }

  async createAndSwitchToAgentThread(agentName: string): Promise<ThreadId> {
    const threadId = await this.chat.createNewAgentThread(agentName);
    await this.bufferManager.registerThread(threadId);
    this.dispatch({
      type: "chat-msg",
      msg: { type: "set-active-thread", id: threadId },
    });
    await this.syncActiveView();
    return threadId;
  }

  async forkAndSwitchToThread(sourceThreadId: ThreadId): Promise<ThreadId> {
    const threadId = await this.chat.handleForkThread({ sourceThreadId });
    await this.bufferManager.registerThread(threadId);
    this.dispatch({
      type: "chat-msg",
      msg: { type: "set-active-thread", id: threadId },
    });
    await this.syncActiveView();
    return threadId;
  }
  private handleSidebarMsg(msg: SidebarMsg): void {
    switch (msg.type) {
      case "setup-resubmit": {
        this.activeBuffers.inputBuffer
          .setLines({
            start: 0 as Row0Indexed,
            end: -1 as Row0Indexed,
            lines: msg.lastUserMessage.split("\n") as Line[],
          })
          .catch((error) => {
            this.nvim.logger.error(`Error updating sidebar input: ${error}`);
          });
        break;
      }
      case "scroll-to-last-user-message": {
        const activeMountedApp = this.bufferManager.getMountedApp(
          this.getActiveKey(),
        );
        if (activeMountedApp) {
          (async () => {
            await activeMountedApp.waitForRender();
            await this.sidebar.scrollToLastUserMessage();
          })().catch((error: Error) =>
            this.nvim.logger.error(
              `Error scrolling to last user message: ${`${error.message}\n${error.stack}`}`,
            ),
          );
        }
        break;
      }
      case "scroll-to-bottom": {
        const activeMountedApp = this.bufferManager.getMountedApp(
          this.getActiveKey(),
        );
        if (activeMountedApp) {
          (async () => {
            await activeMountedApp.waitForRender();
            await this.sidebar.scrollToBottom();
          })().catch((error: Error) =>
            this.nvim.logger.error(
              `Error scrolling to bottom: ${`${error.message}\n${error.stack}`}`,
            ),
          );
        }
        break;
      }
      default:
        assertUnreachable(msg);
    }
  }

  /** After dispatching a chat-msg that changes the active view,
   * call this to update activeBuffers and switch sidebar windows.
   */
  private async syncActiveView(): Promise<void> {
    const activeKey = this.getActiveKey();
    if (activeKey === "overview") {
      this.activeBuffers = this.bufferManager.getOverviewBuffers();
      if (this.sidebar.state.state === "visible") {
        const { displayWindow, inputWindow } = this.sidebar.state;
        await this.bufferManager.switchToOverview(displayWindow, inputWindow);
      }
    } else {
      this.activeBuffers = await this.bufferManager.registerThread(activeKey);
      if (this.sidebar.state.state === "visible") {
        const { displayWindow, inputWindow } = this.sidebar.state;
        await this.bufferManager.switchToThread(
          activeKey,
          displayWindow,
          inputWindow,
        );
      }
    }
    // Step 7: update input window title (profile + token count) after switching threads
    await this.sidebar.renderInputHeader();
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
        } else {
          this.nvim.logger.error(`Profile "${profileName}" not found.`);
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

          thread.contextManager.addFileContext(
            absFilePath,
            relFilePath,
            fileTypeInfo,
          );
        }

        break;
      }

      case "toggle": {
        await this.sidebar.toggle(
          this.options.sidebarPosition,
          this.options.sidebarPositionOpts,
        );
        break;
      }

      case "send": {
        const text = await this.sidebar.getMessage(
          this.activeBuffers.inputBuffer,
        );
        this.nvim.logger.debug(`current message: ${text}`);
        if (!text) return;

        await this.preprocessAndSend(text);
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
        await this.createAndSwitchToNewThread();
        if (!this.sidebar.isVisible()) {
          await this.command("toggle");
        }
        break;
      }
      case "agent": {
        const agentName = rest[0];
        if (!agentName) {
          await this.nvim.call("nvim_err_writeln", [
            "Usage: :Magenta agent <name>",
          ]);
          break;
        }

        await this.createAndSwitchToAgentThread(agentName);
        if (!this.sidebar.isVisible()) {
          await this.command("toggle");
        }
        break;
      }

      case "threads-navigate-up": {
        this.dispatch({
          type: "chat-msg",
          msg: { type: "threads-navigate-up" },
        });
        await this.syncActiveView();
        this.dispatch({
          type: "sidebar-msg",
          msg: { type: "scroll-to-bottom" },
        });
        break;
      }

      case "threads-overview": {
        this.dispatch({
          type: "chat-msg",
          msg: { type: "threads-overview" },
        });
        await this.syncActiveView();
        this.dispatch({
          type: "sidebar-msg",
          msg: { type: "scroll-to-bottom" },
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

        await this.activeBuffers.inputBuffer.setLines({
          start: -1 as Row0Indexed,
          end: -1 as Row0Indexed,
          lines: content.split("\n") as Line[],
        });

        break;
      }

      default:
        this.nvim.logger.error(`Unrecognized command ${command}\n`);
        notifyErr(
          this.nvim,
          "unrecognized command",
          new Error(`Unrecognized command ${command}\n`),
        );
    }
  }

  onKey(args: string[]) {
    const key = args[0];
    const mountedApp = this.bufferManager.getMountedApp(this.getActiveKey());
    if (mountedApp) {
      if (BINDING_KEYS.indexOf(key as BindingKey) > -1) {
        mountedApp.onKey(key as BindingKey).catch((err) => {
          this.nvim.logger.error(err);
          throw err;
        });
      } else {
        this.nvim.logger.error(`Unexpected MagentaKey ${JSON.stringify(key)}`);
        notifyErr(
          this.nvim,
          "unexpected key",
          new Error(`Unexpected MagentaKey ${JSON.stringify(key)}`),
        );
      }
    }
  }

  private handlingBufEnter = false;

  /** Handle BufEnter events. Ensures magenta buffers stay in magenta windows
   * and non-magenta buffers don't take over magenta windows.
   */
  async onBufEnter(bufNr: BufNr, winId: WindowId): Promise<void> {
    if (this.handlingBufEnter) return;
    if (this.sidebar.state.state !== "visible") return;

    const { displayWindow, inputWindow } = this.sidebar.state;
    const isMagentaWindow =
      winId === displayWindow.id || winId === inputWindow.id;
    const bufInfo = this.bufferManager.lookupBuffer(bufNr);

    this.handlingBufEnter = true;
    try {
      if (bufInfo) {
        // Magenta buffer opened anywhere → treat as "select thread" action
        await this.handleMagentaBufOpened(bufNr, bufInfo, winId);
      } else if (!bufInfo && isMagentaWindow) {
        // Non-magenta buffer opened in a magenta window → eject it
        await this.handleNonMagentaBufInMagentaWindow(bufNr, winId);
      }
    } finally {
      this.handlingBufEnter = false;
    }
  }

  /** Any magenta buffer was opened (in any window). Treat as a "select thread" action.
   * If it was in a non-magenta window, revert the open first.
   * Then switch the sidebar to show the correct thread/overview.
   */
  private async handleMagentaBufOpened(
    _bufNr: BufNr,
    bufInfo: BufferInfo,
    winId: WindowId,
  ): Promise<void> {
    const { displayWindow, inputWindow } = this.sidebar.state as {
      state: "visible";
      displayWindow: NvimWindow;
      inputWindow: NvimWindow;
    };

    const isMagentaWindow =
      winId === displayWindow.id || winId === inputWindow.id;

    // If this is a non-magenta window, revert it to its previous buffer
    if (!isMagentaWindow) {
      const win = new NvimWindow(winId, this.nvim);
      const altBufNr = (await this.nvim.call("nvim_exec2", [
        `echo bufnr('#', ${winId})`,
        { output: true },
      ])) as { output: string };
      const altNr = Number(altBufNr.output);

      if (altNr > 0 && !this.bufferManager.isMagentaBuffer(altNr as BufNr)) {
        await this.nvim.call("nvim_win_set_buf", [winId, altNr]);
      } else {
        const emptyBuf = await NvimBuffer.create(false, true, this.nvim);
        await win.setBuffer(emptyBuf);
      }
    }

    const targetKey = bufInfo.key;
    const currentKey = this.getActiveKey();

    // If already showing the correct thread in the correct role, nothing to do
    if (isMagentaWindow && targetKey === currentKey) {
      const isDisplayWindow = winId === displayWindow.id;
      const isCorrectRole =
        (isDisplayWindow && bufInfo.role === "display") ||
        (!isDisplayWindow && bufInfo.role === "input");
      if (isCorrectRole) return;
    }

    // Select the target thread/overview — syncActiveView sets both windows
    if (targetKey === "overview") {
      this.dispatch({
        type: "chat-msg",
        msg: { type: "threads-overview" },
      });
      await this.syncActiveView();
    } else {
      await this.selectThreadEffect(targetKey);
    }
  }

  /** A non-magenta buffer was opened in a magenta window (e.g. via :e or :b).
   * Restore the magenta window and open the buffer in a non-magenta window instead.
   */
  private async handleNonMagentaBufInMagentaWindow(
    bufNr: BufNr,
    winId: WindowId,
  ): Promise<void> {
    const { displayWindow, inputWindow } = this.sidebar.state as {
      state: "visible";
      displayWindow: NvimWindow;
      inputWindow: NvimWindow;
    };

    // Determine which magenta buffer should be in this window and restore it
    const activeKey = this.getActiveKey();
    if (winId === displayWindow.id) {
      const { displayBuffer } =
        await this.bufferManager.ensureActiveIsMounted(activeKey);
      await displayWindow.setBuffer(displayBuffer);
    } else {
      const { inputBuffer } =
        await this.bufferManager.ensureActiveIsMounted(activeKey);
      await inputWindow.setBuffer(inputBuffer);
    }

    // Move the non-magenta buffer to a non-magenta window
    const foreignBuffer = new NvimBuffer(bufNr, this.nvim);
    const targetWindow = await findOrCreateNonMagentaWindow({
      nvim: this.nvim,
      options: this.options,
    });
    await targetWindow.setBuffer(foreignBuffer);
  }

  async onWinClosed() {
    await this.sidebar.onWinClosed();
  }

  destroy() {
    // BufferManager's mounted apps will be cleaned up when nvim exits
  }

  static async start(nvim: Nvim, homeDir?: HomeDir, sandboxOverride?: Sandbox) {
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

    nvim.onNotification(MAGENTA_FOCUS_CHANGED, (args) => {
      try {
        const data = (args as unknown as { focused: boolean }[])[0];
        if (data.focused) {
          magenta.tmuxNotifier.onFocusGained();
        } else {
          magenta.tmuxNotifier.onFocusLost(magenta.threadSource);
        }
        magenta.tmuxNotifier.update(magenta.threadSource);
      } catch (err) {
        nvim.logger.error(err as Error);
      }
    });

    nvim.onNotification(MAGENTA_BUF_ENTER, async (args) => {
      try {
        const data = (args as unknown as { bufnr: number; winid: number }[])[0];
        await magenta.onBufEnter(data.bufnr as BufNr, data.winid as WindowId);
      } catch (err) {
        nvim.logger.error(
          err instanceof Error
            ? `Error in BufEnter handler: ${err.message}\n${err.stack}`
            : JSON.stringify(err),
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

    // Get the current working directory
    const cwd = await getcwd(nvim);

    const optionsLoader = new DynamicOptionsLoader(
      baseOptions,
      cwd,
      resolvedHomeDir,
      { warn: (msg) => nvim.logger.warn(`Settings: ${msg}`) },
    );
    const parsedOptions = optionsLoader.getOptions();

    const sandbox =
      sandboxOverride ??
      (await initializeSandbox(
        parsedOptions.sandbox,
        cwd,
        resolvedHomeDir,
        undefined,
        { warn: (msg) => nvim.logger.warn(`Sandbox: ${msg}`) },
      ).catch((err) => {
        nvim.logger.error(
          `Failed to initialize sandbox: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Return an unsupported sandbox on failure
        return {
          getState: () => ({
            status: "unsupported" as const,
            reason: "initialization failed",
          }),
          wrapWithSandbox: (cmd: string) => Promise.resolve(cmd),
          getViolationStore: () => ({
            getTotalCount: () => 0,
            getViolations: () => [],
          }),
          annotateStderrWithSandboxFailures: (_cmd: string, stderr: string) =>
            stderr,
          getFsReadConfig: () => ({ denyOnly: [] }),
          getFsWriteConfig: () => ({ allowOnly: [], denyWithinAllow: [] }),
          updateConfigIfChanged: () => {},
          cleanupAfterCommand: () => {},
        } satisfies Sandbox;
      }));

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

    const bufferManager = await BufferManager.create(nvim);

    const magenta = new Magenta(
      nvim,
      lsp,
      cwd,
      resolvedHomeDir,
      optionsLoader,
      sandbox,
      bufferManager,
    );

    // Create the first thread eagerly so there's always an active thread
    const initialThreadId = await magenta.chat.createNewThread();
    magenta.activeBuffers =
      await magenta.bufferManager.registerThread(initialThreadId);
    magenta.dispatch({
      type: "chat-msg",
      msg: { type: "set-active-thread", id: initialThreadId },
    });

    nvim.logger.info(`Magenta initialized. ${JSON.stringify(parsedOptions)}`);
    return magenta;
  }

  /** Preprocess user input text and dispatch the appropriate message.
   * Handles @fork, @compact, @async detection and command expansion.
   */
  private async preprocessAndSend(text: string): Promise<void> {
    const thread = this.chat.getActiveThread();

    // @fork: create a forked thread, then re-process remaining text on it
    if (text.trim().startsWith("@fork")) {
      const strippedText = text.replace(/^\s*@fork\s*/, "");
      await this.forkAndSwitchToThread(thread.id);

      // If there's remaining text, re-invoke preprocessAndSend on the new active thread
      if (strippedText.trim()) {
        await this.preprocessAndSend(strippedText);
      }
      return;
    }

    // @compact: tell the thread to start compaction
    // Note: @compact @fork is not supported. Use @fork @compact instead.
    if (text.trim().startsWith("@compact")) {
      const rawNextPrompt = text.replace(/^\s*@compact\s*/, "").trim();
      const nextMessages = rawNextPrompt
        ? await this.processCommands(rawNextPrompt, thread)
        : undefined;
      const nextPrompt = nextMessages?.map((m) => m.text).join("\n");
      this.dispatch({
        type: "thread-msg",
        id: thread.id,
        msg: {
          type: "start-compaction",
          ...(nextPrompt ? { nextPrompt } : {}),
        },
      });
      return;
    }

    // @async: strip prefix and set flag
    // Note: @async @fork and @async @compact are not supported. Use @fork @async instead.
    const isAsync = text.trim().startsWith("@async");
    const cleanText = isAsync ? text.replace(/^\s*@async\s*/, "") : text;

    const messages = await this.processCommands(cleanText, thread);

    this.dispatch({
      type: "thread-msg",
      id: thread.id,
      msg: {
        type: "send-message",
        messages,
        ...(isAsync ? { async: true } : {}),
      },
    });
  }

  /** Run CommandRegistry on user text, returning processed InputMessages. */
  private async processCommands(
    text: string,
    thread: import("./chat/thread.ts").Thread,
  ): Promise<InputMessage[]> {
    const { processedText, additionalContent } =
      await this.commandRegistry.processMessage(text, {
        nvim: this.nvim,
        cwd: thread.context.environment.cwd,
        homeDir: thread.context.environment.homeDir,
        contextManager: thread.contextManager,
        options: this.options,
      });

    const messages: InputMessage[] = [{ type: "user", text: processedText }];

    // Fold additional content (from @diff, @staged, etc.) into text messages
    for (const content of additionalContent) {
      if (content.type === "text") {
        messages.push({ type: "user", text: content.text });
      }
    }

    return messages;
  }
}
