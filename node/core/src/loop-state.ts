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
      readonly type: "streaming";
      readonly startedAt: Date;
      /** Most recent sign of life from the server; drives the dead-air
       * "waiting Ns" counter. */
      readonly lastEventTime: Date;
      readonly block: StreamingBlock | undefined;
      readonly retry: RetryStatus | undefined;
    }
  | {
      readonly type: "running_tools";
      /** As the model asked for them, including malformed requests that never
       * became an `activeTools` entry. */
      readonly requested: ReadonlyArray<RequestedTool>;
      readonly tools: ToolInvocationState;
    };

/** The single account of what a thread is doing. `aborting` is a flag rather
 * than a state of its own: an aborting loop is still streaming or still
 * running tools, the view still has to render that, and as a flag it cannot
 * be clobbered by an activity transition. */
/** A loop's identity. Branded so an unrelated number cannot be passed to the
 * guards that decide whether a caller still owns the loop. */
export type LoopEpoch = number & { readonly __loopEpoch: true };

export type ThreadLoopState =
  | { type: "idle" }
  | {
      type: "running";
      epoch: LoopEpoch;
      activity: LoopActivity;
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

/** Drives `ThreadLoopState` from the edges its owner sees. Every transition
 * notifies, so whoever renders the loop never has to poll it. */
export class LoopStateMachine {
  constructor(private onUpdate: () => void) {}

  private state: ThreadLoopState = { type: "idle" };
  private epoch = 0 as LoopEpoch;

  get current(): ThreadLoopState {
    return this.state;
  }

  /** The loop takes over. Returns the epoch it owns, which every later
   * transition is checked against so a superseded loop cannot write. */
  start(): LoopEpoch {
    this.epoch = (this.epoch + 1) as LoopEpoch;
    this.state = {
      type: "running",
      epoch: this.epoch,
      activity: { type: "preparing" },
      aborting: false,
    };
    this.onUpdate();
    return this.epoch;
  }

  finish(epoch: LoopEpoch): void {
    if (!this.isCurrent(epoch)) return;
    this.state = { type: "idle" };
    this.onUpdate();
  }

  isCurrent(epoch: LoopEpoch): boolean {
    return this.state.type === "running" && this.state.epoch === epoch;
  }

  /** Is whatever loop is currently running winding down? */
  isAborting(): boolean {
    return this.state.type === "running" && this.state.aborting;
  }

  /** Is the loop the caller owns winding down? A superseded epoch is never
   * aborting — the flag belongs to the loop that replaced it. */
  isEpochAborting(epoch: LoopEpoch): boolean {
    return this.isCurrent(epoch) && this.isAborting();
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
    const prev = state.activity;
    let block = prev.block;
    let retry = prev.retry;
    switch (update.type) {
      case "streaming-block":
        block = update.streamingBlock;
        break;
      case "block-finished":
        block = undefined;
        break;
      case "retry-scheduled":
        retry = update.retry;
        block = undefined;
        break;
      case "attempt-started":
        retry = undefined;
        block = undefined;
        break;
      default:
        assertUnreachable(update);
    }
    this.setActivity({
      type: "streaming",
      startedAt: prev.startedAt,
      lastEventTime: new Date(),
      block,
      retry,
    });
  }
}
