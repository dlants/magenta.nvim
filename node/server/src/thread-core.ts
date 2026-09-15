import {
  type AgentTurn,
  type BeforeRequestDecision,
  runAgentLoop,
  type ToolExecution,
} from "./agent.ts";
import type {
  ContextTracker,
  OnToolApplied,
  OnToolAppliedHook,
} from "./capabilities/context-tracker.ts";
import type { ThreadId } from "./chat-types.ts";
import type { EdlRegisters } from "./edl/index.ts";
import type { Logger } from "./logger.ts";
import { ABORT_MARKER_TEXT } from "./providers/inference-shared.ts";
import type {
  AgentInput,
  NativeInferenceManager,
  NativeMessageIdx,
  NonEmptyRequestedTools,
  ProviderMessageContent,
  ProviderToolSpec,
} from "./providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./providers/provider-types.ts";
import type {
  SendResult,
  ToolInvocationState,
  ToolResultsHook,
} from "./thread-api.ts";
import { ToolExecutorHost } from "./tool-executor.ts";
import type { CompletedToolInfo, ToolRequestId } from "./tool-types.ts";
import type { CreateTool, ThreadToolCreator } from "./tools/create-tool.ts";
import type { AbsFilePath } from "./utils/files.ts";

export interface ThreadCoreContext {
  logger: Logger;
  threadToolCreator: ThreadToolCreator;
  completedTools: Map<ToolRequestId, CompletedToolInfo>;
  contextTracker: ContextTracker;
}

export interface ThreadCoreCallbacks {
  onUpdate: () => void;
  onBeforeRequest: () => Promise<BeforeRequestDecision>;
  onToolResults: ToolResultsHook;
  onToolApplied: OnToolAppliedHook;
}

export class ThreadCore {
  editedFilesThisTurn: { path: AbsFilePath; snapshot: string }[] = [];
  preflightTokenCount: number | undefined;
  private disposed = false;

  private constructor(
    readonly id: ThreadId,
    private readonly context: ThreadCoreContext,
    private callbacks: ThreadCoreCallbacks,
    readonly manager: NativeInferenceManager,
    readonly toolSpecs: ProviderToolSpec[],
    readonly edlRegisters: EdlRegisters,
  ) {
    this.createTool = this.context.threadToolCreator({
      contextTracker: this.context.contextTracker,
      onToolApplied: this.onToolApplied,
      edlRegisters: this.edlRegisters,
      requestRender: () => this.handleUpdate(),
    });
  }

  static create({
    id,
    context,
    callbacks,
    manager,
    toolSpecs,
    edlRegisters = { registers: new Map(), nextSavedId: 0 },
  }: {
    id: ThreadId;
    context: ThreadCoreContext;
    callbacks: ThreadCoreCallbacks;
    manager: NativeInferenceManager;
    toolSpecs: ProviderToolSpec[];
    edlRegisters?: EdlRegisters;
  }): ThreadCore {
    return new ThreadCore(
      id,
      context,
      callbacks,
      manager,
      toolSpecs,
      edlRegisters,
    );
  }

  get isActive(): boolean {
    return !this.disposed;
  }
  private handleUpdate(): void {
    if (!this.disposed) this.callbacks.onUpdate();
  }

  /** Edited-file snapshots are scoped to a submission, not an individual turn. */
  beginSubmission(): void {
    this.editedFilesThisTurn = [];
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.toolBatch.type === "running") this.toolBatch.executor.abortAll();
    await this.abortAgentTurn();
  }

  private onToolApplied: OnToolApplied = (absFilePath, tool, fileTypeInfo) => {
    if (!this.isActive) return;
    // Tools do not know about message indices: the assistant message holding
    // the tool_use is already written, and the result message is not, so the
    // fact this tool established will be revealed by the next message.
    const nativeMessageIdx = this.pendingResultMessageIdx;
    try {
      this.callbacks.onToolApplied({
        absFilePath,
        tool,
        fileTypeInfo,
        nativeMessageIdx,
      });
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

  /** The client's capabilities and thread identity are already bound by
   * `threadToolCreator`; this layer binds conversation-local state. */
  private readonly createTool: CreateTool;

  private toolBatch:
    | { type: "idle" }
    | { type: "running"; executor: ToolExecutorHost } = { type: "idle" };

  private executeTools(
    requests: NonEmptyRequestedTools,
    publishTools: (tools: ToolInvocationState) => void,
  ): ToolExecution {
    const executor = new ToolExecutorHost({
      createTool: this.createTool,
      completedTools: this.context.completedTools,
      getPendingResultMessageIdx: (requested) =>
        this.manager.getPendingResultMessageIdx(requested),
      publishTools,
      onUpdate: () => this.handleUpdate(),
    });
    this.toolBatch = { type: "running", executor };
    const execution = executor.execute(requests);
    return {
      ...execution,
      promise: execution.promise.finally(() => {
        if (
          this.toolBatch.type === "running" &&
          this.toolBatch.executor === executor
        ) {
          this.toolBatch = { type: "idle" };
        }
      }),
    };
  }
  get lastAssistantMessage():
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

  /** The idx of the last message that will hold the results of the tools
   * running right now. The running batch fixed it when it started, so there
   * is one place it is decided and no stale metadata to fall back to. */
  private get pendingResultMessageIdx(): NativeMessageIdx {
    if (this.toolBatch.type !== "running") {
      throw new Error("onToolApplied called without a running tool batch");
    }
    return this.toolBatch.executor.resultMessageIdx;
  }

  async runTurn(messages: AgentInput[]): Promise<SendResult> {
    if (!this.isActive) return { type: "aborted" };
    const turn = runAgentLoop(
      {
        logger: this.context.logger,
        manager: this.manager,
        executeTools: (requests, publishTools) =>
          this.executeTools(requests, publishTools),
        onBeforeRequest: () =>
          this.isActive
            ? this.callbacks.onBeforeRequest()
            : Promise.resolve({ type: "proceed", injections: [] }),
        onToolResults: (results, idx) =>
          this.isActive
            ? this.callbacks.onToolResults(results, idx)
            : undefined,

        onUpdate: () => this.handleUpdate(),
      },
      messages,
    );
    this.agentTurn = turn;
    this.handleUpdate();
    try {
      const result = await turn.promise;
      if (result.type === "failed") {
        this.context.logger.error(result.error);
      }
      if (result.type === "aborted") {
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
      this.handleUpdate();
    }
  }
  private agentTurn: AgentTurn | undefined;
  get activity() {
    return this.agentTurn?.loopState;
  }
  get aborting(): boolean {
    return this.agentTurn?.loopState.aborting ?? false;
  }
  async abortAgentTurn(): Promise<void> {
    const turn = this.agentTurn;
    if (!turn) return;
    turn.abort();
    await turn.promise.catch(() => {});
  }
}
