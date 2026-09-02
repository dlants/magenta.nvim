import type { ActiveToolEntry } from "./agent.ts";
import type {
  RequestedTool,
  RequestUpdate,
  RetryStatus,
  StreamingBlock,
} from "./providers/provider-types.ts";
import type { ToolInvocationState } from "./thread-api.ts";
import type { ToolRequestId } from "./tool-types.ts";
import { assertUnreachable } from "./utils/assertUnreachable.ts";

/** What the turn loop is doing inside a submission. The owner of the loop sees
 * every edge itself: it calls the agent, it is called back for tool
 * execution, and it is handed the request-progress updates. */
export type LoopActivity =
  /** The loop owns the thread but no request is in flight: probing for
   * pending content, deciding a continuation, the gap between turns. */
  | { type: "preparing" }
  | {
      type: "streaming";
      startedAt: Date;
      /** Most recent sign of life from the server; drives the dead-air
       * "waiting Ns" counter. */
      lastEventTime: Date;
      block: StreamingBlock | undefined;
      retry: RetryStatus | undefined;
    }
  | {
      type: "running_tools";
      /** As the model asked for them, including malformed requests that never
       * became an `activeTools` entry. */
      requested: ReadonlyArray<RequestedTool>;
      tools: ToolInvocationState;
    };

/** The single account of what a thread is doing. `aborting` is a flag rather
 * than a state of its own: an aborting loop is still streaming or still
 * running tools, the view still has to render that, and as a flag it cannot
 * be clobbered by an activity transition. */
export type ThreadLoopState =
  | { type: "idle" }
  | {
      type: "running";
      epoch: number;
      activity: LoopActivity;
      aborting?: true;
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

/** Drives `ThreadLoopState` from the edges its owner sees. Every transition
 * notifies, so whoever renders the loop never has to poll it. */
export class LoopStateMachine {
  constructor(private onUpdate: () => void) {}

  private state: ThreadLoopState = { type: "idle" };
  private epoch = 0;

  get current(): ThreadLoopState {
    return this.state;
  }

  /** The loop takes over. Returns the epoch it owns, which every later
   * transition is checked against so a superseded loop cannot write. */
  start(): number {
    this.epoch += 1;
    this.state = {
      type: "running",
      epoch: this.epoch,
      activity: { type: "preparing" },
    };
    this.onUpdate();
    return this.epoch;
  }

  finish(epoch: number): void {
    if (!this.isCurrent(epoch)) return;
    this.state = { type: "idle" };
    this.onUpdate();
  }

  isCurrent(epoch: number): boolean {
    return this.state.type === "running" && this.state.epoch === epoch;
  }

  isAborting(epoch?: number): boolean {
    if (this.state.type !== "running" || !this.state.aborting) return false;
    return epoch === undefined || this.state.epoch === epoch;
  }

  /** Wind the loop down at the next boundary. Survives every activity
   * transition within its epoch, and is cleared only by reaching idle. */
  markAborting(): void {
    if (this.state.type !== "running") return;
    this.state = { ...this.state, aborting: true };
    this.onUpdate();
  }

  private setActivity(activity: LoopActivity): void {
    if (this.state.type !== "running") return;
    this.state = { ...this.state, activity };
    this.onUpdate();
  }

  preparing(): void {
    this.setActivity({ type: "preparing" });
  }

  streaming(): void {
    const now = new Date();
    this.setActivity({
      type: "streaming",
      startedAt: now,
      lastEventTime: now,
      block: undefined,
      retry: undefined,
    });
  }

  runningTools(requested: ReadonlyArray<RequestedTool>): void {
    this.setActivity({
      type: "running_tools",
      requested,
      tools: { type: "pending" },
    });
  }

  /** Where the invocations of the current batch have got to. */
  setToolInvocationState(tools: ToolInvocationState): void {
    const state = this.state;
    if (state.type !== "running" || state.activity.type !== "running_tools") {
      return;
    }
    this.setActivity({ ...state.activity, tools });
  }

  /** Every update is a sign of life from the server, so each stamps
   * `lastEventTime`; the block itself is read at render time. Retries stay
   * inside the `streaming` activity and are never observable as a
   * transition. */
  applyRequestUpdate(update: RequestUpdate): void {
    const state = this.state;
    if (state.type !== "running" || state.activity.type !== "streaming") return;
    const activity = state.activity;
    activity.lastEventTime = new Date();
    switch (update.type) {
      case "streaming-block":
        activity.block = update.streamingBlock;
        break;
      case "block-finished":
        activity.block = undefined;
        break;
      case "retry-scheduled":
        activity.retry = update.retry;
        activity.block = undefined;
        break;
      case "attempt-started":
        activity.retry = undefined;
        activity.block = undefined;
        break;
      default:
        assertUnreachable(update);
    }
    this.onUpdate();
  }
}
