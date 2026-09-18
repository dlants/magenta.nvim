import {
  type AgentTurn,
  type BeforeRequestDecision,
  runAgentLoop,
  type ToolExecution,
} from "./agent.ts";
import type { OnToolAppliedHook } from "./capabilities/context-tracker.ts";
import type { FileIO } from "./capabilities/file-io.ts";
import type { GitClient, GitState } from "./capabilities/git-client.ts";
import type { SubagentConfig, ThreadId, ThreadType } from "./chat-types.ts";
import type { EdlRegisters } from "./edl/index.ts";
import type { Logger } from "./logger.ts";
import type { ProviderProfile } from "./provider-options.ts";
import { ABORT_MARKER_TEXT } from "./providers/inference-shared.ts";
import type {
  AgentInput,
  NativeInferenceManager,
  NativeMessageIdx,
  NonEmptyRequestedTools,
  Provider,
  ProviderMessageContent,
  ProviderToolSpec,
} from "./providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./providers/provider-types.ts";
import type { SystemInfo, SystemPrompt } from "./providers/system-prompt.ts";
import {
  FileSupervisor,
  type Files,
  type FileUpdates,
  type HierarchyDiscovery,
} from "./supervisors/file-supervisor.ts";
import {
  type GitContextUpdate,
  GitSupervisor,
} from "./supervisors/git-supervisor.ts";
import { SystemReminderSupervisor } from "./system-reminder-supervisor.ts";
import type {
  SendResult,
  ToolInvocationState,
  ToolResultsHook,
} from "./thread-api.ts";
import {
  EditedFilesSupervisor,
  SystemInfoSupervisor,
} from "./thread-supervisor.ts";
import { executeToolBatch } from "./tool-executor.ts";
import type { CompletedToolInfo, ToolRequestId } from "./tool-types.ts";
import type { CreateTool, ThreadToolCreator } from "./tools/create-tool.ts";
import type { HomeDir, NvimCwd } from "./utils/files.ts";

export interface ThreadCoreContext {
  logger: Logger;
  threadType: ThreadType;
  profile: ProviderProfile;
  provider: Provider;
  subagentConfig?: SubagentConfig;
  toolSpecs: ProviderToolSpec[];
  cwd: NvimCwd;
  homeDir: HomeDir;
  systemPrompt: SystemPrompt;
  systemInfo: SystemInfo;
  fileIO: FileIO;
  gitClient: GitClient;
  discoverHierarchy?: HierarchyDiscovery;
  threadToolCreator: ThreadToolCreator;
}

/** The structured form of the context injected into one message, retained so
 * the view can render it from history instead of observing delivery. */
export type ContextDelivery = {
  files?: FileUpdates;
  git?: GitContextUpdate;
};

export interface ThreadCoreCallbacks {
  onUpdate: () => void;
  onBeforeRequest: () => Promise<BeforeRequestDecision>;
  onToolResults: ToolResultsHook;
  onToolApplied: OnToolAppliedHook;
}

export type ThreadCoreSeed = {
  initialFiles?: Files;
  initialGitState?: GitState;
};

interface ThreadCoreState {
  manager: NativeInferenceManager;
  fileSupervisor: FileSupervisor;
  gitSupervisor: GitSupervisor | undefined;
  systemInfoSupervisor: SystemInfoSupervisor | undefined;
  systemReminders: SystemReminderSupervisor | undefined;
  editedFilesSupervisor: EditedFilesSupervisor;
  edlRegisters: EdlRegisters;
  contextDeliveries: Map<NativeMessageIdx, ContextDelivery>;
}

export class ThreadCore {
  preflightTokenCount: number | undefined;
  private disposed = false;

  readonly manager: NativeInferenceManager;
  readonly toolSpecs: ProviderToolSpec[];
  readonly fileSupervisor: FileSupervisor;
  readonly gitSupervisor: GitSupervisor | undefined;
  readonly systemInfoSupervisor: SystemInfoSupervisor | undefined;
  readonly systemReminders: SystemReminderSupervisor | undefined;
  readonly editedFilesSupervisor: EditedFilesSupervisor;
  readonly edlRegisters: EdlRegisters;
  private readonly contextDeliveries: Map<NativeMessageIdx, ContextDelivery>;
  private readonly createTool: CreateTool;

  static create(
    id: ThreadId,
    context: ThreadCoreContext,
    callbacks: ThreadCoreCallbacks,
    completedTools: Map<ToolRequestId, CompletedToolInfo>,
    seed: ThreadCoreSeed = {},
  ): ThreadCore {
    const manager = context.provider.createInferenceManager({
      profile: context.profile,
      systemPrompt: context.systemPrompt,
      tools: context.toolSpecs,
      ...(context.subagentConfig?.effort
        ? { effortOverride: context.subagentConfig.effort }
        : {}),
    });
    const fileSupervisor = FileSupervisor.create({
      logger: context.logger,
      fileIO: context.fileIO,
      cwd: context.cwd,
      homeDir: context.homeDir,
      ...(context.discoverHierarchy
        ? { discoverHierarchy: context.discoverHierarchy }
        : {}),
      initialFiles: seed.initialFiles ?? {},
    });
    const state: ThreadCoreState = {
      manager,
      fileSupervisor,
      editedFilesSupervisor: EditedFilesSupervisor.create(),
      gitSupervisor: GitSupervisor.create({
        gitClient: context.gitClient,
        initialGitState: seed.initialGitState,
        logger: context.logger,
      }),
      systemInfoSupervisor:
        context.threadType !== "compact"
          ? SystemInfoSupervisor.create({
              systemInfo: context.systemInfo,
              alreadyInjected: manager.log.messages.length > 0,
            })
          : undefined,
      systemReminders:
        context.threadType === "compact"
          ? undefined
          : SystemReminderSupervisor.create({
              threadType: context.threadType,
              subagentConfig: context.subagentConfig,
              contextTracker: fileSupervisor,
              getCompletedTools: () => completedTools,
            }),
      edlRegisters: { registers: new Map(), nextSavedId: 0 },
      contextDeliveries: new Map(),
    };
    return new ThreadCore(id, context, callbacks, completedTools, state);
  }

  static clone(
    id: ThreadId,
    context: ThreadCoreContext,
    callbacks: ThreadCoreCallbacks,
    completedTools: Map<ToolRequestId, CompletedToolInfo>,
    fork: { source: ThreadCore; nativeMessageIdx: NativeMessageIdx },
  ): ThreadCore {
    const source = fork.source;
    const manager = source.manager.clone();
    manager.truncateMessages(fork.nativeMessageIdx);
    const nativeMessageIdx = manager.getNativeMessageIdx();
    const fileSupervisor = FileSupervisor.clone({
      source: source.fileSupervisor,
      history: { type: "truncate", nativeMessageIdx },
      deps: context,
    });
    const state: ThreadCoreState = {
      manager,
      fileSupervisor,
      editedFilesSupervisor: EditedFilesSupervisor.clone({
        source: source.editedFilesSupervisor,
        nativeMessageIdx,
      }),
      gitSupervisor: source.gitSupervisor
        ? GitSupervisor.clone({
            source: source.gitSupervisor,
            gitClient: context.gitClient,
            logger: context.logger,
            nativeMessageIdx,
          })
        : undefined,
      systemInfoSupervisor: source.systemInfoSupervisor
        ? SystemInfoSupervisor.clone({
            source: source.systemInfoSupervisor,
            nativeMessageIdx,
          })
        : undefined,
      systemReminders: source.systemReminders
        ? SystemReminderSupervisor.clone({
            source: source.systemReminders,
            nativeMessageIdx,
            contextTracker: fileSupervisor,
            getCompletedTools: () => completedTools,
          })
        : undefined,
      edlRegisters: {
        registers: new Map(source.edlRegisters.registers),
        nextSavedId: source.edlRegisters.nextSavedId,
      },
      contextDeliveries: new Map(
        [...source.contextDeliveries].filter(
          ([idx]) => idx <= nativeMessageIdx,
        ),
      ),
    };
    return new ThreadCore(id, context, callbacks, completedTools, state);
  }

  private constructor(
    readonly id: ThreadId,
    private readonly context: ThreadCoreContext,
    private readonly callbacks: ThreadCoreCallbacks,
    private readonly completedTools: Map<ToolRequestId, CompletedToolInfo>,
    state: ThreadCoreState,
  ) {
    this.toolSpecs = context.toolSpecs;
    this.manager = state.manager;
    this.fileSupervisor = state.fileSupervisor;
    this.gitSupervisor = state.gitSupervisor;
    this.systemInfoSupervisor = state.systemInfoSupervisor;
    this.systemReminders = state.systemReminders;
    this.editedFilesSupervisor = state.editedFilesSupervisor;
    this.edlRegisters = state.edlRegisters;
    this.contextDeliveries = state.contextDeliveries;
    this.createTool = context.threadToolCreator({
      contextTracker: this.fileSupervisor,
      edlRegisters: this.edlRegisters,
      onToolApplied: (absFilePath, tool, fileTypeInfo) => {
        if (this.isActive)
          callbacks.onToolApplied({
            absFilePath,
            tool,
            fileTypeInfo,
            nativeMessageIdx: this.pendingResultMessageIdx,
          });
      },
      requestRender: () => this.handleUpdate(),
    });
    this.fileSupervisor.callbacks = {
      onPendingUpdatesChanged: () => this.handleUpdate(),
      onSent: (files, idx) => this.recordDelivery(idx, { files }),
    };
    if (this.gitSupervisor) {
      this.gitSupervisor.callbacks = {
        onSent: (git, idx) => this.recordDelivery(idx, { git }),
      };
    }
  }

  private recordDelivery(
    nativeMessageIdx: NativeMessageIdx,
    delivery: ContextDelivery,
  ): void {
    this.contextDeliveries.set(nativeMessageIdx, {
      ...this.contextDeliveries.get(nativeMessageIdx),
      ...delivery,
    });
    this.handleUpdate();
  }

  getContextDelivery(
    nativeMessageIdx: NativeMessageIdx,
  ): ContextDelivery | undefined {
    return this.contextDeliveries.get(nativeMessageIdx);
  }

  get isActive(): boolean {
    return !this.disposed;
  }
  private handleUpdate(): void {
    if (!this.disposed) this.callbacks.onUpdate();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.fileSupervisor.destroy();
    if (this.gitSupervisor) this.gitSupervisor.callbacks = {};
    await this.abortAgentTurn();
  }

  private resultMessageIdx: NativeMessageIdx | undefined;

  private executeTools(
    requests: NonEmptyRequestedTools,
    publishTools: (tools: ToolInvocationState) => void,
  ): ToolExecution {
    this.resultMessageIdx = this.manager.getPendingResultMessageIdx(requests);
    const execution = executeToolBatch(requests, {
      createTool: this.createTool,
      completedTools: this.completedTools,
      publishTools,
      onUpdate: () => this.handleUpdate(),
    });
    return {
      ...execution,
      promise: execution.promise.finally(() => {
        this.resultMessageIdx = undefined;
      }),
    };
  }
  get lastAssistantMessage():
    | ReadonlyArray<ProviderMessageContent>
    | undefined {
    const messages = this.manager.log.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        return messages[i].content;
      }
    }
    return undefined;
  }
  getLastStopTokenCount(): number {
    if (this.preflightTokenCount !== undefined) {
      return this.preflightTokenCount;
    }
    const latestUsage = this.manager.log.latestUsage;
    if (!latestUsage) {
      return 0;
    }
    return (
      latestUsage.inputTokens +
      latestUsage.outputTokens +
      (latestUsage.cacheHits || 0) +
      (latestUsage.cacheMisses || 0)
    );
  }

  /** The idx of the last message that will hold the results of the tools
   * running right now. The running batch fixed it when it started, so there
   * is one place it is decided and no stale metadata to fall back to. */
  get pendingResultMessageIdx(): NativeMessageIdx {
    if (this.resultMessageIdx === undefined) {
      throw new Error("onToolApplied called without a running tool batch");
    }
    return this.resultMessageIdx;
  }

  async runTurn(messages: AgentInput[]): Promise<SendResult> {
    if (!this.isActive) return { type: "aborted" };
    const turn = runAgentLoop(
      {
        logger: this.context.logger,
        manager: this.manager,
        executeTools: (requests, publishTools) =>
          this.executeTools(requests, publishTools),
        onBeforeRequest: () =>
          this.isActive
            ? this.callbacks.onBeforeRequest()
            : Promise.resolve({ type: "proceed", injections: [] }),
        onToolResults: (results, idx) =>
          this.isActive
            ? this.callbacks.onToolResults(results, idx)
            : undefined,

        onUpdate: () => this.handleUpdate(),
      },
      messages,
    );
    this.agentTurn = turn;
    this.handleUpdate();
    try {
      const result = await turn.promise;
      if (result.type === "failed") {
        this.context.logger.error(result.error);
      }
      if (result.type === "aborted") {
        this.manager.appendUserMessage([
          {
            type: "text",
            text: ABORT_MARKER_TEXT,
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          },
        ]);
      }
      return result;
    } finally {
      this.agentTurn = undefined;
      this.handleUpdate();
    }
  }
  private agentTurn: AgentTurn | undefined;
  get activity() {
    return this.agentTurn?.loopState;
  }
  get aborting(): boolean {
    return this.agentTurn?.loopState.aborting ?? false;
  }
  async abortAgentTurn(): Promise<void> {
    const turn = this.agentTurn;
    if (!turn) return;
    turn.abort();
    await turn.promise.catch(() => {});
  }
}
