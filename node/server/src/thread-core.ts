import type { GitState } from "./capabilities/git-client.ts";
import { FileSupervisor, type Files } from "./supervisors/file-supervisor.ts";
import { GitSupervisor } from "./supervisors/git-supervisor.ts";
import {
  composeSupervisors,
  SystemInfoSupervisor,
} from "./thread-supervisor.ts";

/** How this conversation's context supervisors are seeded. Construction
 * parameters only: what a supervisor delivers is reported on its own `sent`
 * event, which the owning `Thread` subscribes to. */
export interface ThreadContextDelivery {
  initialFiles?: Files;
  pollIntervalMs?: number;
  initialGitState?: GitState | undefined;
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
import type { ThreadCloneContext, ThreadContext } from "./thread.ts";
import type {
  AgentHooks,
  SendResult,
  ThreadHooks,
  ToolInvocationState,
  YieldValue,
} from "./thread-api.ts";
import type { SuspendReason } from "./thread-supervisor.ts";
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
}

export class ThreadCore {
  editedFilesThisTurn: { path: AbsFilePath; snapshot: string }[] = [];
  preflightTokenCount: number | undefined;
  private disposed = false;
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
    /** The display archive of every structured result the log can still
     * refer to. Carried onto the conversation that replaces this one, which
     * is why it is handed in rather than started empty. */
    readonly structuredToolResults: Map<ToolRequestId, ToolStructuredResult>,
    private pendingSeed: AgentInput[],
    readonly fileSupervisor: FileSupervisor,
    readonly gitSupervisor: GitSupervisor | undefined,
    readonly systemInfoSupervisor: SystemInfoSupervisor | undefined,
    /** Absent exactly on the compaction thread, whose content its caller
     * composes exactly. */
    readonly systemReminders: SystemReminderSupervisor | undefined,
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
    // Files are tracked for every conversation but only *delivered* where
    // reminders are, so the two appear and disappear together.
    this.contextHooks = composeSupervisors([
      ...(gitSupervisor ? [gitSupervisor] : []),
      ...(systemReminders ? [fileSupervisor] : []),
      ...(systemInfoSupervisor ? [systemInfoSupervisor] : []),
      ...(systemReminders ? [systemReminders] : []),
    ]);
  }

  /** Content that leads the next turn: the hand-off a reset supplies, or a
   * nudge aimed at this conversation rather than at the thread. Drained by
   * the first turn that runs. */
  get seed(): ReadonlyArray<AgentInput> {
    return this.pendingSeed;
  }
  addSeed(messages: AgentInput[]): void {
    this.pendingSeed = [...this.pendingSeed, ...messages];
  }

  static create({
    id,
    context,
    callbacks,
    manager,
    toolSpecs,
    edlRegisters = { registers: new Map(), nextSavedId: 0 },
    initialFiles,
    seed = [],
    structuredResults,
  }: {
    id: ThreadId;
    context: ThreadContext;
    callbacks: ThreadCoreCallbacks;
    manager: NativeInferenceManager;
    toolSpecs: ProviderToolSpec[];
    edlRegisters?: EdlRegisters;
    initialFiles?: Files;
    seed?: AgentInput[];
    structuredResults?: ReadonlyMap<ToolRequestId, ToolStructuredResult>;
  }): ThreadCore {
    const delivery = context.contextDelivery;
    const fileSupervisor = FileSupervisor.create({
      logger: context.logger,
      fileIO: context.fileIO,
      cwd: context.cwd,
      homeDir: context.homeDir,
      initialFiles: initialFiles ?? delivery?.initialFiles ?? {},
      ...(delivery?.pollIntervalMs !== undefined
        ? { pollIntervalMs: delivery.pollIntervalMs }
        : {}),
    });
    const gitSupervisor = delivery
      ? GitSupervisor.create({
          gitClient: context.gitClient,
          initialGitState: delivery.initialGitState,
          logger: context.logger,
        })
      : undefined;
    const systemInfoSupervisor =
      delivery && context.threadType !== "compact"
        ? SystemInfoSupervisor.create({
            systemInfo: context.systemInfo,
            alreadyInjected: manager.log.messages.length > 0,
          })
        : undefined;
    const structuredToolResults = new Map(structuredResults);
    const systemReminders =
      context.threadType === "compact"
        ? undefined
        : SystemReminderSupervisor.create({
            threadType: context.threadType,
            subagentConfig: context.subagentConfig,
            contextTracker: fileSupervisor,
            getStructuredResults: () => structuredToolResults,
          });
    return new ThreadCore(
      id,
      context,
      callbacks,
      manager,
      toolSpecs,
      edlRegisters,
      structuredToolResults,
      [...seed],
      fileSupervisor,
      gitSupervisor,
      systemInfoSupervisor,
      systemReminders,
    );
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
    context: ThreadCloneContext;
    callbacks: ThreadCoreCallbacks;
    nativeMessageIdx: NativeMessageIdx;
  }): ThreadCore {
    // Conversation kind is inherited from the source, so supervisor presence
    // cannot diverge from it.
    const clonedContext: ThreadContext =
      source.context.threadType === "compact"
        ? { ...context, threadType: "compact" }
        : { ...context, threadType: source.context.threadType };
    const toolSpecs = getToolSpecs(
      clonedContext.threadType,
      clonedContext.mcpToolManager,
      clonedContext.availableCapabilities,
      clonedContext.getAgents(),
      clonedContext.subagentConfig,
      clonedContext.yieldSchema,
      clonedContext.getScriptRunner?.()?.getScriptCatalog(),
      clonedContext.subagentDockerfile,
    );
    const manager = source.manager.clone();
    manager.truncateMessages(nativeMessageIdx);
    const effectiveNativeMessageIdx = manager.getNativeMessageIdx();
    const fileSupervisor = FileSupervisor.clone({
      source: source.fileSupervisor,
      history: {
        type: "truncate",
        nativeMessageIdx: effectiveNativeMessageIdx,
      },
    });
    const gitSupervisor = source.gitSupervisor
      ? GitSupervisor.clone({
          source: source.gitSupervisor,
          nativeMessageIdx: effectiveNativeMessageIdx,
        })
      : undefined;
    const systemInfoSupervisor = source.systemInfoSupervisor
      ? SystemInfoSupervisor.clone({
          source: source.systemInfoSupervisor,
          nativeMessageIdx: effectiveNativeMessageIdx,
        })
      : undefined;
    const structuredToolResults = new Map<
      ToolRequestId,
      ToolStructuredResult
    >();
    for (const [key, value] of source.structuredToolResults) {
      structuredToolResults.set(key, structuredClone(value));
    }
    const systemReminders = source.systemReminders
      ? SystemReminderSupervisor.clone({
          source: source.systemReminders,
          nativeMessageIdx: effectiveNativeMessageIdx,
          contextTracker: fileSupervisor,
          getStructuredResults: () => structuredToolResults,
        })
      : undefined;
    return new ThreadCore(
      id,
      clonedContext,
      callbacks,
      manager,
      toolSpecs,
      {
        registers: new Map(source.edlRegisters.registers),
        nextSavedId: source.edlRegisters.nextSavedId,
      },
      structuredToolResults,
      [],
      fileSupervisor,
      gitSupervisor,
      systemInfoSupervisor,
      systemReminders,
    );
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

  /** A new submission starts here. Only the edited-file list is per
   * submission — the seed belongs to the first *turn*, and `runTurn` drains
   * it — so this is the whole boundary. */
  beginSubmission(): void {
    this.editedFilesThisTurn = [];
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
      }
      return { ...executed, result: wireResult };
    });
    return { ...invocation, promise };
  }
  private toolBatch:
    | { type: "idle" }
    | { type: "running"; executor: ToolExecutorHost } = { type: "idle" };

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
    this.toolBatch = { type: "running", executor };
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
   * running right now. The running batch fixed it when it started, so there
   * is one place it is decided and no stale metadata to fall back to. */
  private get pendingResultMessageIdx(): NativeMessageIdx {
    if (this.toolBatch.type !== "running") {
      throw new Error("onToolApplied called without a running tool batch");
    }
    return this.toolBatch.executor.resultMessageIdx;
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
        // Registered after every context supervisor: the owner's queued
        // content is the user's own, and it lands last in the message.
        ...ownerHooks.onBeforeRequestLast,
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
  async runTurn(submitted: AgentInput[]): Promise<SendResult> {
    if (!this.isActive) return { type: "aborted" };
    const messages = [...this.pendingSeed, ...submitted];
    this.pendingSeed = [];
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
