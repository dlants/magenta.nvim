import type { Logger } from "./logger.ts";
import {
  ABORT_TOOL_RESULT_TEXT,
  UNANSWERED_TOOL_RESULT_TEXT,
} from "./providers/inference-shared.ts";
import type {
  AgentInput,
  NativeInferenceManager,
  RequestedTool,
  StreamEvent,
  ToolResults,
} from "./providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./providers/provider-types.ts";
import type { AgentHooks, SendResult } from "./thread-api.ts";
import type { SuspendReason } from "./thread-supervisor.ts";
import { assertUnreachable } from "./utils/assertUnreachable.ts";

export interface AgentContext {
  logger: Logger;
}

export type ToolOutcome =
  | { type: "continue"; results: ToolResults }
  | { type: "suspend"; results: ToolResults; reason: SuspendReason }
  | { type: "aborted"; results: ToolResults };

export type ToolExecution = {
  promise: Promise<ToolOutcome>;
  abort(): void;
};

export type ToolExecutor = (
  requests: ReadonlyArray<RequestedTool>,
) => ToolExecution;

export type AgentTurn = {
  promise: Promise<SendResult>;
  abort(): void;
};

export type AgentLoopDeps = AgentContext & {
  manager: NativeInferenceManager;
  onStreamEvent: (event: StreamEvent) => void;
  executeTools: ToolExecutor;
  getHooks: () => AgentHooks;
};

/** One full assistant turn - iterating through tool invocations until the agent decides to stop.
 */
export function runAgentLoop(
  deps: AgentLoopDeps,
  input: AgentInput[] = [],
): AgentTurn {
  const { logger, manager } = deps;
  let aborted = false;
  // when we send off an inference request or a tool execution, save the abort handle.
  let inFlight: { abort(): void } | undefined;

  const runLoop = async (): Promise<SendResult> => {
    let initialInputPending = true;
    while (true) {
      if (aborted) return { type: "aborted" };

      const decision = await runBeforeRequestHooks(deps);
      // Injected content and the caller's own input go into the log even when
      // the loop is suspended, so both are there for the resume.
      if (decision.injections.length > 0) {
        manager.appendUserMessage(decision.injections);
      }
      if (initialInputPending) {
        manager.appendUserMessage(input);
        initialInputPending = false;
      }

      if (decision.type === "suspend") {
        return { type: "suspended", reason: decision.reason };
      }
      if (aborted) return { type: "aborted" };

      const request = manager.sendRequest((event) => deps.onStreamEvent(event));
      inFlight = request;
      const outcome = await request.promise;
      inFlight = undefined;

      if (aborted) return { type: "aborted" };
      if (outcome.type === "aborted") return { type: "aborted" };
      if (outcome.type === "error")
        return { type: "failed", error: outcome.error };
      if (outcome.type === "stopped") {
        return { type: "completed", stopReason: outcome.stopReason };
      }
      const requested = outcome.requested;

      let toolOutcome: ToolOutcome;
      try {
        const execution = deps.executeTools(requested);
        inFlight = execution;
        toolOutcome = await execution.promise;
      } catch (error) {
        // A rejecting executor is still a turn that must leave every tool_use
        // answered, so fall through with no results and let the fill do it.
        logger.error(
          `executeTools rejected: ${error instanceof Error ? error.message : String(error)}`,
        );
        toolOutcome = { type: "continue", results: new Map() };
      } finally {
        inFlight = undefined;
      }

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

      if (aborted || toolOutcome.type === "aborted") {
        aborted = true;
        return { type: "aborted" };
      }

      if (toolOutcome.type === "suspend") {
        return { type: "suspended", reason: toolOutcome.reason };
      }

      // continue to the next iteration
    }
  };

  const promise = runLoop().catch((error: unknown) => ({
    type: "failed" as const,
    error: error instanceof Error ? error : new Error(String(error)),
  }));

  return {
    promise,
    abort: () => {
      aborted = true;
      inFlight?.abort();
    },
  };
}

export type BeforeRequestDecision = {
  injections: AgentInput[];
} & ({ type: "proceed" } | { type: "suspend"; reason: SuspendReason });

async function runBeforeRequestHooks(
  deps: AgentLoopDeps,
): Promise<BeforeRequestDecision> {
  const { logger, manager } = deps;
  const injections: AgentInput[] = [];
  let suspend: SuspendReason | undefined;
  let tokenCount: number | undefined;
  let counted = false;

  for (const hook of deps.getHooks().onBeforeRequest) {
    if (hook.requestPreflightTokenCount && !counted && !suspend) {
      counted = true;
      try {
        tokenCount = await manager.countTokens?.();
      } catch (error) {
        tokenCount = undefined;
        logger.warn(
          `preflight countTokens failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const action = await hook.run({
      inputTokenCount: tokenCount,
      outputTokenCount: outputTokenCount(manager),
      ...(suspend === undefined
        ? ({ status: "pending" } as const)
        : ({ status: "suspended", reason: suspend } as const)),
    });
    switch (action.type) {
      case "inject":
        for (const block of action.content) {
          injections.push(
            block.type === "text"
              ? {
                  type: "text" as const,
                  text: block.text,
                  nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
                }
              : block,
          );
        }
        break;
      case "suspend":
        suspend ??= action.reason;
        break;
      case "none":
        break;
      default:
        assertUnreachable(action);
    }
  }
  return suspend !== undefined
    ? { type: "suspend", reason: suspend, injections }
    : { type: "proceed", injections };
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

function outputTokenCount(manager: NativeInferenceManager): number {
  let total = 0;
  for (const message of manager.log.messages) {
    total += message.usage?.outputTokens ?? 0;
  }
  return total;
}
