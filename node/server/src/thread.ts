import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import type { AgentContext } from "./agent.ts";
import type { AgentsMap } from "./agents/agents.ts";
import type { GitState } from "./capabilities/git-client.ts";
import type { ScriptRunner } from "./capabilities/script-runner.ts";
import type { ThreadManager } from "./capabilities/thread-manager.ts";
import type { ThreadId, ThreadType } from "./chat-types.ts";
import {
  type Compactor,
  type CompactSuspendReason,
  summaryText,
} from "./compaction/index.ts";
import type { ThreadLoopState } from "./loop-state.ts";
import type {
  AgentInput,
  NativeMessageIdx,
  ProviderMessage,
  ProviderToolSpec,
  StopReason,
  Usage,
} from "./providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./providers/provider-types.ts";
import type { SystemInfo, SystemPrompt } from "./providers/system-prompt.ts";
import {
  compactPrompt,
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
import {
  ActiveSubmission,
  type AgentRequestContext,
  type CoreLoopResult,
  type OnUpdate,
  type QueuedMessage,
  type RestResult,
  type ThreadResult,
  type ThreadStatus,
  type YieldState,
  type YieldValue,
} from "./thread-api.ts";
import {
  type ContextDelivery,
  ThreadCore,
  type ThreadCoreCallbacks,
  type ThreadCoreContext,
  type ThreadCoreSeed,
} from "./thread-core.ts";
import type { ForkProvenance } from "./thread-logger.ts";
import {
  coreLivenessCheck,
  type EditedFileGroup,
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
import { Defer, untilAborted } from "./utils/async.ts";
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

export interface ThreadContextBase
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

/** What a `@compact` entry means for this delivery, and — mid-turn, where a
 * flush rides a request that already exists — the message it rides. */
type FlushPolicy =
  | { policy: "prompt" }
  | { policy: "defer"; nativeMessageIdx: NativeMessageIdx };

/** Flushed content as a single prompt: the only way spent queue content can
 * travel across a suspension that throws the log away. */
function joinText(messages: ReadonlyArray<AgentInput>): string {
  return messages
    .filter((m) => m.type === "text")
    .map((m) => m.text)
    .join("\n")
    .trim();
}

/** What the turn loop can hand back: a `yield` suspension is resolved inside
 * the loop, so the owner's suspension handling never has to consider it —
 * which makes it exactly the submission outcome. */
type LoopResult = RestResult;
type SuspensionOutcome =
  | { type: "continue"; messages: AgentInput[] }
  | { type: "settle"; result: RestResult };

export type ThreadCallbacks = {
  readonly onUpdate: OnUpdate;
  /** A title was set, by an owner or by title generation. */
  readonly onTitle?: (title: string) => void;
  /** The conversation generation was replaced. `compaction` describes the
   * compaction that caused it, when one did and the submission was still
   * current. */
  readonly onCoreReplaced?: (compaction?: {
    summary?: string;
    chunkCount: number;
  }) => void;
};
/** Everything Thread republishes from its replaceable core: the readers views
 * and tools ask the thread for, rather than reaching for a core that a
 * compaction may already have retired. Declared once, so a new reader is
 * added here and nowhere else, and so the delegating block below cannot drift
 * from what callers are promised. */
export interface ThreadCoreView {
  readonly contextFiles: ContextFileAccess;
  /** The structured context injected into the message at this index, for
   * views that render history. */
  getContextDelivery(
    nativeMessageIdx: NativeMessageIdx,
  ): ContextDelivery | undefined;
  readonly editedFileGroups: EditedFileGroup[];
  readonly toolSpecs: ReadonlyArray<ProviderToolSpec>;
  getLastStopTokenCount(): number;
  readonly activeReminders: ReadonlySet<string>;
  readonly nativeMessageIdx: NativeMessageIdx;
  readonly latestUsage: Usage | undefined;
  getProviderMessages(): ReadonlyArray<ProviderMessage>;
  /** The preflight count of the conversation as it stands. */
  readonly inputTokenCount: number | undefined;
}
/** Stable identity, submission queues, yield contract and archive across
 * replaceable conversation generations. */
export class Thread implements ThreadCoreView {
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
  /** The republished core view. Every member here is a straight delegation to
   * the current core, so replacement is invisible to callers. */
  get contextFiles(): ContextFileAccess {
    return this.core.fileSupervisor;
  }
  getContextDelivery(
    nativeMessageIdx: NativeMessageIdx,
  ): ContextDelivery | undefined {
    return this.core.getContextDelivery(nativeMessageIdx);
  }
  get editedFileGroups(): EditedFileGroup[] {
    return this.core.editedFilesSupervisor.groups;
  }
  get toolSpecs(): ReadonlyArray<ProviderToolSpec> {
    return this.core.toolSpecs;
  }
  getLastStopTokenCount(): number {
    return this.core.getLastStopTokenCount();
  }
  get activeReminders(): ReadonlySet<string> {
    return this.core.systemReminders?.activeReminders ?? new Set();
  }
  get nativeMessageIdx(): NativeMessageIdx {
    return this.core.manager.getNativeMessageIdx();
  }
  get latestUsage(): Usage | undefined {
    return this.core.manager.log.latestUsage;
  }
  getProviderMessages(): ReadonlyArray<ProviderMessage> {
    return this.core.manager.log.messages;
  }
  get inputTokenCount(): number | undefined {
    return this.core.preflightTokenCount;
  }
  private core: ThreadCore;
  /** One chain per core: its members include that core's context
   * supervisors. */
  private readonly chains = new WeakMap<ThreadCore, SupervisorChain>();

  get completedTools(): ReadonlyMap<ToolRequestId, CompletedToolInfo> {
    return this.resultArchive;
  }
  constructor(
    public id: ThreadId,
    private readonly context: ThreadContext,
    public readonly callbacks: ThreadCallbacks,
    public readonly archiveOptions: ThreadArchiveOptions = {},
    fork?: { source: Thread; nativeMessageIdx: NativeMessageIdx },
    // Tool request IDs identify immutable results, shared across resets and forks.
    private readonly resultArchive = new Map<
      ToolRequestId,
      CompletedToolInfo
    >(),
  ) {
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

  private supervisorsFor(core: ThreadCore): SupervisorChain {
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
    return this.supervisorsFor(this.core);
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
        return thread.supervisorsFor(getCore());
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
    context: ThreadContext;
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
  get chatSupervisors(): readonly ThreadSupervisor[] {
    return this.context.chatSupervisors ?? [];
  }
  /** Render state combines the outer submission's lifetime with progress
   * reported by its current agent turn. */
  get loopState(): ThreadLoopState {
    const submission = this.inFlight;
    return submission
      ? {
          type: "running",
          activity: this.core.activity ?? {
            type: "preparing",
            aborting: submission.signal.aborted,
          },
          aborting: submission.signal.aborted || this.core.aborting,
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
    this.callbacks.onUpdate();
  }
  /** Resolved content held for the head of the next turn. Reset replaces it;
   * the next turn drains it exactly once. */
  get pendingTurnContent(): ReadonlyArray<AgentInput> {
    return this.mailbox.seed;
  }
  prependToNextTurn(messages: AgentInput[]): void {
    this.mailbox.appendSeed(messages);
  }
  setTitle(title: string): void {
    this.assertUsable();
    this.#title = title;
    this.callbacks.onTitle?.(title);
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
    // A submission waiting to take over is part of what is being aborted.
    this.claims++;
    await this.inFlight?.abort();
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

  /** Preempt whatever is running and submit now. Settles with how this submission ended. */
  async submit(input: SubmissionInput): Promise<RestResult> {
    this.assertUsable();
    return this.startSubmission(input);
  }

  /** Hand the input to a queue, to ride a later request. Nothing is reported
   * back: the submission that eventually carries it owns its outcome. */
  enqueue(input: SubmissionInput, delivery: DeferredDelivery): void {
    this.assertUsable();
    this.mailbox.enqueue(delivery, submissionEntries(input));
  }

  retry(): Promise<RestResult> {
    return this.startSubmission({ type: "resolved", messages: [] }, true);
  }

  private async startSubmission(
    input: SubmissionInput,
    force?: true,
  ): Promise<RestResult> {
    this.assertAcceptsWork("No further messages can be sent.");
    // Issued before the first await, so a caller that preempts can observe the
    // request having landed synchronously.
    if (this.isBusy) {
      this.cancelSubmission();
      this.drainQueues();
    }
    // Taking over an idle thread must stay synchronous: the caller's next
    // statement expects the submission to be installed.
    const claim = ++this.claims;
    if (this.inFlight) {
      await this.inFlight?.abort();
      // A claim that waited can be overtaken, by a newer submission or by an
      // abort; it never runs.
      if (claim !== this.claims) return { type: "aborted" };
      this.assertUsable();
    }
    const submission = new ActiveSubmission(() => this.core.abortAgentTurn());
    this.status = { type: "running", submission };
    const isCurrent = this.currency(submission);
    this.handleUpdate();
    /** Settle the submission. A `yielded` outcome becomes the yielded
     * status. */
    const finish = (result: RestResult) => {
      // Only a destroy can have displaced this submission, and a destroyed
      // thread's status is terminal.
      if (this.inFlight === submission) {
        this.status =
          result.type === "yielded"
            ? {
                type: "yielded",
                value: result.value,
                ...(result.resultPrefix
                  ? { resultPrefix: result.resultPrefix }
                  : {}),
              }
            : { type: "idle", lastResult: result };
        if (result.type === "yielded") this.settleResult(result);
        this.handleUpdate();
      }
      return result;
    };
    try {
      if (this.reset) await this.reset;
      if (!isCurrent()) return finish({ type: "aborted" });
      const resolved =
        input.type === "raw"
          ? await untilAborted(
              this.context.resolve(input.message),
              submission.signal,
            )
          : { messages: input.messages, reminders: [], compact: false };
      if (!resolved || !isCurrent()) return finish({ type: "aborted" });
      for (const text of resolved.reminders)
        this.activateReminder(
          text,
          this.core.manager.getPendingUserMessageIdx(),
        );
      this.chain.onSubmission(resolved.messages);
      let result: LoopResult = resolved.compact
        ? {
            type: "suspended",
            reason: { kind: "compact", nextPrompt: compactPrompt(resolved) },
          }
        : await this.runLoop(resolved.messages, submission, force);
      while (result.type === "suspended") {
        if (!isCurrent()) return finish({ type: "aborted" });
        const reason = result.reason;
        if (reason.kind === "suspend")
          return finish({ type: "suspended", reason });
        const outcome = await this.compactAndContinue(reason, submission);
        if (outcome.type === "settle") return finish(outcome.result);
        if (!isCurrent()) return finish({ type: "aborted" });
        result = await this.runLoop(outcome.messages, submission);
      }
      return finish(isCurrent() ? result : { type: "aborted" });
    } catch (error) {
      if (!isCurrent()) return finish({ type: "aborted" });
      finish({
        type: "failed",
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    } finally {
      submission.settle();
    }
  }

  private async compactAndContinue(
    reason: CompactSuspendReason,
    submission: ActiveSubmission,
  ): Promise<SuspensionOutcome> {
    const isCurrent = this.currency(submission);
    const compactor = this.context.compactor;
    // A compaction with nobody to run it comes to rest like a plain stop.
    if (!compactor)
      return { type: "settle", result: { type: "suspended", reason } };
    // The signal is the compactor's cue to stop, but waiting on a run that
    // ignores it would wedge whoever is waiting for this thread to go quiet.
    const outcome = await untilAborted(
      compactor.run(
        this.getProviderMessages(),
        reason.nextPrompt,
        submission.signal,
      ),
      submission.signal,
    );
    if (!outcome || !isCurrent() || outcome.type === "aborted")
      return { type: "settle", result: { type: "aborted" } };
    if (outcome.type === "error")
      return {
        type: "settle",
        result: {
          type: "failed",
          error: new Error(`Compaction failed: ${outcome.message}`),
        },
      };
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
    if (!isCurrent()) return { type: "settle", result: { type: "aborted" } };
    return {
      type: "continue",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text:
            reason.nextPrompt?.trim() ||
            "Please continue from where you left off.",
        },
      ],
    };
  }
  private readonly mailbox = new Mailbox();
  get queued(): Queues {
    return this.mailbox.queues;
  }
  private drainQueues(): QueuedMessage[] {
    return this.mailbox.drain();
  }
  private flush(
    delivery: DeferredDelivery,
    policy: { policy: "prompt" },
  ): Promise<FlushedQueue>;
  private flush(
    delivery: DeferredDelivery,
    policy: { policy: "defer"; nativeMessageIdx: NativeMessageIdx },
  ): Promise<{ type: "messages"; messages: AgentInput[] }>;
  private async flush(
    delivery: DeferredDelivery,
    policy: FlushPolicy,
  ): Promise<FlushedQueue> {
    const isCurrent = this.turnGuard();
    return this.mailbox.deliver<FlushedQueue>(delivery, async (next) => {
      const messages: AgentInput[] = [];
      for (;;) {
        const entry = next();
        if (entry === undefined) break;
        if (
          policy.policy === "defer" &&
          entry.type === "raw" &&
          parseCompact(entry.message).compact
        ) {
          return {
            disposition: { type: "restore", to: "next", ahead: [entry] },
            value: { type: "messages", messages },
          };
        }
        const resolved = await this.resolveQueued(
          entry,
          isCurrent,
          policy.policy === "defer"
            ? policy.nativeMessageIdx
            : this.core.manager.getPendingUserMessageIdx(),
        );
        if (!isCurrent())
          return {
            disposition: { type: "commit" },
            value: { type: "messages", messages: [] },
          };
        if (!resolved) continue;
        if (resolved.compact) {
          return {
            disposition: { type: "restore" },
            value: {
              type: "compact",
              nextPrompt:
                joinText([...messages, ...resolved.messages]) || undefined,
            },
          };
        }
        messages.push(...resolved.messages);
      }
      return {
        disposition: { type: "commit" },
        value: { type: "messages", messages },
      };
    });
  }
  private async resolveQueued(
    entry: QueueEntry,
    isCurrent: () => boolean,
    nativeMessageIdx: NativeMessageIdx,
  ) {
    if (entry.type === "resolved")
      return { compact: false, messages: [entry.input], reminders: [] };
    const signal = this.inFlight?.signal;
    try {
      const resolved = signal
        ? await untilAborted(this.context.resolve(entry.message), signal)
        : await this.context.resolve(entry.message);
      if (!resolved || !isCurrent()) return undefined;
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
  private async queueFlushAction(
    ctx: AgentRequestContext,
  ): Promise<RequestAction> {
    if (ctx.status === "suspended" || !this.queued.async.length)
      return { type: "none" };
    return {
      type: "inject",
      content: (
        await this.flush("async", {
          policy: "defer",
          nativeMessageIdx: ctx.nativeMessageIdx,
        })
      ).messages,
    };
  }
  private async hasPendingContent(): Promise<boolean> {
    const core = this.core;
    if (!core.isActive) return false;
    return this.chain.hasPendingContent();
  }
  private status: ThreadStatus = { type: "idle", lastResult: undefined };
  private get inFlight(): ActiveSubmission | undefined {
    return this.status.type === "running" ? this.status.submission : undefined;
  }
  private cancelSubmission(): void {
    const submission = this.inFlight;
    if (!submission || submission.signal.aborted) return;
    void submission.abort();
    this.handleUpdate();
  }
  /** Counts takeovers. Bumped by every submission and by every abort, so a
   * claimant that is waiting for the thread to go quiet can tell that it was
   * overtaken while it waited. */
  private claims = 0;
  private turnGuard(core: ThreadCore = this.core): SubmissionGuard {
    const submission = this.inFlight;
    // With no live submission (a turn driven directly against the core) there
    // is nothing to go stale relative to, so the guard is core liveness
    // alone rather than a permanently false check.
    const live = this.currency(submission);
    return submissionGuard(() => live() && this.core === core && core.isActive);
  }
  private async runLoop(
    messages: AgentInput[],
    submission: ActiveSubmission,
    force?: true,
  ): Promise<LoopResult> {
    const signal = submission.signal;
    const isCurrentLoop = this.currency(submission);
    const core = this.core;
    if (!messages.length && !this.mailbox.seed.length && !force) {
      const pending = await untilAborted(this.hasPendingContent(), signal);
      // Probing takes time, and a send that arrived while it ran owns the
      // loop now: this one is over before it touched the agent.
      if (!isCurrentLoop()) return { type: "aborted" };
      if (!pending) return { type: "empty" };
    }
    const runTurn = async (
      submitted: AgentInput[],
    ): Promise<CoreLoopResult> => {
      if (!isCurrentLoop()) return { type: "aborted" };
      const input = [...this.mailbox.takeSeed(), ...submitted];
      const supervisors = this.supervisorsFor(core);
      const notify = (
        hook: "onAgentLoopStart" | "onAgentLoopStop",
        idx: NativeMessageIdx,
      ) => supervisors[hook](idx);
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
      // Every suspension funnels through here, so a yield raised by the yield
      // tool is resolved inside the loop and the returned type is narrowed to
      // the suspensions an owner can be handed.
      if (result.type === "suspended") {
        const reason = result.reason;
        if (reason.kind !== "yield") return { type: "suspended", reason };
        const resolved = await this.resolveYield(reason.value, submission);
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
          // Back to the loop head, so a supervisor that suspends with a yield
          // is resolved here rather than escaping to the owner.
          result = { type: "suspended", reason: next.reason };
          continue;
        case "messages":
        case "flushed": {
          const continued = await runTurn(next.messages);
          if (!isCurrentLoop()) return { type: "aborted" };
          if (continued.type === "suspended" && next.type === "flushed") {
            result = {
              type: "suspended",
              reason: this.carryOntoSuspension(continued.reason, next.carry),
            };
            continue;
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
  /** Terminal and irreversible, and deliberately not part of `status`: an
   * accepted yield means an owner took the thread's world away, which
   * outlives any submission that is preempted or aborted before it settles.
   * Written only by the yield hooks, and the single source of truth for the
   * "nothing more can be sent" guards. */
  private tornDownState = false;
  /** Whether an owner accepted this thread's yield and tore it down. */
  get tornDown(): boolean {
    return this.tornDownState;
  }
  private async resolveYield(
    value: YieldValue,
    submission: ActiveSubmission,
  ): Promise<
    | { type: "settled"; result: LoopResult }
    | { type: "resubmit"; messages: AgentInput[] }
  > {
    // A hook that is still deliberating when the thread is aborted keeps
    // deliberating; its decision simply has nobody left to apply it.
    const action = await untilAborted(
      this.chain.onYield(value),
      submission.signal,
    );
    if (!action || !this.currency(submission)())
      return { type: "settled", result: { type: "aborted" } };
    if (action.type === "accept") {
      const prefix = action.resultPrefix
        ? { resultPrefix: action.resultPrefix }
        : {};
      this.tornDownState = true;
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
      const flushed = await this.flush(delivery, { policy: "prompt" });
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
    const carry = joinText(messages);
    return carry
      ? { type: "flushed", messages, carry }
      : { type: "messages", messages };
  }
  /** Spent queue content — resolved, so not resolvable again — has to survive
   * the suspension of the request it was flushed for. */
  private carryOntoSuspension(
    reason: SuspendReason,
    carry: string,
  ): SuspendReason {
    // Only compaction throws the log away; every other suspension leaves the
    // spent content in the log, so there is nothing to rewrite. A compaction
    // is about to discard the log, so the content travels on the handoff and
    // is delivered by the post-compaction request.
    return reason.kind === "compact"
      ? {
          ...reason,
          nextPrompt: reason.nextPrompt
            ? `${reason.nextPrompt}\n\n${carry}`
            : carry,
        }
      : reason;
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
    {
      seed,
      archive,
    }: {
      seed: AgentInput[];
      archive:
        | { type: "compaction"; summary: string; chunkCount: number }
        | { type: "none" };
    },
    isCurrent: () => boolean = () => true,
  ): Promise<ThreadCore> {
    // Synchronous re-entrancy guard: a second caller must not be able to
    // overwrite the in-flight reset with its own rejected promise.
    if (this.reset) throw new Error("Thread reset already in progress");
    const reset = (async () => {
      this.assertAcceptsWork("Cannot reset.");
      const initialFiles = buildClonedFiles(this.contextFiles.files);
      await this.core.dispose();
      this.assertUsable();
      // Disposal is irreversible: cancellation prevents the caller's follow-up,
      // but must not leave this thread pointing at a permanently disposed core.
      const core = this.createFreshCore({ initialFiles });
      this.core = core;
      this.mailbox.setSeed(isCurrent() ? seed : []);
      // The replaced core's outcome does not describe the new one.
      if (this.status.type === "idle")
        this.status = { type: "idle", lastResult: undefined };
      this.callbacks.onCoreReplaced?.(
        isCurrent() && archive.type === "compaction"
          ? { summary: archive.summary, chunkCount: archive.chunkCount }
          : undefined,
      );
      this.handleUpdate();
      return core;
    })();
    this.reset = reset;
    try {
      return await reset;
    } finally {
      if (this.reset === reset) this.reset = undefined;
    }
  }

  /** "This submission still speaks for the thread": not aborted, and the
   * thread still alive. Every phase of a submission asks the same question,
   * so it is asked in one place. */
  private currency(submission?: ActiveSubmission): () => boolean {
    return () => !this.destroyed && !submission?.signal.aborted;
  }
  private assertUsable(): void {
    if (this.destroyed) throw new Error("Thread has been destroyed");
  }
  /** The two terminal conditions together: destroyed, or torn down by an
   * owner that accepted the yield. Anything that would drive the thread
   * forward asks for this rather than for either half. */
  private assertAcceptsWork(detail: string): void {
    this.assertUsable();
    if (this.tornDownState)
      throw new Error(`This thread's container has been torn down. ${detail}`);
  }
  private get destroyed(): boolean {
    return this.status.type === "destroyed";
  }
  get isDestroyed(): boolean {
    return this.destroyed;
  }
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.claims++;
    this.cancelSubmission();
    const lastResult = this.lastResult();
    this.status = { type: "destroyed", lastResult };
    await this.core.dispose();
    this.settleResult({
      type: "aborted",
      reason: "thread destroyed before it yielded",
    });
  }
}
