import type {
  AgentInput,
  NativeMessageIdx,
  StopReason,
  ToolResults,
} from "./providers/provider-types.ts";
import type { PendingMessage } from "./submission/index.ts";
import type {
  RequestContext,
  SuspendReason,
  YieldAction,
} from "./thread-supervisor.ts";
import type { ActiveToolEntry, ToolRequestId } from "./tool-types.ts";

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

/** How one submission ended. Delivered once, to the actor that submitted it —
 * never broadcast. Internal continuations (auto-respond, supervisor nudges,
 * the max_tokens continue-prompt, a compaction handoff) do not produce one:
 * the promise resolves when the thread finally comes to rest. */
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

/** How a submission ended, as anything outside the thread may see it: a
 * suspension is a handoff to a supervisor, never an outcome. */
export type RestResult = Exclude<SendResult, { type: "suspended" }>;
export type ThreadSendResult = RestResult | { type: "queued" };
/** The thread's lifecycle outcome, for actors who never submitted: the
 * subagent tool and the script runner. Settles at most once. */
export type ThreadResult =
  | { type: "yielded"; value: YieldValue; resultPrefix?: string }
  /** destroyed before it ever yielded */
  | { type: "aborted"; reason: string };

/** A submission waiting for the current turn to come to rest. `when` replaces
 * the old pendingMessages / pendingNextMessages pair; the view already renders
 * them as two labelled sections of one list. */
export type QueuedMessage = {
  when: "async" | "next";
  /** Raw submissions resolve at delivery; programmatic inputs are already resolved. */
  message: PendingMessage | AgentInput;
};

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

/** "Something visible moved." No payload: read `phase`. Called at streaming
 * rates and not throttled; the recipient coalesces, and its debounce must be
 * trailing-edge or the final call at rest is dropped. */
export type OnUpdate = () => void;
