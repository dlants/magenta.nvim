import type { ToolExecution, ToolOutcome } from "./agent.ts";
import type {
  NativeMessageIdx,
  NonEmptyRequestedTools,
  ProviderToolResult,
} from "./providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./providers/provider-types.ts";
import type { ToolInvocationState } from "./thread-api.ts";
import type {
  ActiveToolEntry,
  ToolInvocation,
  ToolRequest,
  ToolRequestId,
} from "./tool-types.ts";

export type ToolExecutorDeps = {
  createTool: (request: ToolRequest) => ToolInvocation;
  /** The idx of the last message this batch's results will occupy. Fixed
   * when the batch starts: nothing is appended to the log while tools run. */
  getPendingResultMessageIdx: (
    requested: NonEmptyRequestedTools,
  ) => NativeMessageIdx;
  /** Where the invocations are, for whoever renders them. */
  publishTools: (tools: ToolInvocationState) => void;
  onUpdate: () => void;
};

/** Runs one batch of tool requests to completion. Owned by the `Thread` — it
 * is the thread that builds tools and decides to abort — and handed to the
 * agent as `AgentDeps.executeTools`. The agent appends what comes back and
 * runs the `onToolResults` hooks over it. */
export class ToolExecutorHost {
  constructor(private deps: ToolExecutorDeps) {}

  /** The invocations that are running right now. Empty between batches. */
  private live = new Map<ToolRequestId, ActiveToolEntry>();

  /** Whether the batch in flight has been aborted. Read at the two points
   * where an abort can be missed: after the invocations are created but
   * before they are reachable, and once they have all settled. */
  private aborting = false;

  private pendingResultMessageIdx: NativeMessageIdx | undefined;

  /** Where this batch's results will be written. Readable for as long as the
   * batch is live, which is exactly when a tool can report what it applied. */
  get resultMessageIdx(): NativeMessageIdx {
    if (this.pendingResultMessageIdx === undefined) {
      throw new Error("resultMessageIdx read outside a running batch");
    }
    return this.pendingResultMessageIdx;
  }

  /** Abort the batch in flight: stop every live invocation and settle the
   * batch as `aborted`. Also reachable from the thread directly, for the
   * teardowns that are not the agent winding a turn down. */
  abortAll(): void {
    this.aborting = true;
    for (const [, entry] of this.live) entry.handle.abort();
  }

  /** Mirrors `NativeInferenceManager.sendRequest`: the batch starts here and
   * the handle aborts this batch and nothing else. */
  execute(requests: NonEmptyRequestedTools): ToolExecution {
    return { promise: this.runBatch(requests), abort: () => this.abortAll() };
  }

  private async runBatch(
    requests: NonEmptyRequestedTools,
  ): Promise<ToolOutcome> {
    this.aborting = false;
    this.pendingResultMessageIdx =
      this.deps.getPendingResultMessageIdx(requests);
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
    if (this.aborting) this.abortAll();
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

    // Nothing is running any more: `activeTools` means *live* invocations, and
    // the view switches from tool progress to results the moment it empties.
    this.live = new Map();
    this.deps.publishTools({ type: "settled" });

    if (this.aborting) {
      return { type: "aborted", results };
    }

    return { type: "continue", results };
  }
}
