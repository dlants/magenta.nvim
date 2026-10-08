import * as os from "node:os";
import {
  ABORTED,
  type Aborted,
  isSelectionAnchor,
  isThreadId,
  type MagentaServer,
  type NativeMessageIdx,
  OptionsStore,
  parseDelivery,
  pendingMessage,
  probeAndSaveClipboardImage,
  type ReflectAnchor,
  readArchivedThreadLog,
  readThreadMeta,
  renderThreadLogToMarkdown,
  type Sandbox,
  type ServerSessionHost,
  type SessionId,
  startSandbox,
  type ThreadId,
  threadConversationLogPath,
} from "@magenta/server";
import {
  archiveThreadKey,
  type BufferInfo,
  type BufferKey,
  BufferManager,
  bufferKeysEqual,
  threadKey,
} from "./buffer-manager.ts";
import { Lsp } from "./capabilities/lsp.ts";
import { Chat } from "./chat/chat.ts";
import { absolutizeFileRefs } from "./chat/commands/client-commands.ts";
import { createNvimClient } from "./chat/nvim-client.ts";
import { sliceDisplayBufferSelection } from "./chat/reflect-anchor.ts";
import {
  ReflectionsOverview,
  reflectionRoot,
} from "./chat/reflections-overview.ts";
import type { NvimThread } from "./chat/thread.ts";
import {
  type InProcessServer,
  startInProcessServer,
} from "./in-process-server.ts";
import {
  type BufNr,
  type Line,
  MAGENTA_HIGHLIGHT_NAMESPACE,
  NvimBuffer,
} from "./nvim/buffer.ts";
import { initializeMagentaHighlightGroups } from "./nvim/extmarks.ts";
import {
  getCurrentBuffer,
  getcwd,
  getpos,
  notify,
  notifyErr,
} from "./nvim/nvim.ts";
import type { Nvim } from "./nvim/nvim-node/index.ts";
import {
  findOrCreateNonMagentaWindow,
  openFileInNonMagentaWindow,
} from "./nvim/openFileInNonMagentaWindow.ts";
import {
  type ByteIdx,
  NvimWindow,
  type Position0Indexed,
  type Position1Indexed,
  pos1col1to0,
  type Row0Indexed,
  type WindowId,
} from "./nvim/window.ts";
import { openTargetUnderCursor } from "./open-target-under-cursor.ts";
import {
  type ClientOptions,
  getActiveProfile,
  type MagentaOptions,
  parseClientOptions,
} from "./options.ts";
import type { RootMsg, SidebarMsg } from "./root-msg.ts";
import { ScriptController } from "./scripts/script-manager.ts";
import {
  type ColumnChrome,
  type RightColumnTarget,
  Sidebar,
  type SidebarColumnName,
} from "./sidebar.ts";
import {
  BINDING_KEYS,
  type BindingCtx,
  type BindingKey,
  type BindingRange,
} from "./tea/bindings.ts";
import type { Dispatch } from "./tea/tea.ts";
import * as TEA from "./tea/tea.ts";
import { d } from "./tea/view.ts";
import { record as recordTiming } from "./timings.ts";
import { assertUnreachable } from "./utils/assertUnreachable.ts";
import type { HomeDir } from "./utils/files.ts";
import {
  type AbsFilePath,
  detectFileType,
  formatFileRef,
  type NvimCwd,
  resolveFilePath,
  threadCwdFromNvimCwd,
  type UnresolvedFilePath,
} from "./utils/files.ts";
import { getMarkdownExt } from "./utils/markdown.ts";

// these constants should match lua/magenta/init.lua
const MAGENTA_COMMAND = "magentaCommand";
const MAGENTA_ON_WINDOW_CLOSED = "magentaWindowClosed";
const MAGENTA_KEY = "magentaKey";
const MAGENTA_REFLECTIONS_CURSOR = "magentaReflectionsCursor";
const MAGENTA_SHOW_REFLECTIONS = "magentaShowReflections";

/** Visual selection as sent by lua's `listenToBufKey`: 0-indexed rows, byte
 * columns, and the full buffer lines the selection spans. */
function parsePosition(raw: unknown): Position0Indexed | undefined {
  if (
    !Array.isArray(raw) ||
    !Number.isInteger(raw[0]) ||
    !Number.isInteger(raw[1]) ||
    raw[0] < 0 ||
    raw[1] < 0
  ) {
    return undefined;
  }
  return { row: raw[0] as Row0Indexed, col: raw[1] as ByteIdx };
}
function parseVisualRange(raw: unknown): BindingRange | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const start = parsePosition(r.start);
  const end = parsePosition(r.end);
  if (!start || !end || !Array.isArray(r.lines)) return undefined;
  const lines = r.lines.map(String);
  const range = { start, end, linewise: r.linewise === true };
  return {
    ...range,
    text: sliceDisplayBufferSelection(lines, range),
  };
}
const MAGENTA_LSP_RESPONSE = "magentaLspResponse";
const MAGENTA_BUF_ENTER = "magentaBufEnter";
const MAGENTA_BUF_DELETE = "magentaBufDelete";
const MAGENTA_OPEN_ARCHIVED_THREAD_LOG = "magentaOpenArchivedThreadLog";
const MAGENTA_CLIPBOARD_IMAGE_PASTE = "magentaClipboardImagePaste";
const MAGENTA_CLIPBOARD_TEXT_PASTE = "magentaClipboardTextPaste";

function decodeArchivedThreadLogNotification(args: unknown[]): ThreadId {
  const payload = args[0];
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Invalid archived thread log notification payload");
  }
  const threadId = "threadId" in payload ? payload.threadId : undefined;
  if (!isThreadId(threadId)) {
    throw new Error("Invalid thread id in archived thread log notification");
  }
  return threadId;
}

function formatAsQuote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export class Magenta {
  public sidebar: Sidebar;
  public bufferManager: BufferManager;
  /** The one implicit session. */
  public sessionId: SessionId;
  /** White-box handles from the composition root; tests only. */
  public serverInternals: InProcessServer;
  /** Server-side thread preparation for that session. */
  public host: ServerSessionHost;
  /** The protocol boundary views read state from and send operations to. */
  public server: MagentaServer;
  public chat: Chat;
  /** The editor-side view of it. */
  public scriptManager: ScriptController;
  public dispatch: Dispatch<RootMsg>;
  /** Set by the `profile` command; server options only supply the default. */
  public activeBuffers: { displayBuffer: NvimBuffer; inputBuffer: NvimBuffer };
  private suppressDispatchRender = false;

  constructor(
    public nvim: Nvim,
    public lsp: Lsp,
    public cwd: NvimCwd,
    public homeDir: HomeDir,
    public optionsStore: OptionsStore,
    private clientOptions: ClientOptions,
    private sandbox: Sandbox,
    bufferManager: BufferManager,
  ) {
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

        if (msg.type === "show-reflections-overview") {
          this.showReflectionsOverview(msg.threadId).catch((e) => {
            nvim.logger.error(
              `Error showing reflections overview: ${e instanceof Error ? `${e.message}\n${e.stack}` : JSON.stringify(e)}`,
            );
          });
        }

        if (msg.type === "select-archived-thread-effect") {
          this.selectArchivedThread(msg.id).catch((e) => {
            nvim.logger.error(
              `Error selecting archived thread: ${e instanceof Error ? `${e.message}\n${e.stack}` : JSON.stringify(e)}`,
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
        // input buffer) rather than letting it flow into NvimThread.update.
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

        if (msg.type === "thread-msg" && msg.msg.type === "reflect-selection") {
          this.reflectAndSwitch(msg.id, msg.msg.anchor).catch((e) => {
            nvim.logger.error(
              `Error creating reflection: ${e instanceof Error ? `${e.message}\n${e.stack}` : JSON.stringify(e)}`,
            );
          });
          return;
        }

        this.chat.update(msg);
        this.scriptManager.update(msg);

        if (
          msg.type === "chat-msg" &&
          (msg.msg.type === "archive-open" ||
            msg.msg.type === "archive-navigate-back")
        ) {
          this.syncActiveView().catch((e) => {
            nvim.logger.error(
              `Error syncing archive view: ${e instanceof Error ? `${e.message}\n${e.stack}` : JSON.stringify(e)}`,
            );
          });
        }

        if (msg.type === "sidebar-msg") {
          this.handleSidebarMsg(msg.msg);
        }

        // Render only the active buffer's mounted app. Native jump handling
        // suppresses this because rendering can invalidate the forward jumplist.
        if (!this.suppressDispatchRender) {
          const activeMountedApp = this.bufferManager.getMountedApp(
            this.getActiveKey(),
          );
          if (activeMountedApp) {
            activeMountedApp.render();
          }
          const rightId = this.chat.rightThreadId;
          if (rightId) {
            this.bufferManager.getMountedApp(threadKey(rightId))?.render();
          }
          this.reflectionsOverview?.render();
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

    const hostContext = {
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
    };
    this.serverInternals = startInProcessServer({
      logger: this.nvim.logger,
      cwd: threadCwdFromNvimCwd(this.cwd),
      homeDir: this.homeDir,
      sandbox: this.sandbox,
      getBaseOptions: () => this.baseOptions,
      getScriptsPaths: () => this.options.scriptsPaths,
    });
    this.server = this.serverInternals.server;
    this.sessionId = this.serverInternals.sessionId;
    this.host = this.serverInternals.host;
    this.chat = new Chat(
      {
        ...hostContext,
        removeThreadBuffers: (ids) => {
          for (const id of ids) {
            bufferManager.removeThread(id).catch((e: Error) => {
              this.nvim.logger.error(
                `Error removing buffers for thread ${id}: ${e.message}`,
              );
            });
          }
        },
        removeArchivedThreadBuffers: (ids) => {
          for (const id of ids) {
            bufferManager.removeArchivedThread(id).catch((e: Error) => {
              this.nvim.logger.error(
                `Error removing buffer for archived thread ${id}: ${e.message}`,
              );
            });
          }
        },
      },
      {
        sessionId: this.sessionId,
        host: this.host,
        server: this.server,
        scriptRunner: this.serverInternals.scriptRunner,
      },
    );
    this.chat.getActiveReflectionId = () =>
      this.reflectionsOverview?.activeReflectionId ?? this.chat.rightThreadId;
    this.scriptManager = new ScriptController({
      dispatch: this.dispatch,
      chat: this.chat,
      server: this.server,
      sessionId: this.sessionId,
      nvim: this.nvim,
      cwd: this.cwd,
      homeDir: this.homeDir,
      getOptions: () => this.options,
    });
    this.bufferManager = bufferManager;
    this.activeBuffers = bufferManager.getOverviewBuffers();

    this.sidebar = new Sidebar(
      this.nvim,
      (column) => this.getColumnChrome(column),
      this.bufferManager,
      () => this.getActiveKey(),
    );
  }

  private async onUnhandledKey({ key }: { key: BindingKey }): Promise<void> {
    if (key !== "<CR>") return;
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

  private createThreadApp(threadId: ThreadId): TEA.App<unknown> {
    return TEA.createApp<Chat>({
      nvim: this.nvim,
      initialModel: this.chat,
      View: () => this.chat.renderSingleThread(threadId),
      onUnhandledKey: (ctx) => this.onUnhandledKey(ctx),
    });
  }

  private createOverviewApp(): TEA.App<unknown> {
    return TEA.createApp<Chat>({
      nvim: this.nvim,
      initialModel: this.chat,
      View: () =>
        d`${this.chat.renderThreadOverview()}${this.scriptManager.view()}`,
      onUnhandledKey: (ctx) => this.onUnhandledKey(ctx),
    });
  }

  private createArchiveApp(): TEA.App<unknown> {
    return TEA.createApp<Chat>({
      nvim: this.nvim,
      initialModel: this.chat,
      View: () => this.chat.renderArchive(),
      onUnhandledKey: (ctx) => this.onUnhandledKey(ctx),
    });
  }

  /** Options files without the session's profile selection; the host
   * resolves the selection against these, so reading them must not consult
   * the session. */
  private get baseOptions(): MagentaOptions {
    const serverOptions = this.optionsStore.getOptions(
      threadCwdFromNvimCwd(this.cwd),
    );
    return { ...serverOptions, ...this.clientOptions };
  }
  get options(): MagentaOptions {
    const base = this.baseOptions;
    // The session may not exist yet during construction.
    const activeProfile =
      this.server?.getState({ type: "session", sessionId: this.sessionId })
        ?.activeProfile.profile.name ?? base.activeProfile;
    return { ...base, activeProfile };
  }

  private columnThreadId(column: SidebarColumnName): ThreadId | undefined {
    return column === "left" ? this.chat.leftThreadId : this.chat.rightThreadId;
  }

  private getColumnChrome(column: SidebarColumnName): ColumnChrome {
    const threadId = this.columnThreadId(column);
    const wrapper = threadId ? this.chat.threadWrappers[threadId] : undefined;
    const thread =
      wrapper && wrapper.state === "initialized" ? wrapper.thread : undefined;
    return {
      profile: thread ? thread.context.profile : this.getActiveProfile(),
      tokenCount: thread ? thread.threadState.lastStopTokenCount : 0,
      status: !thread
        ? "none"
        : thread.isBusy
          ? "busy"
          : thread.threadState.run.type === "idle" &&
              thread.threadState.run.lastResult?.type === "failed"
            ? "failed"
            : "ok",
      sandboxBypassed:
        threadId !== undefined && this.chat.isSandboxBypassed(threadId),
    };
  }

  getActiveProfile() {
    return getActiveProfile(this.options.profiles, this.options.activeProfile);
  }

  getActiveKey(): BufferKey {
    switch (this.chat.state.state) {
      case "thread-selected":
        return threadKey(this.chat.state.left);
      case "archive":
        return { kind: "archive" };
      case "archive-thread-selected":
        return archiveThreadKey(this.chat.state.archivedThreadId);
      case "thread-overview":
        return { kind: "overview" };
      default:
        return assertUnreachable(this.chat.state);
    }
  }

  async selectThreadEffect(id: ThreadId): Promise<void> {
    this.dispatch({
      type: "chat-msg",
      msg: { type: "set-active-thread", id },
    });
    await this.syncActiveView();
    if (this.chat.rightThreadId === id) await this.focusRightInput();
    this.dispatch({
      type: "sidebar-msg",
      msg: { type: "set-cursor-to-bottom" },
    });
  }

  async selectArchivedThread(id: ThreadId): Promise<void> {
    this.dispatch({
      type: "chat-msg",
      msg: { type: "set-active-archive-thread", id },
    });
    await this.syncActiveView();
  }

  private async refreshArchivedThread(id: ThreadId): Promise<void> {
    const logPath = threadConversationLogPath(id);
    const [entries, meta] = await Promise.all([
      readArchivedThreadLog(id),
      readThreadMeta(id),
    ]);
    const markdown = renderThreadLogToMarkdown(entries);
    const cwdLine = meta.cwd ? `cwd: ${meta.cwd}\n` : "";
    const content = `# Archived thread\n${logPath}\n${cwdLine}\n${markdown}`;
    const buffer = await this.bufferManager.setArchivedThreadContent(
      id,
      content.split("\n") as Line[],
    );
    await buffer.setArchivedThreadKeymap(id, logPath);
  }

  async openArchivedThreadLog(id: ThreadId): Promise<void> {
    await openFileInNonMagentaWindow(threadConversationLogPath(id), {
      nvim: this.nvim,
      cwd: this.cwd,
      homeDir: this.homeDir,
      options: this.options,
    });
  }

  async createAndSwitchToNewThread(): Promise<ThreadId | Aborted> {
    const threadId = await this.chat.createThread({ type: "thread.create" });
    if (threadId === ABORTED) return ABORTED;
    await this.bufferManager.registerThread(threadId);
    this.dispatch({
      type: "chat-msg",
      msg: { type: "set-active-thread", id: threadId },
    });
    await this.syncActiveView();
    return threadId;
  }

  async createAndSwitchToAgentThread(
    agentName: string,
  ): Promise<ThreadId | Aborted> {
    const threadId = await this.chat.createThread({
      type: "thread.create",
      agent: agentName,
    });
    if (threadId === ABORTED) return ABORTED;
    await this.bufferManager.registerThread(threadId);
    this.dispatch({
      type: "chat-msg",
      msg: { type: "set-active-thread", id: threadId },
    });
    await this.syncActiveView();
    return threadId;
  }

  async forkAndSwitchToThread(
    sourceThreadId: ThreadId,
  ): Promise<ThreadId | Aborted> {
    const threadId = await this.chat.handleForkThread({ sourceThreadId });
    if (threadId === ABORTED) return ABORTED;
    await this.bufferManager.registerThread(threadId);
    this.dispatch({
      type: "chat-msg",
      msg: { type: "set-active-thread", id: threadId },
    });
    await this.syncActiveView();
    return threadId;
  }

  /** Creates a reflect thread on `anchor` without sending anything, shows it
   * in the right column, and leaves the cursor in its input buffer in insert
   * mode. */
  async reflectAndSwitch(
    sourceThreadId: ThreadId,
    anchor: ReflectAnchor | undefined,
  ): Promise<ThreadId | Aborted> {
    const duplicate =
      anchor &&
      this.chat.session
        .listDerived(sourceThreadId, "reflect")
        .some(
          ({ origin }) =>
            isSelectionAnchor(origin.anchor) &&
            origin.anchor.messageIdx === anchor.messageIdx &&
            origin.anchor.contentIdx === anchor.contentIdx &&
            origin.anchor.reflectionText === anchor.reflectionText,
        );
    if (duplicate) {
      await notify(this.nvim, "This selection already has a reflection.");
      return ABORTED;
    }
    const threadId = await this.chat.createThread({
      type: "thread.reflect",
      threadId: sourceThreadId,
      ...(anchor ? { anchor } : {}),
    });
    if (threadId === ABORTED) return ABORTED;
    await this.bufferManager.registerThread(threadId);
    this.dispatch({
      type: "chat-msg",
      msg: { type: "reflect-created", parent: sourceThreadId, child: threadId },
    });
    if (!this.sidebar.isVisible()) {
      await this.command("toggle");
    } else {
      await this.syncActiveView();
    }
    // Two columns only exist for left/right positions; otherwise the
    // reflection is reachable but not on screen.
    const input = this.sidebar.getRightWindows()?.inputWindow;
    if (input) {
      await this.nvim.call("nvim_set_current_win", [input.id]);
      await this.nvim.call("nvim_command", ["startinsert"]);
    } else {
      await notify(
        this.nvim,
        "Reflection created; the sidebar position only shows one column.",
      );
    }
    return threadId;
  }

  private reflectionsOverview: ReflectionsOverview | undefined;

  /** Reflections of the visible thread, else of the thread that last held
   * the cursor; a reflection resolves to its source. */
  async showReflectionsForCurrentThread(): Promise<void> {
    const target = this.chat.externalTarget(this.sidebar.isVisible());
    if (!target) {
      await notify(this.nvim, "No thread to show reflections for.");
      return;
    }
    const origin = this.chat.session.getOrigin(target);
    await this.showReflectionsOverview(
      origin?.type === "reflect" ? origin.sourceThreadId : target,
    );
  }

  /** Shows the reflection overview for `threadId` in the right column and
   * focuses it. */
  async showReflectionsOverview(threadId: ThreadId): Promise<void> {
    this.dispatch({
      type: "chat-msg",
      msg: { type: "show-reflections-overview", thread: threadId },
    });
    if (!this.sidebar.isVisible()) {
      await this.command("toggle");
    } else {
      await this.syncActiveView();
    }
    const display = this.sidebar.getRightWindows()?.displayWindow;
    if (display) {
      await this.nvim.call("nvim_set_current_win", [display.id]);
    }
  }

  /** Creates or keeps the overview so it matches the right pane. A replaced
   * overview is returned as `retired`: close it only once its buffer has left
   * the right window, since deleting a shown buffer closes the window. */
  private async syncReflectionsOverview(): Promise<{
    overview: ReflectionsOverview | undefined;
    retired: ReflectionsOverview | undefined;
  }> {
    const state = this.chat.state;
    const wanted =
      state.state === "thread-selected" &&
      state.right?.type === "reflections-overview"
        ? reflectionRoot(this.chat.session, state.left)
        : undefined;
    const current = this.reflectionsOverview;
    if (current && current.threadId === wanted) {
      return { overview: current, retired: undefined };
    }
    const retired = current;
    if (retired) {
      this.reflectionsOverview = undefined;
      this.renderActiveReflectionSource(retired.activeReflectionId);
    }
    if (!wanted) return { overview: undefined, retired };
    this.reflectionsOverview = await ReflectionsOverview.open({
      nvim: this.nvim,
      threadId: wanted,
      session: this.chat.session,
      label: (childId) => this.chat.getThreadDisplayName(childId),
      onOpen: (childId) => {
        // Deferred: this runs inside the overview app's key handler, and
        // syncing disposes that app.
        const origin = this.chat.session.getOrigin(childId);
        if (origin?.type !== "reflect") return;
        setTimeout(
          () => this.openReflection(origin.sourceThreadId, childId),
          0,
        );
      },
      onDelete: (childId) => {
        const origin = this.chat.session.getOrigin(childId);
        void this.chat.deleteThread(childId).then(() => {
          this.reflectionsOverview?.render();
          if (origin?.type === "reflect") {
            this.bufferManager
              .getMountedApp(threadKey(origin.sourceThreadId))
              ?.render();
          }
        });
      },
    });
    return { overview: this.reflectionsOverview, retired };
  }

  /** Re-renders the thread a reflection hangs off, e.g. after it stops being
   * the active one. */
  private renderActiveReflectionSource(childId: ThreadId | undefined): void {
    if (!childId) return;
    const origin = this.chat.session.getOrigin(childId);
    if (origin?.type !== "reflect") return;
    this.bufferManager
      .getMountedApp(threadKey(origin.sourceThreadId))
      ?.render();
  }

  private openReflection(parent: ThreadId, childId: ThreadId): void {
    this.dispatch({
      type: "chat-msg",
      msg: { type: "show-reflection", parent, child: childId },
    });
    this.syncActiveView()
      .then(() => this.focusRightInput())
      .catch((e: Error) =>
        this.nvim.logger.error(`Error opening reflection: ${e.message}`),
      );
  }

  private async focusRightInput(): Promise<void> {
    const input = this.sidebar.getRightWindows()?.inputWindow;
    if (input) await this.nvim.call("nvim_set_current_win", [input.id]);
  }

  /** Moves the cursor to `reflectionId`'s highlight in whichever column now
   * shows its source thread. Returns false if it isn't on screen. */
  private async focusReflectionSource(
    reflectionId: ThreadId,
  ): Promise<boolean> {
    const origin = this.chat.session.getOrigin(reflectionId);
    if (origin?.type !== "reflect") return false;
    const source = origin.sourceThreadId;
    const window =
      this.chat.rightThreadId === source
        ? this.sidebar.getRightWindows()?.displayWindow
        : this.chat.leftThreadId === source
          ? (await this.sidebar.getWindowIfVisible()).displayWindow
          : undefined;
    const app = this.bufferManager.getMountedApp(threadKey(source));
    if (!window || !app || !(await window.valid())) return false;
    await app.waitForRender();
    const highlight = app.getHighlightPos(reflectionId);
    if (!highlight) return false;
    await this.nvim.call("nvim_set_current_win", [window.id]);
    await this.nvim.call("nvim_exec_lua", [
      `local row, col = ...
      vim.api.nvim_win_set_cursor(0, { row, col })
      vim.cmd("normal! zz")`,
      [highlight.startPos.row + 1, highlight.startPos.col],
    ]);
    return true;
  }

  /** Focuses the right column's input if it has one, else the left input. */
  private async focusRightmostInput(): Promise<void> {
    const input =
      this.sidebar.getRightWindows()?.inputWindow ??
      (await this.sidebar.getWindowIfVisible()).inputWindow;
    if (input && (await input.valid())) {
      await this.nvim.call("nvim_set_current_win", [input.id]);
    }
  }

  /** Shows the entry's source thread in the left column and centres the
   * entry's highlight there without moving focus, and marks it active. */
  async onReflectionsCursor(line: number): Promise<void> {
    const overview = this.reflectionsOverview;
    if (!overview) return;
    const entry = overview.entryAt(line);
    const source = entry?.origin.sourceThreadId;
    if (source && this.chat.leftThreadId !== source) {
      this.dispatch({
        type: "chat-msg",
        msg: { type: "show-reflections-overview", thread: source },
      });
      await this.syncActiveView();
    }
    const previous = overview.activeReflectionId;
    const leftApp =
      source && this.bufferManager.getMountedApp(threadKey(source));
    if (previous !== entry?.threadId) {
      overview.activeReflectionId = entry?.threadId;
      this.renderActiveReflectionSource(previous);
      if (leftApp) {
        leftApp.render();
        await leftApp.waitForRender();
      }
    }
    if (!entry || !leftApp || this.sidebar.state.state !== "visible") return;
    if (!(await this.sidebar.state.displayWindow.valid())) return;
    const highlight = leftApp.getHighlightPos(entry.threadId);
    if (!highlight) return;
    await this.nvim.call("nvim_exec_lua", [
      `local win, row, col = ...
      vim.api.nvim_win_call(win, function()
        vim.api.nvim_win_set_cursor(0, { row, col })
        vim.cmd("normal! zz")
      end)`,
      [
        this.sidebar.state.displayWindow.id,
        highlight.startPos.row + 1,
        highlight.startPos.col,
      ],
    ]);
  }

  async forkAtMessageAndSwitch(
    sourceThreadId: ThreadId,
    nativeMessageIdx: NativeMessageIdx,
    prepopulate?: string[],
  ): Promise<ThreadId | Aborted> {
    const threadId = await this.chat.handleForkThread({
      sourceThreadId,
      truncateAtMessageIdx: nativeMessageIdx,
    });
    if (threadId === ABORTED) return ABORTED;
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
    if (activeKey.kind === "overview") {
      this.activeBuffers = this.bufferManager.getOverviewBuffers();
      if (this.sidebar.state.state === "visible") {
        const { displayWindow, inputWindow } = this.sidebar.state;
        this.activeBuffers = await this.bufferManager.switchToOverview(
          displayWindow,
          inputWindow,
        );
      }
    } else if (activeKey.kind === "archive") {
      this.activeBuffers = this.bufferManager.getArchiveBuffers();
      if (this.sidebar.state.state === "visible") {
        const { displayWindow, inputWindow } = this.sidebar.state;
        this.activeBuffers = await this.bufferManager.switchToArchive(
          displayWindow,
          inputWindow,
        );
      }
    } else if (activeKey.kind === "archived-thread") {
      this.activeBuffers = await this.bufferManager.registerArchivedThread(
        activeKey.threadId,
      );
      await this.refreshArchivedThread(activeKey.threadId);
      if (this.sidebar.state.state === "visible") {
        const { displayWindow, inputWindow } = this.sidebar.state;
        this.activeBuffers = await this.bufferManager.switchToArchivedThread(
          activeKey.threadId,
          displayWindow,
          inputWindow,
        );
      }
    } else {
      this.activeBuffers = await this.bufferManager.registerThread(
        activeKey.threadId,
      );
      if (this.sidebar.state.state === "visible") {
        const { displayWindow, inputWindow } = this.sidebar.state;
        this.activeBuffers = await this.bufferManager.switchToThread(
          activeKey.threadId,
          displayWindow,
          inputWindow,
        );
      }
    }
    await this.syncRightColumn();
  }

  /** Binds the right column to the right pane, opening or closing it. */
  private async syncRightColumn(): Promise<void> {
    const { overview, retired } = await this.syncReflectionsOverview();
    const rightId = this.chat.rightThreadId;
    let target: RightColumnTarget;
    if (overview) {
      target = { type: "overview", displayBuffer: overview.buffer };
    } else if (rightId) {
      const buffers = await this.bufferManager.ensureActiveIsMounted(
        threadKey(rightId),
      );
      target = {
        type: "thread",
        displayBuffer: buffers.displayBuffer,
        inputBuffer: buffers.inputBuffer,
      };
    }
    this.handlingBufEnter = true;
    try {
      await this.sidebar.syncRight(target);
    } finally {
      this.handlingBufEnter = false;
    }
    await retired?.close();
  }

  /** The thread owning a magenta display/input buffer, if any. */
  private bufferThreadId(bufnr: BufNr): ThreadId | undefined {
    const key = this.bufferManager.keyForBuffer(bufnr);
    return key?.kind === "thread" ? key.threadId : undefined;
  }

  /** Thread for commands from outside magenta; see `Chat.externalTarget`. */
  private externalTargetThread(): NvimThread | undefined {
    const id = this.chat.externalTarget(this.sidebar.isVisible());
    if (!id) {
      notifyErr(this.nvim, "command", new Error("No magenta thread to target"));
      return undefined;
    }
    return this.chat.getThread(id);
  }

  /** Buffer-scoped when invoked from a thread buffer, external otherwise. */
  private commandTargetThread(bufnr: BufNr): NvimThread | undefined {
    const id = this.bufferThreadId(bufnr);
    return id ? this.chat.getThread(id) : this.externalTargetThread();
  }

  /** Make sure `threadId` is what the sidebar shows, opening it if needed. */
  private async revealThread(threadId: ThreadId): Promise<void> {
    if (!this.chat.shownThreadIds().includes(threadId)) {
      this.dispatch({
        type: "chat-msg",
        msg: { type: "set-active-thread", id: threadId },
      });
      await this.syncActiveView();
    }
    if (!this.sidebar.isVisible()) {
      await this.command("toggle");
    }
  }

  /** Lua reads profiles (picker) and custom commands (completion), which are
   * server configuration. */
  async syncServerOptionsToLua(): Promise<void> {
    const { profiles, customCommands, activeProfile } = this.options;
    try {
      await this.nvim.call("nvim_exec_lua", [
        `require('magenta.options').setServerOptions(...)`,
        [{ profiles, customCommands, activeProfile }],
      ]);
    } catch (e) {
      this.nvim.logger.error(`Failed to sync options to lua: ${String(e)}`);
    }
  }

  /** `bufnr` is the buffer the command was invoked from (lua always sends
   * it). Programmatic callers that omit it act as if invoked from the
   * sidebar's input buffer. */
  async command(input: string, bufnr?: BufNr): Promise<void> {
    const invokingBuf = bufnr ?? this.activeBuffers.inputBuffer.id;
    const [command, ...rest] = input.trim().split(/\s+/);
    this.nvim.logger.debug(`Received command ${command}`);
    // Profiles and custom commands feed lua pickers/completion; the options
    // files may have changed since the last command.
    void this.syncServerOptionsToLua();
    switch (command) {
      case "profile": {
        const profileName = rest.join(" ");
        try {
          await this.chat.execute({
            type: "session.setActiveProfile",
            sessionId: this.chat.sessionId,
            name: profileName,
          });
          void this.syncServerOptionsToLua();
        } catch (e) {
          this.nvim.logger.error(String(e));
          notifyErr(this.nvim, "profile command", e);
        }
        break;
      }

      case "context-files": {
        if (!this.sidebar.isVisible()) {
          await this.command("toggle");
        }

        const thread = this.externalTargetThread();
        if (!thread) break;

        const parts = input.trim().match(/[^\s']+|'([^']*)'|\S+/g) || [];
        const paths = parts
          .slice(1)
          .map((str) => (str.startsWith("'") ? str.slice(1, -1) : str))
          .map((str) => str.trim());

        const files: AbsFilePath[] = [];
        for (const filePath of paths) {
          const absFilePath = resolveFilePath(
            this.cwd,
            filePath as UnresolvedFilePath,
            this.homeDir,
          );
          const fileTypeInfo = await detectFileType(absFilePath);
          if (!fileTypeInfo) {
            this.nvim.logger.error(`File ${filePath} does not exist.`);
            continue;
          }

          files.push(absFilePath);
        }
        const result = await this.server.execute({
          type: "thread.addContextFiles",
          threadId: thread.id,
          files,
        });
        if (result.type === "error") this.nvim.logger.error(result.message);
        break;
      }

      case "toggle": {
        const shown = await this.sidebar.toggle(
          this.options.sidebarPosition,
          this.options.sidebarPositionOpts,
        );
        // The right column follows `right`, which survives hiding.
        if (shown) await this.syncRightColumn();
        break;
      }

      case "send": {
        const key = this.bufferManager.lookupBuffer(invokingBuf);
        if (!(key?.role === "input" && key.key.kind === "thread")) break;
        const threadId = key.key.threadId;
        const text = await this.sidebar.getMessage(
          new NvimBuffer(invokingBuf, this.nvim),
        );
        this.nvim.logger.debug(`current message: ${text}`);
        if (!text) {
          // Enter on an empty input after a failure retries it: the failed
          // submission is still in the log, so there is nothing to retype.
          this.dispatch({
            type: "thread-msg",
            id: threadId,
            msg: { type: "retry" },
          });
          return;
        }

        await this.preprocessAndSend(threadId, text);
        break;
      }

      case "abort": {
        const thread = this.commandTargetThread(invokingBuf);
        if (!thread) break;
        this.dispatch({
          type: "thread-msg",
          id: thread.id,
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

      case "reflections": {
        const threadId = this.bufferThreadId(invokingBuf);
        if (threadId) await this.showReflectionsOverview(threadId);
        break;
      }

      case "threads-navigate-up": {
        const rightThreadId = this.chat.rightThreadId;
        const poppedReflection =
          rightThreadId && this.bufferThreadId(invokingBuf) === rightThreadId
            ? rightThreadId
            : undefined;
        this.dispatch({
          type: "chat-msg",
          msg: { type: "reflect-navigate-up" },
        });
        await this.syncActiveView();
        if (
          poppedReflection &&
          (await this.focusReflectionSource(poppedReflection))
        ) {
          break;
        }
        await this.focusRightmostInput();
        if (
          this.chat.state.state === "thread-selected" ||
          this.chat.state.state === "archive-thread-selected"
        ) {
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
        const activeKey =
          this.bufferManager.keyForBuffer(invokingBuf) ?? this.getActiveKey();
        if (activeKey.kind === "overview") {
          // In the overview, toggle whatever thread or script is under the
          // cursor by routing through the "t" binding.
          const mountedApp = this.bufferManager.getMountedApp(activeKey);
          if (mountedApp) {
            await mountedApp.onKey("t");
          }
        } else if (activeKey.kind === "thread") {
          this.dispatch({
            type: "thread-msg",
            id: activeKey.threadId,
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

        await this.pasteIntoExternalTarget(content);
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
    const rawCtx = args[1] as
      | { selection?: unknown; range?: unknown }
      | undefined;
    let ctx: BindingCtx | undefined;
    if (rawCtx && Array.isArray(rawCtx.selection)) {
      const range = parseVisualRange(rawCtx.range);
      ctx = {
        selection: {
          lines: rawCtx.selection.map((s) => String(s)),
          ...(range ? { range } : {}),
        },
      };
    }
    getCurrentBuffer(this.nvim)
      .then((buf) =>
        this.dispatchKey(this.mountedAppForBuffer(buf.id), key, ctx),
      )
      .catch((err: Error) => this.nvim.logger.error(err));
  }

  /** Keys go to the app of the buffer they were pressed in. */
  private mountedAppForBuffer(bufNr: BufNr): TEA.MountedApp | undefined {
    const overview = this.reflectionsOverview;
    if (overview && overview.buffer.id === bufNr) return overview.mountedApp;
    const key = this.bufferManager.keyForBuffer(bufNr);
    return this.bufferManager.getMountedApp(
      key && key.kind !== "shared-input" ? key : this.getActiveKey(),
    );
  }

  private dispatchKey(
    mountedApp: TEA.MountedApp | undefined,
    key: string,
    ctx: BindingCtx | undefined,
  ) {
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
    const enteredThreadId = this.bufferThreadId(bufNr);
    // nvim_win_set_buf on a non-current window also fires BufEnter (the
    // window is made current temporarily), so confirm the cursor is really
    // there before recording it.
    if (enteredThreadId) {
      getCurrentBuffer(this.nvim)
        .then((buf) => {
          if (buf.id === bufNr) this.chat.recordCursorThread(enteredThreadId);
        })
        .catch((err: Error) => this.nvim.logger.error(err));
    }
    if (this.handlingBufEnter) return;
    if (this.sidebar.state.state !== "visible") return;
    // The right column is bound by syncRightColumn; entering it is not a
    // selection.
    if (this.sidebar.columnOfWindow(winId) === "right") return;
    if (this.reflectionsOverview?.buffer.id === bufNr) return;
    const enteredRight = this.chat.rightThreadId;
    if (enteredRight && enteredThreadId === enteredRight) return;

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

  /** Recover or unregister the view identity associated with a deleted buffer. */
  async onBufDelete(bufNr: BufNr): Promise<void> {
    if (this.reflectionsOverview?.buffer.id === bufNr) {
      this.dispatch({ type: "chat-msg", msg: { type: "close-right-pane" } });
      await this.syncActiveView();
      return;
    }
    const bufInfo = this.bufferManager.lookupBuffer(bufNr);
    if (!bufInfo) return;

    if (bufInfo.key.kind === "shared-input") {
      await this.bufferManager.recreateSharedInput();
      await this.syncActiveView();
      return;
    }

    if (bufInfo.key.kind === "overview") {
      const wasActive = this.getActiveKey().kind === "overview";
      await this.bufferManager.recreateOverview();
      if (wasActive) await this.syncActiveView();
      return;
    }

    if (bufInfo.key.kind === "archive") {
      const wasActive = this.getActiveKey().kind === "archive";
      await this.bufferManager.recreateArchive();
      if (wasActive) await this.syncActiveView();
      return;
    }

    if (bufInfo.key.kind === "archived-thread") {
      await this.bufferManager.removeArchivedThread(bufInfo.key.threadId);
      if (bufferKeysEqual(this.getActiveKey(), bufInfo.key)) {
        this.dispatch({
          type: "chat-msg",
          msg: { type: "threads-navigate-up" },
        });
        await this.syncActiveView();
      }
      return;
    }

    // `:bd` closes, it never deletes: drop the buffers (recreated lazily when
    // the thread is shown again) and exit reflection mode.
    const threadId = bufInfo.key.threadId;
    await this.bufferManager.removeThread(threadId);
    if (this.chat.rightThreadId === threadId) {
      this.dispatch({ type: "chat-msg", msg: { type: "close-right-pane" } });
    } else if (this.chat.leftThreadId === threadId) {
      this.dispatch({ type: "chat-msg", msg: { type: "threads-overview" } });
    } else {
      return;
    }
    await this.syncActiveView();
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

    const currentKey = this.getActiveKey();
    const targetKey: BufferKey =
      bufInfo.key.kind === "shared-input"
        ? currentKey.kind === "archive" || currentKey.kind === "archived-thread"
          ? currentKey
          : { kind: "overview" }
        : bufInfo.key;

    // If already showing the correct thread in the correct role, nothing to do
    if (isMagentaWindow && bufferKeysEqual(targetKey, currentKey)) {
      const isDisplayWindow = winId === displayWindow.id;
      const isCorrectRole =
        (isDisplayWindow && bufInfo.role === "display") ||
        (!isDisplayWindow && bufInfo.role === "input");
      if (isCorrectRole) return;
    }

    // Update state first, then preserve the display window that native jump
    // navigation just entered so Neovim's forward jumplist remains intact.
    this.suppressDispatchRender = true;
    try {
      if (targetKey.kind === "overview") {
        this.dispatch({
          type: "chat-msg",
          msg: { type: "threads-overview" },
        });
      } else if (targetKey.kind === "archive") {
        this.dispatch({ type: "chat-msg", msg: { type: "archive-restore" } });
      } else if (targetKey.kind === "archived-thread") {
        this.dispatch({
          type: "chat-msg",
          msg: {
            type: "set-active-archive-thread",
            id: targetKey.threadId,
          },
        });
      } else {
        this.dispatch({
          type: "chat-msg",
          msg: { type: "set-active-thread", id: targetKey.threadId },
        });
      }
    } finally {
      this.suppressDispatchRender = false;
    }

    if (!isMagentaWindow) {
      await this.syncActiveView();
      return;
    }

    const activeKey = this.getActiveKey();
    const buffers = await this.bufferManager.ensureActiveIsMounted(activeKey);
    if (activeKey.kind === "archived-thread") {
      await this.refreshArchivedThread(activeKey.threadId);
    }
    this.activeBuffers = buffers;
    const isDisplayWindow = winId === displayWindow.id;
    const enteredCorrectRole =
      (isDisplayWindow && bufInfo.role === "display") ||
      (!isDisplayWindow && bufInfo.role === "input");

    if (enteredCorrectRole && isDisplayWindow) {
      await inputWindow.setBuffer(buffers.inputBuffer);
    } else if (enteredCorrectRole) {
      await displayWindow.setBuffer(buffers.displayBuffer);
    } else {
      await Promise.all([
        displayWindow.setBuffer(buffers.displayBuffer),
        inputWindow.setBuffer(buffers.inputBuffer),
      ]);
    }
    await this.sidebar.renderInputHeader();
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

  async onClipboardImagePaste(): Promise<void> {
    const result = await probeAndSaveClipboardImage(this.nvim.logger);
    if (result.kind !== "image") {
      this.nvim.logger.warn(
        "magentaClipboardImagePaste: no image found in clipboard (or probe failed)",
      );
      return;
    }
    await this.pasteIntoExternalTarget(formatFileRef(result.tmpPath));
  }

  async onClipboardTextPaste(
    text: string,
    fromDisplay?: boolean,
  ): Promise<void> {
    const content = fromDisplay ? formatAsQuote(text) : text;
    await this.pasteIntoExternalTarget(content);
  }

  /** Show the external target thread, then append `content` to its input. */
  private async pasteIntoExternalTarget(content: string): Promise<void> {
    const thread = this.externalTargetThread();
    if (!thread) return;
    await this.revealThread(thread.id);
    await this.activeBuffers.inputBuffer.setLines({
      start: -1 as Row0Indexed,
      end: -1 as Row0Indexed,
      lines: content.split("\n") as Line[],
    });
  }

  async onWinClosed() {
    const { rightClosed } = await this.sidebar.onWinClosed();
    if (rightClosed) {
      this.dispatch({ type: "chat-msg", msg: { type: "close-right-pane" } });
      await (await this.syncReflectionsOverview()).retired?.close();
    }
  }

  destroy() {
    this.scriptManager.dispose();
    this.chat.dispose();
    void this.server
      .dispose()
      .catch((e: Error) =>
        this.nvim.logger.error(`Error disposing server: ${e.message}`),
      );
    // BufferManager's mounted apps will be cleaned up when nvim exits
  }

  static async start(nvim: Nvim, homeDir?: HomeDir, sandboxOverride?: Sandbox) {
    let magenta: Magenta | undefined;
    const getMagenta = (): Magenta => {
      if (!magenta) {
        throw new Error("Magenta used before initialization");
      }
      return magenta;
    };
    // Notifications can arrive between `bridge()` (which registers the autocmds
    // on the lua side) and the end of this async initialization. Lifecycle
    // events (buf enter/delete, window closed) are safe to drop in that window;
    // dropping them beats logging a scary "used before initialization" error.
    const getMagentaIfReady = (): Magenta | undefined => magenta;
    const lsp = new Lsp(nvim);
    nvim.onNotification(MAGENTA_COMMAND, async (args: unknown[]) => {
      const input = args[0];
      if (typeof input !== "string") {
        nvim.logger.error(`Invalid magenta command: ${JSON.stringify(args)}`);
        return;
      }
      try {
        await getMagenta().command(
          input,
          typeof args[1] === "number" ? (args[1] as BufNr) : undefined,
        );
      } catch (err) {
        nvim.logger.error(
          err instanceof Error
            ? `Error executing command ${input}: ${err.message}\n${err.stack}`
            : JSON.stringify(err),
        );
        notifyErr(nvim, `error processing command ${input}`, err);
      }
    });

    nvim.onNotification(MAGENTA_ON_WINDOW_CLOSED, async () => {
      try {
        await getMagentaIfReady()?.onWinClosed();
      } catch (err) {
        nvim.logger.error(err as Error);
      }
    });

    nvim.onNotification(MAGENTA_SHOW_REFLECTIONS, async () => {
      try {
        await getMagentaIfReady()?.showReflectionsForCurrentThread();
      } catch (err) {
        nvim.logger.error(err as Error);
      }
    });
    nvim.onNotification(MAGENTA_REFLECTIONS_CURSOR, async (args) => {
      try {
        const line = parseReflectionsCursorLine(args);
        if (line === undefined) {
          nvim.logger.error(`Invalid reflections cursor payload`);
          return;
        }
        await getMagentaIfReady()?.onReflectionsCursor(line);
      } catch (err) {
        nvim.logger.error(err as Error);
      }
    });

    nvim.onNotification(MAGENTA_KEY, (args) => {
      try {
        getMagenta().onKey(args);
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
        await getMagenta().onClipboardImagePaste();
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
        await getMagenta().onClipboardTextPaste(data.text, data.fromDisplay);
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
        await getMagentaIfReady()?.onBufEnter(
          data.bufnr as BufNr,
          data.winid as WindowId,
        );
      } catch (err) {
        nvim.logger.error(
          err instanceof Error
            ? `Error in BufEnter handler: ${err.message}\n${err.stack}`
            : JSON.stringify(err),
        );
      }
    });

    nvim.onNotification(
      MAGENTA_OPEN_ARCHIVED_THREAD_LOG,
      async (args: unknown[]) => {
        try {
          const threadId = decodeArchivedThreadLogNotification(args);
          await getMagenta().openArchivedThreadLog(threadId);
        } catch (err) {
          nvim.logger.error(
            err instanceof Error
              ? `Error opening archived thread log: ${err.message}\n${err.stack}`
              : JSON.stringify(err),
          );
        }
      },
    );
    nvim.onNotification(MAGENTA_BUF_DELETE, async (args) => {
      try {
        const data = (args as unknown as { bufnr: number }[])[0];
        await getMagentaIfReady()?.onBufDelete(data.bufnr as BufNr);
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

    const clientOptions = parseClientOptions(opts, {
      warn: (msg) => nvim.logger.warn(`Settings: ${msg}`),
    });
    // Determine home directory - use provided value or fall back to os.homedir()
    const resolvedHomeDir = homeDir ?? (os.homedir() as HomeDir);
    // Get the current working directory
    const cwd = await getcwd(nvim);
    const optionsStore = new OptionsStore(resolvedHomeDir, nvim.logger);
    const threadCwd = threadCwdFromNvimCwd(cwd);
    const sandbox =
      sandboxOverride ??
      (await startSandbox(
        optionsStore.getOptions(threadCwd).sandbox,
        threadCwd,
        resolvedHomeDir,
        nvim.logger,
      ));

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

    const bufferManager = await BufferManager.create(nvim, {
      createThreadApp: (threadId) => getMagenta().createThreadApp(threadId),
      createOverviewApp: () => getMagenta().createOverviewApp(),
      createArchiveApp: () => getMagenta().createArchiveApp(),
    });

    recordTiming("node: bufferManager created");

    magenta = new Magenta(
      nvim,
      lsp,
      cwd,
      resolvedHomeDir,
      optionsStore,
      clientOptions,
      sandbox,
      bufferManager,
    );
    magenta.server.attachClient(
      await createNvimClient({ nvim, lsp, cwd, homeDir: resolvedHomeDir }),
    );

    await magenta.syncServerOptionsToLua();
    // Create the first thread eagerly so there's always an active thread
    const initialThreadId = await magenta.chat.createThread({
      type: "thread.create",
    });
    if (initialThreadId === ABORTED)
      throw new Error("initial thread creation was aborted");
    magenta.activeBuffers =
      await magenta.bufferManager.registerThread(initialThreadId);
    magenta.dispatch({
      type: "chat-msg",
      msg: { type: "set-active-thread", id: initialThreadId },
    });

    recordTiming("node: initial thread created");
    nvim.logger.info(`Magenta initialized. ${JSON.stringify(magenta.options)}`);
    return magenta;
  }

  /** Parse *when* the user's text should go out and hand it to the thread,
   * which resolves the rest of it — `@compact` included — at delivery. */
  private async preprocessAndSend(
    threadId: ThreadId,
    text: string,
  ): Promise<void> {
    const { delivery, message } = parseDelivery(text);
    const submission = {
      delivery,
      message: pendingMessage(
        absolutizeFileRefs(message, this.cwd, this.homeDir),
      ),
    };
    this.dispatch({
      type: "thread-msg",
      id: threadId,
      msg: { type: "submit-message", submission },
    });
  }
}

function parseReflectionsCursorLine(args: unknown): number | undefined {
  if (!Array.isArray(args)) return undefined;
  const payload: unknown = args[0];
  if (typeof payload !== "object" || payload === null) return undefined;
  const line: unknown = (payload as { line?: unknown }).line;
  return typeof line === "number" && Number.isInteger(line) ? line : undefined;
}
