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
  ComposedRequestActions,
  ComposedSupervisorActions,
  EndTurnAction,
  EndTurnContext,
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

/** The `Agent` -> `Thread` questions. Each is answered by at most one hook,
 * supplied at construction: arbitration between several policies is the
 * owner's business (see `composeSupervisors`), not the agent's. A hook returns
 * an action and must not call back into the agent, and every action it can
 * return is a continuation — no hook return value resolves a `send`. */
export type AgentHooks = {
  /** The model called yield_to_parent. Awaited, and consulted before the tool
   * result is written, so a refusal arrives as that call's result rather than
   * as a contradicting message in a fresh turn. */
  onYield?: (value: YieldValue) => Promise<YieldAction>;
  /** About to issue a provider request — the opening one of a submission, or a
   * continuation carrying tool results. Not re-fired when a request is
   * retried. */
  /** The supervisors' actions, in order. The agent applies every injection
   * and honours the first `suspend` it scans. */
  onBeforeRequest?: (ctx: RequestContext) => Promise<ComposedRequestActions>;
  /** Every requested tool has settled and its results are about to be
   * written. Fire-and-forget, consulted before `onBeforeRequest` for the
   * continuation that carries them — but it also fires on turns that stop
   * here (abort, yield) and issue no continuation at all, deliberately: a
   * consumer accumulating state off tool results (e.g. an abbreviated bash
   * output) wants it carried into whatever request comes next, even one from
   * a later turn. Results are therefore not attached to the continuation
   * `RequestContext`, which would drop them in exactly those cases. */
  onToolResults?: (results: ToolResults) => void;
  /** A file-touching tool (edl, get_files) finished. Fire-and-forget. */
  onToolApplied?: OnToolApplied;
};

/** What the owning `Thread` answers. A superset of `AgentHooks`: the turn
 * loop lives in `Thread`, so the end-of-turn question is asked there and the
 * agent never sees it. */
export type ThreadHooks = Omit<AgentHooks, "onBeforeRequest"> & {
  /** The runner stopped without yielding. */
  onEndTurn?: (ctx: EndTurnContext) => EndTurnAction;
  /** The supervisors' own decision. It has no `submissions`: queued user
   * content is the thread's, and `Thread` wraps this hook to add it. */
  onBeforeRequest?: (ctx: RequestContext) => Promise<ComposedSupervisorActions>;
  /** Whether any supervisor would contribute content to a request issued
   * right now. Must not commit any "sent" state. */
  hasPendingContent?: () => Promise<boolean>;
};

/** "Something visible moved." No payload: read `phase`. Called at streaming
 * rates and not throttled; the recipient coalesces, and its debounce must be
 * trailing-edge or the final call at rest is dropped. */
export type OnUpdate = () => void;
