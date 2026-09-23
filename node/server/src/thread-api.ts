import type {
  NativeMessageIdx,
  StopReason,
  ToolResults,
} from "./providers/provider-types.ts";
import type {
  RequestContext,
  SuspendReason,
  YieldAction,
} from "./thread-supervisor.ts";
import type { ActiveToolEntry, ToolRequestId } from "./tool-types.ts";
import { Defer, untilAborted } from "./utils/async.ts";

export type { QueuedMessage } from "./submission/mailbox.ts";

/** The yield tool's input, unchanged. Consumers own the schema and interpretation. */
export type YieldValue = Record<string, unknown>;

/** Malformed requests never become an `activeTools` entry, so the map can be
 * smaller than `requested`. */
export type ToolInvocationState =
  | { type: "pending" }
  | {
      type: "running";
      activeTools: ReadonlyMap<ToolRequestId, ActiveToolEntry>;
    }
  | { type: "settled" };

/** The core loop alternates agent messages and turn executions, until the
 * agent finishes or we intervene. `R` is the set of suspensions this caller
 * can be handed: the core's own loop can hand back a `yield`, while the
 * thread's loop resolves yields itself and so never surfaces one. */
/** `context_budget` is the tool loop's own stop: the request was too large to
 * issue. Thread absorbs it by compacting, so owners never see it. */
export type LoopStopReason = StopReason | "context_budget";
export type CoreLoopResult<
  R extends SuspendReason = SuspendReason,
  S extends LoopStopReason = LoopStopReason,
> =
  | { type: "completed"; stopReason: S }
  /** The submission settled without ever issuing a request (empty content),
   * so there was never a turn and there is nothing to continue from. */
  | { type: "empty" }
  | { type: "yielded"; value: YieldValue; resultPrefix?: string }
  | { type: "aborted" }
  | { type: "failed"; error: Error }
  /** The model called the yield tool; Thread decides whether it stands. */
  | { type: "suspended"; reason: R };

/** The complete submission outcome, after internal continuations and
 * compaction: no suspensions and never `context_budget`. Delivered to the submitter rather than broadcast as a lifecycle
 * result. */
export type RestResult =
  | { type: "completed"; stopReason: StopReason }
  | { type: "empty" }
  | { type: "yielded"; value: YieldValue; resultPrefix?: string }
  | { type: "aborted" }
  | { type: "failed"; error: Error };
/** The thread's lifecycle outcome, for actors who never submitted: the
 * subagent tool and the script runner. Settles at most once. */
export type ThreadResult =
  | { type: "yielded"; value: YieldValue; resultPrefix?: string }
  /** destroyed before it ever yielded */
  | { type: "aborted"; reason: string };

/** Raised out of a submission step when the submission has been aborted. The
 * submission body does not check for abort at every seam: it lets this
 * propagate to the one place that turns an abort into a result. */
export class SubmissionAborted extends Error {
  constructor() {
    super("submission aborted");
    this.name = "SubmissionAborted";
  }
}
/** The submission that currently owns the thread. There is never more than
 * one: a submission that wants to take over awaits the incumbent's `abort()`
 * before installing its own, so no submission body has to ask whether it is
 * still the live one — only whether it was aborted. */
export class ActiveSubmission {
  private readonly controller = new AbortController();
  private readonly unwound = new Defer<void>();
  private unwinding: Promise<void> | undefined;
  /** `stopWork` interrupts whatever the submission is blocked on (the agent
   * turn), so that awaiting an abort cannot wedge the aborter. */
  constructor(private readonly stopWork: () => Promise<void>) {}
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  get aborted(): boolean {
    return this.controller.signal.aborted;
  }
  /** Cancel the submission and wait for its body to fully unwind, however it
   * ended. Never rejects: a failure belongs to the submitter, not to whoever
   * is waiting for the thread to go quiet. */
  abort(): Promise<void> {
    this.controller.abort();
    this.unwinding ??= (async () => {
      await this.stopWork();
      await this.unwound.promise;
    })();
    return this.unwinding;
  }
  /** Run one interruptible phase of the submission. The signal settles the
   * phase on abort, and `abort()` waits for the body to unwind, so a resumed
   * loop never has to ask whether it still speaks for the thread. */
  async step<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.throwIfAborted();
    const result = await untilAborted(work(this.signal), this.signal);
    this.throwIfAborted();
    return result as T;
  }
  /** A phase that must unwind on its own terms rather than be raced: the
   * agent turn is interrupted by `stopWork` and reports its own abort. */
  async settled<T>(work: () => Promise<T>): Promise<T> {
    const result = await work();
    this.throwIfAborted();
    return result;
  }
  throwIfAborted(): void {
    if (this.aborted) throw new SubmissionAborted();
  }
  /** Called by the submission body as it unwinds. */
  settle(): void {
    this.unwound.resolve();
  }
}

/** Where the thread is in its life. The single source of truth behind
 * `isBusy`, `loopState`, `lastResult()`, `yielded` and `isDestroyed`.
 *
 * `yielded` is a status rather than a sticky flag: a thread whose yield was
 * not accepted may be sent to again, and while that submission runs the thread
 * is `running`, not `yielded`. */
export type ThreadStatus =
  | { type: "idle"; lastResult: RestResult | undefined }
  | { type: "running"; submission: ActiveSubmission }
  | {
      type: "yielded";
      value: YieldValue;
      resultPrefix?: string;
    }
  /** Terminal. The last result is kept because a destroyed thread's history
   * can still be rendered. */
  | { type: "destroyed"; lastResult: RestResult | undefined };

/** The accepted/settled yield, as views render it. */
export type YieldState = Extract<ThreadStatus, { type: "yielded" }>;

/** What the agent tells its owner about the request it is about to issue. */
export type AgentRequestContext = RequestContext;

/** Called once per tool batch after its results have been written to the log,
 * including aborted batches. The callback cannot change the logged results,
 * but may suspend the turn before the next before-request callback.
 * Abort takes precedence over a returned suspension reason. */
export type ToolResultsHook = (
  results: ToolResults,
  nativeMessageIdx: NativeMessageIdx,
) => SuspendReason | undefined;

/** The model called yield_to_parent and the tool result is already in the log.
 * Awaited; a refusal arrives as a follow-up system message after that
 * result. */
export type YieldHook = (value: YieldValue) => Promise<YieldAction>;

/** "Something visible moved." No payload: read `loopState`. Called at streaming
 * rates and not throttled; the recipient coalesces, and its debounce must be
 * trailing-edge or the final call at rest is dropped. */
export type OnUpdate = () => void;
