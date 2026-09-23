import type { BudgetDecision } from "./compaction/token-budget.ts";
import type { Logger } from "./logger.ts";
import {
  ABORT_TOOL_RESULT_TEXT,
  UNANSWERED_TOOL_RESULT_TEXT,
} from "./providers/inference-shared.ts";
import type {
  AgentInput,
  InferenceRequest,
  NativeInferenceManager,
  NonEmptyRequestedTools,
  RequestedTool,
  RetryStatus,
  StreamingBlock,
  ToolResults,
} from "./providers/provider-types.ts";
import type {
  CoreLoopResult,
  ToolInvocationState,
  ToolResultsHook,
} from "./thread-api.ts";
import type { SuspendReason } from "./thread-supervisor.ts";
import { assertUnreachable } from "./utils/assertUnreachable.ts";

export interface AgentContext {
  logger: Logger;
}

export type ToolOutcome =
  | { type: "continue"; results: ToolResults }
  | { type: "aborted"; results: ToolResults };

export type ToolExecution = {
  promise: Promise<ToolOutcome>;
  abort(): void;
};

export type ToolExecutor = (
  requests: NonEmptyRequestedTools,
  publishTools: (tools: ToolInvocationState) => void,
) => ToolExecution;

export type LoopState = { aborting: boolean } & (
  | { type: "preparing" }
  | {
      type: "streaming";
      inFlight: InferenceRequest;
      startedAt: Date;
      lastEventTime: Date;
      block: StreamingBlock | undefined;
      retry: RetryStatus | undefined;
    }
  | {
      type: "running_tools";
      inFlight: ToolExecution;
      requested: NonEmptyRequestedTools;
      tools: ToolInvocationState;
    }
);

export type ToolLoop = {
  readonly loopState: LoopState;
  promise: Promise<CoreLoopResult>;
  abort(): void;
};

export type ToolLoopDeps = AgentContext & {
  manager: NativeInferenceManager;
  onUpdate?: () => void;
  executeTools: ToolExecutor;
  onBeforeRequest: () => Promise<AgentInput[]>;
  /** After injections and input are in the log, before the request. */
  checkBudget: () => Promise<BudgetDecision>;
  onToolResults: ToolResultsHook;
};

/** One full assistant turn - iterating through tool invocations until the agent decides to stop.
 */
export function runToolLoop(
  deps: ToolLoopDeps,
  input: AgentInput[] = [],
): ToolLoop {
  const { logger, manager } = deps;
  let loopState: LoopState = { type: "preparing", aborting: false };
  const updateLoopState = (next: LoopState) => {
    loopState = next;
    deps.onUpdate?.();
  };

  const runLoop = async (): Promise<CoreLoopResult> => {
    let initialInputPending = true;
    while (true) {
      if (loopState.aborting) return { type: "aborted" };

      updateLoopState({ type: "preparing", aborting: loopState.aborting });
      // Injections always land, so a budget stop hands them to compaction.
      const injections = await deps.onBeforeRequest();
      if (injections.length > 0) {
        manager.appendUserMessage(injections);
      }
      if (initialInputPending) {
        manager.appendUserMessage(input);
        initialInputPending = false;
      }

      if (loopState.aborting) return { type: "aborted" };
      const budget = await deps.checkBudget();
      if (loopState.aborting) return { type: "aborted" };
      if (budget.type === "stop") {
        return { type: "completed", stopReason: "context_budget" };
      }
      if (loopState.aborting) return { type: "aborted" };

      const request = manager.sendRequest((event) => {
        if (loopState.type !== "streaming") return;
        loopState.lastEventTime = new Date();
        switch (event.type) {
          case "streaming-block":
            loopState.block = event.streamingBlock;
            break;
          case "block-finished":
            loopState.block = undefined;
            break;
          case "retry-scheduled":
            loopState.retry = event.retry;
            loopState.block = undefined;
            break;
          case "attempt-started":
            loopState.retry = undefined;
            loopState.block = undefined;
            break;
          default:
            assertUnreachable(event);
        }
        deps.onUpdate?.();
      });
      const now = new Date();
      updateLoopState({
        type: "streaming",
        aborting: loopState.aborting,
        inFlight: request,
        startedAt: now,
        lastEventTime: now,
        block: undefined,
        retry: undefined,
      });
      const outcome = await request.promise;
      loopState = { type: "preparing", aborting: loopState.aborting };

      if (loopState.aborting) return { type: "aborted" };
      if (outcome.type === "aborted") return { type: "aborted" };
      if (outcome.type === "error")
        return { type: "failed", error: outcome.error };
      if (outcome.type === "stopped") {
        return { type: "completed", stopReason: outcome.stopReason };
      }
      const requested = outcome.requested;

      let toolOutcome: ToolOutcome;
      let publishingTools = true;
      let toolState: ToolInvocationState = { type: "pending" };
      try {
        const execution = deps.executeTools(requested, (tools) => {
          toolState = tools;
          if (publishingTools && loopState.type === "running_tools") {
            loopState.tools = tools;
            deps.onUpdate?.();
          }
        });
        updateLoopState({
          type: "running_tools",
          aborting: loopState.aborting,
          inFlight: execution,
          requested,
          tools: toolState,
        });
        if (loopState.aborting) execution.abort();
        toolOutcome = await execution.promise;
      } catch (error) {
        // A rejecting executor is still a turn that must leave every tool_use
        // answered, so fall through with no results and let the fill do it.
        logger.error(
          `executeTools rejected: ${error instanceof Error ? error.message : String(error)}`,
        );
        toolOutcome = { type: "continue", results: new Map() };
      } finally {
        publishingTools = false;
        loopState = { type: "preparing", aborting: loopState.aborting };
      }

      // Fixed before the append: a batch can write more than its result
      // messages (image attachments follow them), and the callback names the
      // message the results themselves land in.
      const resultMessageIdx = manager.getPendingResultMessageIdx(requested);
      manager.appendToolResults(
        requested,
        completeToolResults(
          requested,
          toolOutcome.results,
          toolOutcome.type === "aborted"
            ? ABORT_TOOL_RESULT_TEXT
            : UNANSWERED_TOOL_RESULT_TEXT,
        ),
      );

      // Notify the owner after results are in the log, including on abort.
      let suspend: SuspendReason | undefined;
      try {
        suspend = deps.onToolResults(toolOutcome.results, resultMessageIdx);
      } catch (err) {
        logger.error(`onToolResults callback threw: ${(err as Error).message}`);
      }

      if (loopState.aborting || toolOutcome.type === "aborted") {
        loopState.aborting = true;
        deps.onUpdate?.();
        return { type: "aborted" };
      }

      if (suspend) {
        return { type: "suspended", reason: suspend };
      }

      // continue to the next iteration
    }
  };

  // Hooks and progress callbacks must see the handle installed on its owner.
  const promise = Promise.resolve()
    .then(runLoop)
    .catch((error: unknown) => ({
      type: "failed" as const,
      error: error instanceof Error ? error : new Error(String(error)),
    }));

  return {
    get loopState() {
      return loopState;
    },
    promise,
    abort: () => {
      loopState.aborting = true;
      deps.onUpdate?.();
      if (loopState.type !== "preparing") loopState.inFlight.abort();
    },
  };
}

function completeToolResults(
  requested: ReadonlyArray<RequestedTool>,
  results: ToolResults,
  missingError: string,
): ToolResults {
  if (requested.every(({ id }) => results.has(id))) return results;
  const filled = new Map(results);
  for (const { id } of requested) {
    if (!filled.has(id)) {
      filled.set(id, { status: "error", error: missingError });
    }
  }
  return filled;
}
