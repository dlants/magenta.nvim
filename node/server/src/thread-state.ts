import type { StreamingBlock } from "./providers/provider-types.ts";
import type { SubmissionResult, ThreadStatus } from "./thread-api.ts";
import type { ToolLoopActivity } from "./tool-loop.ts";
import type { ActiveToolEntry, ToolRequestId } from "./tool-types.ts";

export type ThreadState =
  /** `lastResult` is how the most recent submission ended; it exists only on
   * resting variants, so a view can never show a stale result beside a live
   * submission, and is `undefined` only before the first submission. */
  | { type: "idle"; lastResult: SubmissionResult | undefined }
  | { type: "running"; activity: ToolLoopActivity; aborting: boolean }
  | Exclude<ThreadStatus, { type: "idle" | "running" }>;

export function activityLabel(state: ThreadState): string {
  return state.type === "running" ? state.activity.type : state.type;
}

export function streamingBlock(state: ThreadState): StreamingBlock | undefined {
  return state.type === "running" && state.activity.type === "streaming"
    ? state.activity.block
    : undefined;
}

export function activeTools(
  state: ThreadState,
): ReadonlyMap<ToolRequestId, ActiveToolEntry> | undefined {
  return state.type === "running" &&
    state.activity.type === "running_tools" &&
    state.activity.tools.type === "running"
    ? state.activity.tools.activeTools
    : undefined;
}
