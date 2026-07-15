import type {
  FileIO,
  InputMessage,
  NativeMessageIdx,
  ScriptRunner,
  SubagentConfig,
  ThreadId,
  ThreadType,
} from "@magenta/core";
import {
  AutoCompactSupervisor,
  deleteArchivedThread,
  listArchivedThreadIds,
  loadAgents,
  MCPToolManagerImpl,
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  readArchivedThreadLog,
  readThreadMeta,
  renderThreadLogToMarkdown,
  SubagentSupervisor,
  ThreadTitle,
  threadCreatedAt,
} from "@magenta/core";
import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import { v7 as uuidv7 } from "uuid";
import type { Lsp } from "../capabilities/lsp.ts";
import type {
  DockerSpawnConfig,
  ThreadManager,
} from "../capabilities/thread-manager.ts";
import {
  autoContextFilesToInitialFiles,
  discoverHierarchyContext,
  resolveAutoContext,
} from "../context/auto-context.ts";
import {
  createDockerEnvironment,
  createLocalEnvironment,
  type EnvironmentConfig,
} from "../environment.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { openScratchInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow.ts";
import type { MagentaOptions, Profile } from "../options.ts";
import { getProvider } from "../providers/provider.ts";
import {
  buildSystemInfo,
  createSystemPrompt,
} from "../providers/system-prompt.ts";
import type { RootMsg } from "../root-msg.ts";
import type { Sandbox } from "../sandbox-manager.ts";
import type { ScriptInvocationId } from "../scripts/script-manager.ts";
import type { Dispatch } from "../tea/tea.ts";
import { d, type VDOMNode, withBindings, withError } from "../tea/view.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type {
  AbsFilePath,
  HomeDir,
  NvimCwd,
  UnresolvedFilePath,
} from "../utils/files.ts";
import type { Result } from "../utils/result.ts";
import { formatTokenCount } from "../utils/tokens.ts";
import type { SandboxRoot } from "./thread.ts";
import { Thread } from "./thread.ts";
import { DockerSupervisor } from "./thread-supervisor.ts";
import { view as threadView } from "./thread-view.ts";

const ARCHIVE_PAGE_SIZE = 50;

const ARCHIVE_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** Hydration state of an archived thread's title. Absence of a key in the
 * titles map means not-yet-hydrated; these variants describe a hydrated row. */
type ArchiveTitle =
  | { status: "untitled" }
  | { status: "titled"; title: string };

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
  scriptInvocationId?: ScriptInvocationId;
  depth: number;
  lastActivityTime: number;
  lastViewedTime: number;
};

type ChatState =
  | {
      state: "thread-overview";
      activeThreadId: ThreadId | undefined;
    }
  | {
      state: "thread-selected";
      activeThreadId: ThreadId;
    }
  | {
      state: "archive";
      activeThreadId: ThreadId | undefined;
      threadIds: ThreadId[];
      loadedCount: number;
      titles: { [id: ThreadId]: ArchiveTitle };
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
    }
  | {
      type: "delete-thread-subtree";
      id: ThreadId;
    }
  | {
      type: "archive-open";
    }
  | {
      type: "archive-listed";
      threadIds: ThreadId[];
    }
  | {
      type: "archive-navigate-back";
    }
  | {
      type: "archive-load-more";
    }
  | {
      type: "archive-delete-thread";
      id: ThreadId;
    }
  | {
      type: "archive-delete-threads";
      ids: ThreadId[];
    }
  | {
      type: "archive-meta-loaded";
      id: ThreadId;
      title: ArchiveTitle;
    };

export type ChatMsg = {
  type: "chat-msg";
  msg: Msg;
};

export class Chat implements ThreadManager {
  state: ChatState;
  public threadWrappers: { [id: ThreadId]: ThreadWrapper };
  public scriptRunner: ScriptRunner | undefined = undefined;
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
      removeThreadBuffers?: (ids: ThreadId[]) => void;
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

        if (msg.msg.type === "turn-ended") {
          this.threadWrappers[msg.id].lastActivityTime = Date.now();
        }

        if (msg.msg.type === "permission-pending-change") {
          this.threadWrappers[msg.id].lastActivityTime = Date.now();
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

        if (this.getThreadResult(thread.id).status === "done") {
          this.fireThreadYieldCallbacks(thread.id);
        }
      }
    }
  }

  /** Record that we've stopped viewing the currently-selected thread, so that
   * any activity from this point on counts as unviewed. */
  private markActiveThreadViewed() {
    if (
      this.state.state === "thread-selected" &&
      this.state.activeThreadId in this.threadWrappers
    ) {
      this.threadWrappers[this.state.activeThreadId].lastViewedTime =
        Date.now();
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
          ...(prev.scriptInvocationId
            ? { scriptInvocationId: prev.scriptInvocationId }
            : {}),
          depth: prev.depth,
          lastActivityTime: prev.lastActivityTime,
          lastViewedTime: prev.lastViewedTime,
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
          ...(thread.scriptInvocationId
            ? { scriptInvocationId: thread.scriptInvocationId }
            : {}),
          depth: thread.depth,
          lastActivityTime: thread.lastActivityTime,
          lastViewedTime: thread.lastViewedTime,
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
          this.markActiveThreadViewed();
          this.threadWrappers[msg.id].lastViewedTime = Date.now();
          this.state = {
            state: "thread-selected",
            activeThreadId: msg.id,
          };
        }
        return;

      case "threads-navigate-up":
        this.markActiveThreadViewed();
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
                  type: "set-cursor-to-bottom",
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
        this.markActiveThreadViewed();
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

      case "delete-thread-subtree": {
        this.deleteThreadSubtree(msg.id);
        return;
      }

      case "toggle-thread-expand":
        if (this.expandedThreads.has(msg.id)) {
          this.expandedThreads.delete(msg.id);
        } else {
          this.expandedThreads.add(msg.id);
        }
        return;

      case "archive-open": {
        this.markActiveThreadViewed();
        this.state = {
          state: "archive",
          activeThreadId: this.state.activeThreadId,
          threadIds: [],
          loadedCount: ARCHIVE_PAGE_SIZE,
          titles: {},
        };
        void this.loadArchiveList();
        return;
      }

      case "archive-listed": {
        if (this.state.state !== "archive") return;
        this.state.threadIds = msg.threadIds;
        this.hydrateArchiveTitles();
        return;
      }

      case "archive-navigate-back": {
        this.state = {
          state: "thread-overview",
          activeThreadId: this.state.activeThreadId,
        };
        return;
      }

      case "archive-load-more": {
        if (this.state.state !== "archive") return;
        this.state.loadedCount += ARCHIVE_PAGE_SIZE;
        this.hydrateArchiveTitles();
        return;
      }

      case "archive-delete-thread": {
        if (this.state.state !== "archive") return;
        this.state.threadIds = this.state.threadIds.filter(
          (id) => id !== msg.id,
        );
        delete this.state.titles[msg.id];
        void deleteArchivedThread(msg.id).catch((err: Error) => {
          this.context.nvim.logger.error(
            `Failed to delete archived thread ${msg.id}: ${err.message}`,
          );
        });
        return;
      }

      case "archive-delete-threads": {
        if (this.state.state !== "archive") return;
        const idSet = new Set(msg.ids);
        this.state.threadIds = this.state.threadIds.filter(
          (id) => !idSet.has(id),
        );
        for (const id of msg.ids) {
          delete this.state.titles[id];
          void deleteArchivedThread(id).catch((err: Error) => {
            this.context.nvim.logger.error(
              `Failed to delete archived thread ${id}: ${err.message}`,
            );
          });
        }
        return;
      }

      case "archive-meta-loaded": {
        if (this.state.state !== "archive") return;
        this.state.titles[msg.id] = msg.title;
        return;
      }

      default:
        assertUnreachable(msg);
    }
  }

  /** Read the archived thread id list off disk and dispatch it back into the
   * archive state. Cheap: readdir + name parsing, no file contents. */
  private async loadArchiveList(): Promise<void> {
    try {
      const threadIds = await listArchivedThreadIds();
      this.myDispatch({ type: "archive-listed", threadIds });
    } catch (err) {
      this.context.nvim.logger.error(
        `Failed to list archived threads: ${(err as Error).message}`,
      );
    }
  }

  /** Lazily read `meta.json` sidecars for the currently-visible window of
   * archived threads, dispatching a message per row as its title arrives. Ids
   * whose title is already hydrated are skipped. */
  private hydrateArchiveTitles(): void {
    if (this.state.state !== "archive") return;
    const window = this.state.threadIds.slice(0, this.state.loadedCount);
    for (const id of window) {
      if (id in this.state.titles) continue;
      void readThreadMeta(id)
        .then((meta) => {
          this.myDispatch({
            type: "archive-meta-loaded",
            id,
            title:
              meta.title === undefined
                ? { status: "untitled" }
                : { status: "titled", title: meta.title },
          });
        })
        .catch((err: Error) => {
          this.context.nvim.logger.error(
            `Failed to read archived thread meta ${id}: ${err.message}`,
          );
        });
    }
  }

  private myDispatch(msg: Msg): void {
    this.context.dispatch({ type: "chat-msg", msg });
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

  private triggerHierarchyDiscovery(
    thread: Thread,
    absFilePath: AbsFilePath,
  ): void {
    discoverHierarchyContext(absFilePath, {
      nvim: this.context.nvim,
      cwd: this.context.cwd,
      homeDir: this.context.homeDir,
      options: this.context.getOptions(),
    })
      .then((discovered) => {
        for (const file of discovered) {
          thread.contextManager.addFileContext(
            file.absFilePath,
            file.relFilePath,
            file.fileTypeInfo,
          );
        }
      })
      .catch((err: Error) => {
        this.context.nvim.logger.error(
          `Error discovering hierarchy context for ${absFilePath}: ${err.message}`,
        );
      });
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
    getSandboxRoot,
    yieldSchema,
    scriptInvocationId,
    autoCompactThreshold,
    autoCompactPrompt,
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
    getSandboxRoot?: () => SandboxRoot | undefined;
    yieldSchema?: JSONSchemaType;
    scriptInvocationId?: ScriptInvocationId;
    autoCompactThreshold?: number;
    autoCompactPrompt?: string;
  }) {
    this.threadWrappers[threadId] = {
      state: "pending",
      parentThreadId: parent,
      ...(scriptInvocationId ? { scriptInvocationId } : {}),
      depth: parent ? (this.threadWrappers[parent]?.depth ?? 0) + 1 : 0,
      lastActivityTime: Date.now(),
      lastViewedTime: Date.now(),
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
      this.scriptRunner?.discover(),
    ]);

    const initialFiles = autoContextFilesToInitialFiles(autoContextFiles);

    if (fileIO) {
      environment.fileIO = fileIO;
      environment.sandboxViolationHandler = undefined;
    }

    const initialGitState = await environment.gitClient.getState();

    const systemInfo = await buildSystemInfo({
      nvim: this.context.nvim,
      cwd: environment.cwd,
      systemInfoOverrides: {
        git: initialGitState,
        ...(resolvedConfig.type === "docker"
          ? { platform: "linux (docker)", cwd: environment.cwd }
          : {}),
      },
    });

    const systemPrompt = await createSystemPrompt(threadType, {
      nvim: this.context.nvim,
      cwd: environment.cwd,
      options: this.context.getOptions(),
      fileIO: environment.fileIO,
      homeDir: environment.homeDir,
      ...(subagentConfig ? { subagentConfig } : {}),
    });

    const thread = new Thread(threadId, threadType, systemPrompt, {
      ...this.context,
      options: {
        ...this.context.getOptions(),
        ...(autoCompactPrompt !== undefined ? { autoCompactPrompt } : {}),
      },
      mcpToolManager: this.mcpToolManager,
      profile,
      chat: this,
      environment,
      initialFiles,
      initialGitState,
      systemInfo,
      ...(subagentConfig ? { subagentConfig } : {}),
      ...(getParentThread ? { getParentThread } : {}),
      ...(getSandboxRoot ? { getSandboxRoot } : {}),
      ...(yieldSchema ? { yieldSchema } : {}),
    });

    bypassRef.get = () => thread.isSandboxBypassed;

    thread.contextManager.on("fileAdded", (absFilePath) => {
      this.triggerHierarchyDiscovery(thread, absFilePath);
    });

    for (const absFilePath of Object.keys(
      thread.contextManager.files,
    ) as AbsFilePath[]) {
      this.triggerHierarchyDiscovery(thread, absFilePath);
    }

    if (contextFiles.length > 0) {
      await thread.contextManager.addFiles(contextFiles);
    }

    const autoCompact =
      threadType === "compact"
        ? []
        : [
            new AutoCompactSupervisor({
              threshold:
                autoCompactThreshold ??
                this.context.getOptions().autoCompactThreshold,
            }),
          ];

    if (dockerSpawnConfig?.supervised) {
      thread.supervisors = [
        new DockerSupervisor(
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
        ),
      ];
      thread.supervisors.push(...autoCompact);
    } else if (threadType === "subagent" || threadType === "docker_root") {
      thread.supervisors = [new SubagentSupervisor(), ...autoCompact];
    } else {
      thread.supervisors = autoCompact;
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

    this.context.removeThreadBuffers?.(idsToDelete);

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

  /** A thread wants the user's attention if it has unviewed activity (a
   * completed turn or a pending permission approval) and has not yielded. */
  threadNeedsAttention(threadId: ThreadId): boolean {
    const wrapper = this.threadWrappers[threadId];
    if (wrapper === undefined || wrapper.state !== "initialized") return false;
    const core = wrapper.thread.core;
    // A yielded thread has finished its work; a streaming thread is actively
    // working. Neither needs the user's attention.
    if (core.state.mode.type === "yielded") return false;
    if (core.getProviderStatus().type === "streaming") return false;
    return wrapper.lastActivityTime > wrapper.lastViewedTime;
  }

  /** Whether any thread in a script-owned subtree wants attention. */
  scriptSubtreeNeedsAttention(threadId: ThreadId): boolean {
    const childrenMap = this.buildChildrenMap();
    const visit = (id: ThreadId): boolean =>
      this.threadNeedsAttention(id) || (childrenMap.get(id) ?? []).some(visit);
    return visit(threadId);
  }

  /**
   * Render a script-owned thread and its subtree, indented starting at the
   * given base depth (the script row sits above at depth 0). Used by the
   * Scripts section in the overview.
   */
  renderScriptThreadSubtree(threadId: ThreadId, baseDepth: number): VDOMNode[] {
    const childrenMap = this.buildChildrenMap();
    const views: VDOMNode[] = [];
    this.renderScriptSubtreeInner(threadId, childrenMap, baseDepth, views);
    return views;
  }

  private renderScriptSubtreeInner(
    threadId: ThreadId,
    childrenMap: Map<ThreadId, ThreadId[]>,
    depth: number,
    views: VDOMNode[],
  ) {
    if (!this.threadWrappers[threadId]) return;
    views.push(
      this.renderThread(threadId, depth, this.state.activeThreadId, undefined, {
        showTokenCount: true,
      }),
    );
    for (const childId of childrenMap.get(threadId) ?? []) {
      this.renderScriptSubtreeInner(childId, childrenMap, depth + 1, views);
    }
  }

  /**
   * Collect pending-permission views for a script-owned thread's subtree, so a
   * collapsed script row never hides a blocking permission prompt.
   */
  approveAllPendingInSubtree(threadId: ThreadId): void {
    this.approveSubtreePending(threadId, this.buildChildrenMap());
  }

  private approveSubtreePending(
    threadId: ThreadId,
    childrenMap: Map<ThreadId, ThreadId[]>,
  ): void {
    const wrapper = this.threadWrappers[threadId];
    if (wrapper?.state === "initialized") {
      wrapper.thread.sandboxViolationHandler?.approveAll();
    }
    for (const childId of childrenMap.get(threadId) ?? []) {
      this.approveSubtreePending(childId, childrenMap);
    }
  }

  collectScriptSubtreeViolationViews(threadId: ThreadId): VDOMNode[] {
    return this.collectSubtreeViolationViews(threadId, this.buildChildrenMap());
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
    extra?: {
      showTokenCount: boolean;
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

    const isSandboxBypassed =
      threadWrapper?.state === "initialized"
        ? threadWrapper.thread.isSandboxBypassed
        : false;
    const sandboxIndicator =
      depth === 0 && isSandboxBypassed ? withError(d` SANDBOX OFF `) : d``;

    const bell = this.threadNeedsAttention(threadId) ? "🔔 " : "";

    const expandIndicator = options?.hasChildren
      ? options.isExpanded
        ? "▼ "
        : "▶ "
      : "";
    const childCountSuffix = options?.hasChildren
      ? ` (${options.childCount} subthreads)`
      : "";

    let tokenSuffix = "";
    if (extra?.showTokenCount && threadWrapper?.state === "initialized") {
      const tokenCount = threadWrapper.thread.core.getLastStopTokenCount();
      if (tokenCount > 0) {
        tokenSuffix = ` [${formatTokenCount(tokenCount)}]`;
      }
    }

    const displayLine = d`${indent}${marker} ${bell}${expandIndicator}${icon}${sandboxIndicator}${displayName}: ${status}${childCountSuffix}${tokenSuffix}`;

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

    bindings.t = () =>
      this.context.dispatch({
        type: "thread-msg",
        id: threadId,
        msg: { type: "toggle-sandbox-bypass" },
      });

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

    return withBindings(displayLine, bindings);
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
    const archiveLink = withBindings(d`[archive]`, {
      "<CR>": () => this.myDispatch({ type: "archive-open" }),
    });

    if (Object.keys(this.threadWrappers).length === 0) {
      return d`# Threads ${archiveLink}

No threads yet`;
    }

    const childrenMap = this.buildChildrenMap();
    const threadViews: VDOMNode[] = [];

    const rootThreads: { id: ThreadId }[] = [];
    for (const [idStr, wrapper] of Object.entries(this.threadWrappers)) {
      // Script-owned threads are rendered nested under their script invocation
      // in the Scripts section, not as top-level threads here.
      if (
        wrapper.parentThreadId === undefined &&
        wrapper.scriptInvocationId === undefined
      ) {
        rootThreads.push({ id: idStr as ThreadId });
      }
    }

    // ThreadIds are uuidv7 (time-ordered), so sorting by id descending yields
    // most-recently-created first. This order is stable regardless of activity.
    rootThreads.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

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

    return d`# Threads ${archiveLink}

${threadViews.map((view) => d`${view}\n`)}`;
  }

  renderArchive(): VDOMNode {
    if (this.state.state !== "archive") {
      return d``;
    }

    const backLink = withBindings(d`< back to threads`, {
      "<CR>": () => this.myDispatch({ type: "archive-navigate-back" }),
    });

    if (this.state.threadIds.length === 0) {
      return d`# Archived threads

${backLink}

No archived threads`;
    }

    const rows: VDOMNode[] = [];
    for (const id of this.state.threadIds) {
      rows.push(d`${this.renderArchiveRow(id)}\n`);
    }

    const remaining = this.state.threadIds.length - this.state.loadedCount;
    const loadMore =
      remaining > 0
        ? withBindings(d`\n[load more] (${remaining.toString()} older)`, {
            "<CR>": () => this.myDispatch({ type: "archive-load-more" }),
          })
        : d``;

    return d`# Archived threads

${backLink}

${rows}${loadMore}`;
  }

  private renderArchiveRow(threadId: ThreadId): VDOMNode {
    if (this.state.state !== "archive") return d``;

    const date = ARCHIVE_DATE_FORMAT.format(threadCreatedAt(threadId));
    const titleEntry = this.state.titles[threadId];
    const title =
      titleEntry === undefined
        ? "…"
        : titleEntry.status === "untitled"
          ? "(untitled)"
          : titleEntry.title;

    const line = d`- ${date}  ${title}`;

    return withBindings(line, {
      "<CR>": () => {
        void (async () => {
          try {
            const entries = await readArchivedThreadLog(threadId);
            const markdown = renderThreadLogToMarkdown(entries);
            await openScratchInNonMagentaWindow(
              markdown.split("\n"),
              `archived-thread-${threadId}.md`,
              {
                nvim: this.context.nvim,
                options: this.context.getOptions(),
              },
            );
          } catch (error) {
            this.context.nvim.logger.error(
              `Error opening archived thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        })();
      },
      dd: () =>
        this.myDispatch({ type: "archive-delete-thread", id: threadId }),
      d: (ctx) => {
        if (this.state.state !== "archive") return;
        const idx = this.state.threadIds.indexOf(threadId);
        if (idx === -1) return;
        const count = ctx?.selection?.length ?? 1;
        const ids = this.state.threadIds.slice(idx, idx + count);
        this.myDispatch({ type: "archive-delete-threads", ids });
      },
    });
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
    const idx =
      truncateAtMessageIdx ?? sourceThread.agent.getNativeMessageIdx();

    const newThreadId = uuidv7() as ThreadId;
    this.threadWrappers[newThreadId] = {
      state: "pending",
      parentThreadId: undefined,
      depth: 0,
      lastActivityTime: Date.now(),
      lastViewedTime: Date.now(),
    };

    const thread = await Thread.cloneFromNativeMessageIdx({
      sourceThread,
      newThreadId,
      nativeMessageIdx: idx,
      chat: this,
      mcpToolManager: this.mcpToolManager,
      dispatch: this.context.dispatch,
      nvim: this.context.nvim,
      cwd: this.context.cwd,
      homeDir: this.context.homeDir,
      lsp: this.context.lsp,
      sandbox: this.context.sandbox,
      getOptions: this.context.getOptions,
      getDisplayWidth: this.context.getDisplayWidth,
    });

    thread.contextManager.on("fileAdded", (absFilePath) => {
      this.triggerHierarchyDiscovery(thread, absFilePath);
    });

    const markerIdx = thread.core.getProviderMessages().length;
    thread.agent.appendUserMessage([
      {
        type: "text",
        text: "<fork-notification>The user forked this thread at this point. They may want to switch gears or ask follow-up questions from here.</fork-notification>",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);
    thread.state.messageViewState[markerIdx] = {
      ...thread.state.messageViewState[markerIdx],
      forkedFrom: sourceThreadId,
    };

    sourceThread.state.forkedTo.push({
      childThreadId: newThreadId,
      atMessageIdx: idx,
    });
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

        // All other states (including aborted and error) are considered
        // pending. An aborted or errored thread can still be resumed and
        // eventually yield.
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
      : opts.subagentConfig?.thinkingModel
        ? {
            ...parentThread.context.profile,
            model: parentThread.context.profile.thinkingModel,
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

  async spawnScriptThread(opts: {
    scriptInvocationId: ScriptInvocationId;
    prompt: string;
    yieldSchema: JSONSchemaType;
    getSandboxRoot: () => SandboxRoot | undefined;
    profile?: Profile;
    cwd?: string;
    contextFiles?: string[];
    systemReminder?: string;
    autoCompactThreshold?: number;
    autoCompactPrompt?: string;
  }): Promise<ThreadId> {
    const threadId = uuidv7() as ThreadId;
    const profile =
      opts.profile ??
      getActiveProfile(
        this.context.getOptions().profiles,
        this.context.getOptions().activeProfile,
      );

    const environmentConfig: EnvironmentConfig = {
      type: "local",
      ...(opts.cwd ? { cwd: opts.cwd as NvimCwd } : {}),
    };

    const thread = await this.createThreadWithContext({
      threadId,
      profile,
      ...(opts.contextFiles
        ? { contextFiles: opts.contextFiles as UnresolvedFilePath[] }
        : {}),
      inputMessages: [{ type: "system", text: opts.prompt }],
      threadType: "subagent",
      environmentConfig,
      ...(opts.systemReminder
        ? { subagentConfig: { systemReminder: opts.systemReminder } }
        : {}),
      scriptInvocationId: opts.scriptInvocationId,
      yieldSchema: opts.yieldSchema,
      getSandboxRoot: opts.getSandboxRoot,
      ...(opts.autoCompactThreshold !== undefined
        ? { autoCompactThreshold: opts.autoCompactThreshold }
        : {}),
      ...(opts.autoCompactPrompt !== undefined
        ? { autoCompactPrompt: opts.autoCompactPrompt }
        : {}),
    });

    return thread.id;
  }

  /** Generate a concise title for a script invocation, mirroring how thread
   * titles are generated: a fast-model forced tool-use call. */
  async generateScriptTitle(
    scriptName: string,
    description: string,
    parameters: unknown,
  ): Promise<string | undefined> {
    const profile = getActiveProfile(
      this.context.getOptions().profiles,
      this.context.getOptions().activeProfile,
    );
    const request = getProvider(this.context.nvim, profile).forceToolUse({
      model: profile.fastModel,
      input: [
        {
          type: "text",
          text: `\
A script has been invoked. Come up with a succinct title describing this specific invocation.

Script name: ${scriptName}
Description: ${description}
Parameters: ${JSON.stringify(parameters)}

The title must be a single line (no newlines) and a few words long (ideally around 40 characters or fewer).`,
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ],
      spec: ThreadTitle.spec,
      disableCaching: true,
    });
    const result = await request.promise;
    if (result.toolRequest.status === "ok") {
      return (result.toolRequest.value.input as ThreadTitle.Input).title;
    }
    return undefined;
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
