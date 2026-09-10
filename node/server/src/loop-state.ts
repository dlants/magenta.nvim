import type { LoopState } from "./agent.ts";
import type { StreamingBlock } from "./providers/provider-types.ts";
import type { SendResult } from "./thread-api.ts";
import type { ActiveToolEntry, ToolRequestId } from "./tool-types.ts";

export type ThreadLoopState =
  /** Nothing in flight. `lastResult` is how the most recent submission ended;
   * it exists only here, so a view can never show a stale result beside a
   * live turn, and is `undefined` only before the first submission. */
  | { type: "idle"; lastResult: SendResult | undefined }
  | {
      type: "running";
      activity: LoopState;
      aborting: boolean;
    };

export function loopLabel(state: ThreadLoopState): string {
  return state.type === "running" ? state.activity.type : state.type;
}

export function loopStreamingBlock(
  state: ThreadLoopState,
): StreamingBlock | undefined {
  return state.type === "running" && state.activity.type === "streaming"
    ? state.activity.block
    : undefined;
}

export function loopActiveTools(
  state: ThreadLoopState,
): ReadonlyMap<ToolRequestId, ActiveToolEntry> | undefined {
  return state.type === "running" &&
    state.activity.type === "running_tools" &&
    state.activity.tools.type === "running"
    ? state.activity.tools.activeTools
    : undefined;
}
