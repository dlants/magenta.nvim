import type {
  FileIO,
  InputMessage,
  NativeMessageIdx,
  SubagentConfig,
  ThreadId,
  ThreadType,
} from "@magenta/core";
import {
  FsFileIO,
  loadAgents,
  MCPToolManagerImpl,
  SubagentSupervisor,
} from "@magenta/core";
import { v7 as uuidv7 } from "uuid";
import type { Lsp } from "../capabilities/lsp.ts";
import type {
  DockerSpawnConfig,
  ThreadManager,
} from "../capabilities/thread-manager.ts";
import {
  autoContextFilesToInitialFiles,
  resolveAutoContext,
} from "../context/auto-context.ts";
import {
  createDockerEnvironment,
  createLocalEnvironment,
  type EnvironmentConfig,
} from "../environment.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { MagentaOptions, Profile } from "../options.ts";
import { createSystemPrompt } from "../providers/system-prompt.ts";
import type { RootMsg } from "../root-msg.ts";
import type { Sandbox } from "../sandbox-manager.ts";
import type { Dispatch } from "../tea/tea.ts";
import { d, type VDOMNode, withBindings } from "../tea/view.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type {
  AbsFilePath,
  HomeDir,
  NvimCwd,
  UnresolvedFilePath,
} from "../utils/files.ts";
import type { Result } from "../utils/result.ts";
import { Thread } from "./thread.ts";
import { DockerSupervisor } from "./thread-supervisor.ts";
import { view as threadView } from "./thread-view.ts";

type ThreadWrapper = (
  | {
      state: "pending";
    }
  | {
      state: "initialized";
      thread: Thread;
    }
  | {
      state: "error";
      error: Error;
    }
) & {
  parentThreadId: ThreadId | undefined;
  depth: number;
  lastActivityTime: number;
};

type ChatState =
  | {
      state: "thread-overview";
      activeThreadId: ThreadId | undefined;
    }
  | {
      state: "thread-selected";
      activeThreadId: ThreadId;
    };

export type Msg =
  | {
      type: "thread-initialized";
      thread: Thread;
    }
  | {
      type: "thread-error";
      id: ThreadId;
      error: Error;
    }
  | {
      type: "set-active-thread";
      id: ThreadId;
    }
  | {
      type: "threads-navigate-up";
    }
  | {
      type: "threads-overview";
    }
  | {
      type: "toggle-thread-expand";
      id: ThreadId;
    }
  | {
      type: "delete-thread";
      id: ThreadId;
    };

export type ChatMsg = {
  type: "chat-msg";
  msg: Msg;
};

export class Chat implements ThreadManager {
  state: ChatState;
  public threadWrappers: { [id: ThreadId]: ThreadWrapper };
  private mcpToolManager: MCPToolManagerImpl;
  private expandedThreads: Set<ThreadId>;
  private threadYieldCallbacks: Map<ThreadId, Array<() => void>>;

  constructor(
    private context: {
      dispatch: Dispatch<RootMsg>;
      getDisplayWidth: () => number;
      getOptions: () => MagentaOptions;
      cwd: NvimCwd;
      homeDir: HomeDir;
      nvim: Nvim;
      lsp: Lsp;
      sandbox: Sandbox;
    },
  ) {
    this.threadWrappers = {};
    this.expandedThreads = new Set();
    this.threadYieldCallbacks = new Map();
    this.state = {
      state: "thread-overview",
      activeThreadId: undefined,
    };

    this.mcpToolManager = new MCPToolManagerImpl(
      this.context.getOptions().mcpServers,
      { logger: this.context.nvim.logger },
    );
  }

  update(msg: RootMsg) {
    if (msg.type === "chat-msg") {
      this.myUpdate(msg.msg);
      return;
    }

    if (msg.type === "thread-msg" && msg.id in this.threadWrappers) {
      const threadState = this.threadWrappers[msg.id];
      if (threadState.state === "initialized") {
        const thread = threadState.thread;
        thread.update(msg);

        if (msg.msg.type === "send-message") {
          const rootId = this.getRootAncestorId(msg.id);
          this.threadWrappers[rootId].lastActivityTime = Date.now();
        }

        if (msg.msg.type === "abort") {
          // Find all child threads of the parent thread and abort them directly
          for (const [threadId, threadWrapper] of Object.entries(
            this.threadWrappers,
          )) {
            if (
              threadWrapper.parentThreadId === thread.id &&
              threadWrapper.state === "initialized" &&
              threadWrapper.thread.core.state.mode.type !== "yielded"
            ) {
              threadWrapper.thread.update({
                type: "thread-msg",
                id: threadId as ThreadId,
                msg: {
                  type: "abort",
                },
              });
            }
          }
        }

        if (thread.core.state.mode.type === "yielded") {
          this.fireThreadYieldCallbacks(thread.id);
        }
      }
    }
  }

  private myUpdate(msg: Msg) {
    switch (msg.type) {
      case "thread-initialized": {
        const prev = this.threadWrappers[msg.thread.id];
        const wrapper: ThreadWrapper = {
          state: "initialized",
          thread: msg.thread,
          parentThreadId: prev.parentThreadId,
          depth: prev.depth,
          lastActivityTime: prev.lastActivityTime,
        };
        this.threadWrappers[msg.thread.id] = wrapper;

        return;
      }

      case "thread-error": {
        const thread = this.threadWrappers[msg.id];
        this.threadWrappers[msg.id] = {
          state: "error",
          error: msg.error,
          parentThreadId: thread.parentThreadId,
          depth: thread.depth,
          lastActivityTime: thread.lastActivityTime,
        };

        if (this.state.state === "thread-selected") {
          this.state = {
            state: "thread-overview",
            activeThreadId: msg.id,
          };
        }

        if (thread) {
          this.fireThreadYieldCallbacks(msg.id);
        }

        return;
      }

      case "set-active-thread":
        if (msg.id in this.threadWrappers) {
          this.state = {
            state: "thread-selected",
            activeThreadId: msg.id,
          };
        }
        return;

      case "threads-navigate-up":
        // If we're viewing a thread and it has a parent, navigate to parent
        if (
          this.state.state === "thread-selected" &&
          this.state.activeThreadId
        ) {
          const threadWrapper = this.threadWrappers[this.state.activeThreadId];
          if (threadWrapper?.parentThreadId) {
            // Navigate to parent thread
            this.state = {
              state: "thread-selected",
              activeThreadId: threadWrapper.parentThreadId,
            };

            // Scroll to bottom when navigating to parent
            setTimeout(() => {
              this.context.dispatch({
                type: "sidebar-msg",
                msg: {
                  type: "scroll-to-last-user-message",
                },
              });
            }, 100);

            return;
          }
        }

        // Otherwise, navigate to thread overview
        this.state = {
          state: "thread-overview",
          activeThreadId: this.state.activeThreadId,
        };
        return;

      case "threads-overview":
        // Force navigation to thread overview regardless of current state
        this.state = {
          state: "thread-overview",
          activeThreadId: this.state.activeThreadId,
        };
        return;

      case "delete-thread": {
        const rootId = this.getRootAncestorId(msg.id);
        this.deleteThreadSubtree(rootId);
        return;
      }

      case "toggle-thread-expand":
        if (this.expandedThreads.has(msg.id)) {
          this.expandedThreads.delete(msg.id);
        } else {
          this.expandedThreads.add(msg.id);
        }
        return;

      default:
        assertUnreachable(msg);
    }
  }

  getMessages() {
    if (
      this.state.state === "thread-selected" &&
      this.state.activeThreadId in this.threadWrappers
    ) {
      const threadState = this.threadWrappers[this.state.activeThreadId];
      if (threadState.state === "initialized") {
        return threadState.thread.getMessages();
      }
    }
    return [];
  }

  /** Get the active agent for use as context in forceToolUse calls */
  getContextAgent() {
    if (
      this.state.state === "thread-selected" &&
      this.state.activeThreadId in this.threadWrappers
    ) {
      const threadState = this.threadWrappers[this.state.activeThreadId];
      if (threadState.state === "initialized") {
        return threadState.thread.agent;
      }
    }
    return undefined;
  }

  private async createThreadWithContext({
    threadId,
    profile,
    contextFiles = [],
    parent,
    inputMessages,
    threadType,
    subagentConfig,
    fileIO,
    environmentConfig,
    dockerSpawnConfig,
    getParentThread,
  }: {
    threadId: ThreadId;
    profile: Profile;
    contextFiles?: UnresolvedFilePath[];
    parent?: ThreadId;
    inputMessages?: InputMessage[];
    threadType: ThreadType;
    subagentConfig?: SubagentConfig;
    fileIO?: FileIO;
    environmentConfig?: EnvironmentConfig;
    dockerSpawnConfig?: DockerSpawnConfig | undefined;
    getParentThread?: () => Thread | undefined;
  }) {
    this.threadWrappers[threadId] = {
      state: "pending",
      parentThreadId: parent,
      depth: parent ? (this.threadWrappers[parent]?.depth ?? 0) + 1 : 0,
      lastActivityTime: Date.now(),
    };

    const resolvedConfig: EnvironmentConfig = environmentConfig ?? {
      type: "local",
    };

    const bypassRef = { get: () => false as boolean };

    const [autoContextFiles, environment] = await Promise.all([
      resolveAutoContext({
        ...this.context,
        options: this.context.getOptions(),
      }),
      resolvedConfig.type === "docker"
        ? createDockerEnvironment({
            container: resolvedConfig.container,
            cwd: resolvedConfig.cwd,
            threadId,
          })
        : Promise.resolve(
            createLocalEnvironment({
              nvim: this.context.nvim,
              lsp: this.context.lsp,

              cwd: resolvedConfig.cwd ?? this.context.cwd,
              homeDir: this.context.homeDir,
              getOptions: this.context.getOptions,
              threadId,
              sandbox: this.context.sandbox,
              onPendingChange: () =>
                this.context.dispatch({
                  type: "thread-msg",
                  id: threadId,
                  msg: { type: "permission-pending-change" },
                }),
              isBypassed: () => bypassRef.get(),
            }),
          ),
    ]);

    const initialFiles = autoContextFilesToInitialFiles(autoContextFiles);

    if (fileIO) {
      environment.fileIO = fileIO;
      environment.sandboxViolationHandler = undefined;
    }

    const systemPrompt = await createSystemPrompt(threadType, {
      nvim: this.context.nvim,
      cwd: environment.cwd,
      options: this.context.getOptions(),
      fileIO: environment.fileIO,
      homeDir: environment.homeDir,
      ...(resolvedConfig.type === "docker"
        ? {
            systemInfoOverrides: {
              platform: "linux (docker)",
              cwd: environment.cwd,
            },
          }
        : {}),
      ...(subagentConfig ? { subagentConfig } : {}),
    });

    const thread = new Thread(threadId, threadType, systemPrompt, {
      ...this.context,
      options: this.context.getOptions(),
      mcpToolManager: this.mcpToolManager,
      profile,
      chat: this,
      environment,
      initialFiles,
      ...(subagentConfig ? { subagentConfig } : {}),
      ...(getParentThread ? { getParentThread } : {}),
    });

    bypassRef.get = () => thread.isSandboxBypassed;

    if (contextFiles.length > 0) {
      await thread.contextManager.addFiles(contextFiles);
    }

    if (dockerSpawnConfig?.supervised) {
      thread.supervisor = new DockerSupervisor(
        dockerSpawnConfig.containerName,
        dockerSpawnConfig.workspacePath,
        dockerSpawnConfig.hostDir,
        {
          onProgress: (message) => {
            thread.core.update({
              type: "set-teardown-message",
              message,
            });
            this.context.dispatch({
              type: "thread-msg",
              id: thread.id,
              msg: { type: "tool-progress" },
            });
          },
        },
      );
    } else if (threadType === "subagent" || threadType === "docker_root") {
      thread.supervisor = new SubagentSupervisor();
    }

    this.context.dispatch({
      type: "chat-msg",
      msg: {
        type: "thread-initialized",
        thread,
      },
    });

    if (inputMessages) {
      this.context.dispatch({
        type: "thread-msg",
        id: threadId,
        msg: {
          type: "send-message",
          messages: inputMessages,
        },
      });
    }

    return thread;
  }

  async createNewThread(): Promise<ThreadId> {
    const id = uuidv7() as ThreadId;

    await this.createThreadWithContext({
      threadId: id,
      profile: getActiveProfile(
        this.context.getOptions().profiles,
        this.context.getOptions().activeProfile,
      ),
      threadType: "root",
    });

    return id;
  }

  async createNewAgentThread(agentName: string): Promise<ThreadId> {
    const agents = loadAgents({
      cwd: this.context.cwd,
      logger: this.context.nvim.logger,
      options: this.context.getOptions(),
    });
    const agentDef = agents[agentName];
    if (!agentDef) {
      throw new Error(
        `Agent "${agentName}" not found. Available agents: ${Object.keys(agents).join(", ")}`,
      );
    }

    const id = uuidv7() as ThreadId;
    const subagentConfig: SubagentConfig = {
      agentName: agentDef.name,
      systemPrompt: agentDef.systemPrompt,
      systemReminder: agentDef.systemReminder,
      tier: agentDef.tier,
    };

    await this.createThreadWithContext({
      threadId: id,
      profile: getActiveProfile(
        this.context.getOptions().profiles,
        this.context.getOptions().activeProfile,
      ),
      threadType: "root",
      ...(subagentConfig ? { subagentConfig } : {}),
    });

    return id;
  }

  private getRootAncestorId(threadId: ThreadId): ThreadId {
    let current = threadId;
    let parentId = this.threadWrappers[current]?.parentThreadId;
    while (parentId !== undefined) {
      current = parentId;
      parentId = this.threadWrappers[current]?.parentThreadId;
    }
    return current;
  }

  private deleteThreadSubtree(rootId: ThreadId): void {
    const childrenMap = this.buildChildrenMap();
    const idsToDelete: ThreadId[] = [];
    const collectIds = (id: ThreadId) => {
      idsToDelete.push(id);
      for (const childId of childrenMap.get(id) ?? []) {
        collectIds(childId);
      }
    };
    collectIds(rootId);

    for (const id of idsToDelete) {
      const wrapper = this.threadWrappers[id];
      if (wrapper?.state === "initialized") {
        wrapper.thread.destroy().catch((e: Error) => {
          this.context.nvim.logger.error(
            `Error destroying thread ${id} during delete: ${e.message}`,
          );
        });
      }
      delete this.threadWrappers[id];
      this.threadYieldCallbacks.delete(id);
    }

    this.expandedThreads.delete(rootId);

    if (
      this.state.activeThreadId &&
      idsToDelete.includes(this.state.activeThreadId)
    ) {
      this.state = {
        state: "thread-overview",
        activeThreadId: undefined,
      };
    }
  }

  private collectSubtreeViolationViews(
    threadId: ThreadId,
    childrenMap: Map<ThreadId, ThreadId[]>,
  ): VDOMNode[] {
    const views: VDOMNode[] = [];
    const wrapper = this.threadWrappers[threadId];
    if (
      wrapper?.state === "initialized" &&
      wrapper.thread.sandboxViolationHandler
    ) {
      const handler = wrapper.thread.sandboxViolationHandler;
      if (handler.getPendingViolations().size > 0) {
        views.push(handler.view());
      }
    }
    const children = childrenMap.get(threadId) ?? [];
    for (const childId of children) {
      views.push(...this.collectSubtreeViolationViews(childId, childrenMap));
    }
    return views;
  }

  private buildChildrenMap(): Map<ThreadId, ThreadId[]> {
    const childrenMap = new Map<ThreadId, ThreadId[]>();
    for (const [idStr, threadWrapper] of Object.entries(this.threadWrappers)) {
      const parentId = threadWrapper.parentThreadId;
      if (parentId !== undefined) {
        if (!childrenMap.has(parentId)) {
          childrenMap.set(parentId, []);
        }
        childrenMap.get(parentId)!.push(idStr as ThreadId);
      }
    }
    return childrenMap;
  }

  private formatThreadStatus(threadId: ThreadId): string {
    const summary = this.getThreadSummary(threadId);

    switch (summary.status.type) {
      case "missing":
        return "❓ not found";

      case "pending":
        return "⏳ initializing";

      case "running":
        return `⏳ ${summary.status.activity}`;

      case "stopped":
        return `⏹️ stopped (${summary.status.reason})`;

      case "yielded":
        return "✅ yielded";

      case "error": {
        const truncatedError =
          summary.status.message.length > 50
            ? `${summary.status.message.substring(0, 47)}...`
            : summary.status.message;
        return `❌ error: ${truncatedError}`;
      }

      default:
        return assertUnreachable(summary.status);
    }
  }

  getThreadDisplayName(threadId: ThreadId): string {
    const threadWrapper = this.threadWrappers[threadId];
    if (!threadWrapper || threadWrapper.state !== "initialized") {
      return "[Untitled]";
    }

    const thread = threadWrapper.thread;
    if (thread.core.state.title) {
      return thread.core.state.title;
    }

    // Find the first user message text
    const messages = thread.getProviderMessages();
    for (const message of messages) {
      if (message.role === "user") {
        for (const content of message.content) {
          if (content.type === "text" && content.text.trim()) {
            const text = content.text.trim();
            return text.length > 50 ? `${text.substring(0, 50)}...` : text;
          }
        }
      }
    }

    return "[Untitled]";
  }

  private renderThread(
    threadId: ThreadId,
    depth: number,
    activeThreadId: ThreadId | undefined,
    options?: {
      hasChildren: boolean;
      isExpanded: boolean;
      childCount: number;
    },
  ): VDOMNode {
    const displayName = this.getThreadDisplayName(threadId);
    const status = this.formatThreadStatus(threadId);
    const marker = threadId === activeThreadId ? "*" : "-";
    const indent = "  ".repeat(depth);
    const threadWrapper = this.threadWrappers[threadId];
    const threadType =
      threadWrapper?.state === "initialized"
        ? threadWrapper.thread.core.state.threadType
        : undefined;
    const icon = threadType === "docker_root" ? "🐳 " : "";

    const expandIndicator = options?.hasChildren
      ? options.isExpanded
        ? "▼ "
        : "▶ "
      : "";
    const childCountSuffix = options?.hasChildren
      ? ` (${options.childCount} subthreads)`
      : "";

    const displayLine = `${indent}${marker} ${expandIndicator}${icon}${displayName}: ${status}${childCountSuffix}`;

    const bindings: Record<string, () => void> = {
      "<CR>": () =>
        this.context.dispatch({
          type: "select-thread-effect",
          id: threadId,
        }),
      dd: () =>
        this.context.dispatch({
          type: "chat-msg",
          msg: {
            type: "delete-thread",
            id: threadId,
          },
        }),
    };

    if (options?.hasChildren) {
      bindings["="] = () =>
        this.context.dispatch({
          type: "chat-msg",
          msg: {
            type: "toggle-thread-expand",
            id: threadId,
          },
        });
    }

    return withBindings(d`${displayLine}`, bindings);
  }

  private renderThreadSubtree(
    threadId: ThreadId,
    childrenMap: Map<ThreadId, ThreadId[]>,
    activeThreadId: ThreadId | undefined,
    views: VDOMNode[],
  ) {
    const wrapper = this.threadWrappers[threadId];
    views.push(this.renderThread(threadId, wrapper.depth, activeThreadId));
    const children = childrenMap.get(threadId) || [];
    for (const childId of children) {
      this.renderThreadSubtree(childId, childrenMap, activeThreadId, views);
    }
  }

  private countSubtreeThreads(
    threadId: ThreadId,
    childrenMap: Map<ThreadId, ThreadId[]>,
  ): number {
    const children = childrenMap.get(threadId) ?? [];
    let count = children.length;
    for (const childId of children) {
      count += this.countSubtreeThreads(childId, childrenMap);
    }
    return count;
  }

  renderThreadOverview() {
    if (Object.keys(this.threadWrappers).length === 0) {
      return d`# Threads

No threads yet`;
    }

    const childrenMap = this.buildChildrenMap();
    const threadViews: VDOMNode[] = [];

    const rootThreads: { id: ThreadId; lastActivityTime: number }[] = [];
    for (const [idStr, wrapper] of Object.entries(this.threadWrappers)) {
      if (wrapper.parentThreadId === undefined) {
        rootThreads.push({
          id: idStr as ThreadId,
          lastActivityTime: wrapper.lastActivityTime,
        });
      }
    }

    rootThreads.sort((a, b) => b.lastActivityTime - a.lastActivityTime);

    for (const { id } of rootThreads) {
      const hasChildren = (childrenMap.get(id)?.length ?? 0) > 0;
      const isExpanded = this.expandedThreads.has(id);
      const childCount = hasChildren
        ? this.countSubtreeThreads(id, childrenMap)
        : 0;

      threadViews.push(
        this.renderThread(id, 0, this.state.activeThreadId, {
          hasChildren,
          isExpanded,
          childCount,
        }),
      );

      if (hasChildren && isExpanded) {
        const children = childrenMap.get(id) ?? [];
        for (const childId of children) {
          this.renderThreadSubtree(
            childId,
            childrenMap,
            this.state.activeThreadId,
            threadViews,
          );
        }
      } else if (hasChildren && !isExpanded) {
        const violationViews = this.collectSubtreeViolationViews(
          id,
          childrenMap,
        );
        for (const violationView of violationViews) {
          threadViews.push(violationView);
        }
      }
    }

    return d`# Threads

${threadViews.map((view) => d`${view}\n`)}`;
  }

  getActiveThread(): Thread {
    if (!this.state.activeThreadId) {
      throw new Error(`Chat is not initialized yet... no active thread`);
    }
    const threadWrapper = this.threadWrappers[this.state.activeThreadId];
    if (!(threadWrapper && threadWrapper.state === "initialized")) {
      throw new Error(
        `Thread ${this.state.activeThreadId} not initialized yet...`,
      );
    }
    return threadWrapper.thread;
  }

  async handleForkThread({
    sourceThreadId,
    truncateAtMessageIdx,
  }: {
    sourceThreadId: ThreadId;
    truncateAtMessageIdx?: NativeMessageIdx;
  }): Promise<ThreadId> {
    const sourceThreadWrapper = this.threadWrappers[sourceThreadId];
    if (!sourceThreadWrapper || sourceThreadWrapper.state !== "initialized") {
      throw new Error(`Thread ${sourceThreadId} not available for forking`);
    }

    const sourceThread = sourceThreadWrapper.thread;
    const sourceAgent = sourceThread.agent;

    // Abort any in-progress operations and wait for completion
    // This handles both streaming and tool_use states
    const agentStatus = sourceAgent.getState().status;
    if (
      agentStatus.type === "streaming" ||
      (agentStatus.type === "stopped" && agentStatus.stopReason === "tool_use")
    ) {
      await sourceThread.abortAndWait();
    }

    const newThreadId = uuidv7() as ThreadId;

    const clonedAgent = sourceAgent.clone();

    if (truncateAtMessageIdx !== undefined) {
      clonedAgent.truncateMessages(truncateAtMessageIdx);
    }

    // Create the new thread with the cloned agent
    this.threadWrappers[newThreadId] = {
      state: "pending",
      parentThreadId: undefined,
      depth: 0,
      lastActivityTime: Date.now(),
    };

    const [autoContextFiles, systemPrompt] = await Promise.all([
      resolveAutoContext({
        ...this.context,
        options: this.context.getOptions(),
      }),
      createSystemPrompt("root", {
        nvim: this.context.nvim,
        cwd: this.context.cwd,
        options: this.context.getOptions(),
        fileIO: new FsFileIO(),
        homeDir: this.context.homeDir,
      }),
    ]);

    const initialFiles = autoContextFilesToInitialFiles(autoContextFiles);

    // Copy context files from source thread
    for (const [absFilePath, fileContext] of Object.entries(
      sourceThread.contextManager.files,
    )) {
      initialFiles[absFilePath as AbsFilePath] = {
        relFilePath: fileContext.relFilePath,
        fileTypeInfo: fileContext.fileTypeInfo,
        agentView: undefined,
      };
    }

    const forkBypassRef = { get: () => false as boolean };

    const forkEnvironment = createLocalEnvironment({
      nvim: this.context.nvim,
      lsp: this.context.lsp,

      cwd: this.context.cwd,
      homeDir: this.context.homeDir,
      getOptions: this.context.getOptions,
      threadId: newThreadId,
      sandbox: this.context.sandbox,
      onPendingChange: () =>
        this.context.dispatch({
          type: "thread-msg",
          id: newThreadId,
          msg: { type: "permission-pending-change" },
        }),
      isBypassed: () => forkBypassRef.get(),
    });

    const thread = new Thread(
      newThreadId,
      "root",
      systemPrompt,
      {
        ...this.context,
        options: this.context.getOptions(),
        mcpToolManager: this.mcpToolManager,
        profile: sourceThread.context.profile,
        chat: this,
        environment: forkEnvironment,
        initialFiles,
      },
      clonedAgent,
    );

    thread.sandboxBypassed = sourceThread.isSandboxBypassed;
    forkBypassRef.get = () => thread.isSandboxBypassed;

    this.context.dispatch({
      type: "chat-msg",
      msg: {
        type: "thread-initialized",
        thread,
      },
    });

    return newThreadId;
  }

  getThreadResult(
    threadId: ThreadId,
  ): { status: "done"; result: Result<string> } | { status: "pending" } {
    const threadWrapper = this.threadWrappers[threadId];
    if (!threadWrapper) {
      return {
        status: "pending",
      };
    }

    switch (threadWrapper.state) {
      case "pending":
        return { status: "pending" };

      case "error":
        return {
          status: "done",
          result: {
            status: "error",
            error: threadWrapper.error.message,
          },
        };

      case "initialized": {
        const thread = threadWrapper.thread;

        const agentStatus = thread.agent.getState().status;

        // Check for yielded state first
        if (thread.core.state.mode.type === "yielded") {
          return {
            status: "done",
            result: {
              status: "ok",
              value: thread.core.state.mode.response,
            },
          };
        }

        // Check for error state
        if (agentStatus.type === "error") {
          return {
            status: "done",
            result: {
              status: "error",
              error: agentStatus.error.message,
            },
          };
        }

        // All other states (including aborted) are considered pending.
        // An aborted thread can still be resumed and eventually yield.
        return { status: "pending" };
      }

      default:
        return assertUnreachable(threadWrapper);
    }
  }

  threadHasPendingApprovals(threadId: ThreadId): boolean {
    if (this.getThreadPendingApprovalTools(threadId).length > 0) return true;
    const wrapper = this.threadWrappers[threadId];
    if (!wrapper || wrapper.state !== "initialized") return false;
    return (
      (wrapper.thread.sandboxViolationHandler?.getPendingViolations().size ??
        0) > 0
    );
  }
  getThreadPendingApprovalTools(_threadId: ThreadId): never[] {
    return [];
  }

  isSandboxBypassed(threadId: ThreadId | undefined): boolean {
    if (!threadId) return false;
    const wrapper = this.threadWrappers[threadId];
    if (!wrapper || wrapper.state !== "initialized") return false;
    return wrapper.thread.isSandboxBypassed;
  }

  getThreadSummary(threadId: ThreadId): {
    title?: string | undefined;
    status:
      | { type: "missing" }
      | { type: "pending" }
      | { type: "running"; activity: string }
      | { type: "stopped"; reason: string }
      | { type: "yielded"; response: string }
      | { type: "error"; message: string };
  } {
    const threadWrapper = this.threadWrappers[threadId];
    if (!threadWrapper) {
      return {
        status: { type: "missing" },
      };
    }

    switch (threadWrapper.state) {
      case "pending":
        return {
          status: { type: "pending" },
        };

      case "error":
        return {
          status: {
            type: "error",
            message: threadWrapper.error.message,
          },
        };

      case "initialized": {
        const thread = threadWrapper.thread;
        const mode = thread.core.state.mode;
        const agentStatus = thread.agent.getState().status;

        const summary = {
          title: thread.core.state.title,
          status: (() => {
            // Check mode for thread-specific states first
            if (mode.type === "yielded") {
              if (mode.teardownMessage) {
                return {
                  type: "running" as const,
                  activity: `🐳 ${mode.teardownMessage}`,
                };
              }
              return {
                type: "yielded" as const,
                response: mode.response,
              };
            }

            if (mode.type === "tool_use") {
              const hasPendingApproval =
                this.threadHasPendingApprovals(threadId);
              return {
                type: "running" as const,
                activity: hasPendingApproval
                  ? "waiting for approval"
                  : "executing tools",
              };
            }

            // Then check agent status
            switch (agentStatus.type) {
              case "error":
                return {
                  type: "error" as const,
                  message: agentStatus.error.message,
                };

              case "stopped":
                return {
                  type: "stopped" as const,
                  reason: agentStatus.stopReason,
                };

              case "streaming":
                return {
                  type: "running" as const,
                  activity: "streaming response",
                };

              default:
                return assertUnreachable(agentStatus);
            }
          })(),
        };

        return summary;
      }

      default:
        return assertUnreachable(threadWrapper);
    }
  }

  private fireThreadYieldCallbacks(threadId: ThreadId): void {
    const callbacks = this.threadYieldCallbacks.get(threadId);
    if (callbacks && callbacks.length > 0) {
      for (const callback of callbacks) {
        callback();
      }
      this.threadYieldCallbacks.delete(threadId);
    }
  }

  async spawnThread(opts: {
    parentThreadId: ThreadId;
    prompt: string;
    threadType: ThreadType;
    subagentConfig?: SubagentConfig;
    contextFiles?: UnresolvedFilePath[];
    dockerSpawnConfig?: DockerSpawnConfig;
    cwd?: string;
  }): Promise<ThreadId> {
    const parentThreadId = opts.parentThreadId;
    const parentThreadWrapper = this.threadWrappers[parentThreadId];
    if (!parentThreadWrapper || parentThreadWrapper.state !== "initialized") {
      throw new Error(`Parent thread ${parentThreadId} not available`);
    }

    const parentThread = parentThreadWrapper.thread;
    const subagentThreadId = uuidv7() as ThreadId;

    const subagentProfile: Profile = opts.subagentConfig?.fastModel
      ? {
          ...parentThread.context.profile,
          model: parentThread.context.profile.fastModel,
          thinking: undefined,
          reasoning: undefined,
        }
      : parentThread.context.profile;

    let environmentConfig: EnvironmentConfig;
    if (opts.dockerSpawnConfig) {
      environmentConfig = {
        type: "docker",
        container: opts.dockerSpawnConfig.containerName,
        cwd: opts.dockerSpawnConfig.workspacePath,
      };
    } else if (opts.cwd) {
      environmentConfig = {
        type: "local",
        cwd: opts.cwd as NvimCwd,
      };
    } else {
      environmentConfig = parentThread.context.environment.environmentConfig;
    }

    const thread = await this.createThreadWithContext({
      threadId: subagentThreadId,
      profile: subagentProfile,
      contextFiles: opts.contextFiles || [],
      parent: parentThreadId,
      inputMessages: [{ type: "system", text: opts.prompt }],
      threadType: opts.threadType,
      ...(opts.subagentConfig ? { subagentConfig: opts.subagentConfig } : {}),
      environmentConfig,
      dockerSpawnConfig: opts.dockerSpawnConfig,
      getParentThread: () => {
        const wrapper = this.threadWrappers[parentThreadId];
        return wrapper?.state === "initialized" ? wrapper.thread : undefined;
      },
    });

    return thread.id;
  }

  onThreadYielded(threadId: ThreadId, callback: () => void): void {
    let callbacks = this.threadYieldCallbacks.get(threadId);
    if (!callbacks) {
      callbacks = [];
      this.threadYieldCallbacks.set(threadId, callbacks);
    }
    callbacks.push(callback);
  }

  renderSingleThread(threadId: ThreadId) {
    const threadWrapper = this.threadWrappers[threadId];

    if (!threadWrapper) {
      return d`Thread not found`;
    }

    switch (threadWrapper.state) {
      case "pending":
        return d`Initializing thread...`;
      case "initialized": {
        const thread = threadWrapper.thread;
        let parentView: string | VDOMNode;

        if (threadWrapper.parentThreadId) {
          const parent = threadWrapper.parentThreadId;
          const parentDisplayName = this.getThreadDisplayName(parent);
          parentView = withBindings(d`Parent thread: ${parentDisplayName}\n`, {
            "<CR>": () =>
              this.context.dispatch({
                type: "select-thread-effect",
                id: parent,
              }),
          });
        } else {
          parentView = "";
        }

        return d`${parentView}${threadView({
          thread,
          dispatch: (msg) =>
            this.context.dispatch({
              type: "thread-msg",
              id: thread.id,
              msg,
            }),
        })}`;
      }
      case "error":
        return d`Error: ${threadWrapper.error.message}`;
      default:
        assertUnreachable(threadWrapper);
    }
  }
}

function getActiveProfile(profiles: Profile[], activeProfile: string) {
  const profile = profiles.find((p) => p.name === activeProfile);
  if (!profile) {
    throw new Error(`Profile ${activeProfile} not found.`);
  }
  return profile;
}
