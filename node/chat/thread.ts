import * as fs from "node:fs/promises";
import type {
  GitContextUpdate,
  GitState,
  ProviderToolResult,
  SubagentConfig,
  ThreadSupervisor,
} from "@magenta/core";
import {
  type CommentId,
  type CommentUpdateEntry,
  type ContextFiles,
  type ContextManager,
  composeSupervisors,
  type InputMessage,
  loadAgents,
  type MCPToolManagerImpl,
  type NativeMessageIdx,
  Thread,
  type ThreadCallbacks,
  type ThreadId,
  type ThreadSendResult,
  type ThreadType,
  type ToolRequestId,
} from "@magenta/core";
import * as diff from "diff";
import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import type { Lsp } from "../capabilities/lsp.ts";
import type { SandboxViolationHandler } from "../capabilities/sandbox-violation-handler.ts";
import { CommentController } from "../comments/comment-controller.ts";
import type { FileUpdates } from "../context/context-manager.ts";
import { createLocalEnvironment, type Environment } from "../environment.ts";
import { displaySnapshotDiff } from "../nvim/displaySnapshotDiff.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import type { MagentaOptions, Profile } from "../options.ts";
import {
  type AgentPhase,
  getProvider,
  type ProviderMessage,
  type Runner,
} from "../providers/provider.ts";
import type { SystemInfo, SystemPrompt } from "../providers/system-prompt.ts";
import type { RootMsg } from "../root-msg.ts";
import type { Sandbox } from "../sandbox-manager.ts";
import type { Dispatch } from "../tea/tea.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { getBufferIfOpen } from "../utils/buffers.ts";
import type {
  AbsFilePath,
  HomeDir,
  NvimCwd,
  UnresolvedFilePath,
} from "../utils/files.ts";
import { displayPath } from "../utils/files.ts";
import type { Chat } from "./chat.ts";
import { notifyUser } from "./notify.ts";

/** Trailing-edge coalescing window for core updates. The core no longer
 * throttles; a render cadence is a view decision. */
const RENDER_DEBOUNCE_MS = 32;
/** The view needs the new message to exist before it can scroll to it. */
const SCROLL_DELAY_MS = 100;

export type SandboxRoot = {
  readonly isSandboxBypassed: boolean;
  toggle?: () => void;
};

export type Msg =
  | { type: "set-title"; title: string }
  | {
      type: "send-message";
      messages: InputMessage[];
      queue?: "async" | "next";
      reminders?: string[];
    }
  | {
      type: "abort";
    }
  | {
      type: "start-compaction";
      nextPrompt?: string;
    }
  | {
      type: "toggle-system-prompt";
    }
  | {
      type: "toggle-tool-definitions";
    }
  | {
      type: "toggle-tool-definition";
      toolName: string;
    }
  | {
      type: "toggle-context-files-expanded";
    }
  | {
      type: "toggle-pending-message";
      index: number;
    }
  | {
      type: "toggle-expand-content";
      messageIdx: number;
      contentIdx: number;
    }
  | {
      type: "toggle-expand-update";
      messageIdx: number;
      filePath: string;
    }
  | {
      type: "toggle-expand-comment-update";
      messageIdx: number;
      commentId: CommentId;
    }
  | {
      type: "toggle-pending-comment";
      commentId: CommentId;
    }
  | {
      type: "toggle-tool-input-summary";
      toolRequestId: ToolRequestId;
    }
  | {
      type: "toggle-tool-input";
      toolRequestId: ToolRequestId;
    }
  | {
      type: "toggle-tool-progress";
      toolRequestId: ToolRequestId;
    }
  | {
      type: "toggle-tool-result-summary";
      toolRequestId: ToolRequestId;
    }
  | {
      type: "toggle-tool-result";
      toolRequestId: ToolRequestId;
    }
  | {
      type: "toggle-tool-result-item";
      toolRequestId: ToolRequestId;
      itemKey: string;
    }
  | {
      type: "toggle-tool-progress-item";
      toolRequestId: ToolRequestId;
      itemKey: string;
    }
  | {
      type: "open-edit-file";
      filePath: UnresolvedFilePath | AbsFilePath;
    }
  | {
      type: "toggle-edited-file-expanded";
      filePath: AbsFilePath;
    }
  | {
      type: "open-edit-file-diff";
      filePath: AbsFilePath;
      snapshot: string;
    }
  | {
      type: "permission-pending-change";
    }
  | {
      type: "tool-progress";
    }
  | {
      type: "turn-ended";
    }
  | {
      type: "toggle-compaction-record";
      recordIdx: number;
    }
  | {
      type: "toggle-compaction-step";
      recordIdx: number;
      stepIdx: number;
    }
  | {
      type: "toggle-sandbox-bypass";
    }
  | {
      type: "fork-message";
      nativeMessageIdx: NativeMessageIdx;
      prepopulate?: string[];
    };

export type ThreadMsg = {
  type: "thread-msg";
  id: ThreadId;
  msg: Msg;
};

/** View state for a single message, stored separately from provider thread content */
export type MessageViewState = {
  contextUpdates?: FileUpdates;
  commentUpdates?: CommentUpdateEntry[];
  gitUpdate?: GitContextUpdate;
  forkedFrom?: ThreadId;
  expandedUpdates?: { [absFilePath: string]: boolean };
  expandedCommentUpdates?: { [commentId: CommentId]: boolean };
  expandedContent?: { [contentIdx: number]: boolean };
};

/** View state for tools, keyed by tool request ID */
export type ToolViewState = {
  inputSummaryExpanded: boolean;
  inputExpanded: boolean;
  progressExpanded: boolean;
  resultSummaryExpanded: boolean;
  resultExpanded: boolean;
  resultItemExpanded?: { [key: string]: boolean };
  progressItemExpanded?: { [key: string]: boolean };
};

/** A thread that owns comments — a root thread. Reached through
 * `NvimThread.isRootThread()` or `Chat.getActiveRootThread()`. */
export type RootNvimThread = NvimThread & {
  commentController: CommentController;
};

export class NvimThread {
  public state: {
    showSystemPrompt: boolean;
    showToolDefinitions: boolean;
    expandedToolDefinitions: { [toolName: string]: boolean };
    contextFilesExpanded: boolean;
    expandedPendingComments: { [commentId: CommentId]: boolean };
    pendingMessagesExpanded: { [index: number]: boolean };
    editedFilesExpanded: { [path: AbsFilePath]: { patch: string } };
    messageViewState: { [messageIdx: number]: MessageViewState };
    toolViewState: { [toolRequestId: ToolRequestId]: ToolViewState };
    compactionViewState: {
      [recordIdx: number]: {
        expanded: boolean;
        expandedSteps: { [stepIdx: number]: boolean };
      };
    };
    toolResultMap: Map<ToolRequestId, ProviderToolResult>;
    forkedTo: { childThreadId: ThreadId; atMessageIdx: NativeMessageIdx }[];
  };

  public core: Thread;
  private myDispatch: Dispatch<Msg>;
  private lastAppliedTitle: string | undefined;
  public sandboxViolationHandler: SandboxViolationHandler | undefined;
  /** The side conversations anchored in buffers. Root chat threads only:
   * subagents and subthreads neither see comments nor can reply to them. */
  public commentController: CommentController | undefined;
  /** True exactly when the core thread owns a comment store, i.e. for root
   * threads. Narrowing through this is what lets comment callers reach a
   * `CommentController` without a runtime check of their own. */
  isRootThread(): this is RootNvimThread {
    return this.commentController !== undefined;
  }
  public sandboxBypassed = false;

  get contextManager(): ContextManager {
    return this.core.contextManager;
  }

  get agent(): Runner {
    return this.core.runner;
  }

  /** The supervisor list this thread's hooks were composed from. Kept so the
   * wiring is inspectable; the core only ever sees the composed hooks. */
  public supervisors: ThreadSupervisor[] = [];

  get isSandboxBypassed(): boolean {
    const sandboxRoot = this.context.getSandboxRoot?.();
    if (sandboxRoot) return sandboxRoot.isSandboxBypassed;
    const parent = this.context.getParentThread?.();
    if (parent) return parent.isSandboxBypassed;
    return this.sandboxBypassed;
  }

  constructor(
    public id: ThreadId,
    threadType: ThreadType,
    systemPrompt: SystemPrompt,
    public context: {
      dispatch: Dispatch<RootMsg>;
      chat: Chat;
      mcpToolManager: MCPToolManagerImpl;
      profile: Profile;
      nvim: Nvim;
      cwd: NvimCwd;
      homeDir: HomeDir;
      options: MagentaOptions;
      getDisplayWidth: () => number;
      getParentThread?: () => NvimThread | undefined;
      getSandboxRoot?: () => SandboxRoot | undefined;
      yieldSchema?: JSONSchemaType;
      scriptName?: string;
      environment: Environment;
      initialFiles?: ContextFiles;
      initialGitState?: GitState | undefined;
      subagentConfig?: SubagentConfig;
      systemInfo: SystemInfo;
    },
    /** A `Thread` built by the caller — the fork path, which needs to clone
     * the source's history before the wrapper exists. */
    preBuiltCore?: Thread,
  ) {
    this.myDispatch = (msg) =>
      this.context.dispatch({
        type: "thread-msg",
        id: this.id,
        msg,
      });

    const env = this.context.environment;
    this.sandboxViolationHandler = env.sandboxViolationHandler;

    this.state = {
      showSystemPrompt: false,
      showToolDefinitions: false,
      expandedToolDefinitions: {},
      contextFilesExpanded: false,
      expandedPendingComments: {},
      pendingMessagesExpanded: {},
      editedFilesExpanded: {},
      messageViewState: {},
      toolViewState: {},
      compactionViewState: {},
      toolResultMap: new Map(),
      forkedTo: [],
    };

    const isDocker = env.environmentConfig.type === "docker";

    if (preBuiltCore) {
      this.core = preBuiltCore;
      this.core.callbacks = this.coreCallbacks();
    } else {
      this.core = new Thread(
        id,
        {
          logger: context.nvim.logger,
          profile: context.profile,
          cwd: isDocker ? env.cwd : context.cwd,
          homeDir: isDocker ? env.homeDir : context.homeDir,
          threadType,
          ...(context.subagentConfig
            ? { subagentConfig: context.subagentConfig }
            : {}),
          systemPrompt,
          systemInfo: context.systemInfo,
          mcpToolManager: context.mcpToolManager,
          threadManager: context.chat,
          getScriptRunner: () => context.chat.scriptRunner,
          fileIO: env.fileIO,
          shell: env.shell,
          gitClient: env.gitClient,
          ...(context.initialGitState !== undefined
            ? { initialGitState: context.initialGitState }
            : {}),
          lspClient: env.lspClient,
          ...(env.luaExecutor !== undefined
            ? { luaExecutor: env.luaExecutor }
            : {}),
          availableCapabilities: env.availableCapabilities,
          environmentConfig: env.environmentConfig,
          maxConcurrentSubagents: context.options.maxConcurrentSubagents || 3,
          maxConcurrentFastSubagents:
            context.options.maxConcurrentFastSubagents || 8,
          ...(context.options.dockerfile
            ? { subagentDockerfile: context.options.dockerfile }
            : {}),
          ...(context.yieldSchema ? { yieldSchema: context.yieldSchema } : {}),
          getAgents: () =>
            loadAgents({
              cwd: isDocker ? env.cwd : context.cwd,
              logger: context.nvim.logger,
              options: context.options,
            }),
          getProvider: (profile) => getProvider(context.nvim, profile),
          ...(context.initialFiles
            ? { initialFiles: context.initialFiles }
            : {}),
        },
        this.coreCallbacks(),
        { type: "fresh" },
        context.scriptName ? { scriptName: context.scriptName } : {},
      );
    }

    // The pending-comments view lives in the display buffer, so a comment
    // queued while the thread is idle has to trigger a redraw on its own.
    this.core.commentStore?.on("changed", () => this.onCoreUpdate());

    if (this.core.commentStore) {
      this.commentController = new CommentController(
        context.nvim,
        context.cwd,
        context.homeDir,
        this.core.commentStore,
      );
    }

    this.core.hooks = composeSupervisors(() => this.supervisors);

    this.rebuildToolResultMap();
  }

  /** Coalesce the core's unthrottled `onUpdate` into at most one dispatch per
   * frame. Trailing-edge on purpose: the core fires once more after the
   * thread comes to rest, and a leading-edge throttle would drop exactly that
   * call and leave a stale streaming block on screen forever. */
  private renderDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  private onCoreUpdate(): void {
    if (this.renderDebounceTimer) return;
    this.renderDebounceTimer = setTimeout(() => {
      this.renderDebounceTimer = undefined;
      if (this.destroyed) return;
      this.rebuildToolResultMap();
      const title = this.core.state.title;
      if (title !== undefined && title !== this.lastAppliedTitle) {
        this.lastAppliedTitle = title;
        this.context.dispatch({
          type: "set-thread-title-effect",
          id: this.core.id,
          title,
        });
      }
      this.myDispatch({ type: "tool-progress" });
      this.maybeScrollToSubmission();
    }, RENDER_DEBOUNCE_MS);
  }

  /** The message count when the pending submission was issued, if a send is
   * waiting to be scrolled into view. The scroll belongs to the actor that
   * submitted, and has to wait until the message it is scrolling to exists. */
  private scrollAfterMessageCount: number | undefined;

  private maybeScrollToSubmission(): void {
    if (this.scrollAfterMessageCount === undefined) return;
    if (
      this.core.getProviderMessages().length <= this.scrollAfterMessageCount
    ) {
      return;
    }
    this.scrollAfterMessageCount = undefined;
    setTimeout(
      () =>
        this.context.dispatch({
          type: "sidebar-msg",
          msg: { type: "scroll-to-last-user-message" },
        }),
      SCROLL_DELAY_MS,
    );
  }

  /** The callbacks the core needs. Everything else it used to broadcast is
   * now the return value of the `send`/`abort` this thread itself issued. */
  private coreCallbacks(): ThreadCallbacks {
    return {
      onUpdate: () => this.onCoreUpdate(),
      onContextUpdatesSent: (updates) => {
        const messageCount = this.core.getProviderMessages().length;
        this.state.messageViewState[messageCount] = {
          ...this.state.messageViewState[messageCount],
          contextUpdates: updates,
        };
      },
      onCommentUpdatesSent: (entries) => {
        const messageCount = this.core.getProviderMessages().length;
        this.state.messageViewState[messageCount] = {
          ...this.state.messageViewState[messageCount],
          commentUpdates: entries,
        };
      },
      onGitContextUpdateSent: (update) => {
        const messageCount = this.core.getProviderMessages().length;
        this.state.messageViewState[messageCount] = {
          ...this.state.messageViewState[messageCount],
          gitUpdate: update,
        };
      },
    };
  }

  /** Turn a finished submission into the effects that used to be broadcast
   * events: the turn-end notification and the rolled-back input text. */
  private handleSendResult(result: ThreadSendResult): void {
    if (result.type === "queued") return;
    this.myDispatch({ type: "turn-ended" });
    if (result.type === "completed" || result.type === "failed") {
      notifyUser(
        { nvim: this.context.nvim, options: this.context.options },
        "thread-turn-end",
      );
    }
    if (result.type === "failed" && result.resubmit !== undefined) {
      this.context.dispatch({
        type: "sidebar-msg",
        msg: {
          type: "setup-resubmit",
          threadId: this.id,
          lastUserMessage: result.resubmit,
        },
      });
    }
  }

  /** Walks the agent's provider messages and rebuilds the tool result map.
   * Re-attaches each result's structuredResult from `core.structuredToolResults`,
   * since the provider strips structuredResult when serializing to native form
   * but the rich view rendering relies on it. */
  rebuildToolResultMap(): void {
    const next = new Map<ToolRequestId, ProviderToolResult>();
    for (const message of this.core.getProviderMessages()) {
      if (message.role !== "user") continue;
      for (const content of message.content) {
        if (content.type === "tool_result") {
          const structured = this.core.structuredToolResults.get(content.id);
          if (structured && content.result.status === "ok") {
            next.set(content.id, {
              ...content,
              result: { ...content.result, structuredResult: structured },
            });
          } else {
            next.set(content.id, content);
          }
        }
      }
    }
    // Include results from active tool entries whose results haven't yet been
    // submitted back to the agent (e.g. mid tool_use turn while other tools
    // are still running). The rendering layer needs these to display custom
    // result summaries as soon as the tool completes.
    const mode = this.core.state.mode;
    if (mode.type === "tool_use") {
      for (const entry of mode.activeTools.values()) {
        if (entry.result && !next.has(entry.request.id)) {
          next.set(entry.request.id, entry.result);
        }
      }
    }
    this.state.toolResultMap = next;
  }

  /** Build an independent fork of `sourceThread` frozen at `nativeMessageIdx`.
   * The cloned agent is created exactly once (by Agent.clone). The source
   * is not aborted, no auto-context is re-resolved, and no system prompt is
   * regenerated. The result is a new NvimThread with its own environment and
   * Layer 3 view state, ready to continue from the snapshot. */
  static async cloneFromNativeMessageIdx(args: {
    sourceThread: NvimThread;
    newThreadId: ThreadId;
    nativeMessageIdx: NativeMessageIdx;
    chat: Chat;
    mcpToolManager: MCPToolManagerImpl;
    dispatch: Dispatch<RootMsg>;
    nvim: Nvim;
    cwd: NvimCwd;
    homeDir: HomeDir;
    lsp: Lsp;
    sandbox: Sandbox;
    getOptions: () => MagentaOptions;
    getDisplayWidth: () => number;
  }): Promise<NvimThread> {
    const {
      sourceThread,
      newThreadId,
      nativeMessageIdx,
      chat,
      mcpToolManager,
      dispatch,
      nvim,
      cwd,
      homeDir,
      lsp,
      sandbox,
      getOptions,
      getDisplayWidth,
    } = args;

    const sourceEnvConfig = sourceThread.context.environment.environmentConfig;
    if (sourceEnvConfig.type !== "local") {
      throw new Error(
        `Thread.cloneFromNativeMessageIdx only supports local-source forks for MVP (got ${sourceEnvConfig.type}). Docker-source forks are a follow-up.`,
      );
    }

    const bypassRef = { get: () => false as boolean };

    const environment = createLocalEnvironment({
      nvim,
      lsp,
      cwd,
      homeDir,
      getOptions,
      threadId: newThreadId,
      sandbox,
      onPendingChange: () =>
        dispatch({
          type: "thread-msg",
          id: newThreadId,
          msg: { type: "permission-pending-change" },
        }),
      isBypassed: () => bypassRef.get(),
    });

    const sourceCore = sourceThread.core;
    const profile = sourceThread.context.profile;
    const sourceCoreState = sourceCore.state;

    const core = await Thread.clone({
      sourceThread: sourceCore,
      newId: newThreadId,
      nativeMessageIdx,
      context: {
        logger: nvim.logger,
        profile,
        cwd: environment.cwd,
        homeDir: environment.homeDir,
        threadType: sourceCoreState.threadType,
        ...(sourceThread.context.subagentConfig
          ? { subagentConfig: sourceThread.context.subagentConfig }
          : {}),
        systemPrompt: sourceCoreState.systemPrompt,
        systemInfo: sourceCoreState.systemInfo,
        mcpToolManager,
        threadManager: chat,
        fileIO: environment.fileIO,
        shell: environment.shell,
        gitClient: environment.gitClient,
        lspClient: environment.lspClient,
        ...(environment.luaExecutor !== undefined
          ? { luaExecutor: environment.luaExecutor }
          : {}),
        availableCapabilities: environment.availableCapabilities,
        environmentConfig: environment.environmentConfig,
        maxConcurrentSubagents: getOptions().maxConcurrentSubagents || 3,
        maxConcurrentFastSubagents:
          getOptions().maxConcurrentFastSubagents || 8,
        ...(getOptions().dockerfile
          ? { subagentDockerfile: getOptions().dockerfile }
          : {}),
        getAgents: () =>
          loadAgents({
            cwd: environment.cwd,
            logger: nvim.logger,
            options: getOptions(),
          }),
        getProvider: (p) => getProvider(nvim, p),
      },
      // Replaced by the wrapper's own callbacks as soon as it exists; a fork
      // has to clone the source's history before there is a wrapper to talk to.
      callbacks: { onUpdate: () => {} },
    });

    const thread = new NvimThread(
      newThreadId,
      sourceCoreState.threadType,
      sourceCoreState.systemPrompt,
      {
        dispatch,
        chat,
        mcpToolManager,
        profile,
        nvim,
        cwd,
        homeDir,
        options: getOptions(),
        getDisplayWidth,
        environment,
        systemInfo: sourceCoreState.systemInfo,
        ...(sourceThread.context.subagentConfig
          ? { subagentConfig: sourceThread.context.subagentConfig }
          : {}),
      },
      core,
    );

    thread.sandboxBypassed = sourceThread.isSandboxBypassed;
    bypassRef.get = () => thread.isSandboxBypassed;

    thread.rebuildToolResultMap();

    for (const [idxStr, viewState] of Object.entries(
      sourceThread.state.messageViewState,
    )) {
      const idx = Number(idxStr);
      if (idx <= nativeMessageIdx) {
        thread.state.messageViewState[idx] = {
          ...(viewState.contextUpdates
            ? { contextUpdates: { ...viewState.contextUpdates } }
            : {}),
          ...(viewState.gitUpdate ? { gitUpdate: viewState.gitUpdate } : {}),
          ...(viewState.expandedUpdates
            ? { expandedUpdates: { ...viewState.expandedUpdates } }
            : {}),
          ...(viewState.expandedContent
            ? { expandedContent: { ...viewState.expandedContent } }
            : {}),
        };
      }
    }

    return thread;
  }

  private destroyed = false;

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.renderDebounceTimer) {
      clearTimeout(this.renderDebounceTimer);
      this.renderDebounceTimer = undefined;
    }

    await this.commentController?.destroy();
    await this.core.destroy();
  }

  getProviderStatus(): AgentPhase {
    return this.core.getProviderStatus();
  }

  getProviderMessages(): ReadonlyArray<ProviderMessage> {
    return this.core.getProviderMessages();
  }

  getMessages(): ProviderMessage[] {
    return this.core.getMessages();
  }

  getLastStopTokenCount(): number {
    return this.core.getLastStopTokenCount();
  }

  private async readCurrentFileContent(filePath: AbsFilePath): Promise<string> {
    const bufResult = await getBufferIfOpen({
      unresolvedPath: filePath,
      context: this.context,
    });
    if (bufResult.status === "ok") {
      const lines = await bufResult.buffer.getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });
      return lines.join("\n");
    }
    return await fs.readFile(filePath, "utf-8");
  }

  update(msg: RootMsg): void {
    if (msg.type === "thread-msg" && msg.id === this.id) {
      this.myUpdate(msg.msg);
    }
  }

  private myUpdate(msg: Msg): void {
    switch (msg.type) {
      case "send-message":
        if (msg.reminders) {
          for (const text of msg.reminders) {
            this.core.update({ type: "activate-reminder", text });
          }
        }
        if (msg.queue === undefined && this.core.phase.type !== "idle") {
          // The send is about to preempt the turn in flight; pending sandbox
          // approvals belong to that turn.
          this.sandboxViolationHandler?.rejectAll();
        }
        if (msg.messages.length) {
          this.scrollAfterMessageCount = this.core.getProviderMessages().length;
        }
        // The drain reads the comment locations core already holds, so they
        // have to be current before the request goes out. Nothing to refresh
        // means nothing to wait for: the send must stay synchronous, or an
        // abort-by-send races the turn it is meant to preempt.
        {
          const send = () =>
            this.core
              .send(msg.messages, msg.queue ? { queue: msg.queue } : {})
              .then(
                (result) => this.handleSendResult(result),
                (e: Error) => this.context.nvim.logger.error(e),
              );
          if (this.commentController?.hasComments()) {
            this.commentController
              .refresh()
              .then(send, (e: Error) => this.context.nvim.logger.error(e));
          } else {
            void send();
          }
        }
        return;

      case "start-compaction":
        this.core
          .compact(msg.nextPrompt)
          .catch((e: Error) => this.context.nvim.logger.error(e));
        return;

      case "abort": {
        if (this.core.state.mode.type === "tool_use") {
          for (const [, entry] of this.core.state.mode.activeTools) {
            entry.handle.abort();
          }
        }
        this.abortAndWait().catch((e: Error) => {
          this.context.nvim.logger.error(`Error during abort: ${e.message}`);
        });
        return;
      }

      case "set-title":
        this.core.setTitle(msg.title);
        return;

      case "toggle-system-prompt":
        this.state.showSystemPrompt = !this.state.showSystemPrompt;
        return;

      case "toggle-tool-definitions":
        this.state.showToolDefinitions = !this.state.showToolDefinitions;
        if (!this.state.showToolDefinitions) {
          this.state.expandedToolDefinitions = {};
        }
        return;

      case "toggle-tool-definition":
        this.state.expandedToolDefinitions[msg.toolName] =
          !this.state.expandedToolDefinitions[msg.toolName];
        return;

      case "toggle-context-files-expanded":
        this.state.contextFilesExpanded = !this.state.contextFilesExpanded;
        return;

      case "toggle-pending-comment":
        this.state.expandedPendingComments[msg.commentId] =
          !this.state.expandedPendingComments[msg.commentId];
        return;

      case "toggle-pending-message":
        this.state.pendingMessagesExpanded[msg.index] =
          !this.state.pendingMessagesExpanded[msg.index];
        return;

      case "toggle-expand-content": {
        const viewState = this.state.messageViewState[msg.messageIdx] || {};
        viewState.expandedContent = viewState.expandedContent || {};
        viewState.expandedContent[msg.contentIdx] =
          !viewState.expandedContent[msg.contentIdx];
        this.state.messageViewState[msg.messageIdx] = viewState;
        return;
      }

      case "toggle-expand-comment-update": {
        const viewState = this.state.messageViewState[msg.messageIdx] || {};
        viewState.expandedCommentUpdates =
          viewState.expandedCommentUpdates || {};
        viewState.expandedCommentUpdates[msg.commentId] =
          !viewState.expandedCommentUpdates[msg.commentId];
        this.state.messageViewState[msg.messageIdx] = viewState;
        return;
      }
      case "toggle-expand-update": {
        const viewState = this.state.messageViewState[msg.messageIdx] || {};
        viewState.expandedUpdates = viewState.expandedUpdates || {};
        viewState.expandedUpdates[msg.filePath] =
          !viewState.expandedUpdates[msg.filePath];
        this.state.messageViewState[msg.messageIdx] = viewState;
        return;
      }

      case "toggle-tool-input-summary":
      case "toggle-tool-input":
      case "toggle-tool-progress":
      case "toggle-tool-result-summary":
      case "toggle-tool-result": {
        const field = {
          "toggle-tool-input-summary": "inputSummaryExpanded",
          "toggle-tool-input": "inputExpanded",
          "toggle-tool-progress": "progressExpanded",
          "toggle-tool-result-summary": "resultSummaryExpanded",
          "toggle-tool-result": "resultExpanded",
        } as const;
        const toolState = this.state.toolViewState[msg.toolRequestId] || {
          inputSummaryExpanded: false,
          inputExpanded: false,
          progressExpanded: false,
          resultSummaryExpanded: false,
          resultExpanded: false,
        };
        const key = field[msg.type];
        toolState[key] = !toolState[key];
        this.state.toolViewState[msg.toolRequestId] = toolState;
        return;
      }

      case "toggle-tool-progress-item": {
        const toolState = this.state.toolViewState[msg.toolRequestId] || {
          inputSummaryExpanded: false,
          inputExpanded: false,
          progressExpanded: false,
          resultSummaryExpanded: false,
          resultExpanded: false,
        };
        const itemExpanded = toolState.progressItemExpanded || {};
        itemExpanded[msg.itemKey] = !itemExpanded[msg.itemKey];
        toolState.progressItemExpanded = itemExpanded;
        this.state.toolViewState[msg.toolRequestId] = toolState;
        return;
      }

      case "toggle-tool-result-item": {
        const toolState = this.state.toolViewState[msg.toolRequestId] || {
          inputSummaryExpanded: false,
          inputExpanded: false,
          progressExpanded: false,
          resultSummaryExpanded: false,
          resultExpanded: false,
        };
        const itemExpanded = toolState.resultItemExpanded || {};
        itemExpanded[msg.itemKey] = !itemExpanded[msg.itemKey];
        toolState.resultItemExpanded = itemExpanded;
        this.state.toolViewState[msg.toolRequestId] = toolState;
        return;
      }

      case "open-edit-file":
        openFileInNonMagentaWindow(msg.filePath, this.context).catch(
          (e: Error) => this.context.nvim.logger.error(e.message),
        );
        return;

      case "toggle-edited-file-expanded": {
        const key = msg.filePath;
        if (this.state.editedFilesExpanded[key]) {
          delete this.state.editedFilesExpanded[key];
          return;
        }
        const entry = this.core.state.editedFilesThisTurn.find(
          (e) => e.path === msg.filePath,
        );
        if (!entry) return;
        this.readCurrentFileContent(msg.filePath)
          .then((current) => {
            const patch = diff.createPatch(
              displayPath(this.context.cwd, msg.filePath, this.context.homeDir),
              entry.snapshot,
              current,
              "snapshot",
              "current",
              { context: 2 },
            );
            this.state.editedFilesExpanded[key] = { patch };
            this.myDispatch({ type: "turn-ended" });
          })
          .catch((e: Error) => this.context.nvim.logger.error(e.message));
        return;
      }

      case "open-edit-file-diff":
        displaySnapshotDiff({
          filePath: msg.filePath,
          snapshot: msg.snapshot,
          nvim: this.context.nvim,
          cwd: this.context.cwd,
          homeDir: this.context.homeDir,
          getDisplayWidth: this.context.getDisplayWidth,
        }).catch((e: Error) => this.context.nvim.logger.error(e.message));
        return;

      case "permission-pending-change":
        notifyUser(
          { nvim: this.context.nvim, options: this.context.options },
          "thread-attention",
        );
        return;

      case "tool-progress":
        if (
          this.core.state.pendingMessages.length === 0 &&
          this.core.state.pendingNextMessages.length === 0
        ) {
          this.state.pendingMessagesExpanded = {};
        }
        return;

      case "turn-ended":
        return;

      case "toggle-compaction-record": {
        const vs = this.state.compactionViewState[msg.recordIdx] || {
          expanded: false,
          expandedSteps: {},
        };
        vs.expanded = !vs.expanded;
        this.state.compactionViewState[msg.recordIdx] = vs;
        return;
      }

      case "toggle-compaction-step": {
        const vs = this.state.compactionViewState[msg.recordIdx] || {
          expanded: false,
          expandedSteps: {},
        };
        vs.expandedSteps[msg.stepIdx] = !vs.expandedSteps[msg.stepIdx];
        this.state.compactionViewState[msg.recordIdx] = vs;
        return;
      }

      case "toggle-sandbox-bypass": {
        let root: NvimThread = this;
        let parentThread = root.context.getParentThread?.();
        while (parentThread) {
          root = parentThread;
          parentThread = root.context.getParentThread?.();
        }
        const sandboxRoot = root.context.getSandboxRoot?.();
        if (sandboxRoot?.toggle) {
          sandboxRoot.toggle();
        } else {
          root.sandboxBypassed = !root.sandboxBypassed;
        }
        if (root.isSandboxBypassed) {
          root.context.chat.approveAllPendingInSubtree(root.id);
        }
        return;
      }

      case "fork-message":
        // Handled at the Magenta dispatch level; ignored here.
        return;

      default:
        assertUnreachable(msg);
    }
  }

  async abortAndWait(): Promise<void> {
    this.sandboxViolationHandler?.rejectAll();
    const { unsent } = await this.core.abort();
    const isUserFacing =
      this.core.state.threadType === "root" ||
      this.core.state.threadType === "docker_root";
    if (!isUserFacing) return;
    const text = unsent
      .flatMap((q) => q.messages)
      .filter((m) => m.type === "user")
      .map((m) => m.text)
      .join("\n");
    if (!text) return;
    this.context.dispatch({
      type: "sidebar-msg",
      msg: { type: "append-to-input", threadId: this.id, text },
    });
  }
}
