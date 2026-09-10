import type { GitState } from "./capabilities/git-client.ts";
import type { CommentUpdateEntry } from "./context/comment-store.ts";
import { CommentSupervisor } from "./context/comment-supervisor.ts";
import type { ContextManager, FileUpdates } from "./context/context-manager.ts";
import { FileContextSupervisor } from "./context/file-context-supervisor.ts";
import { GitSupervisor } from "./context/git-supervisor.ts";
import { type GitContextUpdate, GitTracker } from "./context/git-tracker.ts";
import {
  composeSupervisors,
  SystemInfoSupervisor,
} from "./thread-supervisor.ts";

/** Stable tracking and UI callbacks; each core constructs its own delivery contributors. */
export interface ThreadContextDelivery {
  manager: ContextManager;
  initialGitState?: GitState | undefined;
  onFilesSent?: (updates: FileUpdates) => void;
  onGitSent?: (update: GitContextUpdate) => void;
  beforeReadComments?: () => Promise<void>;
  onCommentsSent?: (entries: CommentUpdateEntry[]) => void;
}

import { type AgentTurn, runAgentLoop, type ToolExecution } from "./agent.ts";
import type { OnToolApplied } from "./capabilities/context-tracker.ts";
import type { ThreadId } from "./chat-types.ts";
import type { EdlRegisters } from "./edl/index.ts";

import { ABORT_MARKER_TEXT } from "./providers/inference-shared.ts";
import type {
  AgentInput,
  NativeInferenceManager,
  ProviderInferenceConfig,
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
import type { InputMessage, ThreadContext, ThreadInit } from "./thread.ts";
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
import { type CreateToolContext, createTool } from "./tools/create-tool.ts";
import { getToolSpecs } from "./tools/toolManager.ts";
import type { AbsFilePath } from "./utils/files.ts";

/** The conversation an agent drives, configured from the thread's profile. */
export function createInferenceManager(
  context: ThreadContext,
  tools: ProviderToolSpec[],
): NativeInferenceManager {
  const profile = context.profile;
  const config = ((): ProviderInferenceConfig | undefined => {
    if (profile.provider === "openai") {
      return profile.reasoning
        ? { type: "reasoning", reasoning: profile.reasoning }
        : undefined;
    }
    const effortOverride = context.subagentConfig?.effort;
    const baseThinking = profile.thinking;
    if (effortOverride) {
      return {
        type: "thinking",
        thinking: {
          enabled: true,
          ...(baseThinking?.displayThinking !== undefined
            ? { displayThinking: baseThinking.displayThinking }
            : {}),
          ...(baseThinking?.budgetTokens !== undefined
            ? { budgetTokens: baseThinking.budgetTokens }
            : {}),
          effort: effortOverride,
        },
      };
    }
    if (!baseThinking) return undefined;
    if (!baseThinking.enabled) {
      return { type: "thinking", thinking: { enabled: false } };
    }
    const { enabled: _enabled, ...rest } = baseThinking;
    return { type: "thinking", thinking: { enabled: true, ...rest } };
  })();
  return context.getProvider(context.profile).createInferenceManager({
    model: context.profile.model,
    systemPrompt: context.systemPrompt,
    tools,
    ...(config ? { config } : {}),
  });
}
export function threadToolSpecs(context: ThreadContext): ProviderToolSpec[] {
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
export function toAgentInput(messages: InputMessage[]): AgentInput[] {
  return messages.map((m) => ({
    type: "text" as const,
    text: m.text,
    nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
  }));
}
export interface ThreadCoreCallbacks {
  onUpdate: () => void;
  getHooks: () => ThreadHooks;
  onStructuredResult: (id: ToolRequestId, result: ToolStructuredResult) => void;
  flushQueue: (ctx: AgentRequestContext) => Promise<RequestAction>;
}

/** One replaceable conversation generation. All tool closures and agent turns
 * are bound to this instance, never to the owner's next conversation. */
export class ThreadCore {
  readonly manager: NativeInferenceManager;
  readonly toolSpecs: ProviderToolSpec[];
  readonly edlRegisters: EdlRegisters;
  editedFilesThisTurn: { path: AbsFilePath; snapshot: string }[] = [];
  preflightTokenCount: number | undefined;
  readonly structuredToolResults = new Map<
    ToolRequestId,
    ToolStructuredResult
  >();
  readonly systemReminders: ReminderSupervisor;
  pendingSeed: InputMessage[] = [];
  private disposed = false;
  readonly fileSupervisor: FileContextSupervisor | undefined;
  readonly gitSupervisor: GitSupervisor | undefined;
  readonly commentSupervisor: CommentSupervisor | undefined;
  private readonly contextHooks: ThreadHooks;

  async hasPendingContext(): Promise<boolean> {
    return this.isActive && (await this.contextHooks.hasPendingContent());
  }

  constructor(
    readonly id: ThreadId,
    readonly context: ThreadContext,
    private callbacks: ThreadCoreCallbacks,
    init: ThreadInit = { type: "fresh" },
  ) {
    this.edlRegisters =
      init.type === "clone"
        ? init.edlRegisters
        : { registers: new Map(), nextSavedId: 0 };
    this.toolSpecs = threadToolSpecs(context);
    this.manager = this.initialManager(init);
    this.systemReminders = this.createReminderSupervisor();
    const delivery = context.contextDelivery;
    if (delivery) {
      this.fileSupervisor = new FileContextSupervisor({
        contextManager: delivery.manager,
        onSent: (updates) => {
          if (this.isActive) delivery.onFilesSent?.(updates);
        },
      });
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
      if (context.commentStore) {
        // Comment delivery remains durable across reset: already-sent entries
        // are not replayed into the replacement history.
        this.commentSupervisor = new CommentSupervisor({
          store: context.commentStore,
          beforeRead: () =>
            delivery.beforeReadComments?.() ?? Promise.resolve(),
          isCurrent: () => this.isActive,
          onSent: (entries) => {
            if (this.isActive) delivery.onCommentsSent?.(entries);
          },
        });
      }
    }
    const supervisors = [
      ...(this.gitSupervisor ? [this.gitSupervisor] : []),
      ...(this.fileSupervisor ? [this.fileSupervisor] : []),
      ...(this.commentSupervisor ? [this.commentSupervisor] : []),
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

  get isActive(): boolean {
    return !this.disposed;
  }
  private currentTurnGuard(): () => boolean {
    const turn = this.agentTurn;
    return () =>
      !this.disposed && turn !== undefined && this.agentTurn === turn;
  }
  private currentLoopGuard(): () => boolean {
    const isCurrent = this.currentTurnGuard();
    const turn = this.agentTurn;
    return () => isCurrent() && !turn?.loopState.aborting;
  }
  private get hooks(): ThreadHooks {
    return this.callbacks.getHooks();
  }
  private handleUpdate(): void {
    if (!this.disposed) this.callbacks.onUpdate();
  }

  beginSubmission(submitted: InputMessage[]): InputMessage[] {
    const messages = [...this.pendingSeed, ...submitted];
    this.pendingSeed = [];
    this.editedFilesThisTurn = [];
    return messages;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.fileSupervisor?.destroy();
    this.toolExecutor?.abortAll();
    await this.abortAgentTurn();
  }

  private createReminderSupervisor(): ReminderSupervisor {
    if (this.context.threadType === "compact") return noReminders;
    return new SystemReminderSupervisor({
      threadType: this.context.threadType,
      subagentConfig: this.context.subagentConfig,
      contextTracker: this.context.contextTracker,
    });
  }
  /** Tool construction is the thread's: the agent only drives invocations.
   * Rebuilt per tool so a tool always sees the thread's current registers. */
  private toolContext(): CreateToolContext {
    const isCurrent = this.currentLoopGuard();
    return {
      threadId: this.id,
      logger: this.context.logger,
      lspClient: this.context.lspClient,
      luaExecutor: this.context.luaExecutor,
      mcpToolManager: this.context.mcpToolManager,
      cwd: this.context.cwd,
      homeDir: this.context.homeDir,
      maxConcurrentSubagents: this.context.maxConcurrentSubagents,
      maxConcurrentFastSubagents: this.context.maxConcurrentFastSubagents,
      contextTracker: this.context.contextTracker,
      onToolApplied: (absFilePath, tool, fileTypeInfo) => {
        if (isCurrent()) this.onToolApplied(absFilePath, tool, fileTypeInfo);
      },
      edlRegisters: this.edlRegisters,
      commentStore: this.context.commentStore,
      fileIO: this.context.fileIO,
      shell: this.context.shell,
      threadManager: this.context.threadManager,
      scriptRunner: this.context.getScriptRunner?.(),
      requestRender: () => {
        if (isCurrent()) this.handleUpdate();
      },
      getAgents: () => this.context.getAgents(),
    };
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
  /** Runs the tool and splits its result: the structured payload is recorded
   * here, and only the wire result reaches the agent. */
  private invokeTool(request: ToolRequest): ToolInvocation {
    const isCurrent = this.currentLoopGuard();
    const invocation = createTool(request, this.toolContext());
    const promise = invocation.promise.then((executed) => {
      const { result } = executed;
      if (result.status !== "ok") return { ...executed, result };
      const { structuredResult, ...wireResult } = result;
      if (structuredResult && isCurrent()) {
        this.structuredToolResults.set(request.id, structuredResult);
        this.callbacks.onStructuredResult(request.id, structuredResult);
      }
      return { ...executed, result: wireResult };
    });
    return { ...invocation, promise };
  }
  private toolExecutor: ToolExecutorHost | undefined;
  /** A fresh conversation, or a copy of the source thread's truncated to the
   * fork point. */
  private initialManager(init: ThreadInit): NativeInferenceManager {
    if (init.type !== "clone") {
      return createInferenceManager(this.context, this.toolSpecs);
    }
    const manager = init.sourceManager.clone();
    manager.truncateMessages(init.nativeMessageIdx);
    return manager;
  }
  private executeTools(
    requests: ReadonlyArray<RequestedTool>,
    publishTools: (tools: ToolInvocationState) => void,
  ): ToolExecution {
    const isCurrent = this.currentLoopGuard();
    const hooks = this.agentHooks();
    const executor = new ToolExecutorHost({
      logger: this.context.logger,
      createTool: (request) => this.invokeTool(request),
      getHooks: () => hooks,
      publishTools: (tools) => {
        if (isCurrent()) publishTools(tools);
      },
      onUpdate: () => {
        if (isCurrent()) this.handleUpdate();
      },
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
  /** The agent's view of the owner's hooks. `onEndTurn` is filtered out
   * structurally by `AgentHooks`; the thread's own two contributions are
   * appended to the before-request array like any other entry. */
  private agentHooks(): AgentHooks {
    if (this.disposed) return { onBeforeRequest: [], onToolResults: [] };
    const isCurrentTurn = this.currentTurnGuard();
    const isCurrent = this.currentLoopGuard();
    const ownerHooks = this.hooks;
    const hooks: AgentHooks = {
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
    return {
      onBeforeRequest: hooks.onBeforeRequest.map((hook) => ({
        ...hook,
        run: (ctx) =>
          isCurrent()
            ? hook.run(ctx)
            : Promise.resolve({ type: "none" as const }),
      })),
      onToolResults: hooks.onToolResults.map(
        (hook) => (results) => (isCurrentTurn() ? hook(results) : undefined),
      ),
    };
  }
  /** `yield_to_parent` ran like any other tool; the suspension it raises is
   * how the agent — which knows nothing about the tool — is told to stop over
   * a log where every tool_use is answered. Narrowing on the structured result
   * rather than the request means only a call that actually succeeded fires
   * it, and only for ids in this step's results, so an earlier yield inherited
   * by a cloned thread can never re-fire. */
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
    // A suspended request is never issued, so a reminder placed in it would
    // be marked sent and never delivered.
    if (ctx.status === "suspended") return { type: "none" };
    return this.systemReminders.onBeforeRequest(ctx) ?? { type: "none" };
  }
  async runTurn(messages: InputMessage[]): Promise<SendResult> {
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
      toAgentInput(messages),
    );
    this.agentTurn = turn;
    this.handleUpdate();
    try {
      const result = await turn.promise;
      if (result.type === "failed") {
        // The manager has already repaired whatever the failed request left
        // half-written, so the log stands as it is: the submission is still
        // in it and a retry re-issues the same request.
        this.context.logger.error(result.error);
      }
      if (result.type === "aborted") {
        // The single terminal abort transition: leave the history well-formed
        // and mark why it stops here, before anything renders the log.
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
      if (this.agentTurn === turn) this.agentTurn = undefined;
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
