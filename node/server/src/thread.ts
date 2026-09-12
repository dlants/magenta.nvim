import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import type { AgentContext } from "./agent.ts";
import type { AgentsMap } from "./agents/agents.ts";
import type { FileIO } from "./capabilities/file-io.ts";
import type { GitClient } from "./capabilities/git-client.ts";
import type { LspClient } from "./capabilities/lsp-client.ts";
import type { LuaExecutor } from "./capabilities/lua-executor.ts";
import type { ScriptRunner } from "./capabilities/script-runner.ts";
import type { Shell } from "./capabilities/shell.ts";
import type { ThreadManager } from "./capabilities/thread-manager.ts";
import type { SubagentConfig, ThreadId, ThreadType } from "./chat-types.ts";
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
  type PendingMessage,
  parseCompact,
  type ResolveSubmission,
} from "./submission/index.ts";
import { buildClonedFiles, type Files } from "./supervisors/file-supervisor.ts";
import type {
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
import { type ThreadContextDelivery, ThreadCore } from "./thread-core.ts";

import { type ForkProvenance, ThreadLogger } from "./thread-logger.ts";
import type { RequestAction, SuspendReason } from "./thread-supervisor.ts";
import type { ToolRequestId, ToolStructuredResult } from "./tool-types.ts";
import type { MCPToolManager as MCPToolManagerImpl } from "./tools/mcp/manager.ts";
import * as ThreadTitle from "./tools/thread-title.ts";
import type { ToolCapability } from "./tools/tool-registry.ts";
import { getToolSpecs } from "./tools/toolManager.ts";
import { assertUnreachable } from "./utils/assertUnreachable.ts";
import { Defer } from "./utils/async.ts";
import type { HomeDir, NvimCwd } from "./utils/files.ts";
export type YieldState = {
  value: YieldValue;
  response: string;
  tornDown: boolean;
};
export type EnvironmentConfig =
  | { type: "local"; cwd?: NvimCwd }
  | { type: "docker"; container: string; cwd: string };

export interface ThreadContext extends AgentContext {
  profile: ProviderProfile;
  subagentConfig?: SubagentConfig;
  provider: Provider;
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
  contextDelivery?: ThreadContextDelivery;
}
export type ThreadArchiveOptions = {
  forkedFrom?: ForkProvenance;
  baseDir?: string;
  scriptName?: string;
};
type DeferredDelivery = "async" | "next";
/** The result of draining one queue: content for the next request, or a
 * compaction the flush ran into — never both. */
type FlushedQueue =
  | { type: "messages"; messages: AgentInput[] }
  | { type: "compact"; nextPrompt: string | undefined };
export type ThreadCallbacks = {
  onUpdate: OnUpdate;
  resolve: ResolveSubmission;
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
  get editedFilesThisTurn() {
    return this.core.editedFilesThisTurn;
  }
  get toolSpecs(): ProviderToolSpec[] {
    return this.core.toolSpecs;
  }
  readonly structuredToolResults = new Map<
    ToolRequestId,
    ToolStructuredResult
  >();
  getLastStopTokenCount(): number {
    return this.core.getLastStopTokenCount();
  }
  async abortAgentTurn(): Promise<void> {
    this.cancelSubmission();
    await this.core.abortAgentTurn();
  }
  public hooks: ThreadHooks = {
    onBeforeRequest: [],
    onToolResults: [],
    onYield: [],
    hasPendingContent: () => Promise.resolve(false),
  };
  private threadLogger: ThreadLogger;

  constructor(
    public id: ThreadId,
    public readonly context: ThreadContext,
    public callbacks: ThreadCallbacks,
    private archiveOptions: ThreadArchiveOptions = {},
    core?: ThreadCore,
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
    this._core = core ?? this.createCore();
  }

  private createCore(initialFiles?: Files): ThreadCore {
    const context = this.context;
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
    const manager = context.provider.createInferenceManager({
      profile: context.profile,
      systemPrompt: context.systemPrompt,
      tools: toolSpecs,
      ...(context.subagentConfig?.effort
        ? { effortOverride: context.subagentConfig.effort }
        : {}),
    });
    return ThreadCore.create({
      id: this.id,
      context,
      callbacks: {
        onUpdate: () => this.handleUpdate(),
        getHooks: () => this.hooks,
        onStructuredResult: (id, result) => {
          this.structuredToolResults.set(id, result);
        },
        flushQueue: (ctx) => this.queueFlushAction(ctx),
      },
      manager,
      toolSpecs,
      ...(initialFiles ? { initialFiles } : {}),
    });
  }

  static async clone(args: {
    sourceThread: Thread;
    newId: ThreadId;
    nativeMessageIdx: NativeMessageIdx;
    context: ThreadContext;
    callbacks: ThreadCallbacks;
  }): Promise<Thread> {
    const { sourceThread, newId, nativeMessageIdx, context, callbacks } = args;
    const core = ThreadCore.clone({
      source: sourceThread.core,
      id: newId,
      context,
      nativeMessageIdx,
      sourceBusy: sourceThread.isBusy,
      callbacks: {
        onUpdate: () => cloned.handleUpdate(),
        getHooks: () => cloned.hooks,
        onStructuredResult: (id, result) => {
          cloned.structuredToolResults.set(id, result);
        },
        flushQueue: (ctx) => cloned.queueFlushAction(ctx),
      },
    });
    const cloned = new Thread(
      newId,
      context,
      callbacks,
      {
        ...sourceThread.archiveOptions,
        forkedFrom: {
          fromThreadId: sourceThread.id,
          nativeMessageIdx,
        },
      },
      core,
    );
    for (const [id, structured] of sourceThread.structuredToolResults) {
      cloned.structuredToolResults.set(id, structuredClone(structured));
    }
    return cloned;
  }
  get activeReminders(): ReadonlySet<string> {
    return this.core.systemReminders.activeReminders;
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
      return { type: "yielded", value: this.yieldState.value };
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
  /** Seed content belongs to the conversation it will lead, not to the
   * stable thread. Reset supplies the replacement conversation's seed. */

  get pendingTurnContent(): ReadonlyArray<AgentInput> {
    return this.core.pendingSeed;
  }
  prependToNextTurn(messages: AgentInput[]): void {
    this.core.pendingSeed = [...this.core.pendingSeed, ...messages];
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
    if (this.yieldState) return { unsent: [] };
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
    this.assertUsable();
    const core = this.core;
    if (delivery !== "now" && this.isBusy) {
      this.enqueue([message], delivery);
      return { type: "queued" };
    }
    this.interrupt();
    const signal = this.interruptionSignal;
    const resolved = await this.callbacks.resolve(message);
    this.assertUsable();
    if (signal.aborted || this.core !== core || !core.isActive)
      return { type: "aborted" };
    if (resolved.compact) {
      if (this.isBusy) {
        this.cancelSubmission();
        await core.abortAgentTurn();
        if (signal.aborted || this.core !== core || !core.isActive)
          return { type: "aborted" };
        this.drainQueues();
      }
      return {
        type: "suspended",
        reason: { kind: "compact", nextPrompt: compactPrompt(resolved) },
      };
    }
    for (const text of resolved.reminders) {
      this.core.systemReminders.activateReminder(text);
    }
    return this.sendMessages(resolved.messages);
  }
  /** Flushed in full when the next provider request is issued (@async). */
  private nextRequestQueue: (PendingMessage | AgentInput)[] = [];
  /** Flushed in full the next time the thread comes to rest (@next). */
  private nextStopQueue: (PendingMessage | AgentInput)[] = [];
  get queued(): {
    async: ReadonlyArray<PendingMessage | AgentInput>;
    next: ReadonlyArray<PendingMessage | AgentInput>;
  } {
    return { async: this.nextRequestQueue, next: this.nextStopQueue };
  }
  get queuedCount(): number {
    return this.nextRequestQueue.length + this.nextStopQueue.length;
  }
  private queue(delivery: DeferredDelivery): (PendingMessage | AgentInput)[] {
    return delivery === "async" ? this.nextRequestQueue : this.nextStopQueue;
  }
  private enqueue(
    messages: (PendingMessage | AgentInput)[],
    delivery: DeferredDelivery,
  ): void {
    this.queue(delivery).push(...messages);
  }
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
    const isCurrent = this.currentLoopGuard();
    const count = this.queue(delivery).length;
    const messages: AgentInput[] = [];
    for (let i = 0; i < count; i++) {
      const entry = this.queue(delivery).shift();
      if (entry === undefined) break;
      const resolved = await this.resolveQueued(entry, isCurrent);
      if (!isCurrent()) return { type: "messages", messages: [] };
      if (!resolved) continue;
      if (resolved.compact) {
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
  }
  /** Drain the async queue into the request that is about to carry the tool
   * results. A `@compact` cannot ride such a request — there is no place to
   * hand the transcript over from — so it is detected before resolution and
   * genuinely not delivered: it and everything behind it move to the `next`
   * queue, where the following stop picks them up. */
  private async flushMidTurn(): Promise<AgentInput[]> {
    const isCurrent = this.currentLoopGuard();
    const count = this.nextRequestQueue.length;
    const messages: AgentInput[] = [];
    for (let i = 0; i < count; i++) {
      const entry = this.nextRequestQueue.shift();
      if (entry === undefined) break;
      if (typeof entry === "string" && parseCompact(entry).compact) {
        this.nextStopQueue.unshift(
          entry,
          ...this.nextRequestQueue.splice(0, count - i - 1),
        );
        return messages;
      }
      const resolved = await this.resolveQueued(entry, isCurrent);
      if (!isCurrent()) return [];
      if (resolved) messages.push(...resolved.messages);
    }
    return messages;
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
    entry: PendingMessage | AgentInput,
    isCurrent: () => boolean,
  ) {
    if (typeof entry !== "string")
      return { compact: false, messages: [entry], reminders: [] };
    try {
      const resolved = await this.callbacks.resolve(entry);
      if (!isCurrent()) return undefined;
      for (const text of resolved.reminders) {
        this.core.systemReminders.activateReminder(text);
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
    if (ctx.status === "suspended" || !this.nextRequestQueue.length)
      return { type: "none" };
    return {
      type: "inject",
      content: await this.flushMidTurn(),
    };
  }
  async send(
    messages: AgentInput[],
    options: SendOptions = {},
  ): Promise<ThreadSendResult> {
    this.assertUsable();
    if (!this.isBusy || !options.queue) this.interrupt();
    return this.sendMessages(messages, options);
  }
  private async sendMessages(
    messages: AgentInput[],
    { queue, force }: SendOptions = {},
  ): Promise<ThreadSendResult> {
    this.assertUsable();
    if (this.resetting) throw new Error("Thread reset in progress");
    if (this.yieldState?.tornDown) {
      throw new Error(
        "This thread's container has been torn down. No further messages can be sent.",
      );
    }
    const signal = this.interruptionSignal;
    if (this.isBusy) {
      if (queue === "async" || queue === "next") {
        this.enqueue(messages, queue);
        return { type: "queued" };
      }
      this.cancelSubmission();
      const core = this.core;
      await core.abortAgentTurn();
      this.assertUsable();
      if (signal.aborted || this.core !== core || this.resetting)
        return { type: "aborted" };
      // Sending now supersedes whatever was waiting on the aborted turn.
      this.drainQueues();
    }
    // The compact thread's content is composed by its caller, so it bypasses
    // context updates, reminders and the queue entirely.
    if (this.threadType === "compact") {
      return this.followSubmission(this.runToRest(messages));
    }
    const result = this.followSubmission(this.runToRest(messages, force));
    if (this.title === undefined && messages.length) {
      this.setThreadTitle(
        messages
          .filter((m) => m.type === "text")
          .map((m) => m.text)
          .join("\n"),
      ).catch((err: Error) =>
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
    const core = this.core;
    const hooks = this.hooks;
    const isCurrent = this.currentLoopGuard();
    const pending = await core.hasPendingContext();
    if (!isCurrent()) return false;
    return pending || (await hooks.hasPendingContent());
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
  private runToRest(
    submitted: AgentInput[],
    force?: true,
  ): Promise<SendResult> {
    this.cancelSubmission();
    const submission = new AbortController();
    this.submission = submission;
    const core = this.core;
    const messages = core.beginSubmission(submitted);
    const isCurrent = this.currentLoopGuard();
    this.handleUpdate();
    const finish = (result: SendResult) => {
      if (this.submission === submission && this.core === core) {
        this.submission = undefined;
        this.lastSubmissionResult = result;
        this.handleUpdate();
      }
      return result;
    };
    return this.runLoop(messages, isCurrent, force).then(
      finish,
      (error: unknown) => {
        finish({
          type: "failed",
          error: error instanceof Error ? error : new Error(String(error)),
        });
        throw error;
      },
    );
  }
  private async runLoop(
    messages: AgentInput[],
    isCurrentLoop: () => boolean,
    force?: true,
  ): Promise<SendResult> {
    const core = this.core;
    if (!messages.length && !force) {
      const pending = await this.hasPendingContent();
      // Probing takes time, and a send that arrived while it ran owns the
      // loop now: this one is over before it touched the agent.
      if (!isCurrentLoop()) return { type: "aborted" };
      if (!pending) return { type: "empty" };
    }
    let result = await core.runTurn(messages);
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
        result = await core.runTurn(resolved.messages);
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
          const continued = await core.runTurn(next.messages);
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
    const rendered = renderYieldValue(value);
    const texts: string[] = [];
    for (const hook of this.hooks.onYield) {
      const action = await hook(value);
      if (!isCurrent()) return { type: "settled", result: { type: "aborted" } };
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
        response: rendered,
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
      (this.nextRequestQueue.length || this.nextStopQueue.length)
    ) {
      return { type: "queues" };
    }
    const action = this.hooks.onEndTurn?.({
      stopReason,
      inputTokenCount: this.core.preflightTokenCount,
      lastAssistantMessage: this.core.lastAssistantMessage,
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
  async reset({
    seed,
    archive,
  }: {
    seed: AgentInput[];
    archive:
      | { type: "compaction"; summary: string; chunkCount: number }
      | { type: "none" };
  }): Promise<ThreadCore> {
    this.assertUsable();
    if (this.yieldState?.tornDown)
      throw new Error(
        "This thread's container has been torn down. Cannot reset.",
      );
    if (this.resetting) throw new Error("Thread reset already in progress");
    this.resetting = true;
    this.interrupt();
    this.cancelSubmission();
    try {
      const initialFiles = buildClonedFiles(this.core.fileSupervisor.files);
      await this.core.dispose();
      this.assertUsable();
      // Disposal is irreversible: cancellation prevents the caller's follow-up,
      // but must not leave this thread pointing at a permanently disposed core.
      if (archive.type === "compaction")
        this.threadLogger.recordCompaction({
          summary: archive.summary,
          chunkCount: archive.chunkCount,
        });
      const core = this.createCore(initialFiles);
      this._core = core;
      this.submission = undefined;
      this.lastSubmissionResult = undefined;
      core.pendingSeed = [...seed];
      this.threadLogger.resetCursor();
      this.hooks.onReset?.();
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
