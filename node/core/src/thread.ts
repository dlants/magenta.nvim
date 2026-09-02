import type { AgentPhase } from "./agent.ts";
import {
  Agent,
  type AgentContext,
  type AgentDeps,
  type InputMessage,
  type ThreadState,
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
import type { ThreadId, ThreadType } from "./chat-types.ts";
import type { CommentStore } from "./context/comment-store.ts";
import type { EdlRegisters } from "./edl/index.ts";
import type { ProviderProfile } from "./provider-options.ts";
import type {
  NativeInferenceManager,
  NativeMessageIdx,
  ProviderMessage,
  ProviderToolSpec,
  StopReason,
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
import type { ToolRequestId, ToolStructuredResult } from "./tool-types.ts";
import { type CreateToolContext, createTool } from "./tools/create-tool.ts";
import type { MCPToolManager as MCPToolManagerImpl } from "./tools/mcp/manager.ts";
import * as ThreadTitle from "./tools/thread-title.ts";
import type { ToolCapability } from "./tools/tool-registry.ts";
import { getToolSpecs } from "./tools/toolManager.ts";
import { assertUnreachable } from "./utils/assertUnreachable.ts";
import { Defer } from "./utils/async.ts";
import type { HomeDir, NvimCwd } from "./utils/files.ts";
export type EnvironmentConfig =
  | { type: "local"; cwd?: NvimCwd }
  | { type: "docker"; container: string; cwd: string };

/** Everything a thread and the tools it builds read. A superset of what the
 * agent itself needs. */
export interface ThreadContext extends AgentContext {
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

/** Holds one `Agent` at a time, swapping it for a fresh one on compaction.
 * Thread 3 is still thread 3 afterwards, which is why the archive keys by
 * thread id survives the swap. */
export class Thread {
  public state: ThreadState;
  public agent: Agent;
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
    this.state = {
      threadType: context.threadType,
      systemPrompt: context.systemPrompt,
      systemInfo: context.systemInfo,
      edlRegisters:
        init.type === "clone"
          ? init.edlRegisters
          : { registers: new Map(), nextSavedId: 0 },
      title: undefined,
      editedFilesThisTurn: [],
      lastTurnResult: undefined,
      toolSpecs: threadToolSpecs(context),
    };
    this.systemReminders = this.createReminderSupervisor();

    this.agent = this.createAgent(
      init.type === "clone"
        ? {
            type: "cloned",
            cloneFrom: init.sourceManager,
            truncateTo: init.nativeMessageIdx,
          }
        : { type: "new" },
    );
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
          registers: new Map(sourceThread.state.edlRegisters.registers),
          nextSavedId: sourceThread.state.edlRegisters.nextSavedId,
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
    return this.loopState.type !== "idle" || this.agent.isBusy;
  }

  get inferenceManager(): NativeInferenceManager {
    return this.agent.manager;
  }

  /** The agent's own phase — there is one representation of this state, and
   * the thread does not re-encode it. How the last submission ended travels
   * separately, on `lastResult()`. */
  get phase(): AgentPhase {
    return this.agent.phase;
  }

  /** A render-only view of how the most recent submission ended. Nothing may
   * branch on it for control flow. */
  lastResult(): SendResult | undefined {
    const state = this.state;
    const phase = this.agent.phase;
    if (phase.type === "yielded") {
      return { type: "yielded", value: phase.value };
    }
    const last = state.lastTurnResult;
    if (!last) return undefined;
    switch (last.type) {
      case "stopped":
        return { type: "completed", stopReason: last.stopReason };
      case "aborted":
        return { type: "aborted" };
      case "failed":
        return {
          type: "failed",
          error: last.error,
          discardedSubmission: true,
        };
      case "suspended":
        return undefined;
      case "yielded":
        return { type: "yielded", value: last.value };
      default:
        assertUnreachable(last);
    }
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
      edlRegisters: this.state.edlRegisters,
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
      !this.state.editedFilesThisTurn.some((e) => e.path === absFilePath)
    ) {
      this.state.editedFilesThisTurn.push({
        path: absFilePath,
        snapshot: tool.previousContent,
      });
    }
  };

  private createAgent(runnerInit: AgentDeps["runnerInit"]): Agent {
    return new Agent(this.context, {
      state: this.state,
      structuredToolResults: this.structuredToolResults,
      createTool: (request) => createTool(request, this.toolContext()),
      toolSpecs: this.state.toolSpecs,
      getHooks: () => this.agentHooks(),
      onUpdate: () => this.handleUpdate(),
      runnerInit,
    });
  }

  private handleUpdate(): void {
    if (this.destroyed) return;
    this.threadLogger.record(
      this.phase.type === "running" ? "streaming" : "at-rest",
    );
    this.callbacks.onUpdate();
  }

  update(...args: Parameters<Agent["update"]>): void {
    this.agent.update(...args);
  }

  getToolSpecs(): ProviderToolSpec[] {
    return this.agent.getToolSpecs();
  }

  getProviderMessages(): ReadonlyArray<ProviderMessage> {
    return this.agent.getProviderMessages();
  }

  getMessages(): ProviderMessage[] {
    return this.agent.getMessages();
  }

  getLastStopTokenCount(): number {
    return this.agent.getLastStopTokenCount();
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
    this.agent.update({ type: "set-title", title });
    this.threadLogger.recordTitle(title);
  }

  /** Abort the in-flight turn and hand back whatever never went out. The
   * queues are the thread's, so the debris is the thread's to report. */
  async abort(): Promise<{ unsent: ReadonlyArray<QueuedMessage> }> {
    if (this.loopState.type === "running")
      this.loopState = { type: "aborting", epoch: this.loopState.epoch };
    await this.agent.abort();
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
        (message): QueuedMessage => ({ when: "async", message }),
      ),
      ...this.nextStopQueue.map(
        (message): QueuedMessage => ({ when: "next", message }),
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
      ],
      onToolResults: [
        ...this.hooks.onToolResults,
        (results) => this.systemReminders.onToolResults(results),
      ],
    };
  }

  private reminderAction(ctx: AgentRequestContext): RequestAction {
    // A suspended request is never issued, so a reminder placed in it would
    // be marked sent and never delivered.
    if (ctx.status === "suspended") return { type: "none" };
    return this.systemReminders.onBeforeRequest(ctx) ?? { type: "none" };
  }

  /** Only a mid-turn request carries the async queue: at a turn boundary
   * `flushAtStop` owns both queues, and flushing here as well would deliver
   * the same entries twice. Which request this is comes from the agent — the
   * only place that knows — rather than from thread-side bookkeeping that
   * could drift out of step with it. A suspension leaves the queues intact
   * and unresolved: their commands must run against the world as it is when
   * they are finally delivered. */
  private async queueFlushAction(
    ctx: AgentRequestContext,
  ): Promise<RequestAction> {
    if (
      ctx.status === "suspended" ||
      ctx.isOpeningRequest ||
      !this.nextRequestQueue.length
    )
      return { type: "none" };
    return { type: "submissions", messages: await this.flushMidTurn() };
  }

  async send(
    messages: InputMessage[],
    { queue }: SendOptions = {},
  ): Promise<ThreadSendResult> {
    // The compact thread's content is composed by its caller, so it bypasses
    // context updates, reminders and the queue entirely.
    if (this.state.threadType === "compact") {
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
      await this.agent.abortAndWait();
      // Sending now supersedes whatever was waiting on the aborted turn.
      this.drainQueues();
    }

    const result = this.followSubmission(this.runToRest(messages));

    if (!this.state.title) {
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

  /** Bumped for each turn loop as it starts, and carried in `loopState`, so
   * "am I still the current loop" is a property of the state. */
  private sendEpoch = 0;

  /** The turn loop's lifecycle. Non-idle from the moment `runToRest` takes
   * over until it settles: the agent looks idle between turns now that it
   * settles at every stop, so busyness is the loop's to report. `aborting`
   * is how an abort landing between turns — when the agent itself has
   * nothing in flight to interrupt — still stops the loop. */
  private loopState:
    | { type: "idle" }
    | { type: "running"; epoch: number }
    | { type: "aborting"; epoch: number } = { type: "idle" };
  private isAborting(epoch: number): boolean {
    return this.loopState.type === "aborting" && this.loopState.epoch === epoch;
  }

  /** Drive the agent until nothing more should be sent. The agent stops at
   * every turn boundary; deciding whether a stop is really the end — queued
   * content, a supervisor nudge, a truncated response — is the thread's. */
  private async runToRest(submitted: InputMessage[]): Promise<SendResult> {
    const messages = this.pendingSeed.length
      ? [...this.pendingSeed, ...submitted]
      : submitted;
    this.pendingSeed = [];
    // An abort can only target a loop that is running, so there is no stale
    // flag to clear here: `abort` leaves `idle` alone.
    this.state.editedFilesThisTurn = [];
    const epoch = ++this.sendEpoch;
    this.loopState = { type: "running", epoch };
    const isCurrentLoop = () =>
      this.loopState.type !== "idle" && this.loopState.epoch === epoch;
    try {
      if (!messages.length) {
        const pending = await this.hasPendingContent();
        // Probing takes time, and a send that arrived while it ran owns the
        // loop now: this one is over before it touched the agent.
        if (!isCurrentLoop()) return { type: "aborted" };
        if (!pending) return { type: "completed", stopReason: undefined };
      }
      let result = await this.agent.send(messages);
      for (;;) {
        if (result.type === "yielded") {
          const resolved = await this.resolveYield(result.value);
          if (resolved.type === "settled") return resolved.result;
          // A rejected yield goes back in through the front door, as an
          // ordinary continuation of this loop.
          result = await this.agent.send(resolved.messages);
          continue;
        }
        // An abort that arrives while a turn is in flight comes back through
        // the agent as an `aborted` result, so there is no separate check
        // here: the only window the loop itself owns is the continuation,
        // guarded below.
        if (result.type !== "completed") return result;
        // No stop reason means the agent settled without running a turn (an
        // empty submission); there is nothing to continue from.
        if (result.stopReason === undefined) return result;

        const stopReason = result.stopReason;
        const next = await this.continuation(stopReason);
        if (this.isAborting(epoch)) return { type: "aborted" };
        switch (next.type) {
          case "rest":
            return result;
          case "suspended":
            return { type: "suspended", reason: next.reason };
          case "messages":
          case "flushed": {
            const continued = await this.agent.send(next.messages);
            if (continued.type === "suspended" && next.type === "flushed") {
              return {
                type: "suspended",
                reason: this.carryOntoSuspension(continued.reason, next.carry),
              };
            }
            // A continuation rolls back only as far as its own request, so
            // the originally submitted content is still in the log and must
            // not be handed back for resubmission.
            result =
              continued.type === "failed"
                ? { ...continued, discardedSubmission: false }
                : continued;
            continue;
          }
          default:
            assertUnreachable(next);
        }
      }
    } finally {
      if (isCurrentLoop()) this.loopState = { type: "idle" };
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
        this.agent.markYieldAccepted(accepted, response);
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
      inputTokenCount: this.agent.inputTokenCount,
      lastAssistantMessage: this.agent.lastAssistantMessage,
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
      systemPrompt: this.state.systemPrompt,
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
    const previousAgent = this.agent;
    this.agent = this.createAgent({ type: "new" });
    await previousAgent.dispose();

    if (archive.type === "compaction") {
      this.threadLogger.recordCompaction({
        summary: archive.summary,
        chunkCount: archive.chunkCount,
      });
    }
    this.threadLogger.resetCursor();

    this.state.edlRegisters = { registers: new Map(), nextSavedId: 0 };
    this.state.editedFilesThisTurn = [];
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

    await this.agent.dispose();

    this.settleResult({
      type: "aborted",
      reason: "thread destroyed before it yielded",
    });
  }
}
