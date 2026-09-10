import type { Logger } from "./logger.ts";
import {
  ABORT_TOOL_RESULT_TEXT,
  UNANSWERED_TOOL_RESULT_TEXT,
} from "./providers/inference-shared.ts";
import type {
  AgentInput,
  InferenceRequest,
  NativeInferenceManager,
  RequestedTool,
  RetryStatus,
  StreamingBlock,
  ToolResults,
} from "./providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./providers/provider-types.ts";
import type {
  AgentHooks,
  SendResult,
  ToolInvocationState,
} from "./thread-api.ts";
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
      requested: ReadonlyArray<RequestedTool>;
      tools: ToolInvocationState;
    }
);

export type AgentTurn = {
  readonly loopState: LoopState;
  promise: Promise<SendResult>;
  abort(): void;
};

export type AgentLoopDeps = AgentContext & {
  manager: NativeInferenceManager;
  onUpdate?: () => void;
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
  let loopState: LoopState = { type: "preparing", aborting: false };
  const updateLoopState = (next: LoopState) => {
    loopState = next;
    deps.onUpdate?.();
  };

  const runLoop = async (): Promise<SendResult> => {
    let initialInputPending = true;
    while (true) {
      if (loopState.aborting) return { type: "aborted" };

      updateLoopState({ type: "preparing", aborting: loopState.aborting });
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

      if (loopState.aborting || toolOutcome.type === "aborted") {
        loopState.aborting = true;
        deps.onUpdate?.();
        return { type: "aborted" };
      }

      if (toolOutcome.type === "suspend") {
        return { type: "suspended", reason: toolOutcome.reason };
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
