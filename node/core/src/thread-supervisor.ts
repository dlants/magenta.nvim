import type { InputMessage } from "./agent.ts";
import type { OnToolApplied } from "./capabilities/context-tracker.ts";
import type { CompactSuspendReason } from "./compaction/index.ts";
import type {
  ProviderMessageContent,
  StopReason,
  StreamStopReason,
} from "./providers/provider-types.ts";
import {
  formatSystemInfo,
  type SystemInfo,
} from "./providers/system-prompt.ts";
import type { ThreadHooks } from "./thread-api.ts";

/** Action returned from the `onEndTurnWithoutYield` hook. */
export type EndTurnAction =
  | { type: "send-message"; text: string }
  | { type: "suspend"; reason: SuspendReason }
  | { type: "none" };

/** Action returned from the `onYield` hook. */
export type YieldAction =
  | { type: "accept"; resultPrefix?: string }
  | { type: "reject"; message: string }
  | { type: "send-message"; text: string }
  | { type: "none" };

/** Content an `onBeforeRequest` supervisor interjects into the request that is
 * about to be issued. Not a bare string: file context updates can be images or
 * documents. */
export type InjectedContent =
  | { type: "text"; text: string }
  | Extract<ProviderMessageContent, { type: "image" | "document" }>;

/** Why a supervisor asked to stop before a request. Core's turn loop does not
 * act on the reason — it only has to leave the log coherent and resumable —
 * but the set of reasons is closed, so whoever handles the suspension narrows
 * on `kind` rather than casting. */
export type SuspendReason = CompactSuspendReason | PlainStopSuspendReason;

/** "Stop this submission here"; nothing to hand off, just a reason to show. */
export type PlainStopSuspendReason = { kind: "stop"; message: string };

/** Action returned from the `onBeforeRequest` hook by a single supervisor.
 *
 * `suspend` says "stop before issuing this request and hand back to my
 * owner". */
export type SupervisorAction =
  | { type: "suspend"; reason: SuspendReason }
  | { type: "inject"; content: InjectedContent[] }
  | { type: "none" };

/** For the text-only supervisors. */
export function injectText(
  text: string,
): Extract<SupervisorAction, { type: "inject" }> {
  return { type: "inject", content: [{ type: "text", text }] };
}

/** The composed result of consulting every supervisor before a request. A
 * plural collaboration reduced to a single decision: all the injections, and
 * at most one suspension. Injections survive a suspension — they belong in
 * the snapshot handed over. */
export type ComposedSupervisorActions =
  | { type: "suspend"; reason: SuspendReason; injections: InjectedContent[] }
  | { type: "proceed"; injections: InjectedContent[] };

/** What the agent's `onBeforeRequest` hook answers: the supervisors' decision
 * plus, on the proceed path, the user's own queued content. `submissions` is
 * separate from `injections` because the agent orders it last and applies the
 * reminder/token-reset rules to it, and it is absent from the suspend variant
 * because a suspension must leave the queues undelivered. Only the owning
 * `Thread` fills it in, from its async queue. */
export type ComposedRequestActions =
  | { type: "suspend"; reason: SuspendReason; injections: InjectedContent[] }
  | {
      type: "proceed";
      injections: InjectedContent[];
      submissions: InputMessage[];
    };

/** Fold a list of supervisors into the single `ThreadHooks` set a `Thread`
 * consults. The merge rules are exactly today's: `send-message` texts join
 * with a blank line, and the first `accept`/`reject` wins a yield. Request
 * actions are merged into a single `ComposedRequestActions`: every injection,
 * in supervisor order, and the first `suspend`. Arbitration lives here rather than
 * in the agent because it is policy over a plural collaborator, and each
 * consumer is free to choose a different one. */
export function composeSupervisors(
  getSupervisors: () => ReadonlyArray<ThreadSupervisor>,
): ThreadHooks {
  return {
    onEndTurn: (context) => {
      const texts: string[] = [];
      // The first suspension wins, and it wins over any nudge: there is no
      // point asking the model to continue into a request we refuse to
      // issue. Every supervisor is still consulted — as on the
      // `onBeforeRequest` side, a stop is a fact each of them may need to
      // record — so this cannot short-circuit out of the loop.
      let suspend: Extract<EndTurnAction, { type: "suspend" }> | undefined;
      for (const sup of getSupervisors()) {
        const action = sup.onEndTurnWithoutYield?.(context);
        if (!action) continue;
        if (action.type === "send-message") texts.push(action.text);
        else if (action.type === "suspend") suspend ??= action;
      }
      if (suspend) return suspend;
      if (texts.length === 0) return { type: "none" };
      return { type: "send-message", text: texts.join("\n\n") };
    },
    onYield: async (value) => {
      // The built-in supervisors predate structured yields and read text.
      const result =
        value.type === "text" ? value.text : JSON.stringify(value.value);
      const texts: string[] = [];
      for (const sup of getSupervisors()) {
        const action = await sup.onYield?.(result);
        if (!action) continue;
        if (action.type === "accept" || action.type === "reject") return action;
        if (action.type === "send-message") texts.push(action.text);
      }
      if (texts.length === 0) return { type: "none" };
      return { type: "send-message", text: texts.join("\n\n") };
    },
    onBeforeRequest: async (context) => {
      const injections: InjectedContent[] = [];
      // The first suspension wins; a later one cannot restate the reason.
      let suspend: { reason: SuspendReason } | undefined;
      for (const sup of getSupervisors()) {
        const action = await sup.onBeforeRequest?.(context);
        if (!action) continue;
        if (action.type === "inject") injections.push(...action.content);
        else if (action.type === "suspend")
          suspend ??= { reason: action.reason };
      }
      return suspend
        ? { type: "suspend", reason: suspend.reason, injections }
        : { type: "proceed", injections };
    },
    hasPendingContent: async () => {
      for (const sup of getSupervisors()) {
        if (await sup.hasPendingContent?.()) return true;
      }
      return false;
    },
    onToolApplied: (absFilePath, tool, fileTypeInfo) => {
      for (const sup of getSupervisors()) {
        sup.onToolApplied?.(absFilePath, tool, fileTypeInfo);
      }
    },
  };
}

export type EndTurnContext = {
  stopReason: StopReason;
  /** The thread's input token count as of this stop, so an end-turn
   * supervisor can answer the same question `onBeforeRequest` answers. */
  inputTokenCount: number | undefined;
  lastAssistantMessage: ReadonlyArray<ProviderMessageContent> | undefined;
};

/** The opening request of a send. */
type SubmissionRequest = { kind: "submission" };
/** A request carrying tool results or a supervisor nudge. */
type ContinuationRequest = {
  kind: "continuation";
  stopReason: StreamStopReason;
};
/** The fields the caller of `onBeforeRequest` supplies; the agent fills in the
 * token count itself. */
export type RequestContextKind = SubmissionRequest | ContinuationRequest;
export type RequestContext = {
  inputTokenCount: number | undefined;
  /** Cumulative output tokens across the agent's message log. */
  outputTokenCount: number;
  /** No message has been sent on this agent yet. Survives a compaction reset,
   * where the replacement agent starts from an empty log. */
  isFirstMessage: boolean;
} & RequestContextKind;

export interface ThreadSupervisor {
  onEndTurnWithoutYield?(context: EndTurnContext): EndTurnAction;
  onYield?(result: string): Promise<YieldAction>;
  onBeforeRequest?(context: RequestContext): Promise<SupervisorAction>;
  /** Would `onBeforeRequest` contribute anything right now? Must not commit
   * any "sent" state — it answers a question about a request that may never
   * be issued. A supervisor whose contribution is standing (a reminder, the
   * system-info preamble) answers `false`: standing content alone is not
   * worth a request. */
  hasPendingContent?(): Promise<boolean>;
  onToolApplied?: OnToolApplied;
}

function containsYieldTag(
  content: ReadonlyArray<ProviderMessageContent> | undefined,
): boolean {
  if (!content) return false;
  for (const block of content) {
    if (block.type === "text" && /<\/?yield[\w_]*[\s/>]/i.test(block.text)) {
      return true;
    }
  }
  return false;
}

/** Puts the machine/environment preamble at the head of the conversation. A
 * supervisor rather than agent behaviour, so the owner decides which threads
 * get it — the compaction thread, whose content its caller composes exactly,
 * does not. */
export class SystemInfoSupervisor implements ThreadSupervisor {
  constructor(private readonly systemInfo: SystemInfo) {}

  async onBeforeRequest(context: RequestContext): Promise<SupervisorAction> {
    if (context.kind !== "submission" || !context.isFirstMessage) {
      return { type: "none" };
    }
    return injectText(formatSystemInfo(this.systemInfo));
  }
}

/** A truncated response is not an end of turn: the model was cut off
 * mid-thought, so it gets asked to pick up where it left off. Lives here
 * rather than in the agent because it is a policy over a stop, and it must be
 * consulted before any other end-turn supervisor can read the stop as a
 * refusal to yield. */
export class MaxTokensSupervisor implements ThreadSupervisor {
  onEndTurnWithoutYield(context: EndTurnContext): EndTurnAction {
    if (context.stopReason !== "max_tokens") return { type: "none" };
    return {
      type: "send-message",
      text: "Your previous response was truncated due to the output token limit. Please continue where you left off.",
    };
  }
}
/** For regular subagents. Only intervenes when the agent writes a
 *  `<yield>` XML tag instead of calling the tool. Otherwise allows
 *  the agent to stop normally. */
export class SubagentSupervisor implements ThreadSupervisor {
  onEndTurnWithoutYield(context: EndTurnContext): EndTurnAction {
    if (context.stopReason !== "end_turn") return { type: "none" };
    if (containsYieldTag(context.lastAssistantMessage)) {
      return {
        type: "send-message",
        text: "You wrote a yield XML tag in your text. XML tags in your response are not parsed as tool calls. You must invoke the yield_to_parent tool (via a proper tool call) to return results to the parent agent.",
      };
    }
    return { type: "none" };
  }

  async onYield(_result: string): Promise<YieldAction> {
    return { type: "none" };
  }
}

/** For unsupervised threads (e.g. docker_unsupervised). Always prompts
 *  the agent to resume work when it stops without yielding. */
export class UnsupervisedSupervisor implements ThreadSupervisor {
  private restartCount = 0;
  private readonly maxRestarts: number;

  constructor(opts?: { maxRestarts?: number }) {
    this.maxRestarts = opts?.maxRestarts ?? 5;
  }

  onEndTurnWithoutYield(context: EndTurnContext): EndTurnAction {
    if (
      context.stopReason !== "end_turn" ||
      this.restartCount >= this.maxRestarts
    ) {
      return { type: "none" };
    }
    this.restartCount++;

    if (containsYieldTag(context.lastAssistantMessage)) {
      return {
        type: "send-message",
        text: "You wrote a yield XML tag in your text. XML tags in your response are not parsed as tool calls. You must invoke the yield_to_parent tool (via a proper tool call) to return results to the parent agent.",
      };
    }

    return {
      type: "send-message",
      text: `You stopped without yielding. You must complete your task and call yield_to_parent when done. (auto-restart ${this.restartCount}/${this.maxRestarts})`,
    };
  }

  async onYield(_result: string): Promise<YieldAction> {
    return { type: "none" };
  }
}

/** Triggers auto-compaction when the thread's input token count breaches
 *  a configurable threshold. Only implements the handoff hook. */
export class AutoCompactSupervisor implements ThreadSupervisor {
  private readonly threshold: number;
  private readonly nextPrompt: string;

  constructor(opts: { nextPrompt: string; threshold?: number }) {
    this.threshold = opts.threshold ?? 300000;
    this.nextPrompt = opts.nextPrompt;
  }

  private breached(inputTokenCount: number | undefined): boolean {
    return inputTokenCount !== undefined && inputTokenCount >= this.threshold;
  }

  private get reason(): CompactSuspendReason {
    return { kind: "compact", nextPrompt: this.nextPrompt };
  }

  async onBeforeRequest(context: RequestContext): Promise<SupervisorAction> {
    if (!this.breached(context.inputTokenCount)) return { type: "none" };
    return { type: "suspend", reason: this.reason };
  }

  /** A thread that comes to rest over the threshold still has to compact:
   * waiting for the next request would put the user's next message in the
   * log first. */
  onEndTurnWithoutYield(context: EndTurnContext): EndTurnAction {
    if (!this.breached(context.inputTokenCount)) return { type: "none" };
    return { type: "suspend", reason: this.reason };
  }
}
