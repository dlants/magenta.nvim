import type { OnToolApplied } from "./capabilities/context-tracker.ts";
import type {
  ProviderMessageContent,
  StreamStopReason,
} from "./providers/provider-types.ts";
import type { AgentHooks } from "./thread-api.ts";

/** Action returned from the `onEndTurnWithoutYield` hook. */
export type EndTurnAction =
  | { type: "send-message"; text: string }
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

/** Action returned from the `onBeforeRequest` hook by a single supervisor. */
export type RequestAction =
  | { type: "compact"; nextPrompt: string | undefined }
  | { type: "inject"; content: InjectedContent[] }
  | { type: "none" };

/** What the composed hook hands the agent: the injections to apply, in
 * supervisor order, and at most one compaction. Unlike a list of
 * `RequestAction`, this cannot represent a contradictory plan. */
export type BeforeRequestPlan = {
  injections: InjectedContent[];
  compaction: { nextPrompt: string | undefined } | undefined;
};

/** For the text-only supervisors. */
export function injectText(
  text: string,
): Extract<RequestAction, { type: "inject" }> {
  return { type: "inject", content: [{ type: "text", text }] };
}

/** Fold a list of supervisors into the single `AgentHooks` trio an `Agent`
 * consults. The merge rules are exactly today's: `send-message` texts join
 * with a blank line, and the first `accept`/`reject` wins a yield. Request
 * actions are not merged: they are collected in supervisor order and the agent
 * applies them in that order. Arbitration lives here rather than
 * in the agent because it is policy over a plural collaborator, and each
 * consumer is free to choose a different one. */
export function composeSupervisors(
  getSupervisors: () => ReadonlyArray<ThreadSupervisor>,
): AgentHooks {
  return {
    onEndTurn: (context) => {
      const texts: string[] = [];
      for (const sup of getSupervisors()) {
        const action = sup.onEndTurnWithoutYield?.(context);
        if (action && action.type === "send-message") texts.push(action.text);
      }
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
      const plan: BeforeRequestPlan = {
        injections: [],
        compaction: undefined,
      };
      for (const sup of getSupervisors()) {
        const action = await sup.onBeforeRequest?.(context);
        if (!action) continue;
        if (action.type === "inject") {
          plan.injections.push(...action.content);
        } else if (action.type === "compact") {
          // First compaction wins; a later one cannot restate the prompt.
          plan.compaction ??= { nextPrompt: action.nextPrompt };
        }
      }
      return plan;
    },
    onToolApplied: (absFilePath, tool, fileTypeInfo) => {
      for (const sup of getSupervisors()) {
        sup.onToolApplied?.(absFilePath, tool, fileTypeInfo);
      }
    },
  };
}

/** Union of all hook action types. Prefer the narrower per-hook types
 *  where possible so that a hook cannot return an action it does not
 *  own (e.g. `compact` is only representable from `onBeforeRequest`). */
export type SupervisorAction = EndTurnAction | YieldAction | RequestAction;

export type EndTurnContext = {
  stopReason: string;
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
} & RequestContextKind;

export interface ThreadSupervisor {
  onEndTurnWithoutYield?(context: EndTurnContext): EndTurnAction;
  onYield?(result: string): Promise<YieldAction>;
  onBeforeRequest?(context: RequestContext): Promise<RequestAction>;
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

/** For regular subagents. Only intervenes when the agent writes a
 *  `<yield>` XML tag instead of calling the tool. Otherwise allows
 *  the agent to stop normally. */
export class SubagentSupervisor implements ThreadSupervisor {
  onEndTurnWithoutYield(context: EndTurnContext): EndTurnAction {
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
      context.stopReason === "aborted" ||
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

  async onBeforeRequest(context: RequestContext): Promise<RequestAction> {
    if (
      context.inputTokenCount !== undefined &&
      context.inputTokenCount >= this.threshold
    ) {
      return { type: "compact", nextPrompt: this.nextPrompt };
    }
    return { type: "none" };
  }
}
