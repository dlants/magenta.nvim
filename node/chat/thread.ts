import * as fs from "node:fs/promises";
import type {
  GitContextUpdate,
  GitState,
  ProviderToolResult,
  SubagentConfig,
  ThreadSupervisor,
} from "@magenta/core";
import {
  type ContextFiles,
  type ContextManager,
  type InputMessage,
  loadAgents,
  type MCPToolManagerImpl,
  type NativeMessageIdx,
  ThreadCore,
  type ThreadId,
  type ThreadType,
  type ToolRequestId,
} from "@magenta/core";
import * as diff from "diff";
import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import type { Lsp } from "../capabilities/lsp.ts";
import type { SandboxViolationHandler } from "../capabilities/sandbox-violation-handler.ts";
import type { FileUpdates } from "../context/context-manager.ts";
import { createLocalEnvironment, type Environment } from "../environment.ts";
import { displaySnapshotDiff } from "../nvim/displaySnapshotDiff.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import type { MagentaOptions, Profile } from "../options.ts";
import {
  type Agent,
  type AgentStatus,
  getProvider,
  type ProviderMessage,
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

export type SandboxRoot = {
  readonly isSandboxBypassed: boolean;
  toggle?: () => void;
};

export type Msg =
  | { type: "set-title"; title: string }
  | {
      type: "send-message";
      messages: InputMessage[];
      async?: boolean;
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
      filePath: UnresolvedFilePath;
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
  gitUpdate?: GitContextUpdate;
  forkedFrom?: ThreadId;
  expandedUpdates?: { [absFilePath: string]: boolean };
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

export class Thread {
  public state: {
    showSystemPrompt: boolean;
    showToolDefinitions: boolean;
    expandedToolDefinitions: { [toolName: string]: boolean };
    contextFilesExpanded: boolean;
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

  public core: ThreadCore;
  private myDispatch: Dispatch<Msg>;
  private lastAppliedTitle: string | undefined;
  public sandboxViolationHandler: SandboxViolationHandler | undefined;
  public sandboxBypassed = false;

  get contextManager(): ContextManager {
    return this.core.contextManager;
  }

  get agent(): Agent {
    return this.core.agent;
  }

  get supervisors(): ThreadSupervisor[] {
    return this.core.supervisors;
  }

  set supervisors(value: ThreadSupervisor[]) {
    this.core.supervisors = value;
  }

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
      getParentThread?: () => Thread | undefined;
      getSandboxRoot?: () => SandboxRoot | undefined;
      yieldSchema?: JSONSchemaType;
      environment: Environment;
      initialFiles?: ContextFiles;
      initialGitState?: GitState | undefined;
      subagentConfig?: SubagentConfig;
      systemInfo: SystemInfo;
    },
    clonedAgent?: Agent,
    preBuiltCore?: ThreadCore,
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
    } else {
      this.core = new ThreadCore(
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
          helpTagsProvider: env.helpTagsProvider,
          ...(env.luaExecutor !== undefined
            ? { luaExecutor: env.luaExecutor }
            : {}),
          availableCapabilities: env.availableCapabilities,
          environmentConfig: env.environmentConfig,
          maxConcurrentSubagents: context.options.maxConcurrentSubagents || 3,
          maxConcurrentFastSubagents:
            context.options.maxConcurrentFastSubagents || 8,
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
        clonedAgent,
      );
    }

    const coreListeners = {
      update: () => {
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
      },
      pendingUpdatesChanged: () => this.myDispatch({ type: "tool-progress" }),
      turnEnded: (payload: { reason: "end_turn" | "aborted" | "error" }) => {
        this.myDispatch({ type: "turn-ended" });
        if (payload.reason === "end_turn" || payload.reason === "error") {
          notifyUser(
            {
              nvim: this.context.nvim,
              options: this.context.options,
            },
            "thread-turn-end",
          );
        }
      },
      setupResubmit: (threadId: ThreadId, lastUserMessage: string) =>
        this.context.dispatch({
          type: "sidebar-msg",
          msg: { type: "setup-resubmit", threadId, lastUserMessage },
        }),
      recoverPendingMessages: (threadId: ThreadId, text: string) =>
        this.context.dispatch({
          type: "sidebar-msg",
          msg: { type: "append-to-input", threadId, text },
        }),
      scrollToLastMessage: () =>
        this.context.dispatch({
          type: "sidebar-msg",
          msg: { type: "scroll-to-last-user-message" },
        }),
      aborting: () => {
        this.sandboxViolationHandler?.rejectAll();
      },
      contextUpdatesSent: (updates: Record<string, unknown>) => {
        const messageCount = this.core.getProviderMessages().length;
        this.state.messageViewState[messageCount] = {
          ...this.state.messageViewState[messageCount],
          contextUpdates: updates as FileUpdates,
        };
      },
      gitContextUpdateSent: (update: GitContextUpdate) => {
        const messageCount = this.core.getProviderMessages().length;
        this.state.messageViewState[messageCount] = {
          ...this.state.messageViewState[messageCount],
          gitUpdate: update,
        };
      },
    };
    this.coreListeners = coreListeners;
    this.core.on("update", coreListeners.update);
    this.core.on("pendingUpdatesChanged", coreListeners.pendingUpdatesChanged);
    this.core.on("turnEnded", coreListeners.turnEnded);
    this.core.on("setupResubmit", coreListeners.setupResubmit);
    this.core.on(
      "recoverPendingMessages",
      coreListeners.recoverPendingMessages,
    );
    this.core.on("scrollToLastMessage", coreListeners.scrollToLastMessage);
    this.core.on("aborting", coreListeners.aborting);
    this.core.on("contextUpdatesSent", coreListeners.contextUpdatesSent);
    this.core.on("gitContextUpdateSent", coreListeners.gitContextUpdateSent);

    this.rebuildToolResultMap();
  }

  /** Walks the agent's provider messages and rebuilds the tool result map.
   * Preserves any pre-existing structuredResult for surviving tool result IDs,
   * since the provider strips structuredResult when serializing to native form
   * but the rich view rendering relies on it. */
  rebuildToolResultMap(): void {
    const next = new Map<ToolRequestId, ProviderToolResult>();
    const prev = this.state.toolResultMap;
    for (const message of this.core.getProviderMessages()) {
      if (message.role !== "user") continue;
      for (const content of message.content) {
        if (content.type === "tool_result") {
          const cached = prev.get(content.id);
          if (
            cached?.result.status === "ok" &&
            content.result.status === "ok"
          ) {
            next.set(content.id, {
              ...content,
              result: {
                ...content.result,
                structuredResult: cached.result.structuredResult,
              },
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
   * The cloned agent is created exactly once (by ThreadCore.clone). The source
   * is not aborted, no auto-context is re-resolved, and no system prompt is
   * regenerated. The result is a new Thread with its own environment and
   * Layer 3 view state, ready to continue from the snapshot. */
  static async cloneFromNativeMessageIdx(args: {
    sourceThread: Thread;
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
  }): Promise<Thread> {
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

    const core = await ThreadCore.clone({
      sourceCore,
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
        helpTagsProvider: environment.helpTagsProvider,
        ...(environment.luaExecutor !== undefined
          ? { luaExecutor: environment.luaExecutor }
          : {}),
        availableCapabilities: environment.availableCapabilities,
        environmentConfig: environment.environmentConfig,
        maxConcurrentSubagents: getOptions().maxConcurrentSubagents || 3,
        maxConcurrentFastSubagents:
          getOptions().maxConcurrentFastSubagents || 8,
        getAgents: () =>
          loadAgents({
            cwd: environment.cwd,
            logger: nvim.logger,
            options: getOptions(),
          }),
        getProvider: (p) => getProvider(nvim, p),
      },
    });

    const thread = new Thread(
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
      undefined,
      core,
    );

    thread.sandboxBypassed = sourceThread.isSandboxBypassed;
    bypassRef.get = () => thread.isSandboxBypassed;

    const survivingToolResults = sourceThread.state.toolResultMap;
    const newMap = new Map<ToolRequestId, ProviderToolResult>();
    for (const message of core.getProviderMessages()) {
      if (message.role !== "user") continue;
      for (const content of message.content) {
        if (content.type === "tool_result") {
          const cached = survivingToolResults.get(content.id);
          if (
            cached?.result.status === "ok" &&
            content.result.status === "ok"
          ) {
            newMap.set(content.id, {
              ...content,
              result: {
                ...content.result,
                structuredResult: cached.result.structuredResult,
              },
            });
          } else {
            newMap.set(content.id, content);
          }
        }
      }
    }
    thread.state.toolResultMap = newMap;

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

  private coreListeners:
    | {
        update: () => void;
        pendingUpdatesChanged: () => void;
        turnEnded: (payload: {
          reason: "end_turn" | "aborted" | "error";
        }) => void;
        setupResubmit: (threadId: ThreadId, lastUserMessage: string) => void;
        recoverPendingMessages: (threadId: ThreadId, text: string) => void;
        scrollToLastMessage: () => void;
        aborting: () => void;
        contextUpdatesSent: (updates: Record<string, unknown>) => void;
        gitContextUpdateSent: (update: GitContextUpdate) => void;
      }
    | undefined;

  private destroyed = false;

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.coreListeners) {
      this.core.off("update", this.coreListeners.update);
      this.core.off(
        "pendingUpdatesChanged",
        this.coreListeners.pendingUpdatesChanged,
      );
      this.core.off("turnEnded", this.coreListeners.turnEnded);
      this.core.off("setupResubmit", this.coreListeners.setupResubmit);
      this.core.off(
        "recoverPendingMessages",
        this.coreListeners.recoverPendingMessages,
      );
      this.core.off(
        "scrollToLastMessage",
        this.coreListeners.scrollToLastMessage,
      );
      this.core.off("aborting", this.coreListeners.aborting);
      this.core.off(
        "contextUpdatesSent",
        this.coreListeners.contextUpdatesSent,
      );
      this.core.off(
        "gitContextUpdateSent",
        this.coreListeners.gitContextUpdateSent,
      );
      this.coreListeners = undefined;
    }

    await this.core.destroy();
  }

  getProviderStatus(): AgentStatus {
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
        this.core
          .handleSendMessageRequest(msg.messages, msg.async)
          .catch((e: Error) => this.context.nvim.logger.error(e));
        return;

      case "start-compaction":
        this.core.startCompaction(msg.nextPrompt);
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
        if (this.core.state.pendingMessages.length === 0) {
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
        let root: Thread = this;
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
    await this.core.abort();
  }
}
