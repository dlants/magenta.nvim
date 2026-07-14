import type {
  ProviderMessageContent,
  StopReason,
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

/** Action returned from the `onAbort` hook. */
export type AbortAction = { type: "none" };

/** Action returned from the `onHandoff` hook. */
export type HandoffAction =
  | { type: "compact"; nextPrompt?: string }
  | { type: "none" };

/** Union of all hook action types. Prefer the narrower per-hook types
 *  where possible so that a hook cannot return an action it does not
 *  own (e.g. `compact` is only representable from `onHandoff`). */
export type SupervisorAction =
  | EndTurnAction
  | YieldAction
  | AbortAction
  | HandoffAction;

export type EndTurnContext = {
  stopReason: string;
  lastAssistantMessage: ReadonlyArray<ProviderMessageContent> | undefined;
};

export type HandoffContext = {
  inputTokenCount: number | undefined;
  stopReason: StopReason;
};

export interface ThreadSupervisor {
  onEndTurnWithoutYield?(context: EndTurnContext): EndTurnAction;
  onYield?(result: string): Promise<YieldAction>;
  onAbort?(): AbortAction;
  onHandoff?(context: HandoffContext): HandoffAction;
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

  onAbort(): AbortAction {
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

  onAbort(): AbortAction {
    return { type: "none" };
  }
}

/** Triggers auto-compaction when the thread's input token count breaches
 *  a configurable threshold. Only implements the handoff hook. */
export class AutoCompactSupervisor implements ThreadSupervisor {
  private readonly threshold: number;
  private readonly nextPrompt: string | undefined;

  constructor(opts?: { threshold?: number; nextPrompt?: string }) {
    this.threshold = opts?.threshold ?? 300000;
    this.nextPrompt = opts?.nextPrompt;
  }

  onHandoff(context: HandoffContext): HandoffAction {
    if (
      context.inputTokenCount !== undefined &&
      context.inputTokenCount >= this.threshold
    ) {
      return this.nextPrompt !== undefined
        ? { type: "compact", nextPrompt: this.nextPrompt }
        : { type: "compact" };
    }
    return { type: "none" };
  }
}
