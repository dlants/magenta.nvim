import type {
  NativeMessageIdx,
  StopReason,
  ToolResults,
} from "./providers/provider-types.ts";
import type { YieldAction } from "./thread-supervisor.ts";
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

/** `context_budget` is the tool loop's own stop: the request was too large to
 * issue. Thread absorbs it by compacting, so owners never see it. */
export type ToolLoopStopReason = StopReason | "context_budget";

/** Outcomes shared by the tool loop and the submission that ran it. */
export type TerminalResult =
  | { type: "aborted" }
  | { type: "failed"; error: Error };
/** How one run of the tool loop ended. `yield` is the model's request to hand
 * back (the yield tool's result is already in the log); Thread's submission
 * supervisors decide whether it stands. */
export type ToolLoopResult =
  | { type: "completed"; stopReason: ToolLoopStopReason }
  | { type: "yield"; value: YieldValue }
  | TerminalResult;

/** The complete submission outcome, after internal continuations and
 * compaction: never `context_budget`. Delivered to the submitter rather than
 * broadcast as a lifecycle result. */
export type SubmissionResult =
  | { type: "completed"; stopReason: StopReason }
  /** The submission settled without ever issuing a request (empty content),
   * so there was never a tool loop and there is nothing to continue from. */
  | { type: "empty" }
  | { type: "yielded"; value: YieldValue; resultPrefix?: string }
  | TerminalResult;
/** The thread's lifecycle outcome, for actors who never submitted: the
 * subagent tool and the script runner. Settles at most once. */
export type ThreadOutcome =
  | { type: "yielded"; value: YieldValue; resultPrefix?: string }
  /** destroyed before it ever yielded */
  | { type: "aborted"; reason: string };

/** What a submission phase returns instead of its result once the submission
 * has been aborted. Abort is a value, never an exception (see context.md). */
export const ABORTED: unique symbol = Symbol("aborted");
export type Aborted = typeof ABORTED;
/** The submission that currently owns the thread. There is never more than
 * one: a submission that wants to take over awaits the incumbent's `abort()`
 * before installing its own, so no submission body has to ask whether it is
 * still the live one — only whether it was aborted. */
export class ActiveSubmission {
  private readonly controller = new AbortController();
  private readonly unwound = new Defer<void>();
  private unwinding: Promise<void> | undefined;
  /** `stopWork` interrupts whatever the submission is blocked on (the tool
   * loop), so that awaiting an abort cannot wedge the aborter. */
  constructor(private readonly stopWork: () => Promise<void>) {}
  get abortSignal(): AbortSignal {
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
  /** Run a phase whose result is abandoned on abort. Only for work whose
   * effects the caller applies, so dropping the result drops the effects
   * (see the cancellation invariants in context.md). */
  async step<T>(
    work: (abortSignal: AbortSignal) => Promise<T>,
  ): Promise<T | Aborted> {
    if (this.aborted) return ABORTED;
    const result = await untilAborted(work(this.abortSignal), this.abortSignal);
    if (this.aborted) return ABORTED;
    return result as T;
  }
  /** Join a phase that owns effects: it is awaited until it has cleaned up
   * after an abort, and only then does the submission unwind. */
  async settled<T>(work: () => Promise<T>): Promise<T | Aborted> {
    const result = await work();
    return this.aborted ? ABORTED : result;
  }
  /** Called by the submission body as it unwinds. */
  settle(): void {
    this.unwound.resolve();
  }
}

/** Where the thread is in its life. The single source of truth behind
 * `isBusy`, `state`, `lastResult()`, `yielded` and `isDestroyed`.
 *
 * `yielded` is a status rather than a sticky flag: a thread whose yield was
 * not accepted may be sent to again, and while that submission runs the thread
 * is `running`, not `yielded`. */
export type ThreadStatus =
  | { type: "idle"; lastResult: SubmissionResult | undefined }
  | { type: "running"; submission: ActiveSubmission }
  | {
      type: "yielded";
      value: YieldValue;
      resultPrefix?: string;
    }
  /** Terminal. The last result is kept because a destroyed thread's history
   * can still be rendered. */
  | { type: "destroyed"; lastResult: SubmissionResult | undefined };

/** The accepted/settled yield, as views render it. */
export type YieldState = Extract<ThreadStatus, { type: "yielded" }>;

/** Called once per tool batch after its results have been written to the log,
 * including aborted batches. Observe only: it cannot change the logged
 * results or end the loop. */
export type ToolResultsHook = (
  results: ToolResults,
  nativeMessageIdx: NativeMessageIdx,
) => void;

/** The model called yield_to_parent and the tool result is already in the log.
 * Awaited; a refusal arrives as a follow-up system message after that
 * result. */
export type YieldHook = (value: YieldValue) => Promise<YieldAction>;

/** "Something visible moved." No payload: read `state`. Called at streaming
 * rates and not throttled; the recipient coalesces, and its debounce must be
 * trailing-edge or the final call at rest is dropped. */
export type OnUpdate = () => void;
