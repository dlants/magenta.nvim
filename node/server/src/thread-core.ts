import {
  type AgentTurn,
  type BeforeRequestDecision,
  runAgentLoop,
  type ToolExecution,
} from "./agent.ts";
import type { OnToolAppliedHook } from "./capabilities/context-tracker.ts";
import type { ThreadId } from "./chat-types.ts";
import type { EdlRegisters } from "./edl/index.ts";
import type { Logger } from "./logger.ts";
import { ABORT_MARKER_TEXT } from "./providers/inference-shared.ts";
import type {
  AgentInput,
  NativeInferenceManager,
  NativeMessageIdx,
  NonEmptyRequestedTools,
  ProviderMessageContent,
  ProviderToolSpec,
} from "./providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./providers/provider-types.ts";
import {
  FileSupervisor,
  type Files,
  type FileUpdates,
} from "./supervisors/file-supervisor.ts";
import {
  type GitContextUpdate,
  GitSupervisor,
} from "./supervisors/git-supervisor.ts";
import { SystemReminderSupervisor } from "./system-reminder-supervisor.ts";
import type { ThreadContext } from "./thread.ts";
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
import type { CreateTool } from "./tools/create-tool.ts";
import { getToolSpecs } from "./tools/toolManager.ts";
import type { AbsFilePath } from "./utils/files.ts";

export interface ThreadCoreCallbacks {
  onUpdate: () => void;
  onBeforeRequest: () => Promise<BeforeRequestDecision>;
  onToolResults: ToolResultsHook;
  onToolApplied: OnToolAppliedHook;
  onFilesSent: (updates: FileUpdates) => void;
  onGitSent: (update: GitContextUpdate) => void;
  onFileAdded: (path: AbsFilePath) => void;
}

export class ThreadCore {
  preflightTokenCount: number | undefined;
  private disposed = false;

  readonly manager: NativeInferenceManager;
  readonly toolSpecs: ProviderToolSpec[];
  fileSupervisor!: FileSupervisor;
  gitSupervisor: GitSupervisor | undefined;
  systemInfoSupervisor: SystemInfoSupervisor | undefined;
  systemReminders: SystemReminderSupervisor | undefined;
  editedFilesSupervisor!: EditedFilesSupervisor;
  edlRegisters: EdlRegisters = { registers: new Map(), nextSavedId: 0 };
  private readonly context: {
    logger: Logger;
    createTool: CreateTool;
  };

  constructor(
    readonly id: ThreadId,
    private readonly environment: ThreadContext,
    private readonly callbacks: ThreadCoreCallbacks,
    private readonly completedTools: Map<ToolRequestId, CompletedToolInfo>,
    options: {
      initialFiles?: Files;
      fork?: { source: ThreadCore; nativeMessageIdx: NativeMessageIdx };
    } = {},
  ) {
    this.toolSpecs = ThreadCore.buildToolSpecs(environment);
    this.manager = options.fork
      ? this.cloneHistory(options.fork.source, options.fork.nativeMessageIdx)
      : environment.provider.createInferenceManager({
          profile: environment.profile,
          systemPrompt: environment.systemPrompt,
          tools: this.toolSpecs,
          ...(environment.subagentConfig?.effort
            ? { effortOverride: environment.subagentConfig.effort }
            : {}),
        });
    if (!options.fork)
      this.createSupervisors(this.manager, options.initialFiles);
    const createTool = environment.clientToolCreator({ threadId: id })({
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
    this.context = { logger: environment.logger, createTool };
    this.fileSupervisor.on("pendingUpdatesChanged", () => this.handleUpdate());
    this.fileSupervisor.on("sent", (updates) => {
      if (this.isActive) callbacks.onFilesSent(updates);
    });
    this.fileSupervisor.on("fileAdded", (path) => {
      if (this.isActive) callbacks.onFileAdded(path);
    });
    this.gitSupervisor?.on("sent", (update) => {
      if (this.isActive) callbacks.onGitSent(update);
    });
  }

  private static buildToolSpecs(context: ThreadContext): ProviderToolSpec[] {
    return getToolSpecs(
      context.threadType,
      context.mcpToolManager,
      context.availableCapabilities,
      context.getAgents(),
      context.subagentConfig,
      context.yieldSchema,
      context.getScriptRunner?.()?.getScriptCatalog(),
      context.subagentDockerfile,
    );
  }

  private createSupervisors(
    manager: NativeInferenceManager,
    initialFiles?: Files,
  ): void {
    const context = this.environment;
    const delivery = context.contextDelivery;
    this.editedFilesSupervisor = EditedFilesSupervisor.create();
    this.fileSupervisor = FileSupervisor.create({
      logger: context.logger,
      fileIO: context.fileIO,
      cwd: context.cwd,
      homeDir: context.homeDir,
      initialFiles: initialFiles ?? delivery?.initialFiles ?? {},
      ...(delivery?.pollIntervalMs !== undefined
        ? { pollIntervalMs: delivery.pollIntervalMs }
        : {}),
    });
    this.gitSupervisor = delivery
      ? GitSupervisor.create({
          gitClient: context.gitClient,
          initialGitState: delivery.initialGitState,
          logger: context.logger,
        })
      : undefined;
    this.systemInfoSupervisor =
      delivery && context.threadType !== "compact"
        ? SystemInfoSupervisor.create({
            systemInfo: context.systemInfo,
            alreadyInjected: manager.log.messages.length > 0,
          })
        : undefined;
    this.systemReminders =
      context.threadType === "compact"
        ? undefined
        : SystemReminderSupervisor.create({
            threadType: context.threadType,
            subagentConfig: context.subagentConfig,
            contextTracker: this.fileSupervisor,
            getCompletedTools: () => this.completedTools,
          });
  }

  private cloneHistory(
    source: ThreadCore,
    nativeMessageIdx: NativeMessageIdx,
  ): NativeInferenceManager {
    const manager = source.manager.clone();
    manager.truncateMessages(nativeMessageIdx);
    const effectiveIdx = manager.getNativeMessageIdx();
    this.editedFilesSupervisor = EditedFilesSupervisor.clone({
      source: source.editedFilesSupervisor,
      nativeMessageIdx: effectiveIdx,
    });
    this.fileSupervisor = FileSupervisor.clone({
      source: source.fileSupervisor,
      history: { type: "truncate", nativeMessageIdx: effectiveIdx },
      deps: this.environment,
    });
    this.gitSupervisor = source.gitSupervisor
      ? GitSupervisor.clone({
          source: source.gitSupervisor,
          gitClient: this.environment.gitClient,
          logger: this.environment.logger,
          nativeMessageIdx: effectiveIdx,
        })
      : undefined;
    this.systemInfoSupervisor = source.systemInfoSupervisor
      ? SystemInfoSupervisor.clone({
          source: source.systemInfoSupervisor,
          nativeMessageIdx: effectiveIdx,
        })
      : undefined;
    this.systemReminders = source.systemReminders
      ? SystemReminderSupervisor.clone({
          source: source.systemReminders,
          nativeMessageIdx: effectiveIdx,
          contextTracker: this.fileSupervisor,
          getCompletedTools: () => this.completedTools,
        })
      : undefined;
    this.edlRegisters = {
      registers: new Map(source.edlRegisters.registers),
      nextSavedId: source.edlRegisters.nextSavedId,
    };
    return manager;
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
    this.gitSupervisor?.removeAllListeners();
    await this.abortAgentTurn();
  }

  private resultMessageIdx: NativeMessageIdx | undefined;

  private executeTools(
    requests: NonEmptyRequestedTools,
    publishTools: (tools: ToolInvocationState) => void,
  ): ToolExecution {
    this.resultMessageIdx = this.manager.getPendingResultMessageIdx(requests);
    const execution = executeToolBatch(requests, {
      createTool: this.context.createTool,
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
