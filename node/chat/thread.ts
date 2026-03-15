import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThreadSupervisor } from "@magenta/core";
import {
  type ContextFiles,
  type ContextManager,
  type InputMessage,
  type MCPToolManagerImpl,
  ThreadCore,
  type ThreadId,
  type ThreadType,
  type ToolRequestId,
} from "@magenta/core";
import player from "play-sound";
import type { PermissionCheckingFileIO } from "../capabilities/permission-file-io.ts";
import type { PermissionCheckingShell } from "../capabilities/permission-shell.ts";
import type { FileUpdates } from "../context/context-manager.ts";
import type { Environment } from "../environment.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow.ts";
import type { MagentaOptions, Profile } from "../options.ts";
import {
  type Agent,
  type AgentStatus,
  getProvider,
  type ProviderMessage,
} from "../providers/provider.ts";
import type { SystemPrompt } from "../providers/system-prompt.ts";
import type { RootMsg } from "../root-msg.ts";
import type { Dispatch } from "../tea/tea.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { HomeDir, NvimCwd, UnresolvedFilePath } from "../utils/files.ts";
import type { Chat } from "./chat.ts";

export type Msg =
  | { type: "set-title"; title: string }
  | {
      type: "send-message";
      messages: InputMessage[];
      async?: boolean;
    }
  | {
      type: "abort";
    }
  | {
      type: "start-compaction";
      nextPrompt?: string;
      contextFiles?: string[];
    }
  | {
      type: "toggle-system-prompt";
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
      type: "toggle-tool-details";
      toolRequestId: ToolRequestId;
    }
  | {
      type: "open-edit-file";
      filePath: UnresolvedFilePath;
    }
  | {
      type: "permission-pending-change";
    }
  | {
      type: "tool-progress";
    }
  | {
      type: "toggle-compaction-record";
      recordIdx: number;
    }
  | {
      type: "toggle-compaction-step";
      recordIdx: number;
      stepIdx: number;
    };

export type ThreadMsg = {
  type: "thread-msg";
  id: ThreadId;
  msg: Msg;
};

/** View state for a single message, stored separately from provider thread content */
export type MessageViewState = {
  contextUpdates?: FileUpdates;
  expandedUpdates?: { [absFilePath: string]: boolean };
  expandedContent?: { [contentIdx: number]: boolean };
};

/** View state for tools, keyed by tool request ID */
export type ToolViewState = {
  details: boolean;
};

export class Thread {
  public state: {
    showSystemPrompt: boolean;
    messageViewState: { [messageIdx: number]: MessageViewState };
    toolViewState: { [toolRequestId: ToolRequestId]: ToolViewState };
    compactionViewState: {
      [recordIdx: number]: {
        expanded: boolean;
        expandedSteps: { [stepIdx: number]: boolean };
      };
    };
  };

  public core: ThreadCore;
  private myDispatch: Dispatch<Msg>;
  public permissionFileIO: PermissionCheckingFileIO | undefined;
  public permissionShell: PermissionCheckingShell | undefined;

  get contextManager(): ContextManager {
    return this.core.contextManager;
  }

  get agent(): Agent {
    return this.core.agent;
  }

  get supervisor(): ThreadSupervisor | undefined {
    return this.core.supervisor;
  }

  set supervisor(value: ThreadSupervisor | undefined) {
    this.core.supervisor = value;
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
      environment: Environment;
      initialFiles?: ContextFiles;
    },
    clonedAgent?: Agent,
  ) {
    this.myDispatch = (msg) =>
      this.context.dispatch({
        type: "thread-msg",
        id: this.id,
        msg,
      });

    const env = this.context.environment;
    this.permissionFileIO = env.permissionFileIO;
    this.permissionShell = env.permissionShell;

    this.state = {
      showSystemPrompt: false,
      messageViewState: {},
      toolViewState: {},
      compactionViewState: {},
    };

    const isDocker = env.environmentConfig.type === "docker";

    this.core = new ThreadCore(
      id,
      {
        logger: context.nvim.logger,
        profile: context.profile,
        cwd: isDocker ? env.cwd : context.cwd,
        homeDir: isDocker ? env.homeDir : context.homeDir,
        threadType,
        systemPrompt,
        mcpToolManager: context.mcpToolManager,
        threadManager: context.chat,
        fileIO: env.fileIO,
        shell: env.shell,
        lspClient: env.lspClient,
        diagnosticsProvider: env.diagnosticsProvider,
        availableCapabilities: env.availableCapabilities,
        environmentConfig: env.environmentConfig,
        maxConcurrentSubagents: context.options.maxConcurrentSubagents || 3,
        container: context.options.container,
        toolSkills: isDocker
          ? (context.options.toolSkills?.docker ?? [])
          : (context.options.toolSkills?.host ?? []),
        getProvider: (profile) => getProvider(context.nvim, profile),
        ...(context.initialFiles ? { initialFiles: context.initialFiles } : {}),
      },
      clonedAgent,
    );

    this.core.on("update", () => this.myDispatch({ type: "tool-progress" }));
    this.core.on("playChime", () => this.playChimeIfNeeded());
    this.core.on("scrollToLastMessage", () =>
      this.context.dispatch({
        type: "sidebar-msg",
        msg: { type: "scroll-to-last-user-message" },
      }),
    );
    this.core.on("setupResubmit", (lastUserMessage) =>
      this.context.dispatch({
        type: "sidebar-msg",
        msg: { type: "setup-resubmit", lastUserMessage },
      }),
    );

    this.core.on("aborting", () => {
      this.permissionFileIO?.denyAll();
      this.permissionShell?.denyAll();
    });
    this.core.on("contextUpdatesSent", (updates) => {
      const messageCount = this.core.getProviderMessages().length;
      this.state.messageViewState[messageCount] = {
        contextUpdates: updates as FileUpdates,
      };
    });
    // Re-render when context files change (added/removed directly on core)
    this.contextManager.on("fileAdded", () =>
      this.myDispatch({ type: "tool-progress" }),
    );
    this.contextManager.on("fileRemoved", () =>
      this.myDispatch({ type: "tool-progress" }),
    );
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

  update(msg: RootMsg): void {
    if (msg.type === "thread-msg" && msg.id === this.id) {
      this.myUpdate(msg.msg);
    }
  }

  private myUpdate(msg: Msg): void {
    console.error(`[Thread ${this.id}] myUpdate: ${msg.type}`);
    switch (msg.type) {
      case "send-message":
        this.core
          .handleSendMessageRequest(msg.messages, msg.async)
          .catch((e: Error) => this.context.nvim.logger.error(e));
        return;

      case "start-compaction":
        this.core.startCompaction(msg.nextPrompt, msg.contextFiles);
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

      case "toggle-tool-details": {
        const toolState = this.state.toolViewState[msg.toolRequestId] || {
          details: false,
        };
        toolState.details = !toolState.details;
        this.state.toolViewState[msg.toolRequestId] = toolState;
        return;
      }

      case "open-edit-file":
        openFileInNonMagentaWindow(msg.filePath, this.context).catch(
          (e: Error) => this.context.nvim.logger.error(e.message),
        );
        return;

      case "permission-pending-change":
      case "tool-progress":
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

      default:
        assertUnreachable(msg);
    }
  }

  async abortAndWait(): Promise<void> {
    await this.core.abort();
  }

  private playChimeIfNeeded(): void {
    const agentStatus = this.core.agent.getState().status;

    if (
      agentStatus.type === "stopped" &&
      agentStatus.stopReason === "end_turn"
    ) {
      this.playChimeSound();
      return;
    }
  }

  private playChimeSound(): void {
    const actualVolume = this.context.options.chimeVolume;

    if (!actualVolume) {
      return;
    }

    try {
      const play = player();
      const chimeFile = join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "chime.wav",
      );

      const playOptions = {
        afplay: ["-v", actualVolume.toString()],
        aplay: ["-v", `${Math.round(actualVolume * 100).toString()}%`],
        mpg123: ["-f", Math.round(actualVolume * 32768).toString()],
      };

      play.play(chimeFile, playOptions, (err: Error | null) => {
        if (err) {
          this.context.nvim.logger.error(
            `Failed to play chime sound: ${err.message}`,
          );
        }
      });
    } catch (error) {
      this.context.nvim.logger.error(
        `Error setting up chime sound: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
