import type { ActiveToolEntry, ToolOutcome } from "./agent.ts";
import type { Logger } from "./logger.ts";
import type {
  ProviderToolResult,
  RequestedTool,
} from "./providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./providers/provider-types.ts";
import type { AgentHooks, ToolInvocationState } from "./thread-api.ts";
import type { SuspendReason } from "./thread-supervisor.ts";
import type {
  ToolInvocation,
  ToolRequest,
  ToolRequestId,
} from "./tool-types.ts";

export type ToolExecutorDeps = {
  logger: Logger;
  createTool: (request: ToolRequest) => ToolInvocation;
  getHooks: () => AgentHooks;
  /** Whether the owner is winding the turn down. Checked at the two points
   * where an abort can be missed: after the invocations are created but
   * before they are reachable, and once they have all settled. */
  isAborting: () => boolean;
  /** Where the invocations are, for whoever renders them. */
  publishTools: (tools: ToolInvocationState) => void;
  onUpdate: () => void;
};

/** Runs one batch of tool requests to completion. Owned by the `Thread` — it
 * is the thread that builds tools, holds the `onToolResults` hooks and decides
 * to abort — and handed to the agent as `AgentDeps.executeTools`. The agent
 * only appends what comes back. */
export class ToolExecutorHost {
  constructor(private deps: ToolExecutorDeps) {}

  /** The invocations that are running right now. Empty between batches. */
  private live = new Map<ToolRequestId, ActiveToolEntry>();

  /** Abort every live invocation. The outcome of the batch is still decided by
   * `isAborting`, so this only stops the work. */
  abortAll(): void {
    for (const [, entry] of this.live) entry.handle.abort();
  }

  async execute(requests: ReadonlyArray<RequestedTool>): Promise<ToolOutcome> {
    const activeTools = new Map<ToolRequestId, ActiveToolEntry>();
    const results = new Map<ToolRequestId, ProviderToolResult["result"]>();

    for (const requested of requests) {
      if (requested.request.status !== "ok") {
        results.set(requested.id, {
          status: "error",
          error: `Malformed tool_use block: ${requested.request.error}`,
        });
        continue;
      }
      const request = requested.request.value;
      let invocation: ToolInvocation;
      try {
        invocation = this.deps.createTool(request);
      } catch (err) {
        results.set(requested.id, {
          status: "error",
          error: `Tool creation failed: ${(err as Error).message}`,
        });
        continue;
      }
      activeTools.set(request.id, {
        handle: invocation,
        progress: "progress" in invocation ? invocation.progress : undefined,
        toolName: request.toolName,
        request,
      });
    }

    this.live = activeTools;
    // An abort can land while the invocations are being created, before they
    // are reachable; abort them here so none is left running.
    if (this.deps.isAborting()) this.abortAll();
    this.deps.publishTools({ type: "running", activeTools });

    const settled = await Promise.all(
      [...activeTools].map(async ([id, entry]) => {
        let result: ProviderToolResult;
        try {
          result = await entry.handle.promise;
        } catch (err) {
          result = {
            type: "tool_result",
            id,
            result: {
              status: "error",
              error: `Tool execution failed: ${(err as Error).message}`,
            },
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          };
        }
        entry.result = result;
        this.deps.onUpdate();
        return [id, result] as const;
      }),
    );

    for (const [id, result] of settled) {
      results.set(id, result.result);
    }

    // Every hook is consulted even once one has asked to suspend — a stop is a
    // fact each of them may need to record — and the first `suspend` wins.
    let suspend: SuspendReason | undefined;
    for (const hook of this.deps.getHooks().onToolResults) {
      try {
        const asked = hook(results);
        suspend ??= asked;
      } catch (err) {
        this.deps.logger.error(
          `onToolResults hook threw: ${(err as Error).message}`,
        );
      }
    }
    // Nothing is running any more: `activeTools` means *live* invocations, and
    // the view switches from tool progress to results the moment it empties.
    this.live = new Map();
    this.deps.publishTools({ type: "settled" });

    if (this.deps.isAborting()) {
      return { type: "aborted", results };
    }

    if (suspend) {
      return { type: "suspend", results, reason: suspend };
    }

    return { type: "continue", results };
  }
}
