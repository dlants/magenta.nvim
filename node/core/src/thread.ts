import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import {
  type AgentContext,
  type AgentTurn,
  runAgentLoop,
  type ToolExecution,
} from "./agent.ts";
import type { AgentsMap } from "./agents/agents.ts";
import type {
  ContextTracker,
  OnToolApplied,
} from "./capabilities/context-tracker.ts";
import type { FileIO } from "./capabilities/file-io.ts";
import type { GitClient } from "./capabilities/git-client.ts";
import type { LspClient } from "./capabilities/lsp-client.ts";
import type { LuaExecutor } from "./capabilities/lua-executor.ts";
import type { ScriptRunner } from "./capabilities/script-runner.ts";
import type { Shell } from "./capabilities/shell.ts";
import type { ThreadManager } from "./capabilities/thread-manager.ts";
import type { SubagentConfig, ThreadId, ThreadType } from "./chat-types.ts";
import type { CommentStore } from "./context/comment-store.ts";
import type { EdlRegisters } from "./edl/index.ts";
import {
  type LoopEpoch,
  LoopStateMachine,
  type ThreadLoopState,
} from "./loop-state.ts";
import type { ProviderProfile } from "./provider-options.ts";
import { ABORT_MARKER_TEXT } from "./providers/inference-shared.ts";
import type {
  AgentInput,
  NativeInferenceManager,
  NativeMessageIdx,
  Provider,
  ProviderInferenceConfig,
  ProviderMessage,
  ProviderMessageContent,
  ProviderToolSpec,
  RequestedTool,
  StopReason,
  ToolResults,
} from "./providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./providers/provider-types.ts";
import type { SystemInfo, SystemPrompt } from "./providers/system-prompt.ts";
import {
  compactPrompt,
  type Delivery,
  type PendingMessage,
  parseCompact,
  pendingMessage,
  type ResolveSubmission,
} from "./submission/index.ts";
import {
  noReminders,
  type ReminderSupervisor,
  SystemReminderSupervisor,
} from "./system-reminder-supervisor.ts";
import type {
  AgentHooks,
  AgentRequestContext,
  OnUpdate,
  QueuedMessage,
  RestResult,
  SendOptions,
  SendResult,
  ThreadHooks,
  ThreadResult,
  ThreadSendResult,
  YieldValue,
} from "./thread-api.ts";
import { renderYieldValue } from "./thread-api.ts";
import { type ForkProvenance, ThreadLogger } from "./thread-logger.ts";
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
import type { MCPToolManager as MCPToolManagerImpl } from "./tools/mcp/manager.ts";
import * as ThreadTitle from "./tools/thread-title.ts";
import type { ToolCapability } from "./tools/tool-registry.ts";
import { getToolSpecs } from "./tools/toolManager.ts";
import { assertUnreachable } from "./utils/assertUnreachable.ts";
import { Defer } from "./utils/async.ts";
import type { AbsFilePath, HomeDir, NvimCwd } from "./utils/files.ts";
/** How a thread's yield came to rest. */
export type YieldState = {
  value: YieldValue;
  /** The rendered result, including any `resultPrefix` the accepting owner
   * added. */
  response: string;
  /** The accepting owner took the thread's world away with it. */
  tornDown: boolean;
};

export type EnvironmentConfig =
  | { type: "local"; cwd?: NvimCwd }
  | { type: "docker"; container: string; cwd: string };

/** Everything a thread and the tools it builds read. A superset of what the
 * agent itself needs. */
export interface ThreadContext extends AgentContext {
  profile: ProviderProfile;
  subagentConfig?: SubagentConfig;
  getProvider: (profile: ProviderProfile) => Provider;
  /** The shape this thread yields in. The thread's own concern: it decides the
   * tool's spec and reads the yielded input back — the agent never sees a
   * yield. */
  yieldSchema?: JSONSchemaType;
  cwd: NvimCwd;
  homeDir: HomeDir;
  threadType: ThreadType;
  systemPrompt: SystemPrompt;
  systemInfo: SystemInfo;
  mcpToolManager: MCPToolManagerImpl;
  threadManager: ThreadManager;
  getScriptRunner?: () => ScriptRunner | undefined;
  fileIO: FileIO;
  shell: Shell;
  gitClient: GitClient;
  lspClient: LspClient;
  luaExecutor?: LuaExecutor | undefined;
  availableCapabilities: Set<ToolCapability>;
  environmentConfig: EnvironmentConfig;
  subagentDockerfile?: string;
  maxConcurrentSubagents: number;
  maxConcurrentFastSubagents: number;
  getAgents: () => AgentsMap;
  contextTracker: ContextTracker;
  commentStore?: CommentStore | undefined;
}
function inferenceConfig(
  context: ThreadContext,
): ProviderInferenceConfig | undefined {
  const profile = context.profile;
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
}

/** The conversation an agent drives, configured from the thread's profile. */
export function createInferenceManager(
  context: ThreadContext,
  tools: ProviderToolSpec[],
): NativeInferenceManager {
  const config = inferenceConfig(context);
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

export type ThreadArchiveOptions = {
  baseDir?: string;
  scriptName?: string;
};

export type ThreadInit =
  | { type: "fresh" }
  | {
      type: "clone";
      sourceManager: NativeInferenceManager;
      nativeMessageIdx: NativeMessageIdx;
      provenance: ForkProvenance;
      edlRegisters: EdlRegisters;
    };

/** Which of the two deferred queues an entry sits in. */
type DeferredDelivery = "async" | "next";

/** The result of draining one queue: content for the next request, or a
 * compaction the flush ran into — never both. */
type FlushedQueue =
  | { type: "messages"; messages: InputMessage[] }
  | { type: "compact"; nextPrompt: string | undefined };

export type ThreadCallbacks = {
  onUpdate: OnUpdate;
  resolve: ResolveSubmission;
};

/** Holds one conversation at a time, swapping it for a fresh one on compaction.
 * Thread 3 is still thread 3 afterwards, which is why the archive keys by
 * thread id survives the swap. */
/** The thread owns the shape of a submission; the agent takes it already in
 * the provider-neutral input form. */
/** One piece of content a caller hands the thread. `system` is the owner's
 * own voice — a supervisor nudge, a tool-driven follow-up — as distinct from
 * text the user typed. */
export type InputMessage =
  | { type: "user"; text: string }
  | { type: "system"; text: string };

export function toAgentInput(messages: InputMessage[]): AgentInput[] {
  return messages.map((m) => ({
    type: "text" as const,
    text: m.text,
    nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
  }));
}

export class Thread {
  #title: string | undefined;

  get title(): string | undefined {
    return this.#title;
  }
  get threadType(): ThreadType {
    return this.context.threadType;
  }
  get systemPrompt(): SystemPrompt {
    return this.context.systemPrompt;
  }
  get systemInfo(): SystemInfo {
    return this.context.systemInfo;
  }
  edlRegisters: EdlRegisters;
  editedFilesThisTurn: { path: AbsFilePath; snapshot: string }[] = [];
  readonly toolSpecs: ProviderToolSpec[];
  /** The conversation this thread is on, swapped for a fresh one on
   * compaction. */
  private manager: NativeInferenceManager;
  /** The preflight count the last turn took, kept here because it outlives
   * the turn that took it and is reported at rest. Cleared with the manager
   * it was counted for. */
  private preflightTokenCount: number | undefined;
  public hooks: ThreadHooks = {
    onBeforeRequest: [],
    onToolResults: [],
    onYield: [],
    hasPendingContent: () => Promise.resolve(false),
  };
  /** Kept for the lifetime of the thread, so they outlive any one agent. */
  readonly structuredToolResults = new Map<
    ToolRequestId,
    ToolStructuredResult
  >();
  private threadLogger: ThreadLogger;
  /** Owns all reminder state and policy. Lives here rather than in the agent
   * because the thread is what activates reminders out of message resolution
   * and what resets state on compaction. Absent for compact threads, whose
   * content their caller composes exactly. */
  private systemReminders: ReminderSupervisor;

  constructor(
    public id: ThreadId,
    public readonly context: ThreadContext,
    public callbacks: ThreadCallbacks,
    init: ThreadInit = { type: "fresh" },
    private archiveOptions: ThreadArchiveOptions = {},
  ) {
    const forkProvenance = init.type === "clone" ? init.provenance : undefined;
    this.threadLogger = new ThreadLogger(
      id,
      context.threadType,
      () => this.getProviderMessages(),
      context.logger,
      {
        ...(archiveOptions.baseDir !== undefined
          ? { baseDir: archiveOptions.baseDir }
          : {}),
        ...(archiveOptions.scriptName !== undefined
          ? { scriptName: archiveOptions.scriptName }
          : {}),
        cwd: context.cwd,
        ...(forkProvenance ? { forkedFrom: forkProvenance } : {}),
      },
    );
    this.edlRegisters =
      init.type === "clone"
        ? init.edlRegisters
        : { registers: new Map(), nextSavedId: 0 };
    this.toolSpecs = threadToolSpecs(context);
    this.systemReminders = this.createReminderSupervisor();
    this.toolExecutor = new ToolExecutorHost({
      logger: context.logger,
      createTool: (request) => this.invokeTool(request),
      getHooks: () => this.agentHooks(),
      publishTools: (tools) => this.loop.setToolInvocationState(tools),
      onUpdate: () => this.handleUpdate(),
    });

    this.manager = this.initialManager(init);
  }

  /** Build an independent copy of `sourceThread` resuming at
   * `nativeMessageIdx`. The source is not aborted and shares no mutable state
   * with the result. */
  static async clone(args: {
    sourceThread: Thread;
    newId: ThreadId;
    nativeMessageIdx: NativeMessageIdx;
    context: ThreadContext;
    callbacks: ThreadCallbacks;
  }): Promise<Thread> {
    const { sourceThread, newId, nativeMessageIdx, context, callbacks } = args;
    const cloned = new Thread(
      newId,
      context,
      callbacks,
      {
        type: "clone",
        sourceManager: sourceThread.inferenceManager,
        nativeMessageIdx,
        provenance: {
          fromThreadId: sourceThread.id,
          nativeMessageIdx,
        },
        edlRegisters: {
          registers: new Map(sourceThread.edlRegisters.registers),
          nextSavedId: sourceThread.edlRegisters.nextSavedId,
        },
      },
      sourceThread.archiveOptions,
    );
    for (const [id, structured] of sourceThread.structuredToolResults) {
      cloned.structuredToolResults.set(id, structured);
    }
    return cloned;
  }

  private createReminderSupervisor(): ReminderSupervisor {
    if (this.context.threadType === "compact") return noReminders;
    return new SystemReminderSupervisor({
      threadType: this.context.threadType,
      subagentConfig: this.context.subagentConfig,
      contextTracker: this.context.contextTracker,
    });
  }

  /** The reminders currently in force. For rendering and tests. */
  get activeReminders(): ReadonlySet<string> {
    return this.systemReminders.activeReminders;
  }

  /** Busy from the first request of a submission until the loop comes to
   * rest, which spans the gaps between turns. */
  get isBusy(): boolean {
    return this.loopState.type !== "idle";
  }

  get inferenceManager(): NativeInferenceManager {
    return this.manager;
  }

  /** What this thread is doing. The thread sees every edge of it — it calls
   * the agent, it is called back for tool execution, and it is handed the
   * request-progress updates — so it is the loop's own account, not a mirror
   * of the agent's. How the last submission ended travels separately, on
   * `lastResult()`. */
  get loopState(): ThreadLoopState {
    return this.loop.current;
  }

  /** A render-only view of how the most recent submission ended. Nothing may
   * branch on it for control flow. */
  lastResult(): RestResult | undefined {
    if (this.yieldState) {
      return { type: "yielded", value: this.yieldState.value };
    }
    const state = this.loopState;
    if (state.type !== "idle") return undefined;
    const last = state.lastResult;
    // A suspension is a handoff, not an outcome anyone renders.
    return last?.type === "suspended" ? undefined : last;
  }

  /** Tool construction is the thread's: the agent only drives invocations.
   * Rebuilt per tool so a tool always sees the thread's current registers. */
  private toolContext(): CreateToolContext {
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
      onToolApplied: (absFilePath, tool, fileTypeInfo) =>
        this.onToolApplied(absFilePath, tool, fileTypeInfo),
      edlRegisters: this.edlRegisters,
      commentStore: this.context.commentStore,
      fileIO: this.context.fileIO,
      shell: this.context.shell,
      threadManager: this.context.threadManager,
      scriptRunner: this.context.getScriptRunner?.(),
      requestRender: () => this.handleUpdate(),
      getAgents: () => this.context.getAgents(),
    };
  }

  private onToolApplied: OnToolApplied = (absFilePath, tool, fileTypeInfo) => {
    try {
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
    const invocation = createTool(request, this.toolContext());
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
  /** Tool execution is the thread's: it owns the live invocations, the
   * `onToolResults` hooks and aborting them. Handed to each agent it builds. */
  private toolExecutor: ToolExecutorHost;

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

  /** Being called is the "tools started" edge and returning is "tools
   * settled": between them the loop is running tools, and on either side of
   * them it is streaming. */
  private executeTools(requests: ReadonlyArray<RequestedTool>): ToolExecution {
    this.loop.runningTools(requests);
    const execution = this.toolExecutor.execute(requests);
    return {
      ...execution,
      promise: execution.promise.finally(() => this.loop.toolsSettled()),
    };
  }

  private handleUpdate(): void {
    if (this.destroyed) return;
    this.threadLogger.record(
      this.loopState.type === "running" ? "streaming" : "at-rest",
    );
    this.callbacks.onUpdate();
  }

  getToolSpecs(): ProviderToolSpec[] {
    return this.toolSpecs;
  }

  getProviderMessages(): ReadonlyArray<ProviderMessage> {
    return this.manager.log.messages;
  }

  private get lastAssistantMessage():
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

  /** The preflight count the last turn took, for rendering. */
  get inputTokenCount(): number | undefined {
    return this.preflightTokenCount;
  }

  getMessages(): ProviderMessage[] {
    return [...this.getProviderMessages()];
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

  /** Content that leads the next submission's user message: a compaction
   * summary, a fork notification. Held here rather than in the agent, since
   * it must survive the agent swap in `reset` and an arbitrary wait for the
   * user's next message. */
  private pendingSeed: InputMessage[] = [];

  get pendingTurnContent(): ReadonlyArray<InputMessage> {
    return this.pendingSeed;
  }

  prependToNextTurn(messages: InputMessage[]): void {
    this.pendingSeed = [...this.pendingSeed, ...messages];
  }

  /** For tests: await pending best-effort archive writes. */
  async awaitArchiveFlush(): Promise<void> {
    await this.threadLogger.flushed();
  }

  setTitle(title: string): void {
    this.#title = title;
    this.threadLogger.recordTitle(title);
    this.handleUpdate();
  }

  /** Abort the in-flight turn and hand back whatever never went out. The
   * queues are the thread's, so the debris is the thread's to report. */
  /** Set once the thread's yield has been resolved. `tornDown` means an owner
   * accepted it and took the thread's world away, so nothing more can be
   * sent. */
  private yieldState: YieldState | undefined;
  get yielded(): YieldState | undefined {
    return this.yieldState;
  }

  async abort(): Promise<{ unsent: ReadonlyArray<QueuedMessage> }> {
    // A yielded thread has already completed its work.
    if (this.yieldState) return { unsent: [] };
    this.loop.markAborting();
    await this.abortAgentTurn();
    const unsent = this.drainQueues();
    if (unsent.length) this.handleUpdate();
    return { unsent };
  }

  get result(): Promise<ThreadResult> {
    return this.resultDefer.promise;
  }
  private resultDefer = new Defer<ThreadResult>();
  private resultSettled = false;
  private settleResult(result: ThreadResult): void {
    if (this.resultSettled) return;
    this.resultSettled = true;
    this.resultDefer.resolve(result);
  }

  async submit(
    message: PendingMessage,
    delivery: Delivery = "now",
  ): Promise<ThreadSendResult> {
    if (delivery !== "now" && this.isBusy) {
      this.enqueue([message], delivery);
      return { type: "queued" };
    }
    const resolved = await this.callbacks.resolve(message);
    if (resolved.compact) {
      return {
        type: "suspended",
        reason: { kind: "compact", nextPrompt: compactPrompt(resolved) },
      };
    }
    for (const text of resolved.reminders) {
      this.systemReminders.activateReminder(text);
    }
    return this.send(resolved.messages);
  }

  /** Flushed in full when the next provider request is issued (@async). */
  private nextRequestQueue: PendingMessage[] = [];
  /** Flushed in full the next time the thread comes to rest (@next). */
  private nextStopQueue: PendingMessage[] = [];

  /** Everything waiting for a delivery point, grouped by the point it waits
   * for and in the order it will go out. For rendering; nothing may branch on
   * it for control flow. */
  get queued(): {
    async: ReadonlyArray<PendingMessage>;
    next: ReadonlyArray<PendingMessage>;
  } {
    return { async: this.nextRequestQueue, next: this.nextStopQueue };
  }

  get queuedCount(): number {
    return this.nextRequestQueue.length + this.nextStopQueue.length;
  }

  private queue(delivery: DeferredDelivery): PendingMessage[] {
    return delivery === "async" ? this.nextRequestQueue : this.nextStopQueue;
  }

  private enqueue(
    messages: PendingMessage[],
    delivery: DeferredDelivery,
  ): void {
    this.queue(delivery).push(...messages);
  }

  /** Empty both queues and hand the debris back. Nothing is broadcast: the
   * caller gets its own return value. */
  private drainQueues(): QueuedMessage[] {
    const unsent: QueuedMessage[] = [
      ...this.nextRequestQueue.map(
        (message): QueuedMessage => ({
          when: "async",
          message,
        }),
      ),
      ...this.nextStopQueue.map(
        (message): QueuedMessage => ({
          when: "next",
          message,
        }),
      ),
    ];
    this.nextRequestQueue = [];
    this.nextStopQueue = [];
    return unsent;
  }

  /** Drain one queue at a stop, resolving each entry at the moment it is
   * delivered. An entry whose resolution throws is dropped with a visible
   * error rather than wedging the turn loop.
   *
   * A `@compact` entry ends the flush: it becomes the compaction's follow-up
   * prompt (with anything resolved ahead of it folded in, since there is no
   * request left to carry it) and the entries behind it go back on the
   * queue. */
  private async flushAtStop(delivery: DeferredDelivery): Promise<FlushedQueue> {
    const entries = this.queue(delivery).splice(0);
    const messages: InputMessage[] = [];
    for (let i = 0; i < entries.length; i++) {
      const resolved = await this.resolveQueued(entries[i]);
      if (!resolved) continue;
      if (resolved.compact) {
        this.enqueueFront(entries.slice(i + 1), delivery);
        return {
          type: "compact",
          nextPrompt:
            [...messages, ...resolved.messages]
              .map((m) => m.text)
              .join("\n")
              .trim() || undefined,
        };
      }
      messages.push(...resolved.messages);
    }
    return { type: "messages", messages };
  }

  /** Drain the async queue into the request that is about to carry the tool
   * results. A `@compact` cannot ride such a request — there is no place to
   * hand the transcript over from — so it is detected before resolution and
   * genuinely not delivered: it and everything behind it move to the `next`
   * queue, where the following stop picks them up. */
  private async flushMidTurn(): Promise<InputMessage[]> {
    const entries = this.nextRequestQueue.splice(0);
    const messages: InputMessage[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (parseCompact(entry).compact) {
        this.nextStopQueue.unshift(...entries.slice(i));
        return messages;
      }
      const resolved = await this.resolveQueued(entry);
      if (resolved) messages.push(...resolved.messages);
    }
    return messages;
  }

  /** Resolve one entry, activating its reminders. An entry whose resolution
   * throws is dropped with a visible error rather than wedging the turn
   * loop. */
  private async resolveQueued(entry: PendingMessage) {
    try {
      const resolved = await this.callbacks.resolve(entry);
      for (const text of resolved.reminders) {
        this.systemReminders.activateReminder(text);
      }
      return resolved;
    } catch (error) {
      this.context.logger.error(
        `Failed to resolve queued message: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  private enqueueFront(
    entries: ReadonlyArray<PendingMessage>,
    delivery: DeferredDelivery,
  ): void {
    if (!entries.length) return;
    this.queue(delivery).unshift(...entries);
  }

  /** The agent's view of the owner's hooks. `onEndTurn` is filtered out
   * structurally by `AgentHooks`; the thread's own two contributions are
   * appended to the before-request array like any other entry. */
  private agentHooks(): AgentHooks {
    return {
      onBeforeRequest: [
        ...this.hooks.onBeforeRequest,
        // Last, so the reminder sits after every other injection and
        // immediately before the user's own content.
        { run: (ctx) => Promise.resolve(this.reminderAction(ctx)) },
        { run: (ctx) => this.queueFlushAction(ctx) },
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
        ...this.hooks.onToolResults,
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

  /** Whatever is in the async queue rides the next request, whichever request
   * that is: flushing takes the entries off the queue, so a later flush finds
   * nothing and there is no double delivery to guard against. A suspension
   * leaves the queues intact and unresolved: their commands must run against
   * the world as it is when they are finally delivered. */
  private async queueFlushAction(
    ctx: AgentRequestContext,
  ): Promise<RequestAction> {
    if (ctx.status === "suspended" || !this.nextRequestQueue.length)
      return { type: "none" };
    return {
      type: "inject",
      content: (await this.flushMidTurn()).map(({ text }) => ({
        type: "text" as const,
        text,
      })),
    };
  }

  async send(
    messages: InputMessage[],
    { queue, force }: SendOptions = {},
  ): Promise<ThreadSendResult> {
    if (this.yieldState?.tornDown) {
      throw new Error(
        "This thread's container has been torn down. No further messages can be sent.",
      );
    }
    // The compact thread's content is composed by its caller, so it bypasses
    // context updates, reminders and the queue entirely.
    if (this.threadType === "compact") {
      return this.followSubmission(this.runToRest(messages));
    }

    if (this.isBusy) {
      if (queue === "async" || queue === "next") {
        this.enqueue(
          messages.map((m) => pendingMessage(m.text)),
          queue,
        );
        return { type: "queued" };
      }
      this.loop.markAborting();
      await this.abortAgentTurn();
      // Sending now supersedes whatever was waiting on the aborted turn.
      this.drainQueues();
    }

    const result = this.followSubmission(this.runToRest(messages, force));

    if (this.title === undefined && messages.length) {
      this.setThreadTitle(messages.map((m) => m.text).join("\n")).catch(
        (err: Error) =>
          this.context.logger.error(
            `Error getting thread title: ${err.message}\n${err.stack}`,
          ),
      );
    }

    return result;
  }

  private followSubmission(outcome: Promise<SendResult>): Promise<SendResult> {
    return outcome.then((r) => {
      if (r.type === "yielded") this.settleResult(r);
      return r;
    });
  }

  /** Whether a send with no user content is worth a request: only if a
   * supervisor has something to deliver. Standing content — the system
   * reminder, the system-info preamble — does not count, and the probe must
   * not consume anything, since the request may never be issued. */
  private async hasPendingContent(): Promise<boolean> {
    return await this.hooks.hasPendingContent();
  }

  /** The turn loop's lifecycle. Non-idle from the moment `runToRest` takes
   * over until it settles: the agent settles at every stop, so busyness is
   * the loop's to report. `aborting` is how an abort landing between turns —
   * when the agent itself has nothing in flight to interrupt — still stops
   * the loop. */
  private loop = new LoopStateMachine(() => this.handleUpdate());

  /** One turn through the agent. Streaming from the moment the request is
   * handed over until the loop gets the thread back; the tool batches inside
   * it announce themselves from `executeTools`. */
  private async runTurn(messages: InputMessage[]): Promise<SendResult> {
    const turn = runAgentLoop(
      {
        logger: this.context.logger,
        manager: this.manager,
        executeTools: (requests) => this.executeTools(requests),
        getHooks: () => this.agentHooks(),
        onStreamEvent: (event) => this.loop.applyStreamEvent(event),
      },
      toAgentInput(messages),
    );
    this.agentTurn = turn;
    this.loop.streaming(turn.promise);
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
      this.agentTurn = undefined;
      this.loop.preparing();
    }
  }

  /** The agent turn in flight, held so an abort can reach it. Aborting is the
   * only reason the thread keeps it: everything else about the turn is its
   * result. */
  private agentTurn: AgentTurn | undefined;

  /** Wind the agent's turn down and wait for it to settle. Abort enters the
   * agent through the turn handle, so a thread between turns simply has
   * nothing to abort — the loop's own `aborting` flag stops it there. */
  async abortAgentTurn(): Promise<void> {
    const turn = this.agentTurn;
    if (!turn) return;
    turn.abort();
    await turn.promise.catch(() => {});
  }

  /** Drive the agent until nothing more should be sent. The agent stops at
   * every turn boundary; deciding whether a stop is really the end — queued
   * content, a supervisor nudge, a truncated response — is the thread's. */
  private async runToRest(
    submitted: InputMessage[],
    force?: true,
  ): Promise<SendResult> {
    const messages = this.pendingSeed.length
      ? [...this.pendingSeed, ...submitted]
      : submitted;
    this.pendingSeed = [];
    // An abort can only target a loop that is running, so there is no stale
    // flag to clear here: `abort` leaves `idle` alone.
    this.editedFilesThisTurn = [];
    const epoch = this.loop.start();
    // How the submission ended is recorded as the loop comes to rest, so it
    // only ever exists alongside `idle`. A throw out of the loop is an
    // outcome too, and lands as a failure rather than as an absent result.
    try {
      const result = await this.runLoop(messages, epoch, force);
      this.loop.finish(epoch, result);
      return result;
    } catch (error) {
      this.loop.finish(epoch, {
        type: "failed",
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    }
  }

  private async runLoop(
    messages: InputMessage[],
    epoch: LoopEpoch,
    force?: true,
  ): Promise<SendResult> {
    const isCurrentLoop = () => this.loop.isCurrent(epoch);
    if (!messages.length && !force) {
      const pending = await this.hasPendingContent();
      // Probing takes time, and a send that arrived while it ran owns the
      // loop now: this one is over before it touched the agent.
      if (!isCurrentLoop()) return { type: "aborted" };
      if (!pending) return { type: "empty" };
    }
    let result = await this.runTurn(messages);
    for (;;) {
      // A yield suspension is the thread's own, raised by `yieldGate`, and
      // must never escape: an owner would read it as an unclaimed stop.
      if (result.type === "suspended" && result.reason.kind === "yield") {
        const resolved = await this.resolveYield(result.reason.value);
        if (resolved.type === "settled") return resolved.result;
        // A rejected yield goes back in through the front door, as an
        // ordinary continuation of this loop.
        result = await this.runTurn(resolved.messages);
        continue;
      }
      // An abort that arrives while a turn is in flight comes back through
      // the agent as an `aborted` result, so there is no separate check
      // here: the only window the loop itself owns is the continuation,
      // guarded below.
      if (result.type !== "completed") return result;

      const stopReason = result.stopReason;
      const next = await this.continuation(stopReason);
      if (this.loop.isEpochAborting(epoch)) return { type: "aborted" };
      switch (next.type) {
        case "rest":
          return result;
        case "suspended":
          return { type: "suspended", reason: next.reason };
        case "messages":
        case "flushed": {
          const continued = await this.runTurn(next.messages);
          if (continued.type === "suspended" && next.type === "flushed") {
            return {
              type: "suspended",
              reason: this.carryOntoSuspension(continued.reason, next.carry),
            };
          }
          result = continued;
          continue;
        }
        default:
          assertUnreachable(next);
      }
    }
  }

  /** The agent has yielded and settled; the supervisors decide whether that
   * stands. The first `accept`/`reject` wins outright — later hooks are not
   * consulted, since the decision is made — and `send-message` texts
   * concatenate. */
  private async resolveYield(
    value: YieldValue,
  ): Promise<
    | { type: "settled"; result: SendResult }
    | { type: "resubmit"; messages: InputMessage[] }
  > {
    const rendered = renderYieldValue(value);
    const texts: string[] = [];
    for (const hook of this.hooks.onYield) {
      const action = await hook(value);
      if (action.type === "accept") {
        const response = action.resultPrefix
          ? `${action.resultPrefix}\n\n${rendered}`
          : rendered;
        const accepted: YieldValue =
          value.type === "structured"
            ? value
            : { type: "text", text: response };
        this.yieldState = { value: accepted, response, tornDown: true };
        return {
          type: "settled",
          result: { type: "yielded", value: accepted },
        };
      }
      if (action.type === "reject") {
        return {
          type: "resubmit",
          messages: [{ type: "system", text: action.message }],
        };
      }
      if (action.type === "send-message") texts.push(action.text);
    }
    if (!texts.length) {
      this.yieldState = {
        value,
        response: rendered,
        tornDown: false,
      };
      return { type: "settled", result: { type: "yielded", value } };
    }
    return {
      type: "resubmit",
      messages: [{ type: "system", text: texts.join("\n\n") }],
    };
  }
  /** What follows this stop, if anything. A stop that issues no request never
   * reaches the before-request supervisors: the resting case is `onEndTurn`'s,
   * which is where auto-compaction gets to suspend a thread at rest. */
  private async continuation(stopReason: StopReason): Promise<
    | { type: "rest" }
    | { type: "suspended"; reason: SuspendReason }
    | { type: "messages"; messages: InputMessage[] }
    /** Messages drained from a queue. Resolving them ran their effects and
     * emptied the queue, so if the request they were flushed for never goes
     * out, `carry` (always non-empty) has to travel on the suspension. */
    | { type: "flushed"; messages: InputMessage[]; carry: string }
  > {
    const planned = this.plannedContinuation(stopReason);
    if (planned.type === "suspend") {
      return { type: "suspended", reason: planned.reason };
    }
    if (planned.type === "rest") return { type: "rest" };

    if (planned.type === "messages") {
      return { type: "messages", messages: planned.messages };
    }

    // Both queues are flushed in full, in insertion order: anything enqueued
    // while this resolution is running lands in the next flush.
    const messages: InputMessage[] = [];
    for (const delivery of ["async", "next"] as const) {
      const flushed = await this.flushAtStop(delivery);
      if (flushed.type === "compact") {
        return {
          type: "suspended",
          reason: { kind: "compact", nextPrompt: flushed.nextPrompt },
        };
      }
      messages.push(...flushed.messages);
    }
    if (!messages.length) return { type: "rest" };
    // Resolved queue content is spent: if the request it was flushed for is
    // suspended, it has to travel on the handoff rather than be resolved a
    // second time, so it is handed back for that.
    const carry = messages
      .map((m) => m.text)
      .join("\n")
      .trim();
    return carry
      ? { type: "flushed", messages, carry }
      : { type: "messages", messages };
  }
  /** Spent queue content — resolved, so not resolvable again — has to survive
   * the suspension of the request it was flushed for. */
  private carryOntoSuspension(reason: SuspendReason, carry: string) {
    switch (reason.kind) {
      case "compact":
        // The log is about to be thrown away, so the content travels on the
        // handoff and is delivered by the post-compaction request.
        return {
          ...reason,
          nextPrompt: reason.nextPrompt
            ? `${reason.nextPrompt}\n\n${carry}`
            : carry,
        };
      case "stop":
      case "yield":
        // The runner appends a suspended request's input to the log anyway, so
        // the content is already in place for whatever resumes the thread.
        return reason;
      default:
        return assertUnreachable(reason);
    }
  }

  /** Decided before anything is resolved or drained, because a stop that ends
   * the turn issues no request and the queues must not run their effects into
   * a message nothing is about to send. The supervisors' own injections are no
   * longer a concern here: they are composed by the gate, inside the request
   * that carries them. */
  private plannedContinuation(
    stopReason: StopReason,
  ):
    | { type: "messages"; messages: InputMessage[] }
    | { type: "queues" }
    | { type: "suspend"; reason: SuspendReason }
    | { type: "rest" } {
    if (
      stopReason === "end_turn" &&
      (this.nextRequestQueue.length || this.nextStopQueue.length)
    ) {
      return { type: "queues" };
    }

    const action = this.hooks.onEndTurn?.({
      stopReason,
      inputTokenCount: this.preflightTokenCount,
      lastAssistantMessage: this.lastAssistantMessage,
    });
    if (action?.type === "suspend") {
      return { type: "suspend", reason: action.reason };
    }
    if (action?.type === "send-message") {
      return {
        type: "messages",
        messages: [{ type: "system", text: action.text }],
      };
    }
    return { type: "rest" };
  }

  async setThreadTitle(userMessage: string): Promise<void> {
    const profileForRequest: ProviderProfile = {
      ...this.context.profile,
      thinking: undefined,
      reasoning: undefined,
    };

    const request = this.context.getProvider(profileForRequest).forceToolUse({
      model: this.context.profile.fastModel,
      input: [
        {
          type: "text",
          text: `\
The user has provided the following prompt:
${userMessage}

Come up with a succinct thread title for this prompt. It must be a single line (no newlines) and a few words long (ideally around 40 characters or fewer).
`,
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ],
      spec: ThreadTitle.spec,
      systemPrompt: this.systemPrompt,
      disableCaching: true,
    });
    const result = await request.promise;
    if (result.toolRequest.status === "ok") {
      const input = ThreadTitle.validateInput(
        result.toolRequest.value.input as { [key: string]: unknown },
      );
      if (input.status === "ok") {
        this.setTitle(input.value.title);
      }
    }
  }

  /** Swap in a fresh agent seeded with `seed`. The thread id, context manager,
   * structured tool results and edl registers survive.
   *
   * `archive` exists only because the archive's entry schema has a
   * `compaction` variant; the caller states its intent rather than relying on
   * omission. */
  async reset({
    seed,
    archive,
  }: {
    seed: InputMessage[];
    archive:
      | { type: "compaction"; summary: string; chunkCount: number }
      | { type: "none" };
  }): Promise<void> {
    this.toolExecutor.abortAll();
    await this.abortAgentTurn();
    this.manager = createInferenceManager(this.context, this.toolSpecs);
    this.preflightTokenCount = undefined;

    if (archive.type === "compaction") {
      this.threadLogger.recordCompaction({
        summary: archive.summary,
        chunkCount: archive.chunkCount,
      });
    }
    this.threadLogger.resetCursor();

    this.edlRegisters = { registers: new Map(), nextSavedId: 0 };
    this.editedFilesThisTurn = [];
    this.handleUpdate();
    this.systemReminders = this.createReminderSupervisor();
    this.hooks.onReset?.();

    // The swap discards the message list the old seed was queued for, so it
    // goes with it.
    this.pendingSeed = seed;
  }

  private destroyed = false;

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    this.toolExecutor.abortAll();
    await this.abortAgentTurn();

    this.settleResult({
      type: "aborted",
      reason: "thread destroyed before it yielded",
    });
  }
}
