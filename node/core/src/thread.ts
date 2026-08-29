import {
  Agent,
  type AgentContext,
  type AgentDeps,
  type AgentSendOutcome,
  type InputMessage,
  type ThreadState,
} from "./agent.ts";
import type { ThreadId } from "./chat-types.ts";
import type {
  CompactionResult,
  CompactionStep,
} from "./compaction-controller.ts";
import { CompactionManager } from "./compaction-manager.ts";
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
  type Delivery,
  type PendingMessage,
  pendingMessage,
  type ResolveParts,
  resolvePartsAsText,
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

/** How a `Thread` comes into being: either brand new, or forked from another
 * thread's history — in which case the cloned runner, its provenance and the
 * inherited registers all arrive together. */
/** Archive placement for a thread's conversation log. */
export type ThreadArchiveOptions = {
  /** Base dir for the conversation archive. Defaults to MAGENTA_TEMP_DIR. */
  baseDir?: string;
  /** Name of the magenta script that spawned this thread, if any. */
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

/**
 * The durable half of a conversation: a stable `ThreadId`, the queue of
 * messages waiting for the current turn to finish, compaction, the archive
 * logger and the context/git managers.
 *
 * It holds one `Agent` — the ephemeral half, which owns a single message list
 * — and swaps it for a fresh one when a compaction completes. Thread 3 is
 * still thread 3 after a compaction, which is why the archive keys by thread
 * id and why the context manager survives the swap.
 */
/** The collaborators the owner supplies. `onUpdate` is the one channel a
 * thread has for saying "something visible moved". */
export type ThreadCallbacks = {
  onUpdate: OnUpdate;
  /** Turns a submission's parts into content, at delivery. Defaults to a
   * plain-text passthrough for threads whose content is composed
   * programmatically (subagents, scripts, compaction). */
  resolve?: ResolveParts;
};

export class Thread {
  public state: ThreadState;
  public agent: Agent;
  public compactionController: CompactionManager | undefined;
  /** The owner's answers to the agent's three questions. Composed from a
   * supervisor list by `composeSupervisors` at the call site that knows the
   * policy; the agent never sees a list. */
  public hooks: AgentHooks = {};
  /** Structured tool results by request id, kept for the lifetime of the
   * thread — so they outlive any one agent. */
  readonly structuredToolResults = new Map<
    ToolRequestId,
    ToolStructuredResult
  >();
  private threadLogger: ThreadLogger;

  constructor(
    public id: ThreadId,
    private context: AgentContext,
    /** Mutable only for the fork path, which must build a `Thread` before the
     * wrapper that owns it exists. Every other caller supplies it once. */
    public callbacks: ThreadCallbacks,
    init: ThreadInit = { type: "fresh" },
    /** Where this thread's conversation archive goes. Archive plumbing, not
     * agent configuration, so it is not part of the context bag. */
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
      compactionHistory: [],
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

  /** Build an independent copy of `sourceThread` that resumes the conversation
   * frozen at `nativeMessageIdx`. The cloned runner is created exactly once
   * here and ownership is transferred to the new Thread. The source is not
   * aborted and shares no mutable state with the result. */
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

  /** The runner driving the current agent. */
  get runner(): Runner {
    return this.agent.runner;
  }

  /** Where this thread is right now, in the vocabulary the views and the
   * archive will move to. Derived on read rather than stored: everything in
   * `TurnActivity` moves between renders, so a mirror would be stale by
   * construction. Until stage 4 rewrites the internals this reads the mode
   * bag; the shape it presents is the final one. */
  get phase(): ThreadPhase {
    const mode = this.state.mode;
    if (mode.type === "compacting") {
      return {
        type: "compacting",
        chunkIndex: mode.chunkIndex,
        totalChunks: mode.totalChunks,
      };
    }
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
      resolve: this.callbacks.resolve ?? resolvePartsAsText,
      runnerInit,
    });
  }

  /** The single "something moved" path: drive the archive's cursor-differ,
   * then tell the owner. There is no throttle here — coalescing is the
   * recipient's job, and it must be trailing-edge so the final call at rest
   * is not dropped. */
  private handleUpdate(): void {
    // A destroyed thread has no owner left to tell; disposing the agent can
    // still produce one last abort-driven update.
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

  /** Abort the turn in flight and hand back the queued messages that will now
   * never be sent. The debris goes to whoever aborted; nothing is broadcast. */
  async abort(): Promise<{ unsent: ReadonlyArray<QueuedMessage> }> {
    return await this.agent.abort();
  }

  /** Resolves when the thread yields, or when it is destroyed without ever
   * having yielded. Settles at most once. For actors who never submitted —
   * the subagent tool, the script runner — where `send`'s promise is private
   * to its submitter. */
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

  /** The compaction handoff currently in flight, if any. It is the only piece
   * of submission state the thread has to track: the caller's promise has to
   * stay pending across the swap, so the agent's outcome cannot settle it. */
  private compactionDone: Defer<SendResult> | undefined;

  /** Submit `messages` and resolve once the thread comes to rest.
   *
   * Internal continuations — auto-respond, supervisor nudges, the max_tokens
   * continue-prompt, a compaction handoff — do not resolve it; the promise
   * spans the whole thing, including the turn that runs after a compaction.
   */
  /** The entry point for user text: an unresolved submission plus when it
   * should be delivered. Its parts are resolved here if it goes out now, or
   * at flush time if it is queued — never at parse time. */
  async submit(
    message: PendingMessage,
    delivery: Delivery = "now",
  ): Promise<ThreadSendResult> {
    if (delivery !== "now" && this.agent.isBusy) {
      this.enqueue([message], delivery);
      return { type: "queued" };
    }
    const { messages, reminders } = await this.resolve(message.parts);
    for (const text of reminders) {
      this.update({ type: "activate-reminder", text });
    }
    return this.send(messages);
  }

  private get resolve(): ResolveParts {
    return this.callbacks.resolve ?? resolvePartsAsText;
  }

  private enqueue(
    messages: PendingMessage[],
    delivery: "async" | "next",
  ): void {
    this.update(
      {
        type:
          delivery === "async" ? "enqueue-next-request" : "enqueue-next-stop",
        messages,
      },
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
      return this.followSubmission(this.agent.send(messages, { raw: true }));
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

  /** Follow one submission across any compaction handoffs it triggers: the
   * agent stops, the thread swaps in a replacement, and the submission
   * continues on it. */
  private followSubmission(
    outcome: Promise<AgentSendOutcome>,
  ): Promise<SendResult> {
    const result: Promise<SendResult> = outcome.then((o) =>
      o.type === "compact" ? this.compact(o.nextPrompt) : o,
    );
    return result.then((r) => {
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

  /** Hand the conversation off to a summarizing pass and continue it on a
   * replacement agent. Resolves when that continuation comes to rest. */
  compact(nextPrompt?: string): Promise<SendResult> {
    const done = new Defer<SendResult>();
    this.compactionDone = done;
    const manager = new CompactionManager({
      logger: this.context.logger,
      profile: this.context.profile,
      mcpToolManager: this.context.mcpToolManager,
      threadId: this.id,
      cwd: this.context.cwd,
      homeDir: this.context.homeDir,
      lspClient: this.context.lspClient,
      availableCapabilities: this.context.availableCapabilities,
      contextTracker: this.context.contextTracker,
      onToolApplied: (absFilePath, tool, fileTypeInfo) =>
        this.hooks.onToolApplied?.(absFilePath, tool, fileTypeInfo),
      shell: this.context.shell,
      threadManager: this.context.threadManager,
      maxConcurrentSubagents: this.context.maxConcurrentSubagents,
      maxConcurrentFastSubagents: this.context.maxConcurrentFastSubagents,
      getProvider: this.context.getProvider,
      requestRender: () => this.callbacks.onUpdate(),
    });
    manager.on("transition", (_prev, next) => {
      if (next.type === "complete") {
        this.handleCompactionResult(next.result);
      } else if (next.type === "error") {
        this.handleCompactionResult({ type: "error", steps: next.steps });
      } else if (
        next.type === "processing-chunk" ||
        next.type === "waiting-for-tools"
      ) {
        this.update({
          type: "set-mode",
          mode: {
            type: "compacting",
            chunkIndex: next.chunkIndex,
            totalChunks: next.totalChunks,
          },
        });
      }
    });
    this.compactionController = manager;
    manager.start(this.getProviderMessages(), nextPrompt);
    return done.promise;
  }

  private settleCompaction(result: SendResult): void {
    const done = this.compactionDone;
    this.compactionDone = undefined;
    done?.resolve(result);
  }

  private handleCompactionResult(result: CompactionResult): void {
    this.compactionController = undefined;
    this.update({ type: "set-mode", mode: { type: "normal" } });

    if (result.type === "complete") {
      this.handleCompactComplete(
        result.summary,
        result.nextPrompt,
        result.steps,
      ).then(
        (sendResult) => this.settleCompaction(sendResult),
        (e: Error) => {
          this.context.logger.error(
            `Failed during compact-complete: ${e.message}`,
          );
          this.settleCompaction({
            type: "failed",
            error: e,
            resubmit: undefined,
          });
        },
      );
    } else {
      this.update({
        type: "push-compaction-record",
        record: { steps: result.steps, finalSummary: undefined },
      });
      this.settleCompaction({
        type: "failed",
        error: new Error("Compaction failed"),
        resubmit: undefined,
      });
    }
  }

  private async handleCompactComplete(
    summary: string,
    nextPrompt: string | undefined,
    steps: CompactionStep[],
  ): Promise<SendResult> {
    this.update({
      type: "push-compaction-record",
      record: { steps, finalSummary: summary },
    });

    // The context manager is a thread-level collaborator: which files the user
    // is watching has nothing to do with which agent is running, so it
    // deliberately survives the swap.
    const previousAgent = this.agent;
    this.agent = this.createAgent({ type: "new" });
    await previousAgent.dispose();

    this.threadLogger.recordCompaction({ summary, chunkCount: steps.length });
    // The replacement agent starts from an empty, summarized message list, so
    // the archive's cursor restarts with it.
    this.threadLogger.resetCursor();

    this.update({ type: "reset-after-compaction" });

    const summaryText = `<conversation-summary>\n${summary}\n</conversation-summary>`;
    this.agent.prependToNextTurn([
      {
        type: "text",
        text: summaryText,
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);

    return this.followSubmission(
      this.agent.send([
        {
          type: "user",
          text: nextPrompt ?? "Please continue from where you left off.",
        },
      ]),
    );
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
