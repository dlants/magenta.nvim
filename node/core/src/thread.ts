import {
  Agent,
  type AgentContext,
  type AgentDeps,
  DEFERRED_QUEUES,
  type DeferredDelivery,
  type InputMessage,
  type ThreadState,
} from "./agent.ts";
import type { ThreadId } from "./chat-types.ts";
import type { EdlRegisters } from "./edl/index.ts";
import type { ProviderProfile } from "./provider-options.ts";
import type {
  AgentInput,
  AgentPhase,
  NativeMessageIdx,
  ProviderMessage,
  ProviderToolSpec,
  Runner,
} from "./providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./providers/provider-types.ts";
import {
  compactPrompt,
  type Delivery,
  type PendingMessage,
  pendingMessage,
  type ResolveSubmission,
} from "./submission/index.ts";
import type {
  AgentHooks,
  OnUpdate,
  QueuedMessage,
  SendOptions,
  SendResult,
  ThreadPhase,
  ThreadResult,
  ThreadSendResult,
} from "./thread-api.ts";
import { type ForkProvenance, ThreadLogger } from "./thread-logger.ts";
import type { ToolRequestId, ToolStructuredResult } from "./tool-types.ts";
import * as ThreadTitle from "./tools/thread-title.ts";
import { assertUnreachable } from "./utils/assertUnreachable.ts";
import { Defer } from "./utils/async.ts";

export type ThreadArchiveOptions = {
  baseDir?: string;
  scriptName?: string;
};

export type ThreadInit =
  | { type: "fresh" }
  | {
      type: "clone";
      sourceRunner: Runner;
      nativeMessageIdx: NativeMessageIdx;
      provenance: ForkProvenance;
      edlRegisters: EdlRegisters;
    };

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
  public hooks: AgentHooks = {};
  /** Kept for the lifetime of the thread, so they outlive any one agent. */
  readonly structuredToolResults = new Map<
    ToolRequestId,
    ToolStructuredResult
  >();
  private threadLogger: ThreadLogger;

  constructor(
    public id: ThreadId,
    public readonly context: AgentContext,
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
      nextRequestQueue: [],
      nextStopQueue: [],
      mode: { type: "normal" },
      edlRegisters:
        init.type === "clone"
          ? init.edlRegisters
          : { registers: new Map(), nextSavedId: 0 },
      title: undefined,
      outputTokensSinceLastReminder: 0,
      editedFilesThisTurn: [],
      pendingBashReminder: false,
      bashTokensSinceLastReminder: 0,
      firstBashReminderPending: true,
      failedSubmit: undefined,
      lastTurnResult: undefined,
      preSubmitNativeIdx: undefined,
      activeReminders: new Set(),
      toolSpecs: [],
    };

    this.agent = this.createAgent(
      init.type === "clone"
        ? {
            type: "cloned",
            cloneFrom: init.sourceRunner,
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
    context: AgentContext;
    callbacks: ThreadCallbacks;
  }): Promise<Thread> {
    const { sourceThread, newId, nativeMessageIdx, context, callbacks } = args;
    const cloned = new Thread(
      newId,
      context,
      callbacks,
      {
        type: "clone",
        sourceRunner: sourceThread.runner,
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

  get runner(): Runner {
    return this.agent.runner;
  }

  /** Derived on read rather than stored: everything in `TurnActivity` moves
   * between renders, so a mirror would be stale by construction. */
  get phase(): ThreadPhase {
    const mode = this.state.mode;
    const runnerPhase = this.runner.phase;
    switch (runnerPhase.type) {
      case "aborting":
        return { type: "aborting" };
      case "streaming":
        return {
          type: "running",
          activity: {
            type: "streaming",
            startedAt: runnerPhase.startedAt,
            lastEventTime: runnerPhase.lastEventTime,
            block: runnerPhase.block,
            retry: runnerPhase.retry,
          },
        };
      case "running_tools":
        return {
          type: "running",
          activity: {
            type: "running_tools",
            requested: runnerPhase.requested,
            truncated: runnerPhase.truncated,
          },
        };
      case "idle":
        break;
      default:
        assertUnreachable(runnerPhase);
    }
    if (mode.type === "tool_use") {
      // The runner has handed the turn off and is idle while the executor
      // runs; the requested-tool list is the runner's and is gone, so this is
      // its own variant rather than a `running_tools` with fabricated fields.
      return {
        type: "running",
        activity: {
          type: "awaiting_tools",
          activeTools: mode.activeTools,
        },
      };
    }
    return { type: "idle", lastResult: this.lastSendResult() };
  }

  private lastSendResult(): SendResult | undefined {
    const state = this.state;
    if (state.mode.type === "yielded") {
      return { type: "yielded", value: state.mode.value };
    }
    if (state.failedSubmit) {
      return {
        type: "failed",
        error: state.failedSubmit.error,
        resubmit: state.failedSubmit.userMessage,
      };
    }
    const last = state.lastTurnResult;
    if (!last) return undefined;
    switch (last.type) {
      case "stopped":
        return { type: "completed" };
      case "aborted":
        return { type: "aborted" };
      case "failed":
        return { type: "failed", error: last.error, resubmit: undefined };
      case "suspended":
        return undefined;
      default:
        assertUnreachable(last);
    }
  }

  private createAgent(runnerInit: AgentDeps["runnerInit"]): Agent {
    return new Agent(this.context, {
      threadId: this.id,
      state: this.state,
      structuredToolResults: this.structuredToolResults,
      getHooks: () => this.hooks,
      onUpdate: () => this.handleUpdate(),
      resolve: (message) => this.callbacks.resolve(message),
      runnerInit,
    });
  }

  private handleUpdate(): void {
    if (this.destroyed) return;
    this.threadLogger.record(
      this.phase.type === "idle" ? "at-rest" : "streaming",
    );
    this.callbacks.onUpdate();
  }

  update(...args: Parameters<Agent["update"]>): void {
    this.agent.update(...args);
  }

  refreshToolSpecs(): void {
    this.agent.refreshToolSpecs();
  }

  getToolSpecs(): ProviderToolSpec[] {
    return this.agent.getToolSpecs();
  }

  getProviderStatus(): AgentPhase {
    return this.agent.getProviderStatus();
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

  get pendingTurnContent(): ReadonlyArray<AgentInput> {
    return this.agent.pendingTurnContent;
  }

  prependToNextTurn(content: AgentInput[]): void {
    this.agent.prependToNextTurn(content);
  }

  discardFailedSubmit(): void {
    this.agent.discardFailedSubmit();
  }

  /** For tests: await pending best-effort archive writes. */
  async awaitArchiveFlush(): Promise<void> {
    await this.threadLogger.flushed();
  }

  setTitle(title: string): void {
    this.agent.update({ type: "set-title", title });
    this.threadLogger.recordTitle(title);
  }

  async abort(): Promise<{ unsent: ReadonlyArray<QueuedMessage> }> {
    return await this.agent.abort();
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
    if (delivery !== "now" && this.agent.isBusy) {
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
      this.update({ type: "activate-reminder", text });
    }
    return this.send(resolved.messages);
  }

  private enqueue(
    messages: PendingMessage[],
    delivery: DeferredDelivery,
  ): void {
    this.update(
      { type: DEFERRED_QUEUES[delivery].enqueue, messages },
      { silent: true },
    );
  }

  async send(
    messages: InputMessage[],
    { queue }: SendOptions = {},
  ): Promise<ThreadSendResult> {
    // The compact thread's content is composed by its caller, so it bypasses
    // context updates, reminders and the queue entirely.
    if (this.state.threadType === "compact") {
      return this.followSubmission(this.agent.send(messages));
    }

    if (this.agent.isBusy) {
      if (queue === "async" || queue === "next") {
        this.enqueue(
          messages.map((m) => pendingMessage(m.text)),
          queue,
        );
        return { type: "queued" };
      }
      await this.agent.abortAndWait();
    }

    const result = this.followSubmission(this.agent.send(messages));

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
    seed: AgentInput[];
    archive:
      | { type: "compaction"; summary: string; chunkCount: number }
      | { type: "none" };
  }): Promise<void> {
    const previousAgent = this.agent;
    this.agent = this.createAgent({ type: "new" });
    // Disposing the old agent drains its queues, but queued submissions belong
    // to the thread, so they are carried across the swap — still unresolved,
    // so their commands run on the far side of the reset.
    const carried = {
      async: [...this.state.nextRequestQueue],
      next: [...this.state.nextStopQueue],
    };
    await previousAgent.dispose();
    for (const delivery of ["async", "next"] as const) {
      if (carried[delivery].length) this.enqueue(carried[delivery], delivery);
    }

    if (archive.type === "compaction") {
      this.threadLogger.recordCompaction({
        summary: archive.summary,
        chunkCount: archive.chunkCount,
      });
    }
    this.threadLogger.resetCursor();

    this.update({ type: "reset-agent-state" });

    if (seed.length) this.agent.prependToNextTurn(seed);
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
