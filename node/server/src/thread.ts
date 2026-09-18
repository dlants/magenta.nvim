import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import type { AgentContext } from "./agent.ts";
import type { AgentsMap } from "./agents/agents.ts";
import type { GitState } from "./capabilities/git-client.ts";
import type { ScriptRunner } from "./capabilities/script-runner.ts";
import type { ThreadManager } from "./capabilities/thread-manager.ts";
import type { ThreadId, ThreadType } from "./chat-types.ts";
import { type Compactor, summaryText } from "./compaction/index.ts";
import type { ThreadLoopState } from "./loop-state.ts";
import type {
  AgentInput,
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
  parseCompact,
  type ResolveSubmission,
  type SubmissionInput,
} from "./submission/index.ts";
import {
  type DeferredDelivery,
  Mailbox,
  type QueueEntry,
  type Queues,
  submissionEntries,
} from "./submission/mailbox.ts";
import {
  buildClonedFiles,
  type FileSupervisor,
  type Files,
} from "./supervisors/file-supervisor.ts";
import type {
  AgentRequestContext,
  Generation,
  GenerationId,
  OnUpdate,
  QueuedMessage,
  RestResult,
  SendResult,
  ThreadResult,
  ThreadSendResult,
  ThreadStatus,
  YieldState,
  YieldValue,
} from "./thread-api.ts";
import {
  type ContextDelivery,
  ThreadCore,
  type ThreadCoreCallbacks,
  type ThreadCoreContext,
  type ThreadCoreSeed,
} from "./thread-core.ts";
import { type ForkProvenance, ThreadLogger } from "./thread-logger.ts";
import {
  coreLivenessCheck,
  type RequestAction,
  type RequestContext,
  type SubmissionGuard,
  SupervisorChain,
  type SuspendReason,
  submissionGuard,
  type ThreadSupervisor,
} from "./thread-supervisor.ts";
import type { CompletedToolInfo, ToolRequestId } from "./tool-types.ts";
import type {
  ClientToolCreator,
  ThreadToolCreator,
} from "./tools/create-tool.ts";
import type { MCPToolManager as MCPToolManagerImpl } from "./tools/mcp/manager.ts";
import type { ToolCapability } from "./tools/tool-registry.ts";
import { getToolSpecs } from "./tools/toolManager.ts";
import { assertUnreachable } from "./utils/assertUnreachable.ts";
import { Defer } from "./utils/async.ts";
import type { NvimCwd } from "./utils/files.ts";
export type { ContextDelivery, ThreadCoreContext, ThreadStatus, YieldState };
export type ContextFileAccess = Readonly<
  Pick<
    FileSupervisor,
    | "files"
    | "addFiles"
    | "addFileContext"
    | "removeFileContext"
    | "getPendingUpdates"
  >
>;

export type EnvironmentConfig =
  | { type: "local"; cwd?: NvimCwd }
  | { type: "docker"; container: string; cwd: string };

interface ThreadContextBase
  extends AgentContext,
    Omit<
      ThreadCoreContext,
      "threadType" | "logger" | "threadToolCreator" | "toolSpecs"
    > {
  clientToolCreator: ClientToolCreator;
  mcpToolManager: MCPToolManagerImpl;
  availableCapabilities: Set<ToolCapability>;
  getAgents: () => AgentsMap;
  yieldSchema?: JSONSchemaType;
  getScriptRunner?: () => ScriptRunner | undefined;
  subagentDockerfile?: string;
  initialFiles?: Files;
  initialGitState?: GitState;
  readonly resolve: ResolveSubmission;
  readonly chatSupervisors?: readonly ThreadSupervisor[];
  compactor?: Compactor;
  threadManager: ThreadManager;
  environmentConfig: EnvironmentConfig;
}

type ReminderBearingThreadType = Exclude<ThreadType, "compact">;

export type CompactThreadContext = ThreadContextBase & {
  threadType: "compact";
};
export type ReminderThreadContext = ThreadContextBase & {
  threadType: ReminderBearingThreadType;
};
export type ThreadContext = CompactThreadContext | ReminderThreadContext;

/** Clone callers replace environment collaborators, but conversation kind is
 * inherited from the source so supervisor presence cannot diverge from it. */
export type ThreadCloneContext = ThreadContextBase & { threadType?: never };

export function threadCloneContext(context: ThreadContext): ThreadCloneContext {
  const { threadType: _threadType, ...cloneContext } = context;
  return cloneContext;
}
export type ThreadArchiveOptions = {
  forkedFrom?: ForkProvenance;
  baseDir?: string;
  scriptName?: string;
};

/** The result of draining one queue: content for the next request, or a
 * compaction the flush ran into — never both. */
type FlushedQueue =
  | { type: "messages"; messages: AgentInput[] }
  | { type: "compact"; nextPrompt: string | undefined };

export type ThreadCallbacks = {
  readonly onUpdate: OnUpdate;
  readonly onSubmission?: (messages: readonly AgentInput[]) => void;
};
/** Stable identity, submission queues, yield contract and archive across
 * replaceable conversation generations. */
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
  get contextFiles(): ContextFileAccess {
    return this.core.fileSupervisor;
  }
  /** The structured context injected into the message at this index, for
   * views that render history. */
  getContextDelivery(
    nativeMessageIdx: NativeMessageIdx,
  ): ContextDelivery | undefined {
    return this.core.getContextDelivery(nativeMessageIdx);
  }
  private core: ThreadCore;
  /** One chain per core: its members include that core's context
   * supervisors. */
  private readonly chains = new WeakMap<ThreadCore, SupervisorChain>();

  get editedFileGroups() {
    return this.core.editedFilesSupervisor.groups;
  }
  get toolSpecs(): ReadonlyArray<ProviderToolSpec> {
    return this.core.toolSpecs;
  }
  get completedTools(): ReadonlyMap<ToolRequestId, CompletedToolInfo> {
    return this.resultArchive;
  }
  getLastStopTokenCount(): number {
    return this.core.getLastStopTokenCount();
  }
  private threadLogger: ThreadLogger;

  constructor(
    public id: ThreadId,
    private readonly context: ThreadContext,
    public readonly callbacks: ThreadCallbacks,
    private archiveOptions: ThreadArchiveOptions = {},
    fork?: { source: Thread; nativeMessageIdx: NativeMessageIdx },
    // Tool request IDs identify immutable results, shared across resets and forks.
    private readonly resultArchive = new Map<
      ToolRequestId,
      CompletedToolInfo
    >(),
  ) {
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
        ...(archiveOptions.forkedFrom
          ? { forkedFrom: archiveOptions.forkedFrom }
          : {}),
      },
    );
    this.core = fork
      ? this.createForkedCore({
          source: fork.source.core,
          nativeMessageIdx: fork.nativeMessageIdx,
        })
      : this.createFreshCore();
  }

  /** The thread's own contribution to a request: the queued user content. It
   * is last in the list because it must land last in the message, after every
   * context update. */
  private readonly queueFlush: ThreadSupervisor = {
    onBeforeRequest: (ctx: RequestContext) => this.queueFlushAction(ctx),
  };

  private chainFor(core: ThreadCore): SupervisorChain {
    let chain = this.chains.get(core);
    if (!chain) {
      chain = new SupervisorChain(() => this.orderedSupervisors(core), {
        logger: this.context.logger,
        guard: () => this.turnGuard(core),
        coreIsCurrent: coreLivenessCheck(
          () => this.core === core && core.isActive && !this.destroyed,
        ),
        countTokens: () =>
          core.manager.countTokens?.() ?? Promise.resolve(undefined),
      });
      this.chains.set(core, chain);
    }
    return chain;
  }

  private get chain(): SupervisorChain {
    return this.chainFor(this.core);
  }

  private coreCallbacks(getCore: () => ThreadCore): ThreadCoreCallbacks {
    const thread = this;
    return {
      onUpdate: () => {
        const core = getCore();
        if (this.core === core && core.isActive && !this.destroyed)
          this.handleUpdate();
      },
      // Lazy: the core is still being constructed when this is handed to it.
      get supervisor() {
        return thread.chainFor(getCore());
      },
    };
  }

  private orderedSupervisors(
    core: ThreadCore,
  ): ReadonlyArray<ThreadSupervisor> {
    return [
      ...(this.context.chatSupervisors ?? []),
      this.gate(core),
      ...this.contextSupervisors(core),
    ];
  }

  /** Sits between the chat supervisors and the context supervisors, where the
   * thread's own two ordering facts live: the preflight count the chat
   * supervisors may have forced is published before any context supervisor
   * reads it, and a completed yield tool suspends ahead of them. */
  private gate(core: ThreadCore): ThreadSupervisor {
    return {
      onBeforeRequest: (ctx) => {
        core.preflightTokenCount = ctx.inputTokenCount;
        return Promise.resolve({ type: "none" });
      },
      onToolResults: (results) => {
        for (const [id, result] of results) {
          if (result.status !== "ok") continue;
          const completed = this.resultArchive.get(id);
          if (completed?.request.toolName === "yield_to_parent") {
            return {
              kind: "yield",
              value: completed.request.input as YieldValue,
            };
          }
        }
        return undefined;
      },
    };
  }

  private contextSupervisors(
    core: ThreadCore,
  ): ReadonlyArray<ThreadSupervisor> {
    return [
      core.editedFilesSupervisor,
      ...(core.gitSupervisor ? [core.gitSupervisor] : []),
      ...(core.systemReminders ? [core.fileSupervisor] : []),
      ...(core.systemInfoSupervisor ? [core.systemInfoSupervisor] : []),
      ...(core.systemReminders ? [core.systemReminders] : []),
      this.queueFlush,
    ];
  }

  private buildToolSpecs(): ProviderToolSpec[] {
    const context = this.context;
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
  private freshSeed(): ThreadCoreSeed {
    const { initialFiles, initialGitState } = this.context;
    return {
      ...(initialFiles ? { initialFiles } : {}),
      ...(initialGitState ? { initialGitState } : {}),
    };
  }

  private threadToolCreator: ThreadToolCreator | undefined;
  private coreContext(): ThreadCoreContext {
    this.threadToolCreator ??= this.context.clientToolCreator({
      threadId: this.id,
    });
    return {
      ...this.context,
      threadToolCreator: this.threadToolCreator,
      toolSpecs: this.buildToolSpecs(),
    };
  }

  private createFreshCore(seed?: ThreadCoreSeed): ThreadCore {
    const core = ThreadCore.create(
      this.id,
      this.coreContext(),
      this.coreCallbacks(() => core),
      this.resultArchive,
      { ...this.freshSeed(), ...seed },
    );
    return core;
  }

  private createForkedCore(fork: {
    source: ThreadCore;
    nativeMessageIdx: NativeMessageIdx;
  }): ThreadCore {
    const core = ThreadCore.clone(
      this.id,
      this.coreContext(),
      this.coreCallbacks(() => core),
      this.resultArchive,
      fork,
    );
    return core;
  }
  static clone(args: {
    sourceThread: Thread;
    newId: ThreadId;
    nativeMessageIdx: NativeMessageIdx;
    context: ThreadCloneContext;
    callbacks: ThreadCallbacks;
  }): Thread {
    const { sourceThread, newId, nativeMessageIdx, context, callbacks } = args;
    const clonedContext: ThreadContext = {
      ...context,
      threadType: sourceThread.threadType,
    };
    const cloned = new Thread(
      newId,
      clonedContext,
      callbacks,
      {
        ...sourceThread.archiveOptions,
        forkedFrom: {
          fromThreadId: sourceThread.id,
          nativeMessageIdx,
        },
      },
      { source: sourceThread, nativeMessageIdx },
      sourceThread.resultArchive,
    );
    return cloned;
  }
  get activeReminders(): ReadonlySet<string> {
    return this.core.systemReminders?.activeReminders ?? new Set();
  }

  private activateReminder(
    text: string,
    nativeMessageIdx: NativeMessageIdx,
  ): void {
    this.core.systemReminders?.activateReminder(text, nativeMessageIdx);
  }
  /** Busy from the first request of a submission until the loop comes to
   * rest, which spans the gaps between turns. */
  get isBusy(): boolean {
    return this.loopState.type !== "idle";
  }
  get nativeMessageIdx(): NativeMessageIdx {
    return this.core.manager.getNativeMessageIdx();
  }
  get latestUsage() {
    return this.core.manager.log.latestUsage;
  }
  get chatSupervisors(): readonly ThreadSupervisor[] {
    return this.context.chatSupervisors ?? [];
  }
  /** Render state combines the outer submission's lifetime with progress
   * reported by its current agent turn. */
  get loopState(): ThreadLoopState {
    const generation = this.generation;
    return generation
      ? {
          type: "running",
          activity: this.core.activity ?? {
            type: "preparing",
            aborting: generation.controller.signal.aborted,
          },
          aborting: generation.controller.signal.aborted || this.core.aborting,
        }
      : { type: "idle", lastResult: this.lastResult() };
  }
  /** A render-only view of how the most recent submission ended. Nothing may
   * branch on it for control flow. */
  lastResult(): RestResult | undefined {
    const status = this.status;
    switch (status.type) {
      case "idle":
      case "destroyed":
        return status.lastResult;
      case "yielded": {
        const { value, resultPrefix } = status;
        return {
          type: "yielded",
          value,
          ...(resultPrefix ? { resultPrefix } : {}),
        };
      }
      case "running":
        return undefined;
      default:
        return assertUnreachable(status);
    }
  }
  private handleUpdate(): void {
    if (this.destroyed) return;
    this.threadLogger.record(
      this.loopState.type === "running" ? "streaming" : "at-rest",
    );
    this.callbacks.onUpdate();
  }
  getProviderMessages(): ReadonlyArray<ProviderMessage> {
    return this.core.manager.log.messages;
  }
  get inputTokenCount(): number | undefined {
    return this.core.preflightTokenCount;
  }
  /** Reset replaces this content; the next turn drains it exactly once. */
  private pendingSeed: AgentInput[] = [];

  get pendingTurnContent(): ReadonlyArray<AgentInput> {
    return this.pendingSeed;
  }
  prependToNextTurn(messages: AgentInput[]): void {
    this.pendingSeed = [...this.pendingSeed, ...messages];
  }
  async awaitArchiveFlush(): Promise<void> {
    await this.threadLogger.flushed();
  }
  setTitle(title: string): void {
    this.assertUsable();
    this.#title = title;
    this.threadLogger.recordTitle(title);
    this.handleUpdate();
  }
  /** Abort the in-flight turn and hand back whatever never went out. The
   * queues are the thread's, so the debris is the thread's to report. */
  /** Set once the thread's yield has been resolved, and only while nothing
   * newer is running. */
  get yielded(): YieldState | undefined {
    return this.status.type === "yielded" ? this.status : undefined;
  }
  async abort(): Promise<{ unsent: ReadonlyArray<QueuedMessage> }> {
    if (this.yielded && !this.isBusy) return { unsent: [] };
    const unsent = this.drainQueues();
    this.cancelSubmission();
    await this.core.abortAgentTurn();
    if (unsent.length) this.handleUpdate();
    return { unsent };
  }
  get result(): Promise<ThreadResult> {
    return this.resultDefer.promise;
  }
  private resultDefer = new Defer<ThreadResult>();
  private settleResult(result: ThreadResult): void {
    if (this.resultDefer.resolved) return;
    this.resultDefer.resolve(result);
  }
  async submit(
    input: SubmissionInput,
    delivery: Delivery = "now",
  ): Promise<ThreadSendResult> {
    this.assertUsable();
    if (delivery !== "now" && this.isBusy) {
      this.mailbox.enqueue(delivery, submissionEntries(input));
      return { type: "queued" };
    }
    return this.startSubmission(input);
  }

  retry(): Promise<RestResult> {
    return this.startSubmission({ type: "resolved", messages: [] }, true);
  }

  private async startSubmission(
    input: SubmissionInput,
    force?: true,
  ): Promise<RestResult> {
    this.assertUsable();
    if (this.yielded?.tornDown)
      throw new Error(
        "This thread's container has been torn down. No further messages can be sent.",
      );
    const wasBusy = this.isBusy;
    this.cancelSubmission();
    if (wasBusy) this.drainQueues();
    const generation = this.mintGeneration();
    this.status = { type: "running", generation };
    const signal = generation.controller.signal;
    const isCurrent = () => this.isCurrent(generation);
    this.handleUpdate();
    /** Settle the submission, unless something newer already owns the thread.
     * A `yielded` outcome becomes the yielded status, which also carries
     * whether an owner tore the thread down. */
    const finish = (result: RestResult) => {
      if (this.generation === generation) {
        this.status =
          result.type === "yielded"
            ? {
                type: "yielded",
                value: result.value,
                ...(result.resultPrefix
                  ? { resultPrefix: result.resultPrefix }
                  : {}),
                tornDown: this.yieldTornDown,
              }
            : { type: "idle", lastResult: result };
        if (result.type === "yielded") this.settleResult(result);
        this.handleUpdate();
      }
      return result;
    };
    try {
      if (wasBusy) {
        await this.core.abortAgentTurn();
        if (!isCurrent()) return finish({ type: "aborted" });
      }
      if (this.reset) await this.reset;
      if (!isCurrent()) return finish({ type: "aborted" });
      const resolved =
        input.type === "raw"
          ? await this.context.resolve(input.message)
          : { messages: input.messages, reminders: [], compact: false };
      if (!isCurrent()) return finish({ type: "aborted" });
      for (const text of resolved.reminders)
        this.activateReminder(
          text,
          this.core.manager.getPendingUserMessageIdx(),
        );
      this.callbacks.onSubmission?.(resolved.messages);
      let result: SendResult = resolved.compact
        ? {
            type: "suspended",
            reason: { kind: "compact", nextPrompt: compactPrompt(resolved) },
          }
        : await this.runLoop(resolved.messages, isCurrent, force);
      while (result.type === "suspended") {
        if (!isCurrent()) return finish({ type: "aborted" });
        const reason = result.reason;
        const compactor = this.context.compactor;
        // Nobody claimed this suspension: a plain stop, or a compaction with
        // no compactor to run it. The log is coherent, so it is reported as a
        // stop with its reason rather than as an empty submission.
        if (reason.kind === "yield")
          throw new Error("yield suspension escaped the turn loop");
        if (reason.kind !== "compact" || !compactor)
          return finish({ type: "stopped", reason });
        const outcome = await compactor.run(
          this.getProviderMessages(),
          reason.nextPrompt,
          signal,
        );
        if (!isCurrent() || outcome.type === "aborted")
          return finish({ type: "aborted" });
        if (outcome.type === "error")
          return finish({
            type: "failed",
            error: new Error(`Compaction failed: ${outcome.message}`),
          });
        await this.replaceCore(
          {
            seed: [
              {
                type: "text",
                nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
                text: summaryText(outcome.summary),
              },
            ],
            archive: {
              type: "compaction",
              summary: outcome.summary,
              chunkCount: outcome.chunkCount,
            },
          },
          isCurrent,
        );
        if (!isCurrent()) return finish({ type: "aborted" });
        result = await this.runLoop(
          [
            {
              type: "text",
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
              text:
                reason.nextPrompt?.trim() ||
                "Please continue from where you left off.",
            },
          ],
          isCurrent,
        );
      }
      return finish(isCurrent() ? result : { type: "aborted" });
    } catch (error) {
      if (!isCurrent()) return finish({ type: "aborted" });
      finish({
        type: "failed",
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    }
  }
  private readonly mailbox = new Mailbox();
  // The entry being resolved is already consumed; only untouched batch entries
  // belong in abort's report, ahead of arrivals made during resolution.
  private detachedBatch:
    | { delivery: DeferredDelivery; entries: QueueEntry[] }
    | undefined;
  get queued(): Queues {
    return this.mailbox.queues;
  }
  private restoreDetachedBatch(): void {
    const batch = this.detachedBatch;
    this.detachedBatch = undefined;
    if (batch) this.mailbox.prepend(batch.delivery, batch.entries.splice(0));
  }
  private drainQueues(): QueuedMessage[] {
    this.restoreDetachedBatch();
    return this.mailbox.drain();
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
    const isCurrent = this.turnGuard();
    const batch = { delivery, entries: this.mailbox.takeBatch(delivery) };
    this.detachedBatch = batch;
    const messages: AgentInput[] = [];
    try {
      while (batch.entries.length) {
        const entry = batch.entries.shift();
        if (entry === undefined) break;
        const resolved = await this.resolveQueued(
          entry,
          isCurrent,
          this.core.manager.getPendingUserMessageIdx(),
        );
        if (!isCurrent()) return { type: "messages", messages: [] };
        if (!resolved) continue;
        if (resolved.compact) {
          this.mailbox.prepend(delivery, batch.entries.splice(0));
          return {
            type: "compact",
            nextPrompt:
              [...messages, ...resolved.messages]
                .filter((m) => m.type === "text")
                .map((m) => m.text)
                .join("\n")
                .trim() || undefined,
          };
        }
        messages.push(...resolved.messages);
      }
      return { type: "messages", messages };
    } finally {
      if (this.detachedBatch === batch) this.detachedBatch = undefined;
    }
  }
  /** Drain the async queue into the request that is about to carry the tool
   * results. A `@compact` cannot ride such a request — there is no place to
   * hand the transcript over from — so it is detected before resolution and
   * genuinely not delivered: it and everything behind it move to the `next`
   * queue, where the following stop picks them up. */
  private async flushMidTurn(
    nativeMessageIdx: NativeMessageIdx,
  ): Promise<AgentInput[]> {
    const isCurrent = this.turnGuard();
    const batch = {
      delivery: "async" as const,
      entries: this.mailbox.takeBatch("async"),
    };
    this.detachedBatch = batch;
    const messages: AgentInput[] = [];
    try {
      while (batch.entries.length) {
        const entry = batch.entries.shift();
        if (entry === undefined) break;
        if (entry.type === "raw" && parseCompact(entry.message).compact) {
          this.mailbox.prepend("next", [entry, ...batch.entries.splice(0)]);
          return messages;
        }
        const resolved = await this.resolveQueued(
          entry,
          isCurrent,
          nativeMessageIdx,
        );
        if (!isCurrent()) return [];
        if (resolved) messages.push(...resolved.messages);
      }
      return messages;
    } finally {
      if (this.detachedBatch === batch) this.detachedBatch = undefined;
    }
  }
  /** Resolve one entry, activating its reminders. An entry whose resolution
   * throws is dropped with a visible error rather than wedging the turn
   * loop. */
  private async resolveQueued(
    entry: QueueEntry,
    isCurrent: () => boolean,
    nativeMessageIdx: NativeMessageIdx,
  ) {
    if (entry.type === "resolved")
      return { compact: false, messages: [entry.input], reminders: [] };
    try {
      const resolved = await this.context.resolve(entry.message);
      if (!isCurrent()) return undefined;
      for (const text of resolved.reminders) {
        this.activateReminder(text, nativeMessageIdx);
      }
      return resolved;
    } catch (error) {
      this.context.logger.error(
        `Failed to resolve queued message: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }
  /** Whatever is in the async queue rides the next request, whichever request
   * that is: flushing takes the entries off the queue, so a later flush finds
   * nothing and there is no double delivery to guard against. A suspension
   * leaves the queues intact and unresolved: their commands must run against
   * the world as it is when they are finally delivered. */
  private async queueFlushAction(
    ctx: AgentRequestContext,
  ): Promise<RequestAction> {
    if (ctx.status === "suspended" || !this.queued.async.length)
      return { type: "none" };
    return {
      type: "inject",
      content: await this.flushMidTurn(ctx.nativeMessageIdx),
    };
  }
  /** Whether a send with no user content is worth a request: only if a
   * supervisor has something to deliver. Standing content — the system
   * reminder, the system-info preamble — does not count, and the probe must
   * not consume anything, since the request may never be issued. */
  private async hasPendingContent(): Promise<boolean> {
    const core = this.core;
    if (!core.isActive) return false;
    return this.chain.hasPendingContent();
  }
  /** The single source of truth for where the thread is in its life. */
  private status: ThreadStatus = { type: "idle" };
  /** Outer hooks may outlive cancellation. Each submission captures its own
   * generation so a late continuation cannot act on the replacement
   * submission. */
  private get generation(): Generation | undefined {
    return this.status.type === "running" ? this.status.generation : undefined;
  }
  private nextGenerationId = 0;
  private mintGeneration(): Generation {
    return {
      id: this.nextGenerationId++ as GenerationId,
      controller: new AbortController(),
    };
  }
  private cancelSubmission(): void {
    const generation = this.generation;
    if (!generation || generation.controller.signal.aborted) return;
    generation.controller.abort();
    this.handleUpdate();
  }
  private isCurrent(generation: Generation): boolean {
    return (
      this.generation === generation && !generation.controller.signal.aborted
    );
  }
  /** The submission guard narrowed to the core the caller is running against:
   * a turn cannot outlive the core it was issued on, even though its
   * submission can (compaction replaces the core mid-submission). */
  private turnGuard(core: ThreadCore = this.core): SubmissionGuard {
    const generation = this.generation;
    // With no live submission (a turn driven directly against the core) there
    // is nothing to go stale relative to, so the guard is core liveness
    // alone rather than a permanently false check.
    const live = generation
      ? () => this.isCurrent(generation)
      : () => !this.destroyed;
    return submissionGuard(() => live() && this.core === core && core.isActive);
  }
  private async runLoop(
    messages: AgentInput[],
    isCurrentLoop: () => boolean,
    force?: true,
  ): Promise<SendResult> {
    const core = this.core;
    if (!messages.length && !this.pendingSeed.length && !force) {
      const pending = await this.hasPendingContent();
      // Probing takes time, and a send that arrived while it ran owns the
      // loop now: this one is over before it touched the agent.
      if (!isCurrentLoop()) return { type: "aborted" };
      if (!pending) return { type: "empty" };
    }
    const runTurn = async (submitted: AgentInput[]): Promise<SendResult> => {
      if (!isCurrentLoop()) return { type: "aborted" };
      const input = [...this.pendingSeed, ...submitted];
      this.pendingSeed = [];
      const chain = this.chainFor(core);
      const notify = (
        hook: "onAgentLoopStart" | "onAgentLoopStop",
        idx: NativeMessageIdx,
      ) => chain[hook](idx);
      try {
        notify("onAgentLoopStart", core.manager.getPendingUserMessageIdx());
        return await core.runTurn(input);
      } finally {
        notify("onAgentLoopStop", core.manager.getNativeMessageIdx());
      }
    };
    let result = await runTurn(messages);
    for (;;) {
      if (!isCurrentLoop()) return { type: "aborted" };
      // A successful yield tool raises this suspension internally; it must
      // never escape as an unclaimed stop at the submission boundary.
      if (result.type === "suspended" && result.reason.kind === "yield") {
        const resolved = await this.resolveYield(
          result.reason.value,
          isCurrentLoop,
        );
        if (!isCurrentLoop()) return { type: "aborted" };
        if (resolved.type === "settled") return resolved.result;
        result = await runTurn(resolved.messages);
        continue;
      }
      if (result.type !== "completed") return result;
      const stopReason = result.stopReason;
      const next = await this.continuation(stopReason);
      if (!isCurrentLoop()) return { type: "aborted" };
      switch (next.type) {
        case "rest":
          return result;
        case "suspended":
          return { type: "suspended", reason: next.reason };
        case "messages":
        case "flushed": {
          const continued = await runTurn(next.messages);
          if (!isCurrentLoop()) return { type: "aborted" };
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
  /** Decided by the yield hooks, consumed when the submission settles: an
   * accepted yield means an owner took the thread's world away. */
  private yieldTornDown = false;
  private async resolveYield(
    value: YieldValue,
    isCurrent: () => boolean,
  ): Promise<
    | { type: "settled"; result: SendResult }
    | { type: "resubmit"; messages: AgentInput[] }
  > {
    const action = await this.chain.onYield(value);
    if (!isCurrent()) return { type: "settled", result: { type: "aborted" } };
    if (action.type === "accept") {
      const prefix = action.resultPrefix
        ? { resultPrefix: action.resultPrefix }
        : {};
      this.yieldTornDown = true;
      return {
        type: "settled",
        result: { type: "yielded", value, ...prefix },
      };
    }
    if (action.type === "reject") {
      return {
        type: "resubmit",
        messages: [
          {
            type: "text",
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
            text: action.message,
          },
        ],
      };
    }
    if (action.type !== "send-message") {
      this.yieldTornDown = false;
      return { type: "settled", result: { type: "yielded", value } };
    }
    return {
      type: "resubmit",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: action.text,
        },
      ],
    };
  }
  /** What follows this stop, if anything. A stop that issues no request never
   * reaches the before-request supervisors: the resting case is `onEndTurn`'s,
   * which is where auto-compaction gets to suspend a thread at rest. */
  private async continuation(stopReason: StopReason): Promise<
    | { type: "rest" }
    | { type: "suspended"; reason: SuspendReason }
    | { type: "messages"; messages: AgentInput[] }
    /** Messages drained from a queue. Resolving them ran their effects and
     * emptied the queue, so if the request they were flushed for never goes
     * out, `carry` (always non-empty) has to travel on the suspension. */
    | { type: "flushed"; messages: AgentInput[]; carry: string }
  > {
    const isCurrent = this.turnGuard();
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
    const messages: AgentInput[] = [];
    for (const delivery of ["async", "next"] as const) {
      const flushed = await this.flushAtStop(delivery);
      if (!isCurrent()) return { type: "rest" };
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
      .filter((m) => m.type === "text")
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
    | { type: "messages"; messages: AgentInput[] }
    | { type: "queues" }
    | { type: "suspend"; reason: SuspendReason }
    | { type: "rest" } {
    if (
      stopReason === "end_turn" &&
      (this.queued.async.length || this.queued.next.length)
    ) {
      return { type: "queues" };
    }
    const action = this.chain.onEndTurnWithoutYield({
      stopReason,
      inputTokenCount: this.core.preflightTokenCount,
      lastAssistantMessage: this.core.lastAssistantMessage,
      nativeMessageIdx: this.core.manager.getNativeMessageIdx(),
    });
    if (action?.type === "suspend") {
      return { type: "suspend", reason: action.reason };
    }
    if (action?.type === "send-message") {
      return {
        type: "messages",
        messages: [
          {
            type: "text",
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
            text: action.text,
          },
        ],
      };
    }
    return { type: "rest" };
  }
  /** The in-flight core replacement, if any: both the re-entrancy guard and
   * what a preempting submission waits on. */
  private reset: Promise<ThreadCore> | undefined;
  private async replaceCore(
    options: Parameters<Thread["resetCore"]>[0],
    isCurrent: () => boolean = () => true,
  ): Promise<ThreadCore> {
    // Synchronous re-entrancy guard: a second caller must not be able to
    // overwrite the in-flight reset with its own rejected promise.
    if (this.reset) throw new Error("Thread reset already in progress");
    const reset = this.resetCore(options, isCurrent);
    this.reset = reset;
    try {
      return await reset;
    } finally {
      if (this.reset === reset) this.reset = undefined;
    }
  }

  private async resetCore(
    {
      seed,
      archive,
    }: {
      seed: AgentInput[];
      archive:
        | { type: "compaction"; summary: string; chunkCount: number }
        | { type: "none" };
    },
    isCurrent: () => boolean,
  ): Promise<ThreadCore> {
    this.assertUsable();
    if (this.yielded?.tornDown)
      throw new Error(
        "This thread's container has been torn down. Cannot reset.",
      );
    const initialFiles = buildClonedFiles(this.contextFiles.files);
    await this.core.dispose();
    this.assertUsable();
    // Disposal is irreversible: cancellation prevents the caller's follow-up,
    // but must not leave this thread pointing at a permanently disposed core.
    if (isCurrent() && archive.type === "compaction")
      this.threadLogger.recordCompaction({
        summary: archive.summary,
        chunkCount: archive.chunkCount,
      });
    const core = this.createFreshCore({ initialFiles });
    this.core = core;
    this.pendingSeed = isCurrent() ? [...seed] : [];
    // The replaced core's outcome does not describe the new one.
    if (this.status.type === "idle") this.status = { type: "idle" };
    this.threadLogger.resetCursor();
    this.handleUpdate();
    return core;
  }

  private assertUsable(): void {
    if (this.destroyed) throw new Error("Thread has been destroyed");
  }
  private get destroyed(): boolean {
    return this.status.type === "destroyed";
  }
  get isDestroyed(): boolean {
    return this.destroyed;
  }
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.cancelSubmission();
    const lastResult = this.lastResult();
    this.status = { type: "destroyed", ...(lastResult ? { lastResult } : {}) };
    await this.core.dispose();
    this.settleResult({
      type: "aborted",
      reason: "thread destroyed before it yielded",
    });
  }
}
