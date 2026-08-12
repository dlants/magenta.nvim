import type {
  ProviderMessageContent,
  StreamStopReason,
} from "./providers/provider-types.ts";

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

/** Action returned from the `onBeforeRequest` hook. */
export type RequestAction =
  | { type: "compact"; nextPrompt: string | undefined }
  /** Interject text into the request that is about to be issued. `then` says
   * what happens to the request itself, so "compact" is representable from
   * exactly one place in this union rather than from two variants. */
  | {
      type: "inject";
      text: string;
      andThen:
        | { type: "compact"; nextPrompt: string | undefined }
        | { type: "none" };
    }
  | { type: "none" };

/** Today's merge semantics for several supervisors answering the same
 * request: injected texts are joined, compaction requests are OR-ed and their
 * prompts joined, and an injection carries any compaction along with it so a
 * compact request is never lost when a supervisor also injects. */
export function mergeRequestActions(
  actions: ReadonlyArray<RequestAction>,
): RequestAction {
  const injections: string[] = [];
  const prompts: string[] = [];
  let shouldCompact = false;
  for (const action of actions) {
    if (action.type === "inject") {
      injections.push(action.text);
    }
    const compaction = requestedCompaction(action);
    if (compaction) {
      shouldCompact = true;
      if (compaction.nextPrompt !== undefined) {
        prompts.push(compaction.nextPrompt);
      }
    }
  }
  const nextPrompt = prompts.length > 0 ? prompts.join("\n\n") : undefined;
  const andThen:
    | { type: "compact"; nextPrompt: string | undefined }
    | {
        type: "none";
      } = shouldCompact ? { type: "compact", nextPrompt } : { type: "none" };
  if (injections.length === 0) return andThen;
  return { type: "inject", text: injections.join("\n\n"), andThen };
}

/** The compaction a request action asks for, if any — so consumers do not have
 * to test two variants. */
export function requestedCompaction(
  action: RequestAction,
): { nextPrompt: string | undefined } | undefined {
  switch (action.type) {
    case "compact":
      return { nextPrompt: action.nextPrompt };
    case "inject":
      return action.andThen.type === "compact"
        ? { nextPrompt: action.andThen.nextPrompt }
        : undefined;
    case "none":
      return undefined;
  }
}

/** Union of all hook action types. Prefer the narrower per-hook types
 *  where possible so that a hook cannot return an action it does not
 *  own (e.g. `compact` is only representable from `onBeforeRequest`). */
export type SupervisorAction = EndTurnAction | YieldAction | RequestAction;

export type EndTurnContext = {
  stopReason: string;
  lastAssistantMessage: ReadonlyArray<ProviderMessageContent> | undefined;
};

export type RequestContext = {
  inputTokenCount: number | undefined;
  stopReason: StreamStopReason;
};

export interface ThreadSupervisor {
  onEndTurnWithoutYield?(context: EndTurnContext): EndTurnAction;
  onYield?(result: string): Promise<YieldAction>;
  onBeforeRequest?(context: RequestContext): RequestAction;
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

  onBeforeRequest(context: RequestContext): RequestAction {
    if (
      context.inputTokenCount !== undefined &&
      context.inputTokenCount >= this.threshold
    ) {
      return { type: "compact", nextPrompt: this.nextPrompt };
    }
    return { type: "none" };
  }
}
