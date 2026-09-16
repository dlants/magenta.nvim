import type { OnToolAppliedHook } from "./capabilities/context-tracker.ts";
import type { CompactSuspendReason } from "./compaction/index.ts";
import type {
  NativeMessageIdx,
  ProviderMessageContent,
  StopReason,
  ToolResults,
} from "./providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./providers/provider-types.ts";
import {
  formatSystemInfo,
  type SystemInfo,
} from "./providers/system-prompt.ts";
import type { YieldValue } from "./thread-api.ts";
import type { AbsFilePath } from "./utils/files.ts";

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
export type SuspendReason =
  | CompactSuspendReason
  | PlainStopSuspendReason
  | YieldSuspendReason;

/** The model called yield_to_parent and its result is in the log. Produced
 * only by Thread's own yield gate and consumed only by Thread's turn loop —
 * it never escapes to an owner. */
export type YieldSuspendReason = { kind: "yield"; value: YieldValue };

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

/** A supervisor's contribution to Thread's combined before-request decision. */
export type RequestAction = SupervisorAction;

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
  inputTokenCount: number | undefined;
  /** Cumulative output tokens across the agent's message log. */
  outputTokenCount: number;
  /** The idx of the message that will carry this request's injections. */
  nativeMessageIdx: NativeMessageIdx;
} & (
  | { status: "pending" }
  /** An earlier hook has already suspended this request, so it will never be
   * issued. A supervisor that commits agent-visible state must decline. */
  | { status: "suspended"; reason: SuspendReason }
);

export interface ThreadSupervisor {
  onAgentLoopStart?(nativeMessageIdx: NativeMessageIdx): void;
  onAgentLoopStop?(nativeMessageIdx: NativeMessageIdx): void;
  onEndTurnWithoutYield?(context: EndTurnContext): EndTurnAction;
  onYield?(result: YieldValue): Promise<YieldAction>;
  /** Called by Thread after the batch's results are in the log. A supervisor
   * may request suspension; Thread combines these into the single callback
   * result returned to the agent loop. */
  onToolResults?(
    results: ToolResults,
    /** The idx of the message holding these results. */
    nativeMessageIdx: NativeMessageIdx,
  ): SuspendReason | undefined;
  /** This supervisor reads `context.inputTokenCount` in `onBeforeRequest` and
   * needs it to describe the request it is deciding about, so the agent
   * counts the conversation before consulting it. Declaring it is what makes
   * the count happen at all. */
  requestPreflightTokenCount?: boolean;
  onBeforeRequest?(context: RequestContext): Promise<SupervisorAction>;
  /** Would `onBeforeRequest` contribute anything right now? Must not commit
   * any "sent" state — it answers a question about a request that may never
   * be issued. A supervisor whose contribution is standing (a reminder, the
   * system-info preamble) answers `false`: standing content alone is not
   * worth a request. */
  hasPendingContent?(): Promise<boolean>;
  onToolApplied?: OnToolAppliedHook;
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

export class EditedFilesSupervisor implements ThreadSupervisor {
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

  onAgentLoopStart(nativeMessageIdx: NativeMessageIdx): void {
    const group: EditedFileHistoryGroup = {
      id: this.nextGroupId++,
      startNativeMessageIdx: nativeMessageIdx,
      edits: [],
    };
    this.history.push(group);
    this.activeGroup = group;
  }

  onAgentLoopStop(nativeMessageIdx: NativeMessageIdx): void {
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
export class SystemInfoSupervisor implements ThreadSupervisor {
  private constructor(
    private readonly systemInfo: SystemInfo,
    private injectedAt: NativeMessageIdx | undefined,
  ) {}

  static create(args: {
    systemInfo: SystemInfo;
    alreadyInjected: boolean;
  }): SystemInfoSupervisor {
    return new SystemInfoSupervisor(
      args.systemInfo,
      args.alreadyInjected ? PLACEHOLDER_NATIVE_MESSAGE_IDX : undefined,
    );
  }

  static clone(args: {
    source: SystemInfoSupervisor;
    nativeMessageIdx: NativeMessageIdx;
  }): SystemInfoSupervisor {
    return new SystemInfoSupervisor(
      args.source.systemInfo,
      args.source.injectedAt !== undefined &&
        args.source.injectedAt <= args.nativeMessageIdx
        ? args.source.injectedAt
        : undefined,
    );
  }

  async onBeforeRequest(context: RequestContext): Promise<SupervisorAction> {
    if (context.status === "suspended" || this.injectedAt !== undefined)
      return { type: "none" };
    this.injectedAt = context.nativeMessageIdx;
    return injectText(formatSystemInfo(this.systemInfo));
  }
}

/** A truncated response is not an end of turn: the model was cut off
 * mid-thought, so it gets asked to pick up where it left off. Lives here
 * rather than in the agent because it is a policy over a stop, and it must be
 * consulted before any other end-turn supervisor can read the stop as a
 * refusal to yield. */
export class MaxTokensSupervisor implements ThreadSupervisor {
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
export class SubagentSupervisor implements ThreadSupervisor {
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
export class UnsupervisedSupervisor implements ThreadSupervisor {
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

/** Triggers auto-compaction when the thread's input token count breaches
 *  a configurable threshold. Only implements the handoff hook. */
export class AutoCompactSupervisor implements ThreadSupervisor {
  readonly requestPreflightTokenCount = true;

  static create(opts: {
    nextPrompt: string;
    threshold?: number;
  }): AutoCompactSupervisor {
    return new AutoCompactSupervisor(opts.nextPrompt, opts.threshold ?? 300000);
  }

  static clone(args: { source: AutoCompactSupervisor }): AutoCompactSupervisor {
    return new AutoCompactSupervisor(
      args.source.nextPrompt,
      args.source.threshold,
    );
  }

  private constructor(
    private readonly nextPrompt: string,
    private readonly threshold: number,
  ) {}

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
