import * as os from "node:os";
import type { SandboxAskCallback } from "@anthropic-ai/sandbox-runtime";
import type { InputMessage, NativeMessageIdx, ThreadId } from "@magenta/core";
import { probeAndSaveClipboardImage } from "@magenta/core";
import { type BufferInfo, BufferManager } from "./buffer-manager.ts";
import { Lsp } from "./capabilities/lsp.ts";
import { StraceUnavailableError } from "./capabilities/strace.ts";
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
  type Position1Indexed,
  pos1col1to0,
  type Row0Indexed,
  type WindowId,
} from "./nvim/window.ts";
import { openTargetUnderCursor } from "./open-target-under-cursor.ts";
import {
  getActiveProfile,
  type MagentaOptions,
  parseOptions,
} from "./options.ts";
import { DynamicOptionsLoader } from "./options-loader.ts";
import type { RootMsg, SidebarMsg } from "./root-msg.ts";
import { initializeSandbox, type Sandbox } from "./sandbox-manager.ts";
import { ScriptManager } from "./scripts/script-manager.ts";
import { Sidebar } from "./sidebar.ts";
import {
  BINDING_KEYS,
  type BindingCtx,
  type BindingKey,
} from "./tea/bindings.ts";
import type { Dispatch } from "./tea/tea.ts";
import * as TEA from "./tea/tea.ts";
import { d } from "./tea/view.ts";
import { record as recordTiming } from "./timings.ts";
import { assertUnreachable } from "./utils/assertUnreachable.ts";
import type { HomeDir } from "./utils/files.ts";
import {
  detectFileType,
  formatFileRef,
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
const MAGENTA_BUF_DELETE = "magentaBufDelete";
const MAGENTA_CLIPBOARD_IMAGE_PASTE = "magentaClipboardImagePaste";
const MAGENTA_CLIPBOARD_TEXT_PASTE = "magentaClipboardTextPaste";

function formatAsQuote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export class Magenta {
  public sidebar: Sidebar;
  public bufferManager: BufferManager;
  public chat: Chat;
  public scriptManager: ScriptManager;
  public dispatch: Dispatch<RootMsg>;
  public commandRegistry: CommandRegistry;
  public optionsLoader: DynamicOptionsLoader;
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

        if (msg.type === "set-thread-title-effect") {
          this.bufferManager.setThreadTitle(msg.id, msg.title).catch((e) => {
            nvim.logger.error(
              `Error setting thread title: ${e instanceof Error ? `${e.message}\n${e.stack}` : JSON.stringify(e)}`,
            );
          });
        }

        // fork-message: F binding from the view dispatches this. We handle it
        // here at the dispatch layer (clone agent + truncate + switch + populate
        // input buffer) rather than letting it flow into Thread.update.
        if (msg.type === "thread-msg" && msg.msg.type === "fork-message") {
          const sourceThreadId = msg.id;
          const { nativeMessageIdx, prepopulate } = msg.msg;
          this.forkAtMessageAndSwitch(
            sourceThreadId,
            nativeMessageIdx,
            prepopulate,
          ).catch((e) => {
            nvim.logger.error(
              `Error forking thread at message: ${e instanceof Error ? `${e.message}\n${e.stack}` : JSON.stringify(e)}`,
            );
          });
          return;
        }

        this.chat.update(msg);
        this.scriptManager.update(msg);

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
      removeThreadBuffers: (ids) => {
        for (const id of ids) {
          bufferManager.removeThread(id).catch((e: Error) => {
            this.nvim.logger.error(
              `Error removing buffers for thread ${id}: ${e.message}`,
            );
          });
        }
      },
    });

    this.scriptManager = new ScriptManager({
      dispatch: this.dispatch,
      chat: this.chat,
      nvim: this.nvim,
      cwd: this.cwd,
      homeDir: this.homeDir,
      getScriptsPaths: () => this.options.scriptsPaths,
      getOptions: () => this.options,
    });
    this.chat.scriptRunner = {
      discover: () => this.scriptManager.discover(),
      getScriptCatalog: () => this.scriptManager.getScriptCatalog(),
      runScript: ({ scriptName, parameters, triggeringThreadId }) => {
        this.scriptManager.runScript(scriptName, parameters, {
          sandboxBypassed: this.chat.isSandboxBypassed(triggeringThreadId),
        });
      },
    };
    this.bufferManager = bufferManager;
    this.activeBuffers = bufferManager.getOverviewBuffers();
    const onUnhandledKey = async ({
      key,
    }: {
      key: BindingKey;
    }): Promise<void> => {
      if (key === "<CR>") {
        try {
          await openTargetUnderCursor({
            nvim: this.nvim,
            cwd: this.cwd,
            homeDir: this.homeDir,
            options: this.options,
          });
        } catch (err) {
          this.nvim.logger.error(
            `openTargetUnderCursor failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`,
          );
          throw err;
        }
      }
    };

    this.bufferManager.setAppFactories(
      (threadId: ThreadId) =>
        TEA.createApp<Chat>({
          nvim: this.nvim,
          initialModel: this.chat,
          View: () => this.chat.renderSingleThread(threadId),
          onUnhandledKey,
        }),
      () =>
        TEA.createApp<Chat>({
          nvim: this.nvim,
          initialModel: this.chat,
          View: () =>
            this.chat.state.state === "archive"
              ? this.chat.renderArchive()
              : d`${this.chat.renderThreadOverview()}${this.scriptManager.view()}`,
          onUnhandledKey,
        }),
    );

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
      () => this.chat.isSandboxBypassed(this.chat.state.activeThreadId),
    );
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
      msg: { type: "set-cursor-to-bottom" },
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

  async forkAtMessageAndSwitch(
    sourceThreadId: ThreadId,
    nativeMessageIdx: NativeMessageIdx,
    prepopulate?: string[],
  ): Promise<ThreadId> {
    const threadId = await this.chat.handleForkThread({
      sourceThreadId,
      truncateAtMessageIdx: nativeMessageIdx,
    });
    await this.bufferManager.registerThread(threadId);
    this.dispatch({
      type: "chat-msg",
      msg: { type: "set-active-thread", id: threadId },
    });
    await this.syncActiveView();

    if (!this.sidebar.isVisible()) {
      await this.command("toggle");
    }

    const quotedLines: Line[] =
      prepopulate && prepopulate.length > 0
        ? ([...prepopulate.map((l) => `> ${l}`), "", ""] as Line[])
        : ([""] as Line[]);

    await this.activeBuffers.inputBuffer.setLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
      lines: quotedLines,
    });

    if (this.sidebar.state.state === "visible") {
      const inputWindow = this.sidebar.state.inputWindow;
      await this.nvim.call("nvim_set_current_win", [inputWindow.id]);
      const cursorRow = quotedLines.length;
      await inputWindow.setCursor({
        row: cursorRow,
        col: 0,
      } as Position1Indexed);
    }
    return threadId;
  }
  private handleSidebarMsg(msg: SidebarMsg): void {
    switch (msg.type) {
      case "setup-resubmit": {
        const wrapper = this.chat.threadWrappers[msg.threadId];
        if (!wrapper || wrapper.state !== "initialized") {
          this.nvim.logger.warn(
            `setup-resubmit: thread ${msg.threadId} not found or not initialized`,
          );
          break;
        }
        const buffers = this.bufferManager.getThreadBuffers(msg.threadId);
        if (!buffers) {
          break;
        }
        wrapper.thread.core.discardFailedSubmit();
        buffers.inputBuffer
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
      case "append-to-input": {
        const buffers = this.bufferManager.getThreadBuffers(msg.threadId);
        if (!buffers) {
          break;
        }
        (async () => {
          const existingLines = await buffers.inputBuffer.getLines({
            start: 0 as Row0Indexed,
            end: -1 as Row0Indexed,
          });
          const hasExistingText = existingLines.some(
            (line) => line.trim().length > 0,
          );
          const appendedLines = msg.text.split("\n") as Line[];
          const newLines = hasExistingText
            ? ([...existingLines, ...appendedLines] as Line[])
            : appendedLines;
          await buffers.inputBuffer.setLines({
            start: 0 as Row0Indexed,
            end: -1 as Row0Indexed,
            lines: newLines,
          });
        })().catch((error) => {
          this.nvim.logger.error(`Error appending to sidebar input: ${error}`);
        });
        break;
      }
      case "scroll-to-last-user-message": {
        const activeMountedApp = this.bufferManager.getMountedApp(
          this.getActiveKey(),
        );
        if (activeMountedApp) {
          (async () => {
            await activeMountedApp.waitForNextRender();
            await this.sidebar.scrollToLastUserMessage();
          })().catch((error: Error) =>
            this.nvim.logger.error(
              `Error scrolling to last user message: ${`${error.message}\n${error.stack}`}`,
            ),
          );
        }
        break;
      }
      case "set-cursor-to-bottom": {
        const activeMountedApp = this.bufferManager.getMountedApp(
          this.getActiveKey(),
        );
        if (activeMountedApp) {
          (async () => {
            await activeMountedApp.waitForRender();
            await this.sidebar.setCursorToBottom();
          })().catch((error: Error) =>
            this.nvim.logger.error(
              `Error setting cursor to bottom: ${`${error.message}\n${error.stack}`}`,
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
        if (this.getActiveKey() !== "overview") {
          this.dispatch({
            type: "sidebar-msg",
            msg: { type: "set-cursor-to-bottom" },
          });
        }
        break;
      }

      case "threads-overview": {
        this.dispatch({
          type: "chat-msg",
          msg: { type: "threads-overview" },
        });
        await this.syncActiveView();
        break;
      }

      case "sandbox-bypass": {
        const activeKey = this.getActiveKey();
        if (activeKey === "overview") {
          // In the overview, toggle whatever thread or script is under the
          // cursor by routing through the "t" binding.
          const mountedApp = this.bufferManager.getMountedApp(activeKey);
          if (mountedApp) {
            await mountedApp.onKey("t");
          }
        } else {
          this.dispatch({
            type: "thread-msg",
            id: activeKey,
            msg: { type: "toggle-sandbox-bypass" },
          });
        }
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

        const bufInfo = this.bufferManager.lookupBuffer(currentBuffer.id);
        let content: string;
        if (bufInfo?.role === "display") {
          content = `\n${formatAsQuote(lines.join("\n"))}\n`;
        } else {
          const absFilePath = resolveFilePath(
            this.cwd,
            await currentBuffer.getName(),
            this.homeDir,
          );
          content = `
Here is a snippet from the file \`${absFilePath}\`, lines ${startPos.row}-${endPos.row}:
\`\`\`${getMarkdownExt(absFilePath)}
${lines.join("\n")}
\`\`\`
`;
        }

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

  onKey(args: unknown[]) {
    const key = args[0] as string;
    const rawCtx = args[1] as { selection?: unknown } | undefined;
    let ctx: BindingCtx | undefined;
    if (rawCtx && Array.isArray(rawCtx.selection)) {
      ctx = { selection: rawCtx.selection.map((s) => String(s)) };
    }
    const mountedApp = this.bufferManager.getMountedApp(this.getActiveKey());
    if (mountedApp) {
      if (BINDING_KEYS.indexOf(key as BindingKey) > -1) {
        mountedApp.onKey(key as BindingKey, ctx).catch((err) => {
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

  /** A buffer was deleted (`:bd`/`:bw`). If it backs a thread, remove that
   * thread and its descendants (no escalation to the root ancestor). If it
   * backs the overview, recover by recreating the overview buffers. */
  async onBufDelete(bufNr: BufNr): Promise<void> {
    const bufInfo = this.bufferManager.lookupBuffer(bufNr);
    if (!bufInfo) return;

    if (bufInfo.key === "overview") {
      const wasActive = this.getActiveKey() === "overview";
      await this.bufferManager.recreateOverview();
      this.activeBuffers = this.bufferManager.getOverviewBuffers();
      if (wasActive) {
        await this.syncActiveView();
      }
      return;
    }

    this.dispatch({
      type: "chat-msg",
      msg: { type: "delete-thread-subtree", id: bufInfo.key },
    });
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
      await displayWindow.setBufferForced(displayBuffer);
    } else {
      const { inputBuffer } =
        await this.bufferManager.ensureActiveIsMounted(activeKey);
      await inputWindow.setBufferForced(inputBuffer);
    }

    // Move the non-magenta buffer to a non-magenta window
    const foreignBuffer = new NvimBuffer(bufNr, this.nvim);
    const targetWindow = await findOrCreateNonMagentaWindow({
      nvim: this.nvim,
      options: this.options,
    });
    await targetWindow.setBuffer(foreignBuffer);
  }

  async onClipboardImagePaste(): Promise<void> {
    const result = await probeAndSaveClipboardImage(this.nvim.logger);
    if (result.kind !== "image") {
      this.nvim.logger.warn(
        "magentaClipboardImagePaste: no image found in clipboard (or probe failed)",
      );
      return;
    }
    await this.pasteIntoActiveInputBuffer(formatFileRef(result.tmpPath));
  }

  async onClipboardTextPaste(
    text: string,
    fromDisplay?: boolean,
  ): Promise<void> {
    const content = fromDisplay ? formatAsQuote(text) : text;
    await this.pasteIntoActiveInputBuffer(content);
  }

  // Open the sidebar if it isn't visible, then append the given content to
  // the active thread's input buffer. Matches the paste-selection flow.
  private async pasteIntoActiveInputBuffer(content: string): Promise<void> {
    if (!this.sidebar.isVisible()) {
      await this.command("toggle");
    }
    await this.activeBuffers.inputBuffer.setLines({
      start: -1 as Row0Indexed,
      end: -1 as Row0Indexed,
      lines: content.split("\n") as Line[],
    });
  }

  async onWinClosed() {
    await this.sidebar.onWinClosed();
  }

  destroy() {
    this.scriptManager.terminateAll();
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
        magenta.onKey(args);
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

    nvim.onNotification(MAGENTA_CLIPBOARD_IMAGE_PASTE, async () => {
      try {
        await magenta.onClipboardImagePaste();
      } catch (err) {
        nvim.logger.error(
          err instanceof Error
            ? `Error in ClipboardImagePaste handler: ${err.message}\n${err.stack}`
            : JSON.stringify(err),
        );
      }
    });

    nvim.onNotification(MAGENTA_CLIPBOARD_TEXT_PASTE, async (args) => {
      try {
        const data = (
          args as unknown as { text: string; fromDisplay?: boolean }[]
        )[0];
        await magenta.onClipboardTextPaste(data.text, data.fromDisplay);
      } catch (err) {
        nvim.logger.error(
          err instanceof Error
            ? `Error in ClipboardTextPaste handler: ${err.message}\n${err.stack}`
            : JSON.stringify(err),
        );
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

    nvim.onNotification(MAGENTA_BUF_DELETE, async (args) => {
      try {
        const data = (args as unknown as { bufnr: number }[])[0];
        await magenta.onBufDelete(data.bufnr as BufNr);
      } catch (err) {
        nvim.logger.error(
          err instanceof Error
            ? `Error in BufDelete handler: ${err.message}\n${err.stack}`
            : JSON.stringify(err),
        );
      }
    });

    recordTiming("node: notifications registered");

    const opts = await nvim.call("nvim_exec_lua", [
      `return require('magenta').bridge(${nvim.channelId})`,
      [],
    ]);
    recordTiming("node: bridge call returned");

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

    // The sandbox owns exactly one global network-ask callback, but UI prompts
    // live in per-command handlers. Each in-flight sandboxed command pushes
    // itself as the active target; this callback forwards to the top of that
    // stack via routeNetworkAsk. An empty stack fails closed (deny). The
    // sandbox is created below, so we route through a mutable reference that is
    // assigned immediately after construction.
    let sandboxRef: Sandbox | undefined;
    const askCallback: SandboxAskCallback = (params) => {
      if (!sandboxRef) return Promise.resolve(false);
      return sandboxRef.routeNetworkAsk({
        host: params.host,
        port: params.port,
      });
    };

    const sandbox =
      sandboxOverride ??
      (await initializeSandbox(
        parsedOptions.sandbox,
        cwd,
        resolvedHomeDir,
        askCallback,
        { warn: (msg) => nvim.logger.warn(`Sandbox: ${msg}`) },
      ).catch((err) => {
        // strace is a hard requirement on Linux (no regex fallback). If it is
        // missing/cannot attach, refuse to start rather than silently degrading.
        if (err instanceof StraceUnavailableError) {
          throw err;
        }
        const reason = err instanceof Error ? err.message : String(err);
        nvim.logger.warn(
          `Failed to initialize sandbox, continuing without it: ${reason}`,
        );
        // Return an unsupported sandbox on failure
        return {
          getState: () => ({
            status: "unsupported" as const,
            reason: `initialization failed: ${reason}`,
          }),
          wrapWithSandbox: (cmd: string) => Promise.resolve(cmd),
          getViolationStore: () => ({
            getTotalCount: () => 0,
            getViolations: () => [],
            addViolation: () => {},
          }),
          annotateStderrWithSandboxFailures: (_cmd: string, stderr: string) =>
            stderr,
          getFsReadConfig: () => ({ denyOnly: [] }),
          getFsWriteConfig: () => ({ allowOnly: [], denyWithinAllow: [] }),
          updateConfigIfChanged: () => {},
          cleanupAfterCommand: () => {},
          pushNetworkAskTarget: () => {},
          popNetworkAskTarget: () => {},
          routeNetworkAsk: () => Promise.resolve(false),
          recordSessionApprovedHost: () => {},
        } satisfies Sandbox;
      }));
    sandboxRef = sandbox;

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

    recordTiming("node: sandbox + highlights initialized");

    const bufferManager = await BufferManager.create(nvim);

    recordTiming("node: bufferManager created");

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

    recordTiming("node: initial thread created");
    nvim.logger.info(`Magenta initialized. ${JSON.stringify(parsedOptions)}`);
    return magenta;
  }

  /** Preprocess user input text and dispatch the appropriate message.
   * Handles @fork, @compact, @async detection and command expansion.
   */
  private async preprocessAndSend(text: string): Promise<void> {
    const thread = this.chat.getActiveThread();

    // @compact: tell the thread to start compaction
    if (text.trim().startsWith("@compact")) {
      const rawNextPrompt = text.replace(/^\s*@compact\s*/, "").trim();
      // Reminders collected here are intentionally dropped: compaction clears
      // activeReminders, so activating them on this thread would have no effect.
      const nextMessages = rawNextPrompt
        ? (await this.processCommands(rawNextPrompt, thread)).messages
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

    // @async / @next: strip prefix and set queue flag.
    // @async injects into the current turn at the earliest opportunity;
    // @next waits until the agent next stops.
    // Note: @async @compact is not supported. Use @compact @async instead.
    const isAsync = text.trim().startsWith("@async");
    const isNext = text.trim().startsWith("@next");
    const queue = isAsync ? "async" : isNext ? "next" : undefined;
    const cleanText = isAsync
      ? text.replace(/^\s*@async\s*/, "")
      : isNext
        ? text.replace(/^\s*@next\s*/, "")
        : text;

    const { messages, reminders } = await this.processCommands(
      cleanText,
      thread,
    );

    this.dispatch({
      type: "thread-msg",
      id: thread.id,
      msg: {
        type: "send-message",
        messages,
        ...(queue ? { queue } : {}),
        ...(reminders.length ? { reminders } : {}),
      },
    });
  }

  /** Run CommandRegistry on user text, returning processed InputMessages. */
  private async processCommands(
    text: string,
    thread: import("./chat/thread.ts").Thread,
  ): Promise<{ messages: InputMessage[]; reminders: string[] }> {
    const { processedText, additionalContent, reminders } =
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

    return { messages, reminders };
  }
}
