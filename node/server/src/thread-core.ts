import {
  type AgentTurn,
  type BeforeRequestDecision,
  runAgentLoop,
  type ToolExecution,
} from "./agent.ts";
import type { ThreadId } from "./chat-types.ts";
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
import { executeToolBatch } from "./tool-executor.ts";
import type { CompletedToolInfo, ToolRequestId } from "./tool-types.ts";
import type { CreateTool } from "./tools/create-tool.ts";

export interface ThreadCoreContext {
  logger: Logger;
  createTool: CreateTool;
  completedTools: Map<ToolRequestId, CompletedToolInfo>;
}

export interface ThreadCoreCallbacks {
  onUpdate: () => void;
  onBeforeRequest: () => Promise<BeforeRequestDecision>;
  onToolResults: ToolResultsHook;
}

export class ThreadCore {
  preflightTokenCount: number | undefined;
  private disposed = false;

  private constructor(
    readonly id: ThreadId,
    private readonly context: ThreadCoreContext,
    private callbacks: ThreadCoreCallbacks,
    readonly manager: NativeInferenceManager,
    readonly toolSpecs: ProviderToolSpec[],
  ) {}

  static create({
    id,
    context,
    callbacks,
    manager,
    toolSpecs,
  }: {
    id: ThreadId;
    context: ThreadCoreContext;
    callbacks: ThreadCoreCallbacks;
    manager: NativeInferenceManager;
    toolSpecs: ProviderToolSpec[];
  }): ThreadCore {
    return new ThreadCore(id, context, callbacks, manager, toolSpecs);
  }

  get isActive(): boolean {
    return !this.disposed;
  }
  private handleUpdate(): void {
    if (!this.disposed) this.callbacks.onUpdate();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.abortAgentTurn();
  }

  private resultMessageIdx: NativeMessageIdx | undefined;

  private executeTools(
    requests: NonEmptyRequestedTools,
    publishTools: (tools: ToolInvocationState) => void,
  ): ToolExecution {
    this.resultMessageIdx = this.manager.getPendingResultMessageIdx(requests);
    const execution = executeToolBatch(requests, {
      createTool: this.context.createTool,
      completedTools: this.context.completedTools,
      publishTools,
      onUpdate: () => this.handleUpdate(),
    });
    return {
      ...execution,
      promise: execution.promise.finally(() => {
        this.resultMessageIdx = undefined;
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
  get pendingResultMessageIdx(): NativeMessageIdx {
    if (this.resultMessageIdx === undefined) {
      throw new Error("onToolApplied called without a running tool batch");
    }
    return this.resultMessageIdx;
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
