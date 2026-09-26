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

/** Action returned from the `onToolLoopEnd` hook. */
export type ToolLoopEndAction =
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

export type ToolLoopEndContext = {
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

/** Participates in a submission: observes what is submitted, and decides what
 * happens when a tool loop ends — rest, auto-respond, or
 * suspend. */
export interface SubmissionSupervisor {
  /** The resolved content of a submission, reported once per submission just
   * before its first tool loop. Observational only: nothing the hook returns
   * can affect the submission. */
  onSubmission?(messages: readonly AgentInput[]): void;
  onToolLoopEnd?(context: ToolLoopEndContext): ToolLoopEndAction;
  onYield?(result: YieldValue): Promise<YieldAction>;
}

export type SupervisorChainDeps = {
  logger: Logger;
  /** Whether the live submission has been aborted, checked between members, so an abort mid-fan-out stops the rest. Hooks
   * that record what a tool loop already did (loop start/stop, applied tools,
   * tool results) are not gated: the core stops driving them once disposed. */
  isAborted: () => boolean;
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
    gating: "gated" | "ungated",
    visit: (supervisor: Member) => void,
  ): void {
    for (const supervisor of this.members()) {
      if (gating === "gated" && this.deps.isAborted()) return;
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
    this.forEach("onToolLoopStart", "ungated", (supervisor) =>
      supervisor.onToolLoopStart?.(nativeMessageIdx),
    );
  }

  onToolLoopStop(nativeMessageIdx: NativeMessageIdx): void {
    this.forEach("onToolLoopStop", "ungated", (supervisor) =>
      supervisor.onToolLoopStop?.(nativeMessageIdx),
    );
  }

  onToolApplied: OnToolAppliedHook = (event) => {
    this.forEach("onToolApplied", "ungated", (supervisor) =>
      supervisor.onToolApplied?.(event),
    );
  };

  onToolResults(
    results: ToolResults,
    nativeMessageIdx: NativeMessageIdx,
  ): void {
    this.forEach("onToolResults", "ungated", (supervisor) => {
      supervisor.onToolResults?.(results, nativeMessageIdx);
    });
  }

  async hasPendingContent(): Promise<boolean> {
    for (const supervisor of this.members()) {
      if (!supervisor.hasPendingContent) continue;
      let pending: boolean;
      try {
        pending = await supervisor.hasPendingContent();
      } catch (error) {
        this.logThrow("hasPendingContent", error);
        continue;
      }
      if (this.deps.isAborted()) return false;
      if (pending) return true;
    }
    return false;
  }

  async beforeRequest(facts: RequestContext): Promise<AgentInput[]> {
    const injections: AgentInput[] = [];
    for (const supervisor of this.members()) {
      if (this.deps.isAborted()) break;
      if (!supervisor.onBeforeRequest) continue;
      let action: SupervisorAction;
      try {
        action = await supervisor.onBeforeRequest(facts);
      } catch (error) {
        this.logThrow("onBeforeRequest", error);
        continue;
      }
      if (this.deps.isAborted()) break;
      if (action.type === "inject") injections.push(...action.content);
    }
    return injections;
  }
}

/** The fan-out from a thread's submissions to its supervisors. Combination
 * rules: auto-response texts join, first accept/reject
 * wins. */
export class SubmissionSupervisorChain extends ChainBase<SubmissionSupervisor> {
  onSubmission(messages: readonly AgentInput[]): void {
    this.forEach("onSubmission", "gated", (supervisor) =>
      supervisor.onSubmission?.(messages),
    );
  }

  onToolLoopEnd(context: ToolLoopEndContext): ToolLoopEndAction {
    const texts: string[] = [];
    this.forEach("onToolLoopEnd", "gated", (supervisor) => {
      const action = supervisor.onToolLoopEnd?.(context);
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
export class MaxTokensSupervisor implements SubmissionSupervisor {
  static create(): MaxTokensSupervisor {
    return new MaxTokensSupervisor();
  }

  static clone(_args: { source: MaxTokensSupervisor }): MaxTokensSupervisor {
    return new MaxTokensSupervisor();
  }

  private constructor() {}
  onToolLoopEnd(context: ToolLoopEndContext): ToolLoopEndAction {
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
export class SubagentSupervisor implements SubmissionSupervisor {
  static create(): SubagentSupervisor {
    return new SubagentSupervisor();
  }

  static clone(_args: { source: SubagentSupervisor }): SubagentSupervisor {
    return new SubagentSupervisor();
  }

  private constructor() {}
  onToolLoopEnd(context: ToolLoopEndContext): ToolLoopEndAction {
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
export class UnsupervisedSupervisor implements SubmissionSupervisor {
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

  onToolLoopEnd(context: ToolLoopEndContext): ToolLoopEndAction {
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
