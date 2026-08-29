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
  CommentStore,
  CommentSupervisor,
  type CommentUpdateEntry,
  type ContextFiles,
  ContextManager,
  cloneContextManager,
  composeSupervisors,
  type Delivery,
  extractPartialReplies,
  FileContextSupervisor,
  GitSupervisor,
  GitTracker,
  type InputMessage,
  loadAgents,
  type MCPToolManagerImpl,
  type NativeMessageIdx,
  type PendingMessage,
  type PendingMessagePart,
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
import {
  CommentController,
  type CommentThreadActivity,
} from "../comments/comment-controller.ts";
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
import type { CommandRegistry } from "./commands/registry.ts";
import { notifyUser } from "./notify.ts";

/** Trailing-edge coalescing window for core updates. The core no longer
 * throttles; a render cadence is a view decision. */
const RENDER_DEBOUNCE_MS = 32;
/** The view needs the new message to exist before it can scroll to it. */
const SCROLL_DELAY_MS = 100;
/** How often the tracked-file poller re-reads the files in context. */
const CONTEXT_MANAGER_POLL_INTERVAL_MS = 1000;

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
      /** User text, parsed but not resolved: its commands run at delivery. */
      type: "submit-message";
      message: PendingMessage;
      delivery: Delivery;
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

/** Everything a root thread's side conversations need, in one bag: the three
 * pieces are created together or not at all, so "store without controller" is
 * not representable. */
export type ThreadComments = {
  store: CommentStore;
  supervisor: CommentSupervisor;
  controller: CommentController;
};
/** A thread that owns comments — a root thread. Reached through
 * `NvimThread.isRootThread()` or `Chat.getActiveRootThread()`. */
export type RootNvimThread = NvimThread & {
  comments: ThreadComments;
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
  public readonly comments: ThreadComments | undefined;
  /** True exactly when this is a root thread. Narrowing through this is what
   * lets comment callers reach the store, supervisor and controller without a
   * runtime check of their own. */
  isRootThread(): this is RootNvimThread {
    return this.comments !== undefined;
  }
  public sandboxBypassed = false;

  /** The three context trackers, wrapped as supervisors. They are durable —
   * compaction swaps the agent, not the thread — and they own the two
   * capabilities the agent reads synchronously (`contextTracker`,
   * `commentStore`). */
  public readonly fileSupervisor: FileContextSupervisor;
  public readonly gitSupervisor: GitSupervisor;

  get contextManager(): ContextManager {
    return this.fileSupervisor.contextManager;
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
      commandRegistry: CommandRegistry;
    },
    /** Built by the caller — the fork path, which needs to clone the source's
     * history and its tracked-file state before the wrapper exists. */
    preBuilt?: {
      core: Thread;
      contextManager: ContextManager;
      commentStore: CommentStore | undefined;
    },
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
    const cwd = isDocker ? env.cwd : context.cwd;
    const homeDir = isDocker ? env.homeDir : context.homeDir;

    this.fileSupervisor = new FileContextSupervisor({
      contextManager:
        preBuilt?.contextManager ??
        new ContextManager(
          context.nvim.logger,
          env.fileIO,
          cwd,
          homeDir,
          context.initialFiles,
          CONTEXT_MANAGER_POLL_INTERVAL_MS,
        ),
      onSent: (updates) =>
        this.recordMessageViewState({ contextUpdates: updates }),
    });
    this.fileSupervisor.contextManager.start();

    this.gitSupervisor = new GitSupervisor({
      gitTracker: new GitTracker(
        env.gitClient,
        context.initialGitState,
        context.nvim.logger,
      ),
      onSent: (update) => this.recordMessageViewState({ gitUpdate: update }),
    });

    const commentStore = preBuilt
      ? preBuilt.commentStore
      : threadType === "root" || threadType === "docker_root"
        ? new CommentStore()
        : undefined;
    if (commentStore) {
      const controller = new CommentController(
        context.nvim,
        context.cwd,
        context.homeDir,
        commentStore,
        () => this.commentActivity(),
      );
      this.comments = {
        store: commentStore,
        controller,
        supervisor: new CommentSupervisor({
          store: commentStore,
          // Extmark positions are the comment locations the store reports, so
          // they have to be current before *every* request, not just the
          // opening one.
          beforeRead: async () => {
            if (controller.hasComments()) {
              await controller.refresh();
            }
          },
          onSent: (entries) =>
            this.recordMessageViewState({ commentUpdates: entries }),
        }),
      };
    }

    if (preBuilt) {
      this.core = preBuilt.core;
      this.core.callbacks = this.coreCallbacks();
    } else {
      this.core = new Thread(
        id,
        {
          logger: context.nvim.logger,
          profile: context.profile,
          cwd,
          homeDir,
          threadType,
          contextTracker: this.fileSupervisor.contextManager,
          commentStore: this.comments?.store,
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
              cwd,
              logger: context.nvim.logger,
              options: context.options,
            }),
          getProvider: (profile) => getProvider(context.nvim, profile),
        },
        this.coreCallbacks(),
        { type: "fresh" },
        context.scriptName ? { scriptName: context.scriptName } : {},
      );
    }

    // The pending-comments view lives in the display buffer, so a comment
    // queued while the thread is idle has to trigger a redraw on its own.
    this.comments?.store.on("changed", () => this.onCoreUpdate());
    // Tracked-file churn moves the context-files section of the display.
    for (const event of [
      "fileAdded",
      "fileRemoved",
      "pendingUpdatesChanged",
    ] as const) {
      this.contextManager.on(event, () => this.onCoreUpdate());
    }

    this.core.hooks = composeSupervisors(() => [
      ...this.contextSupervisors(),
      ...this.supervisors,
    ]);

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
      void this.comments?.controller.syncActivity();
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

  /** What the live turn is doing about the open comments: while the `reply`
   * tool input is still streaming we can see which comments it targets and
   * how far each reply has been written. */
  private commentActivity(): CommentThreadActivity | undefined {
    if (this.core.phase.type === "idle") {
      return undefined;
    }
    const block =
      this.agent.phase.type === "streaming"
        ? this.agent.phase.block
        : undefined;
    if (block?.type === "tool_use" && block.name === "reply") {
      const replies: { [id: CommentId]: string } = {};
      for (const reply of extractPartialReplies(block.inputJson)) {
        replies[reply.commentId as CommentId] = reply.text;
      }
      return { type: "replying", replies };
    }
    return { type: "thinking" };
  }

  /** The context trackers, always ahead of the behavioral supervisors so no
   * injection can follow a compaction in the plan. */
  private contextSupervisors(): ThreadSupervisor[] {
    return this.comments
      ? [this.gitSupervisor, this.fileSupervisor, this.comments.supervisor]
      : [this.gitSupervisor, this.fileSupervisor];
  }

  /** Attach a tracker's structured record to the message its injection is
   * about to produce. */
  private recordMessageViewState(patch: MessageViewState): void {
    const messageCount = this.core.getProviderMessages().length;
    this.state.messageViewState[messageCount] = {
      ...this.state.messageViewState[messageCount],
      ...patch,
    };
  }

  /** The callbacks the core needs. Everything else it used to broadcast is
   * now the return value of the `send`/`abort` this thread itself issued. */
  private coreCallbacks(): ThreadCallbacks {
    return {
      onUpdate: () => this.onCoreUpdate(),
      resolve: (parts) => this.resolveParts(parts),
    };
  }

  /** The nvim half of a submission: expand commands (`@file:`, `@diff`, ...)
   * against the world as it is *now*. Called at delivery, so a message queued
   * behind a long turn sees the current file contents, not the ones it was
   * typed against. */
  private async resolveParts(
    parts: ReadonlyArray<PendingMessagePart>,
  ): Promise<{ messages: InputMessage[]; reminders: string[] }> {
    const { processedText, additionalContent, reminders } =
      await this.context.commandRegistry.processMessage(
        parts.map((p) => p.text).join(""),
        {
          nvim: this.context.nvim,
          cwd: this.context.environment.cwd,
          homeDir: this.context.environment.homeDir,
          contextManager: this.contextManager,
          options: this.context.options,
        },
      );
    const messages: InputMessage[] = [{ type: "user", text: processedText }];
    for (const content of additionalContent) {
      if (content.type === "text") {
        messages.push({ type: "user", text: content.text });
      }
    }
    return { messages, reminders };
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

    // Independent tracked-file state for the fork; comments are root-only and
    // are deliberately not cloned.
    const contextManager = await cloneContextManager(
      sourceThread.contextManager,
      {
        logger: nvim.logger,
        fileIO: environment.fileIO,
        cwd: environment.cwd,
        homeDir: environment.homeDir,
        pollIntervalMs: CONTEXT_MANAGER_POLL_INTERVAL_MS,
      },
    );
    const threadType = sourceCoreState.threadType;
    const commentStore =
      threadType === "root" || threadType === "docker_root"
        ? new CommentStore()
        : undefined;

    const core = await Thread.clone({
      sourceThread: sourceCore,
      newId: newThreadId,
      nativeMessageIdx,
      context: {
        logger: nvim.logger,
        profile,
        cwd: environment.cwd,
        homeDir: environment.homeDir,
        threadType,
        contextTracker: contextManager,
        commentStore,
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
        commandRegistry: sourceThread.context.commandRegistry,
        nvim,
        cwd,
        homeDir,
        options: getOptions(),
        getDisplayWidth,
        environment,
        systemInfo: sourceCoreState.systemInfo,
        initialGitState: sourceThread.gitSupervisor.gitTracker.getAgentView(),
        ...(sourceThread.context.subagentConfig
          ? { subagentConfig: sourceThread.context.subagentConfig }
          : {}),
      },
      { core, contextManager, commentStore },
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

    await this.comments?.controller.destroy();
    await this.core.destroy();
    this.fileSupervisor.destroy();
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
        // Comment positions are refreshed by `CommentSupervisor.beforeRead`,
        // on every request rather than just this one, so the send stays
        // synchronous and an abort-by-send cannot race the turn it preempts.
        this.core
          .send(msg.messages, msg.queue ? { queue: msg.queue } : {})
          .then(
            (result) => this.handleSendResult(result),
            (e: Error) => this.context.nvim.logger.error(e),
          );
        return;

      case "submit-message": {
        if (msg.delivery === "now" && this.core.phase.type !== "idle") {
          // The send is about to preempt the turn in flight; pending sandbox
          // approvals belong to that turn.
          this.sandboxViolationHandler?.rejectAll();
        }
        this.scrollAfterMessageCount = this.core.getProviderMessages().length;
        this.core.submit(msg.message, msg.delivery).then(
          (result) => this.handleSendResult(result),
          (e: Error) => this.context.nvim.logger.error(e),
        );
        return;
      }
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
          this.core.state.nextRequestQueue.length === 0 &&
          this.core.state.nextStopQueue.length === 0
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
    const text = unsent.map((q) => q.message.text).join("\n");
    if (!text) return;
    this.context.dispatch({
      type: "sidebar-msg",
      msg: { type: "append-to-input", threadId: this.id, text },
    });
  }
}
