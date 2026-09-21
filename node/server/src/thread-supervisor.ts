import type { OnToolAppliedHook } from "./capabilities/context-tracker.ts";
import type { CompactSuspendReason } from "./compaction/index.ts";
import type { Logger } from "./logger.ts";
import type {
  AgentInput,
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
import { PRE_HISTORY_IDX } from "./supervisors/history.ts";
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

/** Why a supervisor asked to suspend before a request. Core's turn loop does
 * not act on the reason — it only has to leave the log coherent and resumable
 * — but the set of reasons is closed, so whoever handles the suspension narrows
 * on `kind` rather than casting. */
export type SuspendReason =
  | CompactSuspendReason
  | PlainSuspendReason
  | YieldSuspendReason;

/** The model called yield_to_parent and its result is in the log. Produced
 * only by Thread's own yield gate and consumed only by Thread's turn loop —
 * it never escapes to an owner. */
export type YieldSuspendReason = { kind: "yield"; value: YieldValue };

/** "Suspend this submission here"; nothing to hand off, just a reason to
 * show. */
export type PlainSuspendReason = { kind: "suspend"; message: string };

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
  /** The resolved content of a submission, reported once per submission just
   * before its first turn. Observational only: nothing the hook returns can
   * affect the submission. */
  onSubmission?(messages: readonly AgentInput[]): void;
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

/** What the caller of the chain knows about the request before any supervisor
 * has been consulted. The input token count is deliberately absent: only the
 * chain knows whether any member declared that it needs one. */
export type RequestFacts = Pick<
  RequestContext,
  "outputTokenCount" | "nativeMessageIdx"
>;

/** The chain's combined before-request decision. Injections gathered before a
 * suspension still travel with it: the runner appends them to the log so they
 * are in place for whatever resumes the thread. */
export type CombinedRequestAction = { injections: AgentInput[] } & (
  | { type: "proceed" }
  | { type: "suspend"; reason: SuspendReason }
);

/** Answers "is the submission this hook was started for still the live one".
 * Obtained fresh per hook and checked between members. */
export type SubmissionGuard = (() => boolean) & {
  readonly __guard: "submission";
};

/** Answers the looser "is this core still the thread's core". True for a turn
 * that is unwinding under an abort, so hooks that record what already
 * happened keep running. */
export type CoreLivenessCheck = (() => boolean) & { readonly __guard: "core" };

export function submissionGuard(check: () => boolean): SubmissionGuard {
  return check as SubmissionGuard;
}

export function coreLivenessCheck(check: () => boolean): CoreLivenessCheck {
  return check as CoreLivenessCheck;
}

/** The chain's own surface. Deliberately not `ThreadSupervisor`: the chain
 * combines its members' decisions, so its before-request hook returns a
 * `CombinedRequestAction` that no single supervisor can express, and it is
 * not itself nestable as a member. */
export interface SupervisorFanOut {
  onSubmission(messages: readonly AgentInput[]): void;
  onAgentLoopStart(nativeMessageIdx: NativeMessageIdx): void;
  onAgentLoopStop(nativeMessageIdx: NativeMessageIdx): void;
  onToolApplied: OnToolAppliedHook;
  onToolResults(
    results: ToolResults,
    nativeMessageIdx: NativeMessageIdx,
  ): SuspendReason | undefined;
  onEndTurnWithoutYield(context: EndTurnContext): EndTurnAction;
  onYield(value: YieldValue): Promise<YieldAction>;
  hasPendingContent(): Promise<boolean>;
  beforeRequest(facts: RequestFacts): Promise<CombinedRequestAction>;
}

export type SupervisorChainDeps = {
  logger: Logger;
  /** Called once at the start of a hook; the guard it returns is checked
   * between members so a submission that lands mid-fan-out stops the rest. */
  guard: () => SubmissionGuard;
  /** Looser liveness for the hooks that record what the turn already did —
   * loop start/stop, applied tools, tool results. They must still run for a
   * turn that is unwinding under an abort. */
  coreIsCurrent: CoreLivenessCheck;
  /** Supplied lazily because only a declaring member forces the count. */
  countTokens: () => Promise<number | undefined>;
};

/** The single fan-out point from a thread to its supervisors. Owns the
 * combination rules — first suspend wins, injections concatenate in member
 * order, end-turn texts join, first accept/reject wins — plus the guarding and
 * error logging that used to be repeated per hook. */
export class SupervisorChain implements SupervisorFanOut {
  constructor(
    private readonly members: () => readonly ThreadSupervisor[],
    private readonly deps: SupervisorChainDeps,
  ) {}

  private logThrow(hook: string, error: unknown): void {
    this.deps.logger.error(
      `${hook} hook threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  private forEach(
    hook: string,
    isCurrent: SubmissionGuard | CoreLivenessCheck,
    visit: (supervisor: ThreadSupervisor) => void,
  ): void {
    for (const supervisor of this.members()) {
      if (!isCurrent()) return;
      try {
        visit(supervisor);
      } catch (error) {
        this.logThrow(hook, error);
      }
    }
  }

  onSubmission(messages: readonly AgentInput[]): void {
    this.forEach("onSubmission", this.deps.guard(), (supervisor) =>
      supervisor.onSubmission?.(messages),
    );
  }

  onAgentLoopStart(nativeMessageIdx: NativeMessageIdx): void {
    this.forEach("onAgentLoopStart", this.deps.coreIsCurrent, (supervisor) =>
      supervisor.onAgentLoopStart?.(nativeMessageIdx),
    );
  }

  onAgentLoopStop(nativeMessageIdx: NativeMessageIdx): void {
    this.forEach("onAgentLoopStop", this.deps.coreIsCurrent, (supervisor) =>
      supervisor.onAgentLoopStop?.(nativeMessageIdx),
    );
  }

  onToolApplied: OnToolAppliedHook = (event) => {
    this.forEach("onToolApplied", this.deps.coreIsCurrent, (supervisor) =>
      supervisor.onToolApplied?.(event),
    );
  };

  onToolResults(
    results: ToolResults,
    nativeMessageIdx: NativeMessageIdx,
  ): SuspendReason | undefined {
    let suspend: SuspendReason | undefined;
    this.forEach("onToolResults", this.deps.coreIsCurrent, (supervisor) => {
      suspend ??= supervisor.onToolResults?.(results, nativeMessageIdx);
    });
    return suspend;
  }

  onEndTurnWithoutYield(context: EndTurnContext): EndTurnAction {
    const texts: string[] = [];
    let suspend: Extract<EndTurnAction, { type: "suspend" }> | undefined;
    this.forEach("onEndTurnWithoutYield", this.deps.guard(), (supervisor) => {
      const action = supervisor.onEndTurnWithoutYield?.(context);
      if (action?.type === "send-message") texts.push(action.text);
      else if (action?.type === "suspend") suspend ??= action;
    });
    if (suspend) return suspend;
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

  async hasPendingContent(): Promise<boolean> {
    const isCurrent = this.deps.guard();
    for (const supervisor of this.members()) {
      if (!supervisor.hasPendingContent) continue;
      let pending: boolean;
      try {
        pending = await supervisor.hasPendingContent();
      } catch (error) {
        this.logThrow("hasPendingContent", error);
        continue;
      }
      if (!isCurrent()) return false;
      if (pending) return true;
    }
    return false;
  }

  /** The token count happens at most once per request, only when a declaring
   * member is reached and nothing has suspended yet. */
  async beforeRequest(facts: RequestFacts): Promise<CombinedRequestAction> {
    const isCurrent = this.deps.guard();
    const injections: AgentInput[] = [];
    let suspend: SuspendReason | undefined;
    let tokenCount: number | undefined;
    let counted = false;
    for (const supervisor of this.members()) {
      if (!isCurrent()) break;
      if (!supervisor.onBeforeRequest) continue;
      if (supervisor.requestPreflightTokenCount && !counted && !suspend) {
        counted = true;
        try {
          tokenCount = await this.deps.countTokens();
        } catch (error) {
          this.deps.logger.warn(
            `preflight countTokens failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!isCurrent()) break;
      }
      let action: SupervisorAction;
      try {
        action = await supervisor.onBeforeRequest({
          ...facts,
          inputTokenCount: tokenCount,
          ...(suspend === undefined
            ? { status: "pending" as const }
            : { status: "suspended" as const, reason: suspend }),
        });
      } catch (error) {
        this.logThrow("onBeforeRequest", error);
        continue;
      }
      if (!isCurrent()) break;
      if (action.type === "suspend") suspend ??= action.reason;
      else if (action.type === "inject") {
        for (const block of action.content) {
          injections.push(
            block.type === "text"
              ? { ...block, nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }
              : block,
          );
        }
      }
    }
    return suspend === undefined
      ? { type: "proceed", injections }
      : { type: "suspend", reason: suspend, injections };
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
      args.alreadyInjected ? PRE_HISTORY_IDX : undefined,
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

  /** `ThreadSupervisor` is an interface, not a closed union, so a `kind`
   * discriminant would not narrow a `ThreadSupervisor[]` lookup either. The
   * runtime check lives here rather than at the call site. */
  static find(
    supervisors: readonly ThreadSupervisor[],
  ): AutoCompactSupervisor | undefined {
    return supervisors.find(
      (supervisor): supervisor is AutoCompactSupervisor =>
        supervisor instanceof AutoCompactSupervisor,
    );
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
