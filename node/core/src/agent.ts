import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
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
  StreamingBlock,
  ToolResults,
  TurnResult,
} from "./providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./providers/provider-types.ts";
import type { SystemInfo, SystemPrompt } from "./providers/system-prompt.ts";
import type {
  AgentHooks,
  OnUpdate,
  SendResult,
  ToolInvocationState,
  TurnActivity,
  YieldValue,
} from "./thread-api.ts";
import { renderYieldValue } from "./thread-api.ts";
import type { SuspendReason } from "./thread-supervisor.ts";
import type {
  ToolInvocation,
  ToolName,
  ToolRequest,
  ToolRequestId,
  ToolStructuredResult,
} from "./tool-types.ts";
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

export function phaseLabel(phase: AgentPhase): string {
  return phase.type === "running" ? phase.activity.type : phase.type;
}

export function phaseStreamingBlock(
  phase: AgentPhase,
): StreamingBlock | undefined {
  return phase.type === "running" && phase.activity.type === "streaming"
    ? phase.activity.block
    : undefined;
}

export function phaseActiveTools(
  phase: AgentPhase,
): ReadonlyMap<ToolRequestId, ActiveToolEntry> | undefined {
  return phase.type === "running" &&
    phase.activity.type === "running_tools" &&
    phase.activity.tools.type === "running"
    ? phase.activity.tools.activeTools
    : undefined;
}

export type AgentPhase =
  | { type: "idle" }
  | { type: "running"; activity: TurnActivity }
  | { type: "aborting" }
  | {
      type: "yielded";
      response: string;
      value: YieldValue;
      tornDown: boolean;
    };

export interface AgentContext {
  logger: Logger;
  profile: ProviderProfile;
  subagentConfig?: SubagentConfig;
  yieldSchema?: JSONSchemaType;
  getProvider: (profile: ProviderProfile) => Provider;
}

export type AgentAction =
  | { type: "set-title"; title: string }
  | {
      type: "set-active-tool-result";
      id: ToolRequestId;
      result: ProviderToolResult;
    };

export type ThreadState = {
  title: string | undefined;
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
  /** Tool construction, and everything it needs, is the owner's: the agent
   * only drives the invocations it gets back. */
  createTool: (request: ToolRequest) => ToolInvocation;
  structuredToolResults: Map<ToolRequestId, ToolStructuredResult>;
  getHooks: () => AgentHooks;
  onUpdate: OnUpdate;
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
  private currentPhase: AgentPhase = { type: "idle" };
  get phase(): AgentPhase {
    return this.currentPhase;
  }
  private setPhase(phase: AgentPhase): void {
    this.currentPhase = phase;
    this.deps.onUpdate();
  }
  private setToolInvocationState(tools: ToolInvocationState): void {
    const phase = this.currentPhase;
    if (phase.type !== "running" || phase.activity.type !== "running_tools") {
      return;
    }
    this.setPhase({
      type: "running",
      activity: { ...phase.activity, tools },
    });
  }
  private get activeTools():
    | ReadonlyMap<ToolRequestId, ActiveToolEntry>
    | undefined {
    return phaseActiveTools(this.currentPhase);
  }
  public readonly structuredToolResults: Map<
    ToolRequestId,
    ToolStructuredResult
  >;

  constructor(
    private context: AgentContext,
    private deps: AgentDeps,
  ) {
    this.state = deps.state;
    this.structuredToolResults = deps.structuredToolResults;
    this.state.toolSpecs = deps.toolSpecs;

    if (deps.runnerInit.type === "cloned") {
      this.manager = deps.runnerInit.cloneFrom.clone();
      this.manager.truncateMessages(deps.runnerInit.truncateTo);
    } else {
      this.manager = this.createManager();
    }
  }

  update(action: AgentAction, { silent }: { silent?: boolean } = {}): void {
    switch (action.type) {
      case "set-title":
        this.state.title = action.title;
        break;
      case "set-active-tool-result": {
        if (action.result.result.status === "ok") {
          this.structuredToolResults.set(
            action.id,
            action.result.result.structuredResult,
          );
        }
        const active = this.activeTools;
        if (active) {
          const entry = active.get(action.id);
          if (entry) {
            entry.result = action.result;
          }
        }
        break;
      }
      default:
        assertUnreachable(action);
    }
    if (!silent) {
      this.deps.onUpdate();
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
    this.deps.onUpdate();
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
    return (
      this.currentTurn !== undefined || this.currentPhase.type === "running"
    );
  }

  private pendingTurnPrefix: AgentInput[] | undefined;

  get pendingTurnContent(): ReadonlyArray<AgentInput> {
    return this.pendingTurnPrefix ?? [];
  }

  prependToNextTurn(content: AgentInput[]): void {
    this.pendingTurnPrefix = [...(this.pendingTurnPrefix ?? []), ...content];
  }

  private abortRequested = false;

  private outputTokenCount(): number {
    let total = 0;
    for (const message of this.manager.log.messages) {
      total += message.usage?.outputTokens ?? 0;
    }
    return total;
  }

  private runTurn(input: AgentInput[]): Promise<void> {
    const turn = this.runTurnLoop(input)
      .then((result) => {
        this.currentTurn = undefined;
        return this.handleTurnResult(result);
      })
      .catch(this.handleSendMessageError);
    this.currentTurn = turn;
    return turn;
  }

  private turnInFlight = false;

  /** Heartbeat that forces a re-render ~1/sec while a turn is in flight, so
   * time-based status (waiting timer, retry countdown) updates during dead
   * air. */
  private tickInterval: ReturnType<typeof setInterval> | undefined;

  private startTicker(): void {
    this.stopTicker();
    this.tickInterval = setInterval(() => this.deps.onUpdate(), 1000);
  }

  private stopTicker(): void {
    if (this.tickInterval !== undefined) {
      clearInterval(this.tickInterval);
      this.tickInterval = undefined;
    }
  }

  /** Drive one turn to completion. `send` is the ordinary entry point; this is
   * public so a caller (and the loop's tests) can drive a turn directly. */
  async runTurnLoop(input: AgentInput[]): Promise<TurnResult> {
    if (this.turnInFlight) {
      throw new Error("runTurn called while a turn is already in flight");
    }
    this.turnInFlight = true;
    this.abortRequested = false;
    this.startTicker();
    try {
      const result = await this.runLoop(input);
      if (result.type === "aborted") this.finishTurnAbort();
      if (result.type === "failed")
        this.manager.finalize({ type: "error", error: result.error });
      return result;
    } finally {
      this.turnInFlight = false;
      this.abortRequested = false;
      this.currentPhase = { type: "idle" };
      this.stopTicker();
      this.deps.onUpdate();
    }
  }

  private async runLoop(initialInput: AgentInput[]): Promise<TurnResult> {
    let initialInputPending = true;
    while (true) {
      if (this.abortRequested) return { type: "aborted" };

      const onBeforeRequestResult = await this.onBeforeRequest();
      const appendedInitialInput = initialInputPending;
      if (initialInputPending) {
        this.manager.appendUserMessage(initialInput);
        initialInputPending = false;
      }
      // One notification for the whole composed user message: the gate's
      // injections and the caller's content land in the same message, and an
      // observer that saw it half-built would treat the half as final.
      if (onBeforeRequestResult.appended || appendedInitialInput)
        this.deps.onUpdate();

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

      // `yield_to_parent` is never executed: it ends the turn, so the agent
      // answers it itself and marks every tool it shares the request with as
      // skipped. The log must leave no tool_use unanswered.
      const yieldRequest = requested.find(
        (r) =>
          r.request.status === "ok" &&
          r.request.value.toolName === "yield_to_parent",
      );
      if (yieldRequest && yieldRequest.request.status === "ok") {
        const input = yieldRequest.request.value.input;
        const value: YieldValue =
          this.context.yieldSchema !== undefined
            ? { type: "structured", value: input }
            : { type: "text", text: (input as { result: string }).result };

        const results = new Map<ToolRequestId, ProviderToolResult["result"]>();
        for (const { id } of requested) {
          results.set(
            id,
            id === yieldRequest.id
              ? {
                  status: "ok",
                  value: [
                    {
                      type: "text",
                      text: "Yield accepted. Your result has been sent to the parent thread.",
                      nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
                    },
                  ],
                  structuredResult: { toolName: "yield_to_parent" as ToolName },
                }
              : {
                  status: "error",
                  error: "The thread yielded so this tool was skipped.",
                },
          );
        }

        for (const hook of this.deps.getHooks().onToolResults) {
          hook(results);
        }
        this.manager.appendToolResults(requested, results);
        this.deps.onUpdate();
        return { type: "yielded", value };
      }

      this.currentPhase = {
        type: "running",
        activity: {
          type: "running_tools",
          requested,
          tools: { type: "pending" },
        },
      };
      this.deps.onUpdate();

      let toolOutcome: ToolOutcome;
      try {
        toolOutcome = await this.executeTools(requested);
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
      this.deps.onUpdate();

      if (toolOutcome.type === "aborted") {
        this.abortRequested = true;
        return { type: "aborted" };
      }

      // continue to the next iteration
    }
  }

  /** One provider request. Retries live inside it and stay inside the
   * `streaming` phase, so they are never observable as a transition. */
  private async streamOneResponse(): Promise<RequestResult> {
    this.currentPhase = {
      type: "running",
      activity: {
        type: "streaming",
        startedAt: new Date(),
        lastEventTime: new Date(),
        block: undefined,
        retry: undefined,
      },
    };
    this.deps.onUpdate();
    return await this.manager.sendRequest((update) =>
      this.handleRequestUpdate(update),
    );
  }
  /** Every update is a sign of life from the server, so each stamps
   * `lastEventTime`; the block itself is mirrored onto the phase and read at
   * render time. */
  private handleRequestUpdate(update: RequestUpdate): void {
    const phase = this.currentPhase;
    if (phase.type !== "running" || phase.activity.type !== "streaming") return;
    const activity = phase.activity;
    activity.lastEventTime = new Date();
    switch (update.type) {
      case "streaming-block":
        activity.block = update.streamingBlock;
        break;
      case "block-finished":
        activity.block = undefined;
        break;
      case "retry-scheduled":
        activity.retry = update.retry;
        activity.block = undefined;
        break;
      case "attempt-started":
        activity.retry = undefined;
        activity.block = undefined;
        break;
      default:
        assertUnreachable(update);
    }
    this.deps.onUpdate();
  }
  /** The single terminal abort transition: leave the history well-formed and
   * mark why it stops here. */
  private finishTurnAbort(): void {
    this.currentPhase = { type: "aborting" };
    this.deps.onUpdate();
    this.manager.finalize({ type: "aborted" });
    this.manager.appendUserMessage([
      {
        type: "text",
        text: ABORT_MARKER_TEXT,
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);
    this.deps.onUpdate();
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
      case "yielded":
        // Whether this yield is really the end — a supervisor may reject it or
        // tear the container down — is the owner's call, made on the result.
        this.setPhase({
          type: "yielded",
          response: renderYieldValue(result.value),
          value: result.value,
          tornDown: false,
        });
        this.settle({ type: "yielded", value: result.value });
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
      this.deps.onUpdate();
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

  /** Overridable so a test can stand in for real tool execution; production
   * never replaces it. */
  protected async executeTools(
    requests: ReadonlyArray<RequestedTool>,
  ): Promise<ToolOutcome> {
    const activeTools = new Map<ToolRequestId, ActiveToolEntry>();
    const results = new Map<ToolRequestId, ProviderToolResult["result"]>();

    for (const requested of requests) {
      if (requested.request.status !== "ok") {
        results.set(requested.id, {
          status: "error",
          error: `Malformed tool_use block: ${requested.request.error}`,
        });
        continue;
      }
      const request = requested.request.value;
      let invocation;
      try {
        invocation = this.deps.createTool(request);
      } catch (err) {
        results.set(requested.id, {
          status: "error",
          error: `Tool creation failed: ${(err as Error).message}`,
        });
        continue;
      }
      activeTools.set(request.id, {
        handle: invocation,
        progress: "progress" in invocation ? invocation.progress : undefined,
        toolName: request.toolName,
        request,
      });
    }

    // An abort can land while the invocations are being created, before they
    // are reachable from the phase; abort them here so none is left running.
    if (this.abortRequested) {
      for (const [, entry] of activeTools) entry.handle.abort();
    }
    this.setToolInvocationState({ type: "running", activeTools });

    await Promise.all(
      [...activeTools].map(async ([id, entry]) => {
        let result: ProviderToolResult;
        try {
          result = await entry.handle.promise;
        } catch (err) {
          result = {
            type: "tool_result",
            id,
            result: {
              status: "error",
              error: `Tool execution failed: ${(err as Error).message}`,
            },
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          };
        }
        // One tool's bookkeeping must not tear down the others' results.
        try {
          this.update({ type: "set-active-tool-result", id, result });
        } catch (err) {
          this.context.logger.error(
            `recording the result of ${entry.toolName} failed: ${(err as Error).message}`,
          );
        }
      }),
    );

    for (const [id, entry] of activeTools) {
      if (entry.result) {
        results.set(id, entry.result.result);
      }
    }

    for (const hook of this.deps.getHooks().onToolResults) {
      try {
        hook(results);
      } catch (err) {
        this.context.logger.error(
          `onToolResults hook threw: ${(err as Error).message}`,
        );
      }
    }
    // Nothing is running any more: `activeTools` means *live* invocations, and
    // the view switches from tool progress to results the moment it empties.
    this.setToolInvocationState({ type: "settled" });

    if (this.abortRequested) {
      return { type: "aborted", results };
    }

    return { type: "continue", results };
  }

  private handleErrorState(error: Error): void {
    this.rollbackToPreSubmit();
    this.context.logger.error(error);
    this.settle({ type: "failed", error, discardedSubmission: true });
  }

  async abort(): Promise<void> {
    // A yielded thread has already completed its work — don't overwrite its state.
    if (this.currentPhase.type === "yielded") {
      return;
    }
    await this.abortAndWait();
  }

  async abortAndWait(): Promise<void> {
    this.abortRequested = true;

    const active = this.activeTools;
    if (active) {
      for (const [, entry] of active) {
        entry.handle.abort();
      }
    }
    if (this.turnInFlight) this.manager.abort();

    const turn = this.currentTurn;
    if (turn) {
      await turn;
    } else if (!this.turnInFlight) {
      // Nothing in flight to unwind: settle here. A turn driven directly
      // through `runTurnLoop` unwinds itself, and its caller awaits it.
      this.finishAbort();
    }
  }

  private finishAbort(): void {
    this.abortRequested = false;
    if (this.currentPhase.type !== "yielded") {
      this.currentPhase = { type: "idle" };
    }
    this.deps.onUpdate();
    this.settle({ type: "aborted" });
  }

  private submission: Defer<SendResult> | undefined;

  send(inputMessages?: InputMessage[]): Promise<SendResult> {
    if (this.currentPhase.type === "yielded" && this.currentPhase.tornDown) {
      return Promise.reject(
        new Error(
          "This thread's container has been torn down. No further messages can be sent.",
        ),
      );
    }
    const deferred = new Defer<SendResult>();
    this.submission = deferred;
    this.submit(inputMessages).catch((error: Error) => {
      this.handleSendMessageError(error);
      this.settle({ type: "failed", error, discardedSubmission: true });
    });
    return deferred.promise;
  }

  private settle(outcome: SendResult): void {
    const deferred = this.submission;
    this.submission = undefined;
    this.deps.onUpdate();
    deferred?.resolve(outcome);
  }

  private async submit(inputMessages?: InputMessage[]): Promise<void> {
    this.openingRequestPending = true;
    // Whether a send with no user content is worth a request is the owner's
    // call: it probes its supervisors before it gets here, and the request it
    // decides to issue is composed inside the turn, by the gate.
    const { content } = this.prepareUserContent(inputMessages);

    this.preSubmitNativeIdx = this.manager.getNativeMessageIdx();
    this.deps.onUpdate();
    void this.runTurn(toAgentInput(content));
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

  /** The owner's verdict on a yield it has already been handed: the container
   * is gone, so nothing more can be sent to this thread. */
  markYieldAccepted(value: YieldValue, response: string): void {
    this.setPhase({ type: "yielded", response, value, tornDown: true });
  }

  private async onBeforeRequest(): Promise<OnBeforeRequestResult> {
    const isOpeningRequest = this.openingRequestPending;
    this.openingRequestPending = false;
    // Content seeded for this turn leads its opening request, ahead of the
    // supervisors' own injections. It is consumed here rather than at
    // `submit`, so a turn that never reaches the gate leaves it for the next.
    const lead = isOpeningRequest ? this.takeTurnPrefix() : [];
    const composed = await this.composeBeforeRequest(isOpeningRequest);
    const content =
      composed.type === "suspend"
        ? [...lead, ...composed.content]
        : [
            ...lead,
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
  private takeTurnPrefix(): AgentInput[] {
    const prefix = this.pendingTurnPrefix ?? [];
    this.pendingTurnPrefix = undefined;
    return prefix;
  }

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
