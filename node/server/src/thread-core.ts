import type { GitState } from "./capabilities/git-client.ts";
import {
  FileSupervisor,
  type Files,
  type FileUpdates,
} from "./supervisors/file-supervisor.ts";
import {
  type GitContextUpdate,
  GitSupervisor,
} from "./supervisors/git-supervisor.ts";
import {
  composeSupervisors,
  SystemInfoSupervisor,
} from "./thread-supervisor.ts";

export interface ThreadContextDelivery {
  initialFiles?: Files;
  pollIntervalMs?: number;
  initialGitState?: GitState | undefined;
  onFilesSent?: (updates: FileUpdates) => void;
  onGitSent?: (update: GitContextUpdate) => void;
}

import { type AgentTurn, runAgentLoop, type ToolExecution } from "./agent.ts";
import type { OnToolApplied } from "./capabilities/context-tracker.ts";
import type { ThreadId } from "./chat-types.ts";
import type { EdlRegisters } from "./edl/index.ts";

import { ABORT_MARKER_TEXT } from "./providers/inference-shared.ts";
import type {
  AgentInput,
  NativeInferenceManager,
  NativeMessageIdx,
  NonEmptyRequestedTools,
  ProviderMessageContent,
  ProviderToolSpec,
  ToolResults,
} from "./providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./providers/provider-types.ts";
import { SystemReminderSupervisor } from "./system-reminder-supervisor.ts";
import type { ThreadContext } from "./thread.ts";
import type {
  AgentHooks,
  AgentRequestContext,
  SendResult,
  ThreadHooks,
  ToolInvocationState,
  YieldValue,
} from "./thread-api.ts";
import type { RequestAction, SuspendReason } from "./thread-supervisor.ts";
import { ToolExecutorHost } from "./tool-executor.ts";
import type {
  ToolInvocation,
  ToolRequest,
  ToolRequestId,
  ToolStructuredResult,
} from "./tool-types.ts";
import { structuredResultFor } from "./tool-types.ts";
import { createTool } from "./tools/create-tool.ts";
import { getToolSpecs } from "./tools/toolManager.ts";
import type { AbsFilePath } from "./utils/files.ts";

export interface ThreadCoreCallbacks {
  onUpdate: () => void;
  getHooks: () => ThreadHooks;
  onStructuredResult: (id: ToolRequestId, result: ToolStructuredResult) => void;
  flushQueue: (ctx: AgentRequestContext) => Promise<RequestAction>;
}

export class ThreadCore {
  editedFilesThisTurn: { path: AbsFilePath; snapshot: string }[] = [];
  preflightTokenCount: number | undefined;
  readonly structuredToolResults = new Map<
    ToolRequestId,
    ToolStructuredResult
  >();
  readonly systemReminders: SystemReminderSupervisor | undefined;
  pendingSeed: AgentInput[] = [];
  private disposed = false;
  readonly gitSupervisor: GitSupervisor | undefined;
  readonly systemInfoSupervisor: SystemInfoSupervisor | undefined;
  private readonly contextHooks: ThreadHooks;

  async hasPendingContext(): Promise<boolean> {
    return this.isActive && (await this.contextHooks.hasPendingContent());
  }

  private constructor(
    readonly id: ThreadId,
    readonly context: ThreadContext,
    private callbacks: ThreadCoreCallbacks,
    readonly manager: NativeInferenceManager,
    readonly toolSpecs: ProviderToolSpec[],
    readonly edlRegisters: EdlRegisters,
    readonly fileSupervisor: FileSupervisor,
    gitSupervisor: GitSupervisor | undefined,
    systemInfoSupervisor: SystemInfoSupervisor | undefined,
    systemReminders: SystemReminderSupervisor | undefined,
  ) {
    for (const event of [
      "fileAdded",
      "fileRemoved",
      "filesReset",
      "pendingUpdatesChanged",
    ] as const) {
      this.fileSupervisor.on(event, () => this.handleUpdate());
    }
    this.fileSupervisor.start();
    this.systemReminders = systemReminders;
    this.gitSupervisor = gitSupervisor;
    this.systemInfoSupervisor = systemInfoSupervisor;
    const supervisors = [
      ...(this.gitSupervisor ? [this.gitSupervisor] : []),
      ...(context.threadType !== "compact" ? [this.fileSupervisor] : []),
      ...(this.systemInfoSupervisor ? [this.systemInfoSupervisor] : []),
      ...(this.systemReminders ? [this.systemReminders] : []),
    ];
    this.contextHooks = composeSupervisors(() => supervisors);
  }

  static create({
    id,
    context,
    callbacks,
    manager,
    toolSpecs,
    edlRegisters = { registers: new Map(), nextSavedId: 0 },
    initialFiles,
  }: {
    id: ThreadId;
    context: ThreadContext;
    callbacks: ThreadCoreCallbacks;
    manager: NativeInferenceManager;
    toolSpecs: ProviderToolSpec[];
    edlRegisters?: EdlRegisters;
    initialFiles?: Files;
  }): ThreadCore {
    const delivery = context.contextDelivery;
    let core: ThreadCore | undefined;
    const fileSupervisor = FileSupervisor.create({
      logger: context.logger,
      fileIO: context.fileIO,
      cwd: context.cwd,
      homeDir: context.homeDir,
      initialFiles: initialFiles ?? delivery?.initialFiles ?? {},
      ...(delivery?.pollIntervalMs !== undefined
        ? { pollIntervalMs: delivery.pollIntervalMs }
        : {}),
      onSent: (updates) => {
        if (core?.isActive) delivery?.onFilesSent?.(updates);
      },
    });
    const gitSupervisor = delivery
      ? GitSupervisor.create({
          gitClient: context.gitClient,
          initialGitState: delivery.initialGitState,
          logger: context.logger,
          onSent: (update) => {
            if (core?.isActive) delivery.onGitSent?.(update);
          },
        })
      : undefined;
    const systemInfoSupervisor =
      delivery && context.threadType !== "compact"
        ? SystemInfoSupervisor.create({
            systemInfo: context.systemInfo,
            alreadyInjected: manager.log.messages.length > 0,
          })
        : undefined;
    const systemReminders =
      context.threadType === "compact"
        ? undefined
        : SystemReminderSupervisor.create({
            threadType: context.threadType,
            subagentConfig: context.subagentConfig,
            contextTracker: fileSupervisor,
            getStructuredResults: () =>
              core?.structuredToolResults ?? new Map(),
          });
    core = new ThreadCore(
      id,
      context,
      callbacks,
      manager,
      toolSpecs,
      edlRegisters,
      fileSupervisor,
      gitSupervisor,
      systemInfoSupervisor,
      systemReminders,
    );
    return core;
  }

  static clone({
    source,
    id,
    context,
    callbacks,
    nativeMessageIdx,
  }: {
    source: ThreadCore;
    id: ThreadId;
    context: ThreadContext;
    callbacks: ThreadCoreCallbacks;
    nativeMessageIdx: NativeMessageIdx;
  }): ThreadCore {
    const toolSpecs = getToolSpecs(
      context.threadType,
      context.mcpToolManager,
      context.availableCapabilities,
      context.getAgents(),
      context.subagentConfig,
      context.yieldSchema,
      context.getScriptRunner?.()?.getScriptCatalog(),
      context.subagentDockerfile,
    );
    const manager = source.manager.clone();
    manager.truncateMessages(nativeMessageIdx);
    const effectiveNativeMessageIdx = manager.getNativeMessageIdx();
    const delivery = context.contextDelivery;
    let clone: ThreadCore | undefined;
    const fileSupervisor = FileSupervisor.clone({
      source: source.fileSupervisor,
      history: {
        type: "truncate",
        nativeMessageIdx: effectiveNativeMessageIdx,
      },
      onSent: (updates) => {
        if (clone?.isActive) delivery?.onFilesSent?.(updates);
      },
    });
    const gitSupervisor = source.gitSupervisor
      ? GitSupervisor.clone({
          source: source.gitSupervisor,
          nativeMessageIdx: effectiveNativeMessageIdx,
          onSent: (update) => {
            if (clone?.isActive) delivery?.onGitSent?.(update);
          },
        })
      : undefined;
    const systemInfoSupervisor = source.systemInfoSupervisor
      ? SystemInfoSupervisor.clone({
          source: source.systemInfoSupervisor,
          nativeMessageIdx: effectiveNativeMessageIdx,
        })
      : undefined;
    const systemReminders = source.systemReminders
      ? SystemReminderSupervisor.clone({
          source: source.systemReminders,
          nativeMessageIdx: effectiveNativeMessageIdx,
          contextTracker: fileSupervisor,
          getStructuredResults: () => clone?.structuredToolResults ?? new Map(),
        })
      : undefined;
    clone = new ThreadCore(
      id,
      context,
      callbacks,
      manager,
      toolSpecs,
      {
        registers: new Map(source.edlRegisters.registers),
        nextSavedId: source.edlRegisters.nextSavedId,
      },
      fileSupervisor,
      gitSupervisor,
      systemInfoSupervisor,
      systemReminders,
    );
    return clone;
  }
  get isActive(): boolean {
    return !this.disposed;
  }
  private get hooks(): ThreadHooks {
    return this.callbacks.getHooks();
  }
  private handleUpdate(): void {
    if (!this.disposed) this.callbacks.onUpdate();
  }

  beginSubmission(submitted: AgentInput[]): AgentInput[] {
    const messages = [...this.pendingSeed, ...submitted];
    this.pendingSeed = [];
    this.editedFilesThisTurn = [];
    return messages;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.fileSupervisor.destroy();
    if (this.toolBatch.type === "running") this.toolBatch.executor.abortAll();
    await this.abortAgentTurn();
  }

  private onToolApplied: OnToolApplied = (absFilePath, tool, fileTypeInfo) => {
    if (!this.isActive) return;
    // Tools do not know about message indices: the assistant message holding
    // the tool_use is already written, and the result message is not, so the
    // fact this tool established will be revealed by the next message.
    const nativeMessageIdx = this.pendingResultMessageIdx;
    try {
      this.contextHooks.onToolApplied?.({
        absFilePath,
        tool,
        fileTypeInfo,
        nativeMessageIdx,
      });
      this.hooks.onToolApplied?.({
        absFilePath,
        tool,
        fileTypeInfo,
        nativeMessageIdx,
      });
    } catch (error) {
      this.context.logger.error(
        `onToolApplied hook threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      tool.type === "edl-edit" &&
      !this.editedFilesThisTurn.some((e) => e.path === absFilePath)
    ) {
      this.editedFilesThisTurn.push({
        path: absFilePath,
        snapshot: tool.previousContent,
      });
    }
  };

  private invokeTool(request: ToolRequest): ToolInvocation {
    const invocation = createTool(request, {
      threadId: this.id,
      logger: this.context.logger,
      lspClient: this.context.lspClient,
      luaExecutor: this.context.luaExecutor,
      mcpToolManager: this.context.mcpToolManager,
      cwd: this.context.cwd,
      homeDir: this.context.homeDir,
      maxConcurrentSubagents: this.context.maxConcurrentSubagents,
      maxConcurrentFastSubagents: this.context.maxConcurrentFastSubagents,
      contextTracker: this.fileSupervisor,
      onToolApplied: this.onToolApplied,
      edlRegisters: this.edlRegisters,
      fileIO: this.context.fileIO,
      shell: this.context.shell,
      threadManager: this.context.threadManager,
      scriptRunner: this.context.getScriptRunner?.(),
      requestRender: () => this.handleUpdate(),
      getAgents: () => this.context.getAgents(),
    });
    const promise = invocation.promise.then((executed) => {
      const { result } = executed;
      if (result.status !== "ok") return { ...executed, result };
      const { structuredResult, ...wireResult } = result;
      if (structuredResult) {
        this.structuredToolResults.set(request.id, structuredResult);
        this.callbacks.onStructuredResult(request.id, structuredResult);
      }
      return { ...executed, result: wireResult };
    });
    return { ...invocation, promise };
  }
  private toolBatch:
    | { type: "idle" }
    | {
        type: "running";
        executor: ToolExecutorHost;
        requested: NonEmptyRequestedTools;
      } = { type: "idle" };

  private executeTools(
    requests: NonEmptyRequestedTools,
    publishTools: (tools: ToolInvocationState) => void,
  ): ToolExecution {
    const executor = new ToolExecutorHost({
      logger: this.context.logger,
      createTool: (request) => this.invokeTool(request),
      getHooks: () => this.agentHooks(),
      getPendingResultMessageIdx: (requested) =>
        this.manager.getPendingResultMessageIdx(requested),
      publishTools,
      onUpdate: () => this.handleUpdate(),
    });
    this.toolBatch = { type: "running", executor, requested: requests };
    const execution = executor.execute(requests);
    return {
      ...execution,
      promise: execution.promise.finally(() => {
        if (
          this.toolBatch.type === "running" &&
          this.toolBatch.executor === executor
        ) {
          this.toolBatch = { type: "idle" };
        }
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
   * running right now. The active batch owns both its executor and its
   * non-empty request list, so this cannot fall back to stale metadata. */
  private get pendingResultMessageIdx(): NativeMessageIdx {
    if (this.toolBatch.type !== "running") {
      throw new Error("onToolApplied called without a running tool batch");
    }
    return this.manager.getPendingResultMessageIdx(this.toolBatch.requested);
  }

  private agentHooks(): AgentHooks {
    if (this.disposed) return { onBeforeRequest: [], onToolResults: [] };
    const ownerHooks = this.hooks;
    return {
      onBeforeRequest: [
        // Owner gates run first, so a suspension is visible to every
        // conversation-state supervisor before it can commit a delivery.
        ...ownerHooks.onBeforeRequest,
        // The reminder is the last context supervisor, so its injection sits
        // after context updates and immediately before queued/user content.
        ...this.contextHooks.onBeforeRequest,
        { run: (ctx) => this.callbacks.flushQueue(ctx) },
        // After every hook that might have asked for a count, so it records
        // the one this request was decided on — and never forces one.
        {
          run: (ctx) => {
            this.preflightTokenCount = ctx.inputTokenCount;
            return Promise.resolve({ type: "none" as const });
          },
        },
      ],
      onToolResults: [
        (results) => this.yieldGate(results),
        ...this.contextHooks.onToolResults,
        ...ownerHooks.onToolResults,
      ],
    };
  }

  private yieldGate(results: ToolResults): SuspendReason | undefined {
    for (const id of results.keys()) {
      const structured = structuredResultFor(
        this.structuredToolResults.get(id),
        "yield_to_parent",
      );
      if (!structured) continue;
      const value: YieldValue =
        this.context.yieldSchema !== undefined
          ? { type: "structured", value: structured.input }
          : { type: "text", text: structured.input.result ?? "" };
      return { kind: "yield", value };
    }
    return undefined;
  }
  async runTurn(messages: AgentInput[]): Promise<SendResult> {
    if (!this.isActive) return { type: "aborted" };
    const turn = runAgentLoop(
      {
        logger: this.context.logger,
        manager: this.manager,
        executeTools: (requests, publishTools) =>
          this.executeTools(requests, publishTools),
        getHooks: () => this.agentHooks(),
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
