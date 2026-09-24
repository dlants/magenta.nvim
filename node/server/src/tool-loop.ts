import type { BudgetDecision } from "./compaction/token-budget.ts";
import type { Logger } from "./logger.ts";
import {
  ABORT_TOOL_RESULT_TEXT,
  UNANSWERED_TOOL_RESULT_TEXT,
} from "./providers/inference-shared.ts";
import type {
  AgentInput,
  NativeInferenceManager,
  NonEmptyRequestedTools,
  RequestedTool,
  RetryStatus,
  StreamingBlock,
  ToolResults,
} from "./providers/provider-types.ts";
import type {
  ToolInvocationState,
  ToolLoopResult,
  ToolResultsHook,
  YieldValue,
} from "./thread-api.ts";
import * as YieldToParent from "./tools/yield-to-parent.ts";
import { assertUnreachable } from "./utils/assertUnreachable.ts";

export interface AgentContext {
  logger: Logger;
}

export type ToolOutcome =
  | { type: "continue"; results: ToolResults }
  | { type: "aborted"; results: ToolResults };

export type ToolExecutor = (
  requests: NonEmptyRequestedTools,
  publishTools: (tools: ToolInvocationState) => void,
  signal: AbortSignal,
) => Promise<ToolOutcome>;

export type LoopState =
  | { type: "preparing" }
  | {
      type: "streaming";
      startedAt: Date;
      lastEventTime: Date;
      block: StreamingBlock | undefined;
      retry: RetryStatus | undefined;
    }
  | {
      type: "running_tools";
      requested: NonEmptyRequestedTools;
      tools: ToolInvocationState;
    };

export type ToolLoop = {
  readonly loopState: LoopState;
  promise: Promise<ToolLoopResult>;
};

export type ToolLoopDeps = AgentContext & {
  manager: NativeInferenceManager;
  onUpdate?: () => void;
  executeTools: ToolExecutor;
  onBeforeRequest: (signal: AbortSignal) => Promise<AgentInput[]>;
  /** After injections and input are in the log, before the request. */
  checkBudget: (signal: AbortSignal) => Promise<BudgetDecision>;
  onToolResults: ToolResultsHook;
};

/** One full assistant turn - iterating through tool invocations until the agent decides to stop.
 */
export function runToolLoop(
  deps: ToolLoopDeps,
  input: AgentInput[],
  signal: AbortSignal,
): ToolLoop {
  const { logger, manager } = deps;
  let loopState: LoopState = { type: "preparing" };
  const onAbort = () => deps.onUpdate?.();
  signal.addEventListener("abort", onAbort, { once: true });
  const updateLoopState = (next: LoopState) => {
    loopState = next;
    deps.onUpdate?.();
  };

  const runLoop = async (): Promise<ToolLoopResult> => {
    let initialInputPending = true;
    while (true) {
      signal.throwIfAborted();
      updateLoopState({ type: "preparing" });
      // Injections always land, so a budget stop hands them to compaction.
      const injections = await deps.onBeforeRequest(signal);
      if (injections.length > 0) {
        manager.appendUserMessage(injections);
      }
      if (initialInputPending) {
        manager.appendUserMessage(input);
        initialInputPending = false;
      }

      signal.throwIfAborted();
      const budget = await deps.checkBudget(signal);
      signal.throwIfAborted();
      if (budget.type === "stop") {
        return { type: "completed", stopReason: "context_budget" };
      }

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
      }, signal);
      const now = new Date();
      updateLoopState({
        type: "streaming",
        startedAt: now,
        lastEventTime: now,
        block: undefined,
        retry: undefined,
      });
      const outcome = await request;
      loopState = { type: "preparing" };

      signal.throwIfAborted();
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
        const execution = deps.executeTools(
          requested,
          (tools) => {
            toolState = tools;
            if (publishingTools && loopState.type === "running_tools") {
              loopState.tools = tools;
              deps.onUpdate?.();
            }
          },
          signal,
        );
        updateLoopState({
          type: "running_tools",
          requested,
          tools: toolState,
        });
        toolOutcome = await execution;
      } catch (error) {
        // A rejecting executor is still a turn that must leave every tool_use
        // answered, so fall through with no results and let the fill do it.
        logger.error(
          `executeTools rejected: ${error instanceof Error ? error.message : String(error)}`,
        );
        toolOutcome = { type: "continue", results: new Map() };
      } finally {
        publishingTools = false;
        loopState = { type: "preparing" };
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
      try {
        deps.onToolResults(toolOutcome.results, resultMessageIdx);
      } catch (err) {
        logger.error(`onToolResults callback threw: ${(err as Error).message}`);
      }

      signal.throwIfAborted();
      if (toolOutcome.type === "aborted") return { type: "aborted" };

      const yielded = findYield(requested, toolOutcome.results);
      if (yielded) return { type: "yield", value: yielded };

      // continue to the next iteration
    }
  };

  // Hooks and progress callbacks must see the handle installed on its owner.
  const promise = Promise.resolve()
    .then(runLoop)
    .catch((error: unknown): ToolLoopResult => {
      if (signal.aborted) return { type: "aborted" };
      return {
        type: "failed",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    })
    .finally(() => signal.removeEventListener("abort", onAbort));

  return {
    get loopState() {
      return loopState;
    },
    promise,
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

/** The input of a `yield_to_parent` call in the batch that completed `ok`. */
function findYield(
  requested: NonEmptyRequestedTools,
  results: ToolResults,
): YieldValue | undefined {
  for (const { id, request } of requested) {
    if (request.status !== "ok") continue;
    if (request.value.toolName !== "yield_to_parent") continue;
    if (results.get(id)?.status !== "ok") continue;
    const input = YieldToParent.validateInput(request.value.input);
    if (input.status === "ok") return input.value;
  }
  return undefined;
}
