import type { GitState } from "./capabilities/git-client.ts";
import {
  buildClonedFiles,
  FileSupervisor,
  type Files,
  type FileUpdates,
} from "./supervisors/file-supervisor.ts";
import {
  type GitContextUpdate,
  GitSupervisor,
  GitTracker,
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
  ProviderMessageContent,
  ProviderToolSpec,
  RequestedTool,
  ToolResults,
} from "./providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./providers/provider-types.ts";
import {
  noReminders,
  type ReminderSupervisor,
  SystemReminderSupervisor,
} from "./system-reminder-supervisor.ts";
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
  readonly systemReminders: ReminderSupervisor;
  pendingSeed: AgentInput[] = [];
  private disposed = false;
  readonly fileSupervisor: FileSupervisor;
  readonly gitSupervisor: GitSupervisor | undefined;
  private readonly contextHooks: ThreadHooks;

  async hasPendingContext(): Promise<boolean> {
    return this.isActive && (await this.contextHooks.hasPendingContent());
  }

  constructor(
    readonly id: ThreadId,
    readonly context: ThreadContext,
    private callbacks: ThreadCoreCallbacks,
    readonly manager: NativeInferenceManager,
    readonly toolSpecs: ProviderToolSpec[],
    readonly edlRegisters: EdlRegisters = {
      registers: new Map(),
      nextSavedId: 0,
    },
    initialFiles: Files = context.contextDelivery?.initialFiles ?? {},
  ) {
    const delivery = context.contextDelivery;
    this.fileSupervisor = new FileSupervisor(
      context.logger,
      context.fileIO,
      context.cwd,
      context.homeDir,
      initialFiles,
      delivery?.pollIntervalMs,
      (updates) => {
        if (this.isActive) delivery?.onFilesSent?.(updates);
      },
    );
    for (const event of [
      "fileAdded",
      "fileRemoved",
      "filesReset",
      "pendingUpdatesChanged",
    ] as const) {
      this.fileSupervisor.on(event, () => this.handleUpdate());
    }
    this.fileSupervisor.start();
    this.systemReminders = this.createReminderSupervisor();
    if (delivery) {
      this.gitSupervisor = new GitSupervisor({
        gitTracker: new GitTracker(
          context.gitClient,
          delivery.initialGitState,
          context.logger,
        ),
        onSent: (update) => {
          if (this.isActive) delivery.onGitSent?.(update);
        },
      });
    }
    const supervisors = [
      ...(this.gitSupervisor ? [this.gitSupervisor] : []),
      ...(context.threadType !== "compact" ? [this.fileSupervisor] : []),
      ...(delivery && context.threadType !== "compact"
        ? [
            new SystemInfoSupervisor(context.systemInfo, {
              alreadyInjected: this.manager.log.messages.length > 0,
            }),
          ]
        : []),
    ];
    this.contextHooks = composeSupervisors(() => supervisors);
  }

  static clone({
    source,
    id,
    context,
    callbacks,
    nativeMessageIdx,
    sourceBusy = false,
  }: {
    source: ThreadCore;
    id: ThreadId;
    context: ThreadContext;
    callbacks: ThreadCoreCallbacks;
    nativeMessageIdx: NativeMessageIdx;
    sourceBusy?: boolean;
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
    const preserve =
      source.isActive &&
      !sourceBusy &&
      !source.activity &&
      nativeMessageIdx === source.manager.getNativeMessageIdx() &&
      manager.getNativeMessageIdx() === source.manager.getNativeMessageIdx();
    const clone = new ThreadCore(
      id,
      context,
      callbacks,
      manager,
      toolSpecs,
      {
        registers: new Map(source.edlRegisters.registers),
        nextSavedId: source.edlRegisters.nextSavedId,
      },
      buildClonedFiles(
        source.fileSupervisor.files,
        preserve ? "preserve" : "reseed",
      ),
    );
    if (preserve) {
      clone.fileSupervisor.seedPendingUpdates(
        source.fileSupervisor.getPendingUpdates(),
      );
    }
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
    this.toolExecutor?.abortAll();
    await this.abortAgentTurn();
  }

  private createReminderSupervisor(): ReminderSupervisor {
    if (this.context.threadType === "compact") return noReminders;
    return new SystemReminderSupervisor({
      threadType: this.context.threadType,
      subagentConfig: this.context.subagentConfig,
      contextTracker: this.fileSupervisor,
    });
  }

  private onToolApplied: OnToolApplied = (absFilePath, tool, fileTypeInfo) => {
    if (!this.isActive) return;
    try {
      this.contextHooks.onToolApplied?.(absFilePath, tool, fileTypeInfo);
      this.hooks.onToolApplied?.(absFilePath, tool, fileTypeInfo);
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
  private toolExecutor: ToolExecutorHost | undefined;

  private executeTools(
    requests: ReadonlyArray<RequestedTool>,
    publishTools: (tools: ToolInvocationState) => void,
  ): ToolExecution {
    const executor = new ToolExecutorHost({
      logger: this.context.logger,
      createTool: (request) => this.invokeTool(request),
      getHooks: () => this.agentHooks(),
      publishTools,
      onUpdate: () => this.handleUpdate(),
    });
    this.toolExecutor = executor;
    const execution = executor.execute(requests);
    return {
      ...execution,
      promise: execution.promise.finally(() => {
        if (this.toolExecutor === executor) this.toolExecutor = undefined;
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

  private agentHooks(): AgentHooks {
    if (this.disposed) return { onBeforeRequest: [], onToolResults: [] };
    const ownerHooks = this.hooks;
    return {
      onBeforeRequest: [
        ...this.contextHooks.onBeforeRequest,
        ...ownerHooks.onBeforeRequest,
        // Last, so the reminder sits after every other injection and
        // immediately before the user's own content.
        { run: (ctx) => Promise.resolve(this.reminderAction(ctx)) },
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
        ...ownerHooks.onToolResults,
        (results) => {
          this.systemReminders.onToolResults(
            results,
            this.structuredToolResults,
          );
          return undefined;
        },
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
  private reminderAction(ctx: AgentRequestContext): RequestAction {
    if (ctx.status === "suspended") return { type: "none" };
    return this.systemReminders.onBeforeRequest(ctx) ?? { type: "none" };
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
