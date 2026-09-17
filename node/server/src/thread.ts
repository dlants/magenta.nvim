import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import type { AgentContext, BeforeRequestDecision } from "./agent.ts";

import type { AgentsMap } from "./agents/agents.ts";
import type { OnToolAppliedHook } from "./capabilities/context-tracker.ts";
import type { FileIO } from "./capabilities/file-io.ts";
import type { GitClient, GitState } from "./capabilities/git-client.ts";
import type { ScriptRunner } from "./capabilities/script-runner.ts";
import type { ThreadManager } from "./capabilities/thread-manager.ts";
import type { SubagentConfig, ThreadId, ThreadType } from "./chat-types.ts";
import { type Compactor, summaryText } from "./compaction/index.ts";
import type { EdlRegisters } from "./edl/index.ts";
import type { ThreadLoopState } from "./loop-state.ts";
import type { ProviderProfile } from "./provider-options.ts";
import type {
  AgentInput,
  NativeInferenceManager,
  NativeMessageIdx,
  Provider,
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
  type FileUpdates,
} from "./supervisors/file-supervisor.ts";
import type {
  GitContextUpdate,
  GitSupervisor,
} from "./supervisors/git-supervisor.ts";
import type { SystemReminderSupervisor } from "./system-reminder-supervisor.ts";
import type {
  AgentRequestContext,
  OnUpdate,
  QueuedMessage,
  RestResult,
  SendResult,
  ThreadResult,
  ThreadSendResult,
  YieldValue,
} from "./thread-api.ts";
import {
  ThreadCore,
  type ThreadCoreCallbacks,
  type ThreadCoreInitialization,
} from "./thread-core.ts";

import { type ForkProvenance, ThreadLogger } from "./thread-logger.ts";
import type {
  EditedFilesSupervisor,
  EndTurnAction,
  EndTurnContext,
  RequestAction,
  RequestContext,
  SuspendReason,
  SystemInfoSupervisor,
  ThreadSupervisor,
} from "./thread-supervisor.ts";
import type { CompletedToolInfo, ToolRequestId } from "./tool-types.ts";
import type { ClientToolCreator } from "./tools/create-tool.ts";
import type { MCPToolManager as MCPToolManagerImpl } from "./tools/mcp/manager.ts";
import * as ThreadTitle from "./tools/thread-title.ts";
import type { ToolCapability } from "./tools/tool-registry.ts";
import { assertUnreachable } from "./utils/assertUnreachable.ts";
import { Defer } from "./utils/async.ts";
import type { AbsFilePath, HomeDir, NvimCwd } from "./utils/files.ts";
export interface ThreadContextDelivery {
  initialFiles?: Files;
  pollIntervalMs?: number;
  initialGitState?: GitState | undefined;
}
export type YieldState = {
  value: YieldValue;
  resultPrefix?: string;
  tornDown: boolean;
};
export type EnvironmentConfig =
  | { type: "local"; cwd?: NvimCwd }
  | { type: "docker"; container: string; cwd: string };

interface ThreadContextBase extends AgentContext {
  compactor?: Compactor;
  profile: ProviderProfile;
  subagentConfig?: SubagentConfig;
  provider: Provider;
  yieldSchema?: JSONSchemaType;
  cwd: NvimCwd;
  homeDir: HomeDir;
  systemPrompt: SystemPrompt;
  systemInfo: SystemInfo;
  mcpToolManager: MCPToolManagerImpl;
  threadManager: ThreadManager;
  getScriptRunner?: () => ScriptRunner | undefined;
  fileIO: FileIO;
  gitClient: GitClient;
  clientToolCreator: ClientToolCreator;
  availableCapabilities: Set<ToolCapability>;
  environmentConfig: EnvironmentConfig;
  subagentDockerfile?: string;
  getAgents: () => AgentsMap;
  contextDelivery?: ThreadContextDelivery;
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
  resolve: ResolveSubmission;
  /** A context supervisor committed a delivery into the request going out.
   * Fixed for the thread lifetime; retired cores cannot publish deliveries. */
  readonly onFilesSent?: (updates: FileUpdates) => void;
  readonly onGitSent?: (update: GitContextUpdate) => void;
  readonly onFileAdded?: (path: AbsFilePath) => void;
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
  get fileSupervisor(): FileSupervisor {
    return this.core.fileSupervisor;
  }
  get gitSupervisor(): GitSupervisor | undefined {
    return this.core.gitSupervisor;
  }
  private get systemInfoSupervisor(): SystemInfoSupervisor | undefined {
    return this.core.systemInfoSupervisor;
  }
  private get systemReminders(): SystemReminderSupervisor | undefined {
    return this.core.systemReminders;
  }
  private _core: ThreadCore;
  private interruption = new AbortController();
  get interruptionSignal(): AbortSignal {
    return this.interruption.signal;
  }
  private interrupt(): void {
    const previous = this.interruption;
    this.interruption = new AbortController();
    previous.abort();
  }

  get core(): ThreadCore {
    return this._core;
  }
  get edlRegisters(): EdlRegisters {
    return this.core.edlRegisters;
  }
  get editedFilesSupervisor(): EditedFilesSupervisor {
    return this.core.editedFilesSupervisor;
  }
  get editedFileGroups() {
    return this.editedFilesSupervisor.groups;
  }
  get toolSpecs(): ProviderToolSpec[] {
    return this.core.toolSpecs;
  }
  get completedTools(): ReadonlyMap<ToolRequestId, CompletedToolInfo> {
    return this.resultArchive;
  }
  getLastStopTokenCount(): number {
    return this.core.getLastStopTokenCount();
  }
  async abortAgentTurn(): Promise<void> {
    this.cancelSubmission();
    await this.core.abortAgentTurn();
  }
  private _supervisors: ThreadSupervisor[] = [];
  /** The owner's supervisors. They lead the list — a suspension one of them
   * raises has to be visible to every context supervisor before any of those
   * can commit a delivery. */
  get supervisors(): ThreadSupervisor[] {
    return this._supervisors;
  }
  set supervisors(supervisors: ThreadSupervisor[]) {
    this._supervisors = supervisors;
  }
  private threadLogger: ThreadLogger;

  constructor(
    public id: ThreadId,
    public readonly context: ThreadContext,
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
    this._core = fork
      ? this.createCore({
          type: "fork",
          source: fork.source.core,
          nativeMessageIdx: fork.nativeMessageIdx,
        })
      : this.createCore();
  }

  /** The thread's own contribution to a request: the queued user content. It
   * is last in the list because it must land last in the message, after every
   * context update. */
  private readonly queueFlush: ThreadSupervisor = {
    onBeforeRequest: (ctx: RequestContext) => this.queueFlushAction(ctx),
  };

  private preflightRecorder!: ThreadSupervisor;
  private yieldGate!: ThreadSupervisor;

  private createGates(): void {
    this.preflightRecorder = {
      onBeforeRequest: async (ctx) => {
        this.core.preflightTokenCount = ctx.inputTokenCount;
        return { type: "none" };
      },
    };
    this.yieldGate = {
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

  private coreCallbacks(getCore: () => ThreadCore): ThreadCoreCallbacks {
    const isCurrent = () =>
      this.core === getCore() && getCore().isActive && !this.destroyed;
    return {
      onUpdate: () => {
        if (isCurrent()) this.handleUpdate();
      },
      onFilesSent: (updates) => {
        if (isCurrent()) this.callbacks.onFilesSent?.(updates);
      },
      onGitSent: (update) => {
        if (isCurrent()) this.callbacks.onGitSent?.(update);
      },
      onFileAdded: (path) => {
        if (isCurrent()) this.callbacks.onFileAdded?.(path);
      },
      onToolApplied: (event) => this.onToolApplied(event, isCurrent),
      onBeforeRequest: () => this.beforeRequest(getCore()),
      onToolResults: (results, idx) => {
        let suspend: SuspendReason | undefined;
        for (const supervisor of this.orderedSupervisors) {
          if (!isCurrent()) break;
          try {
            const asked = supervisor.onToolResults?.(results, idx);
            suspend ??= asked;
          } catch (error) {
            this.context.logger.error(
              `onToolResults hook threw: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        return suspend;
      },
    };
  }

  private onToolApplied(
    event: Parameters<OnToolAppliedHook>[0],
    isCurrent: () => boolean,
  ): void {
    for (const supervisor of this.orderedSupervisors) {
      if (!isCurrent()) return;
      try {
        supervisor.onToolApplied?.(event);
      } catch (error) {
        this.context.logger.error(
          `onToolApplied hook threw: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async beforeRequest(
    core: ThreadCore,
  ): Promise<BeforeRequestDecision> {
    const manager = core.manager;
    const isCurrentLoop = this.currentLoopGuard();
    const isCurrent = () =>
      this.core === core && core.isActive && isCurrentLoop();
    const injections: AgentInput[] = [];
    let suspend: SuspendReason | undefined;
    let tokenCount: number | undefined;
    let counted = false;
    for (const supervisor of this.orderedSupervisors) {
      if (!isCurrent()) break;
      if (!supervisor.onBeforeRequest) continue;
      if (supervisor.requestPreflightTokenCount && !counted && !suspend) {
        counted = true;
        try {
          tokenCount = await manager.countTokens?.();
        } catch (error) {
          this.context.logger.warn(
            `preflight countTokens failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!isCurrent()) break;
      }
      const action = await supervisor.onBeforeRequest({
        inputTokenCount: tokenCount,
        outputTokenCount: manager.log.messages.reduce(
          (total, message) => total + (message.usage?.outputTokens ?? 0),
          0,
        ),
        nativeMessageIdx: manager.getPendingUserMessageIdx(),
        ...(suspend === undefined
          ? { status: "pending" as const }
          : { status: "suspended" as const, reason: suspend }),
      });
      if (!isCurrent()) break;
      if (action.type === "suspend") suspend ??= action.reason;
      else if (action.type === "inject") {
        for (const block of action.content) {
          injections.push(
            block.type === "text"
              ? { ...block, nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }
              : block,
          );
        }
      }
    }
    return suspend === undefined
      ? { type: "proceed", injections }
      : { type: "suspend", reason: suspend, injections };
  }

  private onEndTurn(context: EndTurnContext): EndTurnAction {
    const texts: string[] = [];
    let suspend: Extract<EndTurnAction, { type: "suspend" }> | undefined;
    for (const supervisor of this.orderedSupervisors) {
      const action = supervisor.onEndTurnWithoutYield?.(context);
      if (action?.type === "send-message") texts.push(action.text);
      else if (action?.type === "suspend") suspend ??= action;
    }
    if (suspend) return suspend;
    return texts.length
      ? { type: "send-message", text: texts.join("\n\n") }
      : { type: "none" };
  }

  private get orderedSupervisors(): ReadonlyArray<ThreadSupervisor> {
    return [
      ...this._supervisors,
      this.preflightRecorder,
      this.yieldGate,
      this.editedFilesSupervisor,
      ...(this.gitSupervisor ? [this.gitSupervisor] : []),
      ...(this.systemReminders ? [this.fileSupervisor] : []),
      ...(this.systemInfoSupervisor ? [this.systemInfoSupervisor] : []),
      ...(this.systemReminders ? [this.systemReminders] : []),
      this.queueFlush,
    ];
  }

  private createCore(
    opts: ThreadCoreInitialization = { type: "fresh" },
  ): ThreadCore {
    this.createGates();
    const core = new ThreadCore(
      this.id,
      this.context,
      this.coreCallbacks(() => core),
      this.resultArchive,
      opts,
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
    return this.systemReminders?.activeReminders ?? new Set();
  }

  private activateReminder(
    text: string,
    nativeMessageIdx: NativeMessageIdx,
  ): void {
    this.systemReminders?.activateReminder(text, nativeMessageIdx);
  }
  /** Busy from the first request of a submission until the loop comes to
   * rest, which spans the gaps between turns. */
  get isBusy(): boolean {
    return this.loopState.type !== "idle";
  }
  get inferenceManager(): NativeInferenceManager {
    return this.core.manager;
  }
  /** Render state combines the outer submission's lifetime with progress
   * reported by its current agent turn. */
  get loopState(): ThreadLoopState {
    const submission = this.submission;
    return submission
      ? {
          type: "running",
          activity: this.core.activity ?? {
            type: "preparing",
            aborting: submission.signal.aborted,
          },
          aborting: submission.signal.aborted || this.core.aborting,
        }
      : { type: "idle", lastResult: this.lastSubmissionResult };
  }
  /** A render-only view of how the most recent submission ended. Nothing may
   * branch on it for control flow. */
  lastResult(): RestResult | undefined {
    if (this.yieldState) {
      const { value, resultPrefix } = this.yieldState;
      return {
        type: "yielded",
        value,
        ...(resultPrefix ? { resultPrefix } : {}),
      };
    }
    const state = this.loopState;
    if (state.type !== "idle") return undefined;
    const last = state.lastResult;
    // A suspension is a handoff, not an outcome anyone renders.
    return last?.type === "suspended" ? undefined : last;
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
    return this.core.manager.log.messages;
  }
  get inputTokenCount(): number | undefined {
    return this.core.preflightTokenCount;
  }
  getMessages(): ProviderMessage[] {
    return [...this.getProviderMessages()];
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
    this.interrupt();
    if (this.yieldState && !this.isBusy) return { unsent: [] };
    const unsent = this.drainQueues();
    await this.abortAgentTurn();
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
    if (this.yieldState?.tornDown)
      throw new Error(
        "This thread's container has been torn down. No further messages can be sent.",
      );
    const wasBusy = this.isBusy;
    this.interrupt();
    this.cancelSubmission();
    if (wasBusy) this.drainQueues();
    const submission = new AbortController();
    this.submission = submission;
    const signal = this.interruptionSignal;
    const isCurrent = () =>
      this.submission === submission &&
      !submission.signal.aborted &&
      !signal.aborted &&
      !this.destroyed;
    this.handleUpdate();
    const finish = (result: RestResult, displayResult: SendResult = result) => {
      if (this.submission === submission) {
        this.submission = undefined;
        this.lastSubmissionResult = displayResult;
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
      if (this.resetPromise) await this.resetPromise;
      if (!isCurrent()) return finish({ type: "aborted" });
      const resolved =
        input.type === "raw"
          ? await this.callbacks.resolve(input.message)
          : { messages: input.messages, reminders: [], compact: false };
      if (!isCurrent()) return finish({ type: "aborted" });
      for (const text of resolved.reminders)
        this.activateReminder(
          text,
          this.core.manager.getPendingUserMessageIdx(),
        );
      if (
        this.threadType !== "compact" &&
        this.title === undefined &&
        resolved.messages.length
      ) {
        this.setThreadTitle(
          resolved.messages
            .filter((m) => m.type === "text")
            .map((m) => m.text)
            .join("\n"),
        ).catch((error: Error) =>
          this.context.logger.error(
            `Error getting thread title: ${error.message}`,
          ),
        );
      }
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
        if (reason.kind !== "compact" || !compactor)
          return finish({ type: "empty" }, result);
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
    const isCurrent = this.currentLoopGuard();
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
    const isCurrent = this.currentLoopGuard();
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
  private currentLoopGuard(): () => boolean {
    const core = this.core;
    const submission = this.submission;
    return () =>
      this.core === core &&
      core.isActive &&
      submission !== undefined &&
      this.submission === submission &&
      !submission.signal.aborted;
  }
  private async resolveQueued(
    entry: QueueEntry,
    isCurrent: () => boolean,
    nativeMessageIdx: NativeMessageIdx,
  ) {
    if (entry.type === "resolved")
      return { compact: false, messages: [entry.input], reminders: [] };
    try {
      const resolved = await this.callbacks.resolve(entry.message);
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
    const isCurrent = this.currentLoopGuard();
    for (const supervisor of this.orderedSupervisors) {
      const pending = await supervisor.hasPendingContent?.();
      if (!isCurrent()) return false;
      if (pending) return true;
    }
    return false;
  }
  /** Outer hooks may outlive cancellation. Each submission captures its own
   * signal so a late continuation cannot act on the replacement submission. */
  private submission: AbortController | undefined;
  private lastSubmissionResult: SendResult | undefined;
  private cancelSubmission(): void {
    if (!this.submission || this.submission.signal.aborted) return;
    this.submission.abort();
    this.handleUpdate();
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
      const supervisors = this.orderedSupervisors;
      const notify = (
        hook: "onAgentLoopStart" | "onAgentLoopStop",
        idx: NativeMessageIdx,
      ) => {
        for (const supervisor of supervisors) {
          if (this.core !== core) break;
          try {
            supervisor[hook]?.(idx);
          } catch (error) {
            this.context.logger.error(
              `${hook} hook threw: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      };
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
      // A yield suspension is the thread's own, raised by `yieldGate`, and
      // must never escape: an owner would read it as an unclaimed stop.
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
  private async resolveYield(
    value: YieldValue,
    isCurrent: () => boolean,
  ): Promise<
    | { type: "settled"; result: SendResult }
    | { type: "resubmit"; messages: AgentInput[] }
  > {
    const texts: string[] = [];
    for (const supervisor of this.orderedSupervisors) {
      if (!supervisor.onYield) continue;
      const action = await supervisor.onYield(value);

      if (!isCurrent()) return { type: "settled", result: { type: "aborted" } };
      if (action.type === "accept") {
        const prefix = action.resultPrefix
          ? { resultPrefix: action.resultPrefix }
          : {};
        this.yieldState = { value, ...prefix, tornDown: true };

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
      if (action.type === "send-message") texts.push(action.text);
    }
    if (!texts.length) {
      this.yieldState = {
        value,
        tornDown: false,
      };
      return { type: "settled", result: { type: "yielded", value } };
    }
    return {
      type: "resubmit",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: texts.join("\n\n"),
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
    const isCurrent = this.currentLoopGuard();
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
    const action = this.onEndTurn({
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
  async setThreadTitle(userMessage: string): Promise<void> {
    const request = this.context.provider.forceToolUse({
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
  /** Preserve thread identity, queues, yield/result and tracked context; discard
   * conversation-local state; the structured-result display archive survives. */
  async reset(
    options: Parameters<Thread["resetCore"]>[0],
  ): Promise<ThreadCore> {
    this.interrupt();
    this.cancelSubmission();
    this.submission = undefined;
    this.restoreDetachedBatch();
    return this.replaceCore(options);
  }

  private resetPromise: Promise<ThreadCore> | undefined;
  private async replaceCore(
    options: Parameters<Thread["resetCore"]>[0],
    isCurrent: () => boolean = () => true,
  ): Promise<ThreadCore> {
    const reset = this.resetCore(options, isCurrent);
    this.resetPromise = reset;
    try {
      return await reset;
    } finally {
      if (this.resetPromise === reset) this.resetPromise = undefined;
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
    if (this.yieldState?.tornDown)
      throw new Error(
        "This thread's container has been torn down. Cannot reset.",
      );
    if (this.resetting) throw new Error("Thread reset already in progress");
    this.resetting = true;
    try {
      const initialFiles = buildClonedFiles(this.fileSupervisor.files);
      await this.core.dispose();
      this.assertUsable();
      // Disposal is irreversible: cancellation prevents the caller's follow-up,
      // but must not leave this thread pointing at a permanently disposed core.
      if (isCurrent() && archive.type === "compaction")
        this.threadLogger.recordCompaction({
          summary: archive.summary,
          chunkCount: archive.chunkCount,
        });
      const core = this.createCore({
        type: "fresh",
        initialFiles,
      });
      this._core = core;
      this.pendingSeed = isCurrent() ? [...seed] : [];
      this.lastSubmissionResult = undefined;
      this.threadLogger.resetCursor();
      this.handleUpdate();
      return core;
    } finally {
      this.resetting = false;
    }
  }

  private resetting = false;
  private assertUsable(): void {
    if (this.destroyed) throw new Error("Thread has been destroyed");
  }
  private destroyed = false;
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.interrupt();
    await this.core.dispose();
    this.settleResult({
      type: "aborted",
      reason: "thread destroyed before it yielded",
    });
  }
}
