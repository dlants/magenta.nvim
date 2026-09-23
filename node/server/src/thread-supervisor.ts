import type { OnToolAppliedHook } from "./capabilities/context-tracker.ts";
import type { Logger } from "./logger.ts";
import type {
  AgentInput,
  NativeMessageIdx,
  ProviderMessageContent,
  StopReason,
  ToolResults,
} from "./providers/provider-types.ts";
import {
  formatSystemInfo,
  type SystemInfo,
} from "./providers/system-prompt.ts";
import {
  type HistoryIdx,
  historyIdxAtOrBefore,
  PRE_HISTORY,
} from "./supervisors/history.ts";
import type { YieldValue } from "./thread-api.ts";
import type { AbsFilePath } from "./utils/files.ts";

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
 * documents. Input-flavored: the native index is assigned when it lands. */
export type InjectedContent = AgentInput;

/** Action returned from the `onBeforeRequest` hook by a single supervisor. */
export type SupervisorAction =
  | { type: "inject"; content: InjectedContent[] }
  | { type: "none" };

/** For the text-only supervisors. */
export function injectText(
  text: string,
): Extract<SupervisorAction, { type: "inject" }> {
  return { type: "inject", content: [{ type: "text", text }] };
}

export type EndTurnContext = {
  stopReason: StopReason;
  /** The thread's input token count as of this stop, so an end-turn
   * supervisor can answer the same question `onBeforeRequest` answers. */
  inputTokenCount: number | undefined;
  lastAssistantMessage: ReadonlyArray<ProviderMessageContent> | undefined;
  /** The last message of the log. Nothing further will be written, so this is
   * the idx a supervisor records any state it commits here against. */
  nativeMessageIdx: NativeMessageIdx;
};

export type RequestContext = {
  /** Cumulative output tokens across the agent's message log. */
  outputTokenCount: number;
  /** The idx of the message that will carry this request's injections. */
  nativeMessageIdx: NativeMessageIdx;
};

/** Participates in a single tool loop: contributes context to each request,
 * and observes tool batches. It cannot stop a request, and it has no
 * say in what happens once the loop comes to rest. */
export interface ToolLoopSupervisor {
  onToolLoopStart?(nativeMessageIdx: NativeMessageIdx): void;
  onToolLoopStop?(nativeMessageIdx: NativeMessageIdx): void;
  /** Called after the batch's results are in the log. Observe only. */
  onToolResults?(
    results: ToolResults,
    /** The idx of the message holding these results. */
    nativeMessageIdx: NativeMessageIdx,
  ): void;
  onBeforeRequest?(context: RequestContext): Promise<SupervisorAction>;
  /** Would `onBeforeRequest` contribute anything right now? Must not commit
   * any "sent" state — it answers a question about a request that may never
   * be issued. A supervisor whose contribution is standing (a reminder, the
   * system-info preamble) answers `false`: standing content alone is not
   * worth a request. */
  hasPendingContent?(): Promise<boolean>;
  onToolApplied?: OnToolAppliedHook;
}

/** Participates in turn-taking: observes what is submitted, and decides what
 * happens when a tool loop hands the turn back — rest, auto-respond, or
 * suspend. */
export interface TurnSupervisor {
  /** The resolved content of a submission, reported once per submission just
   * before its first tool loop. Observational only: nothing the hook returns
   * can affect the submission. */
  onSubmission?(messages: readonly AgentInput[]): void;
  onEndTurnWithoutYield?(context: EndTurnContext): EndTurnAction;
  onYield?(result: YieldValue): Promise<YieldAction>;
}

export type RequestFacts = RequestContext;

export type SupervisorChainDeps = {
  logger: Logger;
  /** The live submission's signal, taken once at the start of a hook and
   * checked between members, so an abort mid-fan-out stops the rest. Hooks
   * that record what a tool loop already did (loop start/stop, applied tools,
   * tool results) are not gated: the core stops driving them once disposed. */
  signal: () => AbortSignal;
};

abstract class ChainBase<Member> {
  constructor(
    protected readonly members: () => readonly Member[],
    protected readonly deps: SupervisorChainDeps,
  ) {}

  protected logThrow(hook: string, error: unknown): void {
    this.deps.logger.error(
      `${hook} hook threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  protected forEach(
    hook: string,
    signal: AbortSignal | undefined,
    visit: (supervisor: Member) => void,
  ): void {
    for (const supervisor of this.members()) {
      if (signal?.aborted) return;
      try {
        visit(supervisor);
      } catch (error) {
        this.logThrow(hook, error);
      }
    }
  }
}

/** The fan-out from a tool loop to its supervisors. Injections concatenate in
 * member order. */
export class ToolLoopSupervisorChain extends ChainBase<ToolLoopSupervisor> {
  onToolLoopStart(nativeMessageIdx: NativeMessageIdx): void {
    this.forEach("onToolLoopStart", undefined, (supervisor) =>
      supervisor.onToolLoopStart?.(nativeMessageIdx),
    );
  }

  onToolLoopStop(nativeMessageIdx: NativeMessageIdx): void {
    this.forEach("onToolLoopStop", undefined, (supervisor) =>
      supervisor.onToolLoopStop?.(nativeMessageIdx),
    );
  }

  onToolApplied: OnToolAppliedHook = (event) => {
    this.forEach("onToolApplied", undefined, (supervisor) =>
      supervisor.onToolApplied?.(event),
    );
  };

  onToolResults(
    results: ToolResults,
    nativeMessageIdx: NativeMessageIdx,
  ): void {
    this.forEach("onToolResults", undefined, (supervisor) => {
      supervisor.onToolResults?.(results, nativeMessageIdx);
    });
  }

  async hasPendingContent(): Promise<boolean> {
    const signal = this.deps.signal();
    for (const supervisor of this.members()) {
      if (!supervisor.hasPendingContent) continue;
      let pending: boolean;
      try {
        pending = await supervisor.hasPendingContent();
      } catch (error) {
        this.logThrow("hasPendingContent", error);
        continue;
      }
      if (signal.aborted) return false;
      if (pending) return true;
    }
    return false;
  }

  async beforeRequest(facts: RequestFacts): Promise<AgentInput[]> {
    const signal = this.deps.signal();
    const injections: AgentInput[] = [];
    for (const supervisor of this.members()) {
      if (signal.aborted) break;
      if (!supervisor.onBeforeRequest) continue;
      let action: SupervisorAction;
      try {
        action = await supervisor.onBeforeRequest(facts);
      } catch (error) {
        this.logThrow("onBeforeRequest", error);
        continue;
      }
      if (signal.aborted) break;
      if (action.type === "inject") injections.push(...action.content);
    }
    return injections;
  }
}

/** The fan-out from a thread's turn-taking to its supervisors. Combination
 * rules: end-turn texts join, first accept/reject
 * wins. */
export class TurnSupervisorChain extends ChainBase<TurnSupervisor> {
  onSubmission(messages: readonly AgentInput[]): void {
    this.forEach("onSubmission", this.deps.signal(), (supervisor) =>
      supervisor.onSubmission?.(messages),
    );
  }

  onEndTurnWithoutYield(context: EndTurnContext): EndTurnAction {
    const texts: string[] = [];
    this.forEach("onEndTurnWithoutYield", this.deps.signal(), (supervisor) => {
      const action = supervisor.onEndTurnWithoutYield?.(context);
      if (action?.type === "send-message") texts.push(action.text);
    });
    return texts.length
      ? { type: "send-message", text: texts.join("\n\n") }
      : { type: "none" };
  }

  /** The first `accept`/`reject` wins outright — later hooks are not consulted,
   * since the decision is made — and `send-message` texts are joined. */
  async onYield(value: YieldValue): Promise<YieldAction> {
    const texts: string[] = [];
    for (const supervisor of this.members()) {
      if (!supervisor.onYield) continue;
      let action: YieldAction;
      try {
        action = await supervisor.onYield(value);
      } catch (error) {
        this.logThrow("onYield", error);
        continue;
      }
      if (action.type === "accept" || action.type === "reject") return action;
      if (action.type === "send-message") texts.push(action.text);
    }
    return texts.length
      ? { type: "send-message", text: texts.join("\n\n") }
      : { type: "none" };
  }
}

export type EditedFile = {
  path: AbsFilePath;
  snapshot: string;
  content: string;
};

export type EditedFileGroup = {
  id: number;
  startNativeMessageIdx: NativeMessageIdx;
  endNativeMessageIdx?: NativeMessageIdx;
  files: EditedFile[];
};

type EditedFileHistoryGroup = Omit<EditedFileGroup, "files"> & {
  edits: (EditedFile & { nativeMessageIdx: NativeMessageIdx })[];
};

export class EditedFilesSupervisor implements ToolLoopSupervisor {
  private history: EditedFileHistoryGroup[] = [];
  private nextGroupId = 0;
  private activeGroup: EditedFileHistoryGroup | undefined;

  private constructor() {}

  static create(): EditedFilesSupervisor {
    return new EditedFilesSupervisor();
  }

  static clone(args: {
    source: EditedFilesSupervisor;
    nativeMessageIdx: NativeMessageIdx;
  }): EditedFilesSupervisor {
    const cloned = EditedFilesSupervisor.create();
    cloned.nextGroupId = args.source.nextGroupId;
    cloned.history = args.source.history
      .filter((group) => group.startNativeMessageIdx <= args.nativeMessageIdx)
      .map((group) => ({
        ...group,
        endNativeMessageIdx:
          group.endNativeMessageIdx === undefined ||
          group.endNativeMessageIdx > args.nativeMessageIdx
            ? args.nativeMessageIdx
            : group.endNativeMessageIdx,
        edits: group.edits
          .filter((edit) => edit.nativeMessageIdx <= args.nativeMessageIdx)
          .map((edit) => ({ ...edit })),
      }));
    return cloned;
  }

  get groups(): EditedFileGroup[] {
    return this.history.map(({ edits, ...group }) => {
      const files = new Map<AbsFilePath, EditedFile>();
      for (const edit of edits) {
        const previous = files.get(edit.path);
        files.set(edit.path, {
          path: edit.path,
          snapshot: previous?.snapshot ?? edit.snapshot,
          content: edit.content,
        });
      }
      return { ...group, files: [...files.values()] };
    });
  }

  onToolLoopStart(nativeMessageIdx: NativeMessageIdx): void {
    const group: EditedFileHistoryGroup = {
      id: this.nextGroupId++,
      startNativeMessageIdx: nativeMessageIdx,
      edits: [],
    };
    this.history.push(group);
    this.activeGroup = group;
  }

  onToolLoopStop(nativeMessageIdx: NativeMessageIdx): void {
    if (!this.activeGroup) return;
    this.activeGroup.endNativeMessageIdx = nativeMessageIdx;
    this.activeGroup = undefined;
  }

  onToolApplied: OnToolAppliedHook = ({
    absFilePath,
    tool,
    nativeMessageIdx,
  }) => {
    if (tool.type !== "edl-edit" || !this.activeGroup) return;
    this.activeGroup.edits.push({
      path: absFilePath,
      snapshot: tool.previousContent,
      content: tool.content,
      nativeMessageIdx,
    });
  };
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
export class SystemInfoSupervisor implements ToolLoopSupervisor {
  private constructor(
    private readonly systemInfo: SystemInfo,
    private injectedAt: HistoryIdx | undefined,
  ) {}

  static create(args: {
    systemInfo: SystemInfo;
    alreadyInjected: boolean;
  }): SystemInfoSupervisor {
    return new SystemInfoSupervisor(
      args.systemInfo,
      args.alreadyInjected ? PRE_HISTORY : undefined,
    );
  }

  static clone(args: {
    source: SystemInfoSupervisor;
    nativeMessageIdx: NativeMessageIdx;
  }): SystemInfoSupervisor {
    return new SystemInfoSupervisor(
      args.source.systemInfo,
      args.source.injectedAt !== undefined &&
        historyIdxAtOrBefore(args.source.injectedAt, args.nativeMessageIdx)
        ? args.source.injectedAt
        : undefined,
    );
  }

  async onBeforeRequest(context: RequestContext): Promise<SupervisorAction> {
    if (this.injectedAt !== undefined) return { type: "none" };
    this.injectedAt = context.nativeMessageIdx;
    return injectText(formatSystemInfo(this.systemInfo));
  }
}

/** A truncated response is not an end of turn: the model was cut off
 * mid-thought, so it gets asked to pick up where it left off. Lives here
 * rather than in the agent because it is a policy over a stop, and it must be
 * consulted before any other end-turn supervisor can read the stop as a
 * refusal to yield. */
export class MaxTokensSupervisor implements TurnSupervisor {
  static create(): MaxTokensSupervisor {
    return new MaxTokensSupervisor();
  }

  static clone(_args: { source: MaxTokensSupervisor }): MaxTokensSupervisor {
    return new MaxTokensSupervisor();
  }

  private constructor() {}
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
export class SubagentSupervisor implements TurnSupervisor {
  static create(): SubagentSupervisor {
    return new SubagentSupervisor();
  }

  static clone(_args: { source: SubagentSupervisor }): SubagentSupervisor {
    return new SubagentSupervisor();
  }

  private constructor() {}
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

  async onYield(_result: YieldValue): Promise<YieldAction> {
    return { type: "none" };
  }
}

/** For unsupervised threads (e.g. docker_unsupervised). Always prompts
 *  the agent to resume work when it stops without yielding. */
export class UnsupervisedSupervisor implements TurnSupervisor {
  static create(opts?: { maxRestarts?: number }): UnsupervisedSupervisor {
    return new UnsupervisedSupervisor(opts?.maxRestarts ?? 5, 0);
  }

  static clone(args: {
    source: UnsupervisedSupervisor;
  }): UnsupervisedSupervisor {
    return new UnsupervisedSupervisor(
      args.source.maxRestarts,
      args.source.restartCount,
    );
  }

  private constructor(
    private readonly maxRestarts: number,
    private restartCount: number,
  ) {}

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

  async onYield(_result: YieldValue): Promise<YieldAction> {
    return { type: "none" };
  }
}
