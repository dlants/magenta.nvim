import type { SubagentConfig, ThreadType } from "./chat-types.ts";
import type { EdlRegisters } from "./edl/index.ts";
import type { Logger } from "./logger.ts";
import type { ProviderProfile } from "./provider-options.ts";
import {
  ABORT_MARKER_TEXT,
  ABORT_TOOL_RESULT_TEXT,
  UNANSWERED_TOOL_RESULT_TEXT,
} from "./providers/inference-shared.ts";
import type {
  AgentInput,
  NativeInferenceManager,
  NativeMessageIdx,
  Provider,
  ProviderInferenceConfig,
  ProviderMessage,
  ProviderMessageContent,
  ProviderToolResult,
  ProviderToolSpec,
  RequestedTool,
  RequestResult,
  RequestUpdate,
  StopReason,
  ToolResults,
  TurnResult,
} from "./providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./providers/provider-types.ts";
import type { SystemInfo, SystemPrompt } from "./providers/system-prompt.ts";
import type { AgentHooks, SendResult } from "./thread-api.ts";
import type { SuspendReason } from "./thread-supervisor.ts";
import type { ToolInvocation, ToolName, ToolRequest } from "./tool-types.ts";
import { assertUnreachable } from "./utils/assertUnreachable.ts";
import { Defer } from "./utils/async.ts";
import type { AbsFilePath } from "./utils/files.ts";

export type InputMessage =
  | {
      type: "user";
      text: string;
    }
  | {
      type: "system";
      text: string;
    };

function toAgentInput(
  content: ReadonlyArray<ProviderMessageContent>,
): AgentInput[] {
  const out: AgentInput[] = [];
  for (const c of content) {
    if (c.type === "text" || c.type === "system_reminder") {
      out.push({
        type: "text",
        text: c.text,
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      });
    } else if (c.type === "image" || c.type === "document") {
      out.push(c);
    }
  }
  return out;
}

export type ActiveToolEntry = {
  handle: ToolInvocation;
  progress: unknown;
  toolName: ToolName;
  request: ToolRequest;
  result?: ProviderToolResult;
};

export interface AgentContext {
  logger: Logger;
  profile: ProviderProfile;
  subagentConfig?: SubagentConfig;
  getProvider: (profile: ProviderProfile) => Provider;
}

export type ThreadState = {
  threadType: ThreadType;
  systemPrompt: SystemPrompt;
  systemInfo: SystemInfo;
  edlRegisters: EdlRegisters;
  editedFilesThisTurn: { path: AbsFilePath; snapshot: string }[];
  lastTurnResult: TurnResult | undefined;
  toolSpecs: ProviderToolSpec[];
};

export interface AgentDeps {
  state: ThreadState;
  toolSpecs: ProviderToolSpec[];
  /** The manager's progress callback, handed to its owner. The agent stores
   * nothing from it. */
  onRequestUpdate: (update: RequestUpdate) => void;
  /** Tool execution is the owner's: it builds the tools, owns the live
   * invocations, runs the `onToolResults` hooks and aborts them. The agent
   * only appends what comes back. */
  executeTools: ToolExecutor;
  getHooks: () => AgentHooks;
  runnerInit:
    | { type: "new" }
    | {
        type: "cloned";
        cloneFrom: NativeInferenceManager;
        truncateTo: NativeMessageIdx;
      };
}

export type ToolOutcome =
  | { type: "continue"; results: ToolResults }
  /** The owner wants the turn to stop over these results. The reason is opaque
   * to the agent, exactly as on the before-request path. */
  | { type: "suspend"; results: ToolResults; reason: SuspendReason }
  | { type: "aborted"; results: ToolResults };

export type ToolExecutor = (
  requests: ReadonlyArray<RequestedTool>,
) => Promise<ToolOutcome>;

export type BeforeRequestDecision =
  | { type: "proceed" }
  | { type: "suspend"; reason: SuspendReason };

type OnBeforeRequestResult = {
  decision: BeforeRequestDecision;
  appended: boolean;
};

type ComposedBeforeRequest =
  | { type: "suspend"; reason: SuspendReason; content: AgentInput[] }
  | { type: "proceed"; injections: AgentInput[]; submissions: InputMessage[] };

function completeToolResults(
  requested: ReadonlyArray<RequestedTool>,
  results: ToolResults,
  missingError: string,
): ToolResults {
  if (requested.every(({ id }) => results.has(id))) return results;
  const filled = new Map(results);
  for (const { id } of requested) {
    if (!filled.has(id)) {
      filled.set(id, { status: "error", error: missingError });
    }
  }
  return filled;
}

export class Agent {
  public state: ThreadState;
  public manager: NativeInferenceManager;

  constructor(
    private context: AgentContext,
    private deps: AgentDeps,
  ) {
    this.state = deps.state;
    this.state.toolSpecs = deps.toolSpecs;

    if (deps.runnerInit.type === "cloned") {
      this.manager = deps.runnerInit.cloneFrom.clone();
      this.manager.truncateMessages(deps.runnerInit.truncateTo);
    } else {
      this.manager = this.createManager();
    }
  }

  getToolSpecs(): ProviderToolSpec[] {
    return this.state.toolSpecs;
  }

  private inferenceConfig(): ProviderInferenceConfig | undefined {
    const profile = this.context.profile;
    if (profile.provider === "openai") {
      return profile.reasoning
        ? { type: "reasoning", reasoning: profile.reasoning }
        : undefined;
    }

    const effortOverride = this.context.subagentConfig?.effort;
    const baseThinking = profile.thinking;
    if (effortOverride) {
      return {
        type: "thinking",
        thinking: {
          enabled: true,
          ...(baseThinking?.displayThinking !== undefined
            ? { displayThinking: baseThinking.displayThinking }
            : {}),
          ...(baseThinking?.budgetTokens !== undefined
            ? { budgetTokens: baseThinking.budgetTokens }
            : {}),
          effort: effortOverride,
        },
      };
    }

    if (!baseThinking) return undefined;
    if (!baseThinking.enabled) {
      return { type: "thinking", thinking: { enabled: false } };
    }
    const { enabled: _enabled, ...rest } = baseThinking;
    return { type: "thinking", thinking: { enabled: true, ...rest } };
  }

  private createManager(): NativeInferenceManager {
    const provider = this.context.getProvider(this.context.profile);
    const config = this.inferenceConfig();
    const agent = provider.createInferenceManager({
      model: this.context.profile.model,
      systemPrompt: this.state.systemPrompt,
      tools: this.getToolSpecs(),
      ...(config ? { config } : {}),
    });
    return agent;
  }

  getProviderMessages(): ReadonlyArray<ProviderMessage> {
    return this.manager.log.messages;
  }

  private preSubmitNativeIdx: NativeMessageIdx | undefined;

  private rollbackToPreSubmit(): void {
    if (this.preSubmitNativeIdx === undefined) {
      return;
    }
    const idx = this.preSubmitNativeIdx;
    this.preSubmitNativeIdx = undefined;
    this.manager.truncateMessages(idx);
  }

  getMessages(): ProviderMessage[] {
    return [...this.getProviderMessages()];
  }

  getLastStopTokenCount(): number {
    if (this.lastPreflightTokenCount !== undefined) {
      return this.lastPreflightTokenCount;
    }

    const latestUsage = this.manager.log.latestUsage;
    if (!latestUsage) {
      return 0;
    }

    return (
      latestUsage.inputTokens +
      latestUsage.outputTokens +
      (latestUsage.cacheHits || 0) +
      (latestUsage.cacheMisses || 0)
    );
  }

  private currentTurn: Promise<void> | undefined;

  get isBusy(): boolean {
    return this.currentTurn !== undefined || this.turnInFlight;
  }

  /** Private and unobservable: how a turn ends is reported as its result, and
   * who is winding the loop down is the owner's own business. */
  private abortRequested = false;

  private outputTokenCount(): number {
    let total = 0;
    for (const message of this.manager.log.messages) {
      total += message.usage?.outputTokens ?? 0;
    }
    return total;
  }

  private turnInFlight = false;

  private async runLoop(initialInput: AgentInput[]): Promise<TurnResult> {
    let initialInputPending = true;
    while (true) {
      if (this.abortRequested) return { type: "aborted" };

      const onBeforeRequestResult = await this.onBeforeRequest();
      if (initialInputPending) {
        this.manager.appendUserMessage(initialInput);
        initialInputPending = false;
      }

      // we append the input and onBeforeRequest injections before suspending, so everything's
      // in the context for examination and resume
      if (onBeforeRequestResult.decision.type === "suspend") {
        return {
          type: "suspended",
          reason: onBeforeRequestResult.decision.reason,
        };
      }
      if (this.abortRequested) return { type: "aborted" };

      const outcome = await this.streamOneResponse();

      if (outcome.type === "aborted") return { type: "aborted" };
      if (outcome.type === "error") {
        return { type: "failed", error: outcome.error };
      }

      if (outcome.type === "stopped") {
        return { type: "stopped", stopReason: outcome.stopReason };
      }
      const requested = outcome.requested;

      if (this.abortRequested) return { type: "aborted" };

      let toolOutcome: ToolOutcome;
      try {
        toolOutcome = await this.deps.executeTools(requested);
      } catch (error) {
        // A rejecting executor is still a turn that must leave every tool_use
        // answered, so fall through with no results and let the fill do it.
        this.context.logger.error(
          `executeTools rejected: ${error instanceof Error ? error.message : String(error)}`,
        );
        toolOutcome = { type: "continue", results: new Map() };
      }

      // always append a complete set of tool results, so we leave the inference manager in a resumeable state
      this.manager.appendToolResults(
        requested,
        // Only the agent knows why an id went unanswered — an executor that
        // aborted, rejected, or simply skipped it — so it says so here rather
        // than leaving the manager to invent a reason.
        completeToolResults(
          requested,
          toolOutcome.results,
          toolOutcome.type === "aborted"
            ? ABORT_TOOL_RESULT_TEXT
            : UNANSWERED_TOOL_RESULT_TEXT,
        ),
      );

      if (toolOutcome.type === "aborted") {
        this.abortRequested = true;
        return { type: "aborted" };
      }

      if (toolOutcome.type === "suspend") {
        return { type: "suspended", reason: toolOutcome.reason };
      }

      // continue to the next iteration
    }
  }

  /** One provider request. Retries live inside it, and the owner is told about
   * them through the progress callback it supplied. */
  private async streamOneResponse(): Promise<RequestResult> {
    return await this.manager.sendRequest((update) =>
      this.deps.onRequestUpdate(update),
    );
  }

  /** The single terminal abort transition: leave the history well-formed and
   * mark why it stops here. */
  private finishTurnAbort(): void {
    this.manager.finalize({ type: "aborted" });
    this.manager.appendUserMessage([
      {
        type: "text",
        text: ABORT_MARKER_TEXT,
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);
  }

  private async handleTurnResult(result: TurnResult): Promise<void> {
    this.state.lastTurnResult = result;
    switch (result.type) {
      case "failed":
        this.handleErrorState(result.error);
        return;
      case "aborted":
        this.finishAbort();
        return;
      case "suspended":
        this.settle({ type: "suspended", reason: result.reason });
        return;
      case "stopped":
        this.handleStopped(result.stopReason);
        return;
      default:
        assertUnreachable(result);
    }
  }

  /** The most recent preflight count, for the conversation as it stood before
   * some request. `undefined` until a hook asks for one, when the provider has
   * no `countTokens`, and when the count failed — a failed count clears it
   * rather than reporting the previous request's number. */
  private lastPreflightTokenCount: number | undefined;

  get inputTokenCount(): number | undefined {
    return this.lastPreflightTokenCount;
  }

  /** Issued at most once per request, immediately before the first hook that
   * declared it needs the count, so that hook decides about the conversation
   * it is actually about to send. */
  private async countTokensForRequest(): Promise<void> {
    if (!this.manager.countTokens) return;
    try {
      this.lastPreflightTokenCount = await this.manager.countTokens();
    } catch (error) {
      // Drop the previous count rather than pass it off as this request's: a
      // hook deciding about the wrong conversation is worse than one that
      // sees no count and declines.
      this.lastPreflightTokenCount = undefined;
      this.context.logger.warn(
        `preflight countTokens failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  get lastAssistantMessage():
    | ReadonlyArray<ProviderMessageContent>
    | undefined {
    return this.getLastAssistantMessage();
  }

  private handleStopped(stopReason: StopReason): void {
    this.settle({ type: "completed", stopReason });
  }

  private handleErrorState(error: Error): void {
    this.rollbackToPreSubmit();
    this.context.logger.error(error);
    this.settle({ type: "failed", error, discardedSubmission: true });
  }

  async abort(): Promise<void> {
    await this.abortAndWait();
  }

  async abortAndWait(): Promise<void> {
    this.abortRequested = true;

    // The live invocations are the owner's; it aborts them.
    if (this.turnInFlight) this.manager.abort();

    const turn = this.currentTurn;
    if (turn) {
      await turn;
    } else if (!this.turnInFlight) {
      // Nothing in flight to unwind: settle here.
      this.finishAbort();
    }
  }

  private finishAbort(): void {
    this.abortRequested = false;
    this.settle({ type: "aborted" });
  }

  private submission: Defer<SendResult> | undefined;

  send(inputMessages?: InputMessage[]): Promise<SendResult> {
    if (this.turnInFlight) {
      return Promise.reject(
        new Error("send called while a turn is already in flight"),
      );
    }
    const deferred = new Defer<SendResult>();
    this.submission = deferred;

    this.openingRequestPending = true;
    // Whether a send with no user content is worth a request is the owner's
    // call: it probes its supervisors before it gets here, and the request it
    // decides to issue is composed inside the turn, by the gate.
    const { content } = this.prepareUserContent(inputMessages);
    this.preSubmitNativeIdx = this.manager.getNativeMessageIdx();

    this.turnInFlight = true;
    this.abortRequested = false;
    this.currentTurn = this.driveTurn(toAgentInput(content))
      .then((result) => {
        this.currentTurn = undefined;
        return this.handleTurnResult(result);
      })
      .catch(this.handleSendMessageError);

    return deferred.promise;
  }

  /** The turn `send` started. Its result is the owner's `SendResult`; nobody
   * drives a turn any other way. */
  private async driveTurn(input: AgentInput[]): Promise<TurnResult> {
    try {
      const result = await this.runLoop(input);
      if (result.type === "aborted") this.finishTurnAbort();
      if (result.type === "failed")
        this.manager.finalize({ type: "error", error: result.error });
      return result;
    } finally {
      this.turnInFlight = false;
      this.abortRequested = false;
    }
  }

  private settle(outcome: SendResult): void {
    const deferred = this.submission;
    this.submission = undefined;
    deferred?.resolve(outcome);
  }

  private getLastAssistantMessage():
    | ReadonlyArray<ProviderMessageContent>
    | undefined {
    const messages = this.manager.log.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        return messages[i].content;
      }
    }
    return undefined;
  }

  private async onBeforeRequest(): Promise<OnBeforeRequestResult> {
    const isOpeningRequest = this.openingRequestPending;
    this.openingRequestPending = false;
    const composed = await this.composeBeforeRequest(isOpeningRequest);
    const content =
      composed.type === "suspend"
        ? composed.content
        : [
            ...composed.injections,
            ...toAgentInput(
              this.prepareUserContent(composed.submissions).content,
            ),
          ];
    // Whether anything landed decides where the caller's own content goes.
    const appended = content.length > 0;
    if (appended) {
      // The opening request of a turn starts its own user message; a
      // continuation folds into the one already carrying the tool results.
      this.manager.appendUserMessage(content);
    }
    if (composed.type === "suspend") {
      return {
        decision: { type: "suspend", reason: composed.reason },
        appended,
      };
    }
    return { decision: { type: "proceed" }, appended };
  }
  /** Set by `submit` for the turn's opening request and consumed by the first
   * gate; later gates in the same turn are continuations by construction — the
   * loop only comes back around after tool results. It decides where the
   * injections go, and it is what the owner is told on `AgentRequestContext`,
   * so there is one place this is tracked. A turn that never reaches a gate
   * (disposed, aborted at the guards) leaves it set, which is harmless: every
   * request begins with a `submit` that sets it, so no continuation can read
   * a stale one. */
  private openingRequestPending = false;

  private handleSendMessageError = (error: Error): void => {
    this.context.logger.error(error);
  };

  private prepareUserContent(inputMessages?: InputMessage[]): {
    content: ProviderMessageContent[];
    hasContent: boolean;
  } {
    const messageContent: ProviderMessageContent[] = [];
    for (const m of inputMessages || []) {
      messageContent.push({
        type: "text",
        text: m.text,
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      });
    }

    return {
      content: messageContent,
      hasContent: (inputMessages?.length ?? 0) > 0,
    };
  }

  private async composeBeforeRequest(
    isOpeningRequest: boolean,
  ): Promise<ComposedBeforeRequest> {
    const injections: AgentInput[] = [];
    const submissions: InputMessage[] = [];
    let suspend: SuspendReason | undefined;
    let counted = false;
    for (const hook of this.deps.getHooks().onBeforeRequest) {
      if (hook.requestPreflightTokenCount && !counted && !suspend) {
        counted = true;
        await this.countTokensForRequest();
      }
      const action = await hook.run({
        inputTokenCount: this.lastPreflightTokenCount,
        outputTokenCount: this.outputTokenCount(),
        isOpeningRequest,
        ...(suspend === undefined
          ? ({ status: "pending" } as const)
          : ({ status: "suspended", reason: suspend } as const)),
      });
      switch (action.type) {
        case "inject":
          for (const block of action.content) {
            injections.push(
              block.type === "text"
                ? {
                    type: "text" as const,
                    text: block.text,
                    nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
                  }
                : block,
            );
          }
          break;
        case "submissions":
          submissions.push(...action.messages);
          break;
        case "suspend":
          // The first suspension wins; a later one cannot restate the reason.
          suspend ??= action.reason;
          break;
        case "none":
          break;
        default:
          assertUnreachable(action);
      }
    }
    if (suspend !== undefined) {
      return {
        type: "suspend",
        reason: suspend,
        content: [
          ...injections,
          ...toAgentInput(this.prepareUserContent(submissions).content),
        ],
      };
    }
    return { type: "proceed", injections, submissions };
  }

  private disposed = false;

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    try {
      await this.abort();
    } catch {
      // ignore
    }
  }
}
