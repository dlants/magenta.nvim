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
import type { Task } from "./utils/async.ts";

export type ToolOutcome =
  | { type: "continue"; results: ToolResults }
  | { type: "aborted"; results: ToolResults };

export type ToolExecutor = (
  requests: NonEmptyRequestedTools,
  publishTools: (tools: ToolInvocationState) => void,
) => Task<ToolOutcome>;

export type ToolLoopActivity =
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

export type ToolLoop = Task<ToolLoopResult> & {
  readonly activity: ToolLoopActivity;
  readonly aborting: boolean;
};

export type ToolLoopDeps = {
  logger: Logger;
  manager: NativeInferenceManager;
  onUpdate?: () => void;
  executeTools: ToolExecutor;
  onBeforeRequest: () => Promise<AgentInput[]>;
  /** After injections and input are in the log, before the request. */
  checkBudget: () => Task<BudgetDecision | { type: "aborted" }>;
  onToolResults: ToolResultsHook;
};

/** One tool loop - iterating through tool invocations until the agent decides to stop.
 */
export function runToolLoop(deps: ToolLoopDeps, input: AgentInput[]): ToolLoop {
  const { logger, manager } = deps;
  let activity: ToolLoopActivity = { type: "preparing" };
  let aborted = false;
  let settled = false;
  // Installed synchronously when a child starts, cleared once it settles.
  let current: Task<unknown> | undefined;
  const run = async <T>(child: Task<T>): Promise<T> => {
    current = child;
    try {
      return await child.promise;
    } finally {
      current = undefined;
    }
  };
  const updateLoopState = (next: ToolLoopActivity) => {
    activity = next;
    deps.onUpdate?.();
  };

  const runLoop = async (): Promise<ToolLoopResult> => {
    let initialInputPending = true;
    // The loop learns of an abort from its children's results. It checks its
    // own flag only in the gaps, before starting the next child.
    while (true) {
      if (aborted) return { type: "aborted" };
      updateLoopState({ type: "preparing" });
      // Injections always land, so a budget stop hands them to compaction.
      const injections = await deps.onBeforeRequest();
      if (injections.length > 0) {
        manager.appendUserMessage(injections);
      }
      if (initialInputPending) {
        manager.appendUserMessage(input);
        initialInputPending = false;
      }

      if (aborted) return { type: "aborted" };
      const budget = await run(deps.checkBudget());
      if (budget.type === "aborted" || aborted) return { type: "aborted" };
      if (budget.type === "stop") {
        return { type: "completed", stopReason: "context_budget" };
      }

      const request = run(
        manager.sendRequest((event) => {
          if (activity.type !== "streaming") return;
          activity.lastEventTime = new Date();
          switch (event.type) {
            case "streaming-block":
              activity.block = event.streamingBlock;
              break;
            case "block-finished":
              activity.block = undefined;
              break;
            case "retry-scheduled":
              activity.retry = event.retry;
              activity.block = undefined;
              break;
            case "attempt-started":
              activity.retry = undefined;
              activity.block = undefined;
              break;
            default:
              assertUnreachable(event);
          }
          deps.onUpdate?.();
        }),
      );
      const now = new Date();
      updateLoopState({
        type: "streaming",
        startedAt: now,
        lastEventTime: now,
        block: undefined,
        retry: undefined,
      });
      const outcome = await request;
      activity = { type: "preparing" };

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
        const execution = run(
          deps.executeTools(requested, (tools) => {
            toolState = tools;
            if (publishingTools && activity.type === "running_tools") {
              activity.tools = tools;
              deps.onUpdate?.();
            }
          }),
        );
        updateLoopState({
          type: "running_tools",
          requested,
          tools: toolState,
        });
        toolOutcome = await execution;
      } catch (error) {
        // A rejecting executor is still a tool loop that must leave every tool_use
        // answered, so fall through with no results and let the fill do it.
        logger.error(
          `executeTools rejected: ${error instanceof Error ? error.message : String(error)}`,
        );
        toolOutcome = { type: "continue", results: new Map() };
      } finally {
        publishingTools = false;
        activity = { type: "preparing" };
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
      return {
        type: "failed",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    })
    .finally(() => {
      settled = true;
    });

  return {
    get activity() {
      return activity;
    },
    get aborting() {
      return aborted;
    },
    promise,
    abort() {
      if (aborted || settled) return;
      aborted = true;
      current?.abort();
      deps.onUpdate?.();
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
