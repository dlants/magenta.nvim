import type { ActiveToolEntry } from "./agent.ts";
import type { OnToolApplied } from "./capabilities/context-tracker.ts";
import type {
  RequestedTool,
  RetryStatus,
  StopReason,
  StreamingBlock,
  ToolResults,
} from "./providers/provider-types.ts";
import type { PendingMessage } from "./submission/index.ts";
import type {
  EndTurnAction,
  EndTurnContext,
  RequestAction,
  RequestContext,
  SuspendReason,
  YieldAction,
} from "./thread-supervisor.ts";
import type { ToolRequestId } from "./tool-types.ts";

/** What a thread hands back when it yields. Which variant a thread produces is
 * fixed at construction — a thread either has a `yieldSchema` or does not — so
 * a receiver never has to guess by parsing, and a text result that happens to
 * be valid JSON is never silently reinterpreted. */
export type YieldValue =
  | { type: "text"; text: string }
  /** conforms to the `yieldSchema` this thread was constructed with */
  | { type: "structured"; value: unknown };

/** The intra-turn detail, surfaced on `ThreadPhase` so consumers never read
 * the runner's phase themselves. It is a read-through projection of the
 * runner rather than a stored mirror: everything in it (the streaming block,
 * the retry countdown, the active tool list) moves between renders, so a copy
 * would be stale by construction. */
export type TurnActivity =
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
      requested: ReadonlyArray<RequestedTool>;
      /** the turn was cut short by the output token limit mid-tool-use */
      truncated: boolean;
    }
  /** The runner has handed off and is idle while the thread's executor runs
   * the tools; the runner's requested list is no longer available, so the
   * live tool entries are what there is to show. */
  | {
      type: "awaiting_tools";
      activeTools: ReadonlyMap<ToolRequestId, ActiveToolEntry>;
    };

/** Where a thread is right now. Observational, for rendering — outcomes travel
 * by promise, which is why there is no `yielded` variant: a thread that
 * yielded is `idle` with a `yielded` `lastResult`. */
export type ThreadPhase =
  | {
      type: "idle";
      /** A render-only copy of the most recent `SendResult`. Nothing may
       * branch on it for control flow. */
      lastResult: SendResult | undefined;
    }
  | { type: "running"; activity: TurnActivity }
  | { type: "aborting" };

export type SendOptions = {
  /** async: run after the current turn. next: run at the next stop.
   * undefined: abort whatever is running and send now. */
  queue?: "async" | "next";
};

/** How one submission ended. Delivered once, to the actor that submitted it —
 * never broadcast. Internal continuations (auto-respond, supervisor nudges,
 * the max_tokens continue-prompt, a compaction handoff) do not produce one:
 * the promise resolves when the thread finally comes to rest. */
export type SendResult =
  /** The agent came to rest. `stopReason` is how the turn that just finished
   * ended, or `undefined` when the submission settled without ever issuing a
   * request (empty content), so there is nothing to continue from. */
  | { type: "completed"; stopReason: StopReason | undefined }
  | { type: "yielded"; value: YieldValue }
  | { type: "aborted" }
  /** The runner exhausted its retries. The agent has already rolled its
   * message log back to the state before the failed request, so the thread is
   * coherent and resumable, and any queued submissions are untouched. */
  | {
      type: "failed";
      error: Error;
      /** True when the rollback discarded the submitted content itself, so it
       * is no longer in the log and an owner may restore it for resubmission.
       * False when the failure happened on a later request of the same
       * submission — the submitted content is still in the log, and restoring
       * it would duplicate it. */
      discardedSubmission: boolean;
    }
  /** A supervisor stopped the submission before a request was issued. The log
   * is coherent and resumable; what to do about it is the owner's business,
   * and the reason is opaque to core's turn loop. */
  | { type: "suspended"; reason: SuspendReason };

export type ThreadSendResult = SendResult | { type: "queued" };
/** The thread's lifecycle outcome, for actors who never submitted: the
 * subagent tool and the script runner. Settles at most once. */
export type ThreadResult =
  | { type: "yielded"; value: YieldValue }
  /** destroyed before it ever yielded */
  | { type: "aborted"; reason: string };

/** A submission waiting for the current turn to come to rest. `when` replaces
 * the old pendingMessages / pendingNextMessages pair; the view already renders
 * them as two labelled sections of one list. */
export type QueuedMessage = {
  when: "async" | "next";
  /** unresolved: its commands run when (and if) it is finally delivered */
  message: PendingMessage;
};

/** What the agent tells its owner about the request it is about to issue.
 * `isOpeningRequest` is the agent's own knowledge — which request of a turn
 * this is — and it is the single source of truth for it; the supervisors
 * below the owner are not told. */
export type AgentRequestContext = RequestContext & {
  /** This is the first request of the turn the agent's caller asked for, as
   * opposed to a continuation carrying tool results. */
  isOpeningRequest: boolean;
  /** An earlier hook has already suspended this request. Later hooks are
   * still consulted — a stop is a fact each of them may need to record — but
   * one whose contribution commits state (draining a queue, marking a
   * once-per-conversation reminder as sent) must decline. */
  suspended: boolean;
};

/** One entry at the before-request point. An object rather than a function so
 * `Agent` can read `requestPreflightTokenCount` *without* invoking it, and so
 * know whether to issue a token count before this entry runs. */
export type BeforeRequestHook = {
  /** This hook reads `ctx.inputTokenCount` and wants it to describe the
   * request it is deciding about. Not declaring it is the opt-out: a
   * conversation nobody asks about is never counted. */
  requestPreflightTokenCount?: boolean;
  run: (ctx: AgentRequestContext) => Promise<RequestAction>;
};

/** Every requested tool has settled and its results are about to be written.
 * Fire-and-forget, consulted before the continuation's before-request hooks —
 * but it also fires on turns that stop here (abort, yield) and issue no
 * continuation at all, deliberately: a consumer accumulating state off tool
 * results wants it carried into whatever request comes next, even one from a
 * later turn. */
export type ToolResultsHook = (results: ToolResults) => void;

/** The model called yield_to_parent. Awaited, and consulted before the tool
 * result is written, so a refusal arrives as that call's result rather than as
 * a contradicting message in a fresh turn. */
export type YieldHook = (value: YieldValue) => Promise<YieldAction>;

/** The `Agent` -> owner questions: one array per hook point, each composed by
 * that point's own rule. `Agent` never learns what a `Supervisor` is — the
 * owner flattens its supervisors into these arrays at registration. */
export type AgentHooks = {
  /** About to issue a provider request — the opening one of a submission, or
   * a continuation carrying tool results. Not re-fired when a request is
   * retried. Every injection is applied, in order; the first `suspend`
   * wins. */
  onBeforeRequest: BeforeRequestHook[];
  onToolResults: ToolResultsHook[];
  /** The first `accept`/`reject` wins; `send-message` texts concatenate. */
  onYield: YieldHook[];
  /** A file-touching tool (edl, get_files) finished. Fire-and-forget. Not a
   * turn-loop hook point — it fires per file from inside a tool — but the
   * agent wraps it for its own `editedFilesThisTurn` bookkeeping. */
  onToolApplied?: OnToolApplied;
};

/** What the owning `Thread` answers. A superset of `AgentHooks`: the turn
 * loop's outer half lives in `Thread`, so the end-of-turn question is asked
 * there and the agent never sees it. */
export type ThreadHooks = AgentHooks & {
  /** The agent stopped without yielding. */
  onEndTurn?: (ctx: EndTurnContext) => EndTurnAction;
  /** The thread's log was thrown away and it starts over. */
  onReset?: () => void;
  /** Whether any supervisor would contribute content to a request issued
   * right now. Must not commit any "sent" state. */
  hasPendingContent: () => Promise<boolean>;
};

/** "Something visible moved." No payload: read `phase`. Called at streaming
 * rates and not throttled; the recipient coalesces, and its debounce must be
 * trailing-edge or the final call at rest is dropped. */
export type OnUpdate = () => void;
