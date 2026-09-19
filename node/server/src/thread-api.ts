import type { CompactSuspendReason } from "./compaction/index.ts";
import type {
  NativeMessageIdx,
  StopReason,
  ToolResults,
} from "./providers/provider-types.ts";
import type {
  PlainStopSuspendReason,
  RequestContext,
  SuspendReason,
  YieldAction,
} from "./thread-supervisor.ts";
import type { ActiveToolEntry, ToolRequestId } from "./tool-types.ts";

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

/** Internal turn/continuation outcome. Thread consumes suspended handoffs and
 * continuations before settling the public submission promise. */
export type SendResult =
  /** The agent came to rest. `stopReason` is how the turn that just finished
   * ended. */
  | { type: "completed"; stopReason: StopReason }
  /** The submission settled without ever issuing a request (empty content),
   * so there was never a turn and there is nothing to continue from. */
  | { type: "empty" }
  | { type: "yielded"; value: YieldValue; resultPrefix?: string }
  | { type: "aborted" }
  /** The runner exhausted its retries. Nothing is discarded: the submission
   * is still in the log, in a shape the provider will accept, so retrying
   * re-issues the same request and queued submissions are untouched. */
  | { type: "failed"; error: Error }
  /** A supervisor stopped the submission before a request was issued. The log
   * is coherent and resumable; what to do about it is the owner's business,
   * and the reason is opaque to core's turn loop. */
  | { type: "suspended"; reason: SuspendReason };

/** The complete submission outcome, after internal continuations and compaction.
 * Delivered to the submitter rather than broadcast as a lifecycle result.
 *
 * A suspension nobody claimed (no compactor for a `compact` reason, or a plain
 * `stop`) surfaces as `stopped` rather than pretending the submission was
 * `empty`: the log is coherent and resumable, and the reason is what a view
 * shows. `yield` never reaches here — it is resolved inside the turn loop. */
export type RestResult =
  | Exclude<SendResult, { type: "suspended" }>
  | {
      type: "stopped";
      reason: PlainStopSuspendReason | CompactSuspendReason;
    };
export type ThreadSendResult = RestResult | { type: "queued" };
/** The thread's lifecycle outcome, for actors who never submitted: the
 * subagent tool and the script runner. Settles at most once. */
export type ThreadResult =
  | { type: "yielded"; value: YieldValue; resultPrefix?: string }
  /** destroyed before it ever yielded */
  | { type: "aborted"; reason: string };

/** One live submission's identity. Every staleness check is "am I still the
 * live generation": the generation is cleared when its submission finishes and
 * cancelled by abort, destroy or a preempting submission. */
export type GenerationId = number & { readonly __generation: unique symbol };
export type Generation = {
  /** Minted only by Thread, so a foreign object cannot pose as a
   * generation. */
  readonly id: GenerationId;
  /** Cancelled by abort/destroy/preemption; passed to the compactor. */
  readonly controller: AbortController;
};

/** Where the thread is in its life. The single source of truth behind
 * `isBusy`, `loopState`, `lastResult()`, `yielded` and `isDestroyed`.
 *
 * `yielded` is a status rather than a sticky flag: a thread whose yield was
 * not accepted may be sent to again, and while that submission runs the thread
 * is `running`, not `yielded`. */
export type ThreadStatus =
  | { type: "idle"; lastResult: RestResult | undefined }
  | { type: "running"; generation: Generation }
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
