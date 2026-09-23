import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
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
import type { TokenBudget } from "./compaction/token-budget.ts";
import type { ThreadLoopState } from "./loop-state.ts";
import { ABORT_MARKER_TEXT } from "./providers/inference-shared.ts";
import type {
  AgentInput,
  NativeMessageIdx,
  ProviderMessage,
  ProviderToolSpec,
  StopReason,
  Usage,
} from "./providers/provider-types.ts";
import type { SystemInfo, SystemPrompt } from "./providers/system-prompt.ts";
import {
  compactPrompt,
  parseCompact,
  type ResolveSubmission,
  type SubmissionInput,
} from "./submission/index.ts";
import {
  type BatchRun,
  type DeferredDelivery,
  type Disposition,
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
  SubmissionAborted,
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
} from "./thread-core.ts";
import type { ForkProvenance } from "./thread-logger.ts";
import {
  type EditedFileGroup,
  type RequestContext,
  type SupervisorAction,
  type SuspendReason,
  type ToolLoopSupervisor,
  ToolLoopSupervisorChain,
  type TurnSupervisor,
  TurnSupervisorChain,
} from "./thread-supervisor.ts";
import type { AgentContext } from "./tool-loop.ts";
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
/** What hooks see when no submission is running: nothing can abort them. */
const IDLE_SIGNAL = new AbortController().signal;
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
      | "threadType"
      | "logger"
      | "threadToolCreator"
      | "toolSpecs"
      | "tokenBudget"
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
  readonly turnSupervisors?: readonly TurnSupervisor[];
  readonly toolLoopSupervisors?: readonly ToolLoopSupervisor[];
  /** A budget is only meaningful with a compactor to act on its stop, so the
   * two travel together; a compactor alone serves explicit `@compact`. */
  compaction?: { compactor: Compactor; tokenBudget?: TokenBudget };
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

/** Flushed content as a single prompt: the only way spent queue content can
 * travel across a suspension that throws the log away. */
function joinText(messages: ReadonlyArray<AgentInput>): string {
  return messages
    .filter((m) => m.type === "text")
    .map((m) => m.text)
    .join("\n")
    .trim();
}

/** A compaction that suspends a request lands after the user's message is
 * already in the log. That message has not been answered, so it is carried
 * past the compaction as prompt text — like an explicit `@compact` prompt —
 * rather than being summarized. Tool results are mid-loop, not a user turn,
 * and the abort marker is not something the user said. */
export function splitPendingUserText(
  messages: ReadonlyArray<ProviderMessage>,
): {
  history: ReadonlyArray<ProviderMessage>;
  pendingUserText: string | undefined;
} {
  const last = messages.at(-1);
  // With nothing before it, the message is all there is to compact.
  if (
    messages.length < 2 ||
    last?.role !== "user" ||
    last.content.some((block) => block.type === "tool_result")
  )
    return { history: messages, pendingUserText: undefined };
  const text = last.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .filter((text) => text !== ABORT_MARKER_TEXT)
    .join("\n")
    .trim();
  return text
    ? { history: messages.slice(0, -1), pendingUserText: text }
    : { history: messages, pendingUserText: undefined };
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
  /** Index of the fork seam notice, when this thread was created by a fork.
   * Undefined once the core has been replaced by compaction. */
  get forkSeamIdx(): NativeMessageIdx | undefined {
    return this.core.forkSeamIdx;
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
  private readonly chains = new WeakMap<ThreadCore, ToolLoopSupervisorChain>();

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
    this.turnChain = new TurnSupervisorChain(() => this.turnSupervisors, {
      logger: context.logger,
      signal: () => this.submissionSignal,
    });
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
  private readonly queueFlush: ToolLoopSupervisor = {
    onBeforeRequest: (ctx: RequestContext) => this.queueFlushAction(ctx),
  };

  private toolLoopChainFor(core: ThreadCore): ToolLoopSupervisorChain {
    let chain = this.chains.get(core);
    if (!chain) {
      chain = new ToolLoopSupervisorChain(() => this.orderedSupervisors(core), {
        logger: this.context.logger,
        signal: () => this.submissionSignal,
      });
      this.chains.set(core, chain);
    }
    return chain;
  }

  private get toolLoopChain(): ToolLoopSupervisorChain {
    return this.toolLoopChainFor(this.core);
  }

  private readonly turnChain: TurnSupervisorChain;

  private coreCallbacks(getCore: () => ThreadCore): ThreadCoreCallbacks {
    const thread = this;
    return {
      // A replaced core is disposed and stops reporting on its own.
      onUpdate: () => this.handleUpdate(),
      // Lazy: the core is still being constructed when this is handed to it.
      get supervisor() {
        return thread.toolLoopChainFor(getCore());
      },
    };
  }

  private orderedSupervisors(
    core: ThreadCore,
  ): ReadonlyArray<ToolLoopSupervisor> {
    return [
      ...this.toolLoopSupervisors,
      this.gate(),
      ...this.contextSupervisors(core),
    ];
  }

  /** Sits ahead of the context supervisors so a completed yield tool
   * suspends before them. */
  private gate(): ToolLoopSupervisor {
    return {
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
  ): ReadonlyArray<ToolLoopSupervisor> {
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

  private threadToolCreator: ThreadToolCreator | undefined;
  private coreContext(): ThreadCoreContext {
    this.threadToolCreator ??= this.context.clientToolCreator({
      threadId: this.id,
    });
    return {
      ...this.context,
      ...(this.context.compaction?.tokenBudget
        ? { tokenBudget: this.context.compaction.tokenBudget }
        : {}),
      threadToolCreator: this.threadToolCreator,
      toolSpecs: this.buildToolSpecs(),
    };
  }

  private createFreshCore(
    initialFiles: Files | undefined = this.context.initialFiles,
  ): ThreadCore {
    const core = ThreadCore.create(
      this.id,
      this.coreContext(),
      this.coreCallbacks(() => core),
      this.resultArchive,
      {
        ...(initialFiles ? { initialFiles } : {}),
        ...(this.context.initialGitState
          ? { initialGitState: this.context.initialGitState }
          : {}),
      },
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
  get turnSupervisors(): readonly TurnSupervisor[] {
    return this.context.turnSupervisors ?? [];
  }
  get tokenBudget(): TokenBudget | undefined {
    return this.context.compaction?.tokenBudget;
  }
  get toolLoopSupervisors(): readonly ToolLoopSupervisor[] {
    return this.context.toolLoopSupervisors ?? [];
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
    if (this.isDestroyed) return;
    this.callbacks.onUpdate();
  }
  setTitle(title: string): void {
    this.#title = title;
    this.callbacks.onTitle?.(title);
    this.handleUpdate();
  }
  /** Set once the thread's yield has been resolved, and only while nothing
   * newer is running. */
  get yielded(): YieldState | undefined {
    return this.status.type === "yielded" ? this.status : undefined;
  }
  /** Abort the in-flight turn and hand back whatever never went out. The
   * queues are the thread's, so the debris is the thread's to report. */
  async abort(): Promise<{ unsent: ReadonlyArray<QueuedMessage> }> {
    if (this.yielded && !this.isBusy) return { unsent: [] };
    const unsent = this.drainQueues();
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
    return this.startSubmission(input);
  }

  /** Hand the input to a queue, to ride a later request. Nothing is reported
   * back: the submission that eventually carries it owns its outcome. */
  enqueue(input: SubmissionInput, delivery: DeferredDelivery): void {
    const entries = submissionEntries(input);
    switch (delivery) {
      case "async":
        this.mailbox.enqueueAsync(entries);
        return;
      case "next":
        this.mailbox.enqueueNext(entries);
        return;
      default:
        assertUnreachable(delivery);
    }
  }

  retry(): Promise<RestResult> {
    return this.startSubmission({ type: "resolved", messages: [] }, true);
  }

  private async startSubmission(
    input: SubmissionInput,
    force?: true,
  ): Promise<RestResult> {
    if (this.isDestroyed) throw new Error("Thread has been destroyed");
    if (this.tornDownState)
      throw new Error(
        "This thread's container has been torn down. No further messages can be sent.",
      );
    // Installed before the first await, so a caller that preempts can observe
    // the request having landed synchronously. The previous submission is
    // chained into this one: aborting this one waits for both to unwind, and
    // anything that overtakes this one while it waits simply aborts it.
    const previous = this.inFlight;
    if (previous) this.drainQueues();
    // The core's tool loop is interrupted synchronously, before anything is
    // awaited: an aborter must not leave live tools running for a microtask.
    const submission = new ActiveSubmission(async () => {
      await Promise.all([this.core.abortToolLoop(), previous?.abort()]);
    });
    void previous?.abort();
    this.status = { type: "running", submission };
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
      if (previous) await submission.step(() => previous.abort());
      const reset = this.reset;
      if (reset) await submission.step(() => reset);
      const resolved =
        input.type === "raw"
          ? await submission.step(() => this.context.resolve(input.message))
          : { messages: input.messages, reminders: [], compact: false };
      for (const text of resolved.reminders)
        this.activateReminder(
          text,
          this.core.manager.getPendingUserMessageIdx(),
        );
      this.turnChain.onSubmission(resolved.messages);
      let result: LoopResult = resolved.compact
        ? {
            type: "suspended",
            reason: { kind: "compact", nextPrompt: compactPrompt(resolved) },
          }
        : await this.runLoop(resolved.messages, submission, force);
      while (result.type === "suspended") {
        submission.throwIfAborted();
        const reason = result.reason;
        if (reason.kind === "suspend")
          return finish({ type: "suspended", reason });
        const outcome = await this.compactAndContinue(reason, submission);
        if (outcome.type === "settle") return finish(outcome.result);
        result = await this.runLoop(outcome.messages, submission);
      }
      return finish(result);
    } catch (error) {
      if (error instanceof SubmissionAborted)
        return finish({ type: "aborted" });
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
    const compactor = this.context.compaction?.compactor;
    // A compaction with nobody to run it comes to rest like a plain stop.
    if (!compactor)
      return { type: "settle", result: { type: "suspended", reason } };
    // The signal is the compactor's cue to stop, but waiting on a run that
    // ignores it would wedge whoever is waiting for this thread to go quiet.
    const { history, pendingUserText } = splitPendingUserText(
      this.getProviderMessages(),
    );
    const nextPrompt =
      [reason.nextPrompt?.trim(), pendingUserText]
        .filter(Boolean)
        .join("\n\n") || undefined;
    const outcome = await submission.step((signal) =>
      compactor.run(history, nextPrompt, signal),
    );
    if (outcome.type === "aborted")
      return { type: "settle", result: { type: "aborted" } };
    if (outcome.type === "error")
      return {
        type: "settle",
        result: {
          type: "failed",
          error: new Error(`Compaction failed: ${outcome.message}`),
        },
      };
    await this.replaceCore({
      archive: {
        type: "compaction",
        summary: outcome.summary,
        chunkCount: outcome.chunkCount,
      },
    });
    this.opening = [
      {
        type: "text",
        text: summaryText(outcome.summary),
      },
    ];
    submission.throwIfAborted();
    return {
      type: "continue",
      messages: [
        {
          type: "text",
          text: nextPrompt || "Please continue from where you left off.",
        },
      ],
    };
  }
  private opening: AgentInput[] = [];
  private readonly mailbox = new Mailbox();
  get queued(): Queues {
    return this.mailbox.queues;
  }
  private drainQueues(): QueuedMessage[] {
    return this.mailbox.drain();
  }
  /** Drain the async queue into a request that already exists, resolving its
   * entries against the message they will ride. */
  private async flushAsyncIntoRequest(
    nativeMessageIdx: NativeMessageIdx,
    signal: AbortSignal,
  ): Promise<AgentInput[]> {
    return this.mailbox.deliverAsync<AgentInput[]>(async (next) => {
      const messages: AgentInput[] = [];
      for (;;) {
        const entry = next();
        if (entry === undefined) break;
        // A compaction cannot ride a request that is already out, so it and
        // everything queued behind it wait for the next turn.
        if (entry.type === "raw" && parseCompact(entry.message).compact) {
          return {
            disposition: { type: "deferToNext", ahead: [entry] },
            value: messages,
          };
        }
        const resolved = await this.resolveQueued(
          entry,
          signal,
          nativeMessageIdx,
        );
        if (signal.aborted)
          return { disposition: { type: "commit" }, value: [] };
        if (resolved) messages.push(...resolved.messages);
      }
      return { disposition: { type: "commit" }, value: messages };
    });
  }
  /** Drain both queues, in delivery order, for a request that does not exist
   * yet. A compaction stops the drain: it cannot share a message with the
   * content around it. */
  private async flushQueuesForNextTurn(
    signal: AbortSignal,
  ): Promise<FlushedQueue> {
    const messages: AgentInput[] = [];
    for (const flush of [
      () => this.promptFlush(signal, (run) => this.mailbox.deliverAsync(run)),
      () => this.promptFlush(signal, (run) => this.mailbox.deliverNext(run)),
    ]) {
      const flushed = await flush();
      if (signal.aborted) break;
      if (flushed.type === "compact") {
        // Anything already flushed ahead of the compaction is spent, and the
        // log it would have ridden is about to be thrown away: it travels as
        // prompt text, like the compacting flush's own preceding content.
        const carried = joinText(messages);
        return {
          type: "compact",
          nextPrompt:
            [carried, flushed.nextPrompt].filter(Boolean).join("\n\n") ||
            undefined,
        };
      }
      messages.push(...flushed.messages);
    }
    return { type: "messages", messages };
  }
  private async promptFlush(
    signal: AbortSignal,
    deliver: (
      run: BatchRun<FlushedQueue, Disposition>,
    ) => Promise<FlushedQueue>,
  ): Promise<FlushedQueue> {
    return deliver(async (next) => {
      const messages: AgentInput[] = [];
      for (;;) {
        const entry = next();
        if (entry === undefined) break;
        const resolved = await this.resolveQueued(
          entry,
          signal,
          this.core.manager.getPendingUserMessageIdx(),
        );
        if (signal.aborted)
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
    signal: AbortSignal,
    nativeMessageIdx: NativeMessageIdx,
  ) {
    if (entry.type === "resolved")
      return { compact: false, messages: [entry.input], reminders: [] };
    try {
      const resolved = await untilAborted(
        this.context.resolve(entry.message),
        signal,
      );
      if (!resolved || signal.aborted) return undefined;
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
  ): Promise<SupervisorAction> {
    if (!this.queued.async.length) return { type: "none" };
    return {
      type: "inject",
      content: await this.flushAsyncIntoRequest(
        ctx.nativeMessageIdx,
        this.submissionSignal,
      ),
    };
  }
  private async hasPendingContent(): Promise<boolean> {
    const core = this.core;
    if (!core.isActive) return false;
    return this.toolLoopChain.hasPendingContent();
  }
  private status: ThreadStatus = { type: "idle", lastResult: undefined };
  /** The submission whose turn is on the core, which can differ from
   * `inFlight` while a preempted turn unwinds. */
  private turnSubmission: ActiveSubmission | undefined;
  private get submissionSignal(): AbortSignal {
    return (this.turnSubmission ?? this.inFlight)?.signal ?? IDLE_SIGNAL;
  }
  private get inFlight(): ActiveSubmission | undefined {
    return this.status.type === "running" ? this.status.submission : undefined;
  }
  private async runLoop(
    messages: AgentInput[],
    submission: ActiveSubmission,
    force?: true,
  ): Promise<LoopResult> {
    const core = this.core;
    if (!messages.length && !this.opening.length && !force) {
      // Probing takes time, and a send that arrived while it ran owns the
      // loop now: this one is over before it touched the agent.
      const pending = await submission.step(() => this.hasPendingContent());
      if (!pending) return { type: "empty" };
    }
    const runToolLoop = async (
      submitted: AgentInput[],
    ): Promise<CoreLoopResult> => {
      submission.throwIfAborted();
      const input = [...this.opening.splice(0), ...submitted];
      const supervisors = this.toolLoopChainFor(core);
      const notify = (
        hook: "onToolLoopStart" | "onToolLoopStop",
        idx: NativeMessageIdx,
      ) => supervisors[hook](idx);
      try {
        notify("onToolLoopStart", core.manager.getPendingUserMessageIdx());
        this.turnSubmission = submission;
        return await submission.settled(() => core.runToolLoop(input));
      } finally {
        if (this.turnSubmission === submission) this.turnSubmission = undefined;
        notify("onToolLoopStop", core.manager.getNativeMessageIdx());
      }
    };
    let result = await runToolLoop(messages);
    for (;;) {
      // Every suspension funnels through here, so a yield raised by the yield
      // tool is resolved inside the loop and the returned type is narrowed to
      // the suspensions an owner can be handed.
      if (result.type === "suspended") {
        const reason = result.reason;
        if (reason.kind !== "yield") return { type: "suspended", reason };
        const resolved = await this.resolveYield(reason.value, submission);
        if (resolved.type === "settled") return resolved.result;
        result = await runToolLoop(resolved.messages);
        continue;
      }
      if (result.type !== "completed") return result;
      if (result.stopReason === "context_budget") {
        // Core only refuses when it holds a budget, which comes from here.
        const tokenBudget = this.context.compaction?.tokenBudget;
        if (!tokenBudget)
          throw new Error("context_budget stop without a token budget");
        return {
          type: "suspended",
          reason: { kind: "compact", nextPrompt: tokenBudget.handoff },
        };
      }
      const stopReason = result.stopReason;
      const next = await this.continuation(stopReason, submission.signal);
      submission.throwIfAborted();
      switch (next.type) {
        case "rest":
          return { type: "completed", stopReason };
        case "suspended":
          // Back to the loop head, so a supervisor that suspends with a yield
          // is resolved here rather than escaping to the owner.
          result = { type: "suspended", reason: next.reason };
          continue;
        case "messages": {
          result = await runToolLoop(next.messages);
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
    const action = await submission.step(() => this.turnChain.onYield(value));
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
          text: action.text,
        },
      ],
    };
  }

  private async continuation(
    stopReason: StopReason,
    signal: AbortSignal,
  ): Promise<
    | { type: "rest" }
    | { type: "suspended"; reason: SuspendReason }
    | { type: "messages"; messages: AgentInput[] }
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
    const flushed = await this.flushQueuesForNextTurn(signal);
    if (signal.aborted) return { type: "rest" };
    if (flushed.type === "compact") {
      return {
        type: "suspended",
        reason: { kind: "compact", nextPrompt: flushed.nextPrompt },
      };
    }
    const messages = flushed.messages;
    if (!messages.length) return { type: "rest" };
    // Drained content rides the log from here: an auto-compaction that
    // suspends the request it was appended to still sees it, and the
    // post-compaction prompt is the plain "continue" contract.
    return { type: "messages", messages };
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
    const action = this.turnChain.onEndTurnWithoutYield({
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
  private async replaceCore({
    archive,
  }: {
    archive:
      | { type: "compaction"; summary: string; chunkCount: number }
      | { type: "none" };
  }): Promise<ThreadCore> {
    // Synchronous re-entrancy guard: a second caller must not be able to
    // overwrite the in-flight reset with its own rejected promise.
    if (this.reset) throw new Error("Thread reset already in progress");
    const reset = (async () => {
      const initialFiles = buildClonedFiles(this.contextFiles.files);
      await this.core.dispose();
      // Disposal is irreversible: cancellation prevents the caller's follow-up,
      // but must not leave this thread pointing at a permanently disposed core.
      const core = this.createFreshCore(initialFiles);
      this.core = core;
      // The replaced core's opening content does not belong to the new one.
      this.opening = [];
      // The replaced core's outcome does not describe the new one.
      if (this.status.type === "idle")
        this.status = { type: "idle", lastResult: undefined };
      this.callbacks.onCoreReplaced?.(
        archive.type === "compaction"
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

  get isDestroyed(): boolean {
    return this.status.type === "destroyed";
  }

  /** The status turns terminal synchronously — a caller that destroys must
   * see `isDestroyed` immediately — so the submission being unwound is taken
   * before it is lost from the status. */
  async destroy(): Promise<void> {
    if (this.isDestroyed) return;
    const submission = this.inFlight;
    this.status = { type: "destroyed", lastResult: this.lastResult() };
    // The in-flight submission is unwound before its core is disposed: the
    // loop has no liveness checks of its own to fall back on.
    await submission?.abort();
    // A reset outside a submission still swaps the core; dispose whichever
    // core it leaves behind.
    await this.reset?.catch(() => {});
    await this.core.dispose();
    this.settleResult({
      type: "aborted",
      reason: "thread destroyed before it yielded",
    });
  }
}
