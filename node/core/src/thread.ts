import {
  AGENT_EVENT_NAMES,
  Agent,
  type AgentContext,
  type AgentDeps,
  type AgentEvents,
  type InputMessage,
  type ThreadState,
} from "./agent.ts";
import type { ThreadId } from "./chat-types.ts";
import type {
  CompactionResult,
  CompactionStep,
} from "./compaction-controller.ts";
import { CompactionManager } from "./compaction-manager.ts";
import { buildClonedFiles, ContextManager } from "./context/context-manager.ts";
import { GitTracker } from "./context/git-tracker.ts";
import type { EdlRegisters } from "./edl/index.ts";
import { Emitter } from "./emitter.ts";
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
import type { SendResult, ThreadPhase } from "./thread-api.ts";
import { type ForkProvenance, ThreadLogger } from "./thread-logger.ts";
import type { ThreadSupervisor } from "./thread-supervisor.ts";
import type { ToolRequestId, ToolStructuredResult } from "./tool-types.ts";
import * as Scratchpad from "./tools/scratchpad.ts";
import * as ThreadTitle from "./tools/thread-title.ts";
import { assertUnreachable } from "./utils/assertUnreachable.ts";

const CONTEXT_MANAGER_POLL_INTERVAL_MS = 1000;

/** How a `Thread` comes into being: either brand new, or forked from another
 * thread's history — in which case the cloned runner, its provenance and the
 * inherited scratchpad/registers all arrive together. */
export type ThreadInit =
  | { type: "fresh" }
  | {
      type: "clone";
      sourceRunner: Runner;
      nativeMessageIdx: NativeMessageIdx;
      provenance: ForkProvenance;
      scratchpad: Scratchpad.Scratchpad;
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
export class Thread extends Emitter<AgentEvents> {
  public state: ThreadState;
  public agent: Agent;
  public contextManager: ContextManager;
  public gitTracker: GitTracker;
  public compactionController: CompactionManager | undefined;
  public supervisors: ThreadSupervisor[] = [];
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
    init: ThreadInit = { type: "fresh" },
  ) {
    super();
    const forkProvenance = init.type === "clone" ? init.provenance : undefined;
    this.threadLogger = new ThreadLogger(
      id,
      context.threadType,
      () => this.getProviderMessages(),
      () => this.getProviderMessages().length,
      context.logger,
      {
        ...(context.conversationLogBaseDir !== undefined
          ? { baseDir: context.conversationLogBaseDir }
          : {}),
        ...(context.scriptName !== undefined
          ? { scriptName: context.scriptName }
          : {}),
        cwd: context.cwd,
        ...(forkProvenance ? { forkedFrom: forkProvenance } : {}),
      },
    );
    this.contextManager = new ContextManager(
      context.logger,
      context.fileIO,
      context.cwd,
      context.homeDir,
      context.initialFiles,
      CONTEXT_MANAGER_POLL_INTERVAL_MS,
    );
    this.contextManager.start();
    this.gitTracker = new GitTracker(
      context.gitClient,
      context.initialGitState,
      context.logger,
    );
    this.state = {
      threadType: context.threadType,
      systemPrompt: context.systemPrompt,
      systemInfo: context.systemInfo,
      pendingMessages: [],
      pendingNextMessages: [],
      mode: { type: "normal" },
      edlRegisters:
        init.type === "clone"
          ? init.edlRegisters
          : { registers: new Map(), nextSavedId: 0 },
      scratchpad:
        init.type === "clone" ? init.scratchpad : Scratchpad.emptyScratchpad(),
      title: undefined,
      outputTokensSinceLastReminder: 0,
      compactionHistory: [],
      editedFilesThisTurn: [],
      pendingBashReminder: false,
      bashTokensSinceLastReminder: 0,
      firstBashReminderPending: true,
      failedSubmit: undefined,
      lastTurnResult: undefined,
      lastYieldValue: undefined,
      preSubmitNativeIdx: undefined,
      activeReminders: new Set(),
      toolSpecs: [],
    };

    this.listenToContextManager();
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
  }): Promise<Thread> {
    const { sourceThread, newId, nativeMessageIdx, context } = args;
    const initialFiles = await buildClonedFiles(
      sourceThread.contextManager.files,
      context.fileIO,
    );
    const contextWithFiles: AgentContext = {
      ...context,
      initialFiles,
      initialGitState: sourceThread.gitTracker.getAgentView(),
    };
    const cloned = new Thread(newId, contextWithFiles, {
      type: "clone",
      sourceRunner: sourceThread.runner,
      nativeMessageIdx,
      provenance: {
        fromThreadId: sourceThread.id,
        nativeMessageIdx,
      },
      scratchpad: Scratchpad.cloneScratchpad(sourceThread.state.scratchpad),
      edlRegisters: {
        registers: new Map(sourceThread.state.edlRegisters.registers),
        nextSavedId: sourceThread.state.edlRegisters.nextSavedId,
      },
    });
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
      return {
        type: "yielded",
        value: state.lastYieldValue ?? {
          type: "text",
          text: state.mode.response,
        },
      };
    }
    if (state.failedSubmit) {
      return {
        type: "failed",
        error: new Error(state.failedSubmit.errorMessage),
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

  private agentListeners: Array<() => void> = [];

  private createAgent(runnerInit: AgentDeps["runnerInit"]): Agent {
    const agent = new Agent(this.context, {
      threadId: this.id,
      state: this.state,
      contextManager: this.contextManager,
      gitTracker: this.gitTracker,
      structuredToolResults: this.structuredToolResults,
      getSupervisors: () => this.supervisors,
      requestCompaction: (nextPrompt) => this.startCompaction(nextPrompt),
      runnerInit,
    });
    this.attachAgent(agent);
    return agent;
  }

  /** Pipe every agent event out through the thread, and drive the archive off
   * the two it cares about. */
  private attachAgent(agent: Agent): void {
    this.detachAgent();
    const unsubscribes: Array<() => void> = [];
    for (const name of AGENT_EVENT_NAMES) {
      const listener = (...args: AgentEvents[typeof name]) =>
        this.emit(name, ...args);
      agent.on(name, listener);
      unsubscribes.push(() => agent.off(name, listener));
    }
    const onUpdate = () => this.threadLogger.onUpdate();
    const onTurnEnded = () => this.threadLogger.onTurnEnded();
    agent.on("update", onUpdate);
    agent.on("turnEnded", onTurnEnded);
    unsubscribes.push(() => agent.off("update", onUpdate));
    unsubscribes.push(() => agent.off("turnEnded", onTurnEnded));
    this.agentListeners = unsubscribes;
  }

  private detachAgent(): void {
    for (const unsubscribe of this.agentListeners) unsubscribe();
    this.agentListeners = [];
  }

  private contextManagerListeners: Array<() => void> = [];

  private listenToContextManager(): void {
    const onFilesChanged = () => this.emit("update");
    const onPendingUpdatesChanged = () => this.emit("pendingUpdatesChanged");
    this.contextManager.on("fileAdded", onFilesChanged);
    this.contextManager.on("fileRemoved", onFilesChanged);
    this.contextManager.on("pendingUpdatesChanged", onPendingUpdatesChanged);
    this.contextManagerListeners = [
      () => this.contextManager.off("fileAdded", onFilesChanged),
      () => this.contextManager.off("fileRemoved", onFilesChanged),
      () =>
        this.contextManager.off(
          "pendingUpdatesChanged",
          onPendingUpdatesChanged,
        ),
    ];
  }

  private unlistenContextManager(): void {
    for (const unsubscribe of this.contextManagerListeners) unsubscribe();
    this.contextManagerListeners = [];
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

  async sendMessage(inputMessages?: InputMessage[]): Promise<void> {
    await this.agent.sendMessage(inputMessages);
  }

  async abort(): Promise<void> {
    await this.agent.abort();
  }

  async handleSendMessageRequest(
    messages: InputMessage[],
    queue?: "async" | "next",
  ): Promise<void> {
    if (this.state.threadType === "compact") {
      this.agent.sendRawMessage(messages);
      return;
    }

    if (this.agent.isBusy) {
      if (queue === "async") {
        this.update(
          { type: "push-pending-messages", messages },
          { silent: true },
        );
        return;
      } else if (queue === "next") {
        this.update(
          { type: "push-pending-next-messages", messages },
          { silent: true },
        );
        return;
      } else {
        await this.agent.abortAndWait();
      }
    }

    await this.sendMessage(messages);

    if (!this.state.title) {
      this.setThreadTitle(messages.map((m) => m.text).join("\n")).catch(
        (err: Error) =>
          this.context.logger.error(
            `Error getting thread title: ${err.message}\n${err.stack}`,
          ),
      );
    }

    if (messages.length) {
      setTimeout(() => this.emit("scrollToLastMessage"), 100);
    }
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

  startCompaction(nextPrompt?: string): void {
    const manager = new CompactionManager({
      logger: this.context.logger,
      profile: this.context.profile,
      mcpToolManager: this.context.mcpToolManager,
      threadId: this.id,
      cwd: this.context.cwd,
      homeDir: this.context.homeDir,
      lspClient: this.context.lspClient,
      availableCapabilities: this.context.availableCapabilities,
      contextManager: this.contextManager,
      shell: this.context.shell,
      threadManager: this.context.threadManager,
      maxConcurrentSubagents: this.context.maxConcurrentSubagents,
      maxConcurrentFastSubagents: this.context.maxConcurrentFastSubagents,
      getProvider: this.context.getProvider,
      requestRender: () => this.emit("update"),
      initialScratchpad: Scratchpad.cloneScratchpad(this.state.scratchpad),
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
  }

  private handleCompactionResult(result: CompactionResult): void {
    this.compactionController = undefined;
    this.update({ type: "set-mode", mode: { type: "normal" } });

    if (result.type === "complete") {
      this.handleCompactComplete(
        result.summary,
        result.nextPrompt,
        result.steps,
        result.scratchpad,
      ).catch((e: Error) => {
        this.context.logger.error(
          `Failed during compact-complete: ${e.message}`,
        );
      });
    } else {
      this.update({
        type: "push-compaction-record",
        record: { steps: result.steps, finalSummary: undefined },
      });
    }
  }

  private async handleCompactComplete(
    summary: string,
    nextPrompt: string | undefined,
    steps: CompactionStep[],
    scratchpad: Scratchpad.Scratchpad,
  ): Promise<void> {
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
    this.state.scratchpad = scratchpad;

    const summaryText = `<conversation-summary>\n${summary}\n</conversation-summary>`;
    this.agent.prependToNextTurn([
      {
        type: "text",
        text: summaryText,
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);

    if (nextPrompt) {
      await this.sendMessage([{ type: "user", text: nextPrompt }]);
    } else {
      await this.sendMessage([
        { type: "user", text: "Please continue from where you left off." },
      ]);
    }
  }

  private destroyed = false;

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    this.detachAgent();
    await this.agent.dispose();

    this.unlistenContextManager();
    this.contextManager.destroy();

    this.removeAllListeners();
  }
}
