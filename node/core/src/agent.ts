import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import type { AgentsMap } from "./agents/agents.ts";
import type { ContextTracker } from "./capabilities/context-tracker.ts";
import type { FileIO } from "./capabilities/file-io.ts";
import type { GitClient } from "./capabilities/git-client.ts";
import type { LspClient } from "./capabilities/lsp-client.ts";
import type { LuaExecutor } from "./capabilities/lua-executor.ts";
import type { ScriptRunner } from "./capabilities/script-runner.ts";
import type { Shell } from "./capabilities/shell.ts";
import type { ThreadManager } from "./capabilities/thread-manager.ts";
import type { SubagentConfig, ThreadId, ThreadType } from "./chat-types.ts";
import type { CommentStore } from "./context/comment-store.ts";
import type { EdlRegisters } from "./edl/index.ts";
import type { Logger } from "./logger.ts";
import type { ProviderProfile } from "./provider-options.ts";
import { ABORT_MARKER_TEXT } from "./providers/inference-shared.ts";
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
import type { SuspendReason, YieldAction } from "./thread-supervisor.ts";
import type {
  ToolInvocation,
  ToolName,
  ToolRequest,
  ToolRequestId,
  ToolStructuredResult,
} from "./tool-types.ts";
import { type CreateToolContext, createTool } from "./tools/create-tool.ts";
import type { MCPToolManager as MCPToolManagerImpl } from "./tools/mcp/manager.ts";
import type { ToolCapability } from "./tools/tool-registry.ts";
import { getToolSpecs } from "./tools/toolManager.ts";
import { assertUnreachable } from "./utils/assertUnreachable.ts";
import { Defer } from "./utils/async.ts";
import type { AbsFilePath, HomeDir, NvimCwd } from "./utils/files.ts";

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

/** The phase as one flat label, for logging and test assertions. */
export function phaseLabel(phase: AgentPhase): string {
  return phase.type === "running" ? phase.activity.type : phase.type;
}
/** The live tool invocations, when tools are actually running. `undefined`
 * covers both "not a tool-running phase" and "the invocations have settled";
 * a caller that needs to tell those apart narrows `phase` itself. */

/** The block currently being streamed, if a request is in flight. */
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
  /** Unwinding: the tools have been told to stop and the history is being left
   * well-formed. Only reachable from a turn in flight. */
  | { type: "aborting" }
  /** Terminal for practical purposes: the model called `yield_to_parent` and
   * the supervisors accepted. */
  | {
      type: "yielded";
      response: string;
      value: YieldValue;
      tornDown: boolean;
    };

export type EnvironmentConfig =
  | { type: "local"; cwd?: NvimCwd }
  | { type: "docker"; container: string; cwd: string };

export interface AgentContext {
  logger: Logger;
  profile: ProviderProfile;
  cwd: NvimCwd;
  homeDir: HomeDir;
  threadType: ThreadType;
  subagentConfig?: SubagentConfig;
  systemPrompt: SystemPrompt;
  systemInfo: SystemInfo;
  mcpToolManager: MCPToolManagerImpl;
  threadManager: ThreadManager;
  getScriptRunner?: () => ScriptRunner | undefined;
  fileIO: FileIO;
  shell: Shell;
  gitClient: GitClient;
  lspClient: LspClient;
  luaExecutor?: LuaExecutor | undefined;
  availableCapabilities: Set<ToolCapability>;
  environmentConfig: EnvironmentConfig;
  subagentDockerfile?: string;
  maxConcurrentSubagents: number;
  maxConcurrentFastSubagents: number;
  getAgents: () => AgentsMap;
  getProvider: (profile: ProviderProfile) => Provider;
  contextTracker: ContextTracker;
  commentStore?: CommentStore | undefined;
  yieldSchema?: JSONSchemaType;
}

export type AgentAction =
  | { type: "set-title"; title: string }
  | {
      type: "set-active-tool-result";
      id: ToolRequestId;
      result: ProviderToolResult;
    }
  | { type: "reset-agent-state" };

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
  threadId: ThreadId;
  state: ThreadState;
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

/** ToolResults are always inserted into the runner, so we always end in a valid state.
 * This means we can later send another request, or append more messages.
 */
export type ToolOutcome =
  | { type: "continue"; results: ToolResults }
  | { type: "suspend"; results: ToolResults }
  | { type: "aborted"; results: ToolResults };

export type ToolExecutor = (
  requests: ReadonlyArray<RequestedTool>,
) => Promise<ToolOutcome>;
export type BeforeRequestDecision =
  | { type: "proceed" }
  | { type: "suspend"; reason: SuspendReason };
/** What the gate decided, plus whether it put anything in the log. */
type GateOutcome = {
  decision: BeforeRequestDecision;
  appended: boolean;
};

/** A suspended composition cannot carry submissions: a drained queue is not
 * content to send but content already folded into `content`, which the gate
 * records in the log so it is not lost. */
type ComposedBeforeRequest =
  | { type: "suspend"; reason: SuspendReason; content: AgentInput[] }
  | { type: "proceed"; injections: AgentInput[]; submissions: InputMessage[] };

export class Agent {
  public state: ThreadState;
  /** The provider-specific conversation. `Agent` owns the loop that drives it. */
  public manager: NativeInferenceManager;
  /** The turn loop's state, and the only thing callers observe about it. Only
   * the loop writes it; callers read it through `phase`. */
  private currentPhase: AgentPhase = { type: "idle" };
  get phase(): AgentPhase {
    return this.currentPhase;
  }
  private setPhase(phase: AgentPhase): void {
    this.currentPhase = phase;
    this.deps.onUpdate();
  }
  /** Where the turn's tool invocations are. Written by the executor and read
   * by anything that has to reach a running tool. Replaces the phase rather
   * than mutating it, so `TurnActivity` stays a value. */
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
  private readonly threadId: ThreadId;

  constructor(
    private context: AgentContext,
    private deps: AgentDeps,
  ) {
    this.threadId = deps.threadId;
    this.state = deps.state;
    this.structuredToolResults = deps.structuredToolResults;
    this.refreshToolSpecs();

    if (deps.runnerInit.type === "cloned") {
      this.manager = deps.runnerInit.cloneFrom.clone();
      this.manager.truncateMessages(deps.runnerInit.truncateTo);
    } else {
      this.manager = this.createManager();
    }
  }

  private updateThrottleTimer: ReturnType<typeof setTimeout> | undefined;
  private updatePending = false;

  private flushUpdate(): void {
    if (this.updatePending) {
      this.updatePending = false;
      this.deps.onUpdate();
    }
  }

  private scheduleUpdate(): void {
    this.updatePending = true;
    if (!this.updateThrottleTimer) {
      this.updateThrottleTimer = setTimeout(() => {
        this.updateThrottleTimer = undefined;
        this.flushUpdate();
      }, 32);
    }
  }

  private flushUpdateNow(): void {
    if (this.updateThrottleTimer) {
      clearTimeout(this.updateThrottleTimer);
      this.updateThrottleTimer = undefined;
    }
    this.updatePending = false;
  }

  /** Process a state mutation. Calls onUpdate() unless silent is true.
   *  Use silent for internal bookkeeping that doesn't need a view re-render.
   */
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
      case "reset-agent-state":
        this.state.edlRegisters = { registers: new Map(), nextSavedId: 0 };
        this.state.editedFilesThisTurn = [];
        break;
      default:
        assertUnreachable(action);
    }
    if (!silent) {
      this.deps.onUpdate();
    }
  }

  refreshToolSpecs(): void {
    this.state.toolSpecs = getToolSpecs(
      this.state.threadType,
      this.context.mcpToolManager,
      this.context.availableCapabilities,
      this.context.getAgents(),
      this.context.subagentConfig,
      this.context.yieldSchema,
      this.context.getScriptRunner?.()?.getScriptCatalog(),
      this.context.subagentDockerfile,
    );
  }

  getToolSpecs(): ProviderToolSpec[] {
    return this.state.toolSpecs;
  }

  /** Pick the one provider-specific inference config the profile's provider
   * can act on. */
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
    this.refreshToolSpecs();
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

  /** Why the tool executor asked to suspend. Only the yield case exists: a
   * supervisor's suspension travels back on the `TurnResult` itself. */
  private pendingYield: { result: string; value: YieldValue } | undefined;

  private outputTokenCount(): number {
    let total = 0;
    for (const message of this.manager.log.messages) {
      total += message.usage?.outputTokens ?? 0;
    }
    return total;
  }

  private runTurn(input: AgentInput[]): Promise<void> {
    // The seeded prefix is not passed in: it leads the request the gate
    // composes, so the gate is what consumes it.
    const turn = this.runTurnLoop(input)
      .then((result) => {
        this.currentTurn = undefined;
        this.flushUpdateNow();
        return this.handleTurnResult(result);
      })
      .catch(this.handleSendMessageError);
    this.currentTurn = turn;
    return turn;
  }
  /** True between the start and the settling of a turn. */
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
      return await this.runLoop(input);
    } finally {
      this.turnInFlight = false;
      this.abortRequested = false;
      this.currentPhase = { type: "idle" };
      this.stopTicker();
      // At rest there must be no update still queued behind the throttle: the
      // final notification is this one.
      this.flushUpdateNow();
      this.deps.onUpdate();
    }
  }
  /** Alternates between inference and tool execution until something ends the
   * turn. This is the only thing that drives the agent forward. */
  private async runLoop(initialInput: AgentInput[]): Promise<TurnResult> {
    let pending: AgentInput[] | undefined = initialInput;
    while (true) {
      if (this.abortRequested) return this.finishTurnAbort();

      const gate = await this.onBeforeRequest();
      // After the gate, so the owner's injections sit ahead of the caller's
      // own content — and in the same user message as them, but not folded
      // into whatever the log happened to end with otherwise.
      if (pending) {
        this.manager.appendUserMessage(
          pending,
          gate.appended ? { coalesce: true } : undefined,
        );
        this.scheduleUpdate();
        pending = undefined;
      }
      if (gate.decision.type === "suspend") {
        return { type: "suspended", reason: gate.decision.reason };
      }
      if (this.abortRequested) return this.finishTurnAbort();

      const outcome = await this.streamOneResponse();

      if (outcome.type === "aborted") return this.finishTurnAbort();
      if (outcome.type === "error") {
        this.manager.finalize({ type: "error", error: outcome.error });
        return { type: "failed", error: outcome.error };
      }

      const requested = outcome.requested;
      if (requested.length === 0) {
        // Without tool_use blocks the provider's reason is the turn's reason.
        return {
          type: "stopped",
          stopReason:
            outcome.stopReason === "tool_use" ? "end_turn" : outcome.stopReason,
        };
      }

      if (this.abortRequested) return this.finishTurnAbort();

      this.currentPhase = {
        type: "running",
        activity: {
          type: "running_tools",
          requested,
          truncated: outcome.stopReason === "max_tokens",
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

      this.manager.appendToolResults(requested, toolOutcome.results);
      // Not throttled: this is the transition from live tool progress to
      // rendered results, and the view must not show progress for a tool the
      // log has already answered.
      this.deps.onUpdate();

      if (toolOutcome.type === "aborted") {
        this.abortRequested = true;
        return this.finishTurnAbort();
      }
      if (toolOutcome.type === "suspend") return { type: "suspended" };
      if (this.abortRequested) return this.finishTurnAbort();
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
    this.scheduleUpdate();
  }
  /** The single terminal abort transition: leave the history well-formed and
   * mark why it stops here. */
  private finishTurnAbort(): TurnResult {
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
    this.scheduleUpdate();
    return { type: "aborted" };
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
        await this.handleSuspend(result.reason);
        return;
      case "stopped":
        this.handleStopped(result.stopReason);
        return;
      default:
        assertUnreachable(result);
    }
  }

  private async handleSuspend(
    supervisorReason?: SuspendReason | undefined,
  ): Promise<void> {
    if (supervisorReason) {
      this.settle({ type: "suspended", reason: supervisorReason });
      return;
    }
    const pending = this.pendingYield;
    this.pendingYield = undefined;
    if (!pending) return;
    await this.handleYield(pending.result, pending.value);
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
      this.scheduleUpdate();
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

  private createToolContext(): CreateToolContext {
    return {
      mcpToolManager: this.context.mcpToolManager,
      threadId: this.threadId,
      logger: this.context.logger,
      lspClient: this.context.lspClient,
      cwd: this.context.cwd,
      homeDir: this.context.homeDir,
      maxConcurrentSubagents: this.context.maxConcurrentSubagents,
      maxConcurrentFastSubagents: this.context.maxConcurrentFastSubagents,
      contextTracker: this.context.contextTracker,
      onToolApplied: (absFilePath, tool, fileTypeInfo) => {
        try {
          this.deps.getHooks().onToolApplied?.(absFilePath, tool, fileTypeInfo);
        } catch (error) {
          this.context.logger.error(
            `onToolApplied hook threw: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (
          tool.type === "edl-edit" &&
          !this.state.editedFilesThisTurn.some((e) => e.path === absFilePath)
        ) {
          this.state.editedFilesThisTurn.push({
            path: absFilePath,
            snapshot: tool.previousContent,
          });
        }
      },
      edlRegisters: this.state.edlRegisters,
      fileIO: this.context.fileIO,
      shell: this.context.shell,
      threadManager: this.context.threadManager,
      scriptRunner: this.context.getScriptRunner?.(),
      luaExecutor: this.context.luaExecutor,
      commentStore: this.context.commentStore,
      requestRender: () => this.deps.onUpdate(),
      getAgents: () => this.context.getAgents(),
    };
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
        invocation = createTool(request, this.createToolContext());
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
      [...activeTools].map(([id, entry]) =>
        entry.handle.promise.then(
          (result) =>
            this.update({ type: "set-active-tool-result", id, result }),
          (err: Error) =>
            this.update({
              type: "set-active-tool-result",
              id,
              result: {
                type: "tool_result",
                id,
                result: {
                  status: "error",
                  error: `Tool execution failed: ${err.message}`,
                },
                nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
              },
            }),
        ),
      ),
    );

    let yieldResult: string | undefined;
    let yieldValue: YieldValue | undefined;
    for (const [id, entry] of activeTools) {
      if (entry.toolName === "yield_to_parent") {
        yieldValue =
          this.context.yieldSchema !== undefined
            ? { type: "structured", value: entry.request.input }
            : {
                type: "text",
                text: (entry.request.input as { result: string }).result,
              };
        yieldResult =
          this.context.yieldSchema !== undefined
            ? JSON.stringify(entry.request.input)
            : (entry.request.input as { result: string }).result;
        results.set(id, {
          status: "ok",
          value: [
            {
              type: "text",
              text: "Yield accepted. Your result has been sent to the parent thread.",
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
            },
          ],
          structuredResult: { toolName: "yield_to_parent" as ToolName },
        });
        continue;
      }
      if (entry.result) {
        results.set(id, entry.result.result);
      }
    }

    for (const hook of this.deps.getHooks().onToolResults) {
      hook(results);
    }
    // Nothing is running any more: `activeTools` means *live* invocations, and
    // the view switches from tool progress to results the moment it empties.
    this.setToolInvocationState({ type: "settled" });

    if (this.abortRequested) {
      return { type: "aborted", results };
    }

    if (yieldResult !== undefined && yieldValue !== undefined) {
      this.pendingYield = {
        result: yieldResult,
        value: yieldValue,
      };
      return { type: "suspend", results };
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
    this.state.editedFilesThisTurn = [];
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

  private async handleYield(
    yieldResult: string,
    yieldValue: YieldValue,
  ): Promise<void> {
    const action = await this.consultYieldSupervisors(yieldValue);
    switch (action.type) {
      case "accept": {
        const response = action.resultPrefix
          ? `${action.resultPrefix}\n\n${yieldResult}`
          : yieldResult;
        const value: YieldValue =
          yieldValue.type === "structured"
            ? yieldValue
            : { type: "text", text: response };
        this.setPhase({ type: "yielded", response, value, tornDown: true });
        this.settleYield(value);
        break;
      }
      case "none":
        this.setPhase({
          type: "yielded",
          response: yieldResult,
          value: yieldValue,
          tornDown: false,
        });
        this.settleYield(yieldValue);
        break;
      case "reject":
        await this.submit([{ type: "system", text: action.message }]);
        return;
      case "send-message":
        await this.submit([{ type: "system", text: action.text }]);
        return;
      default:
        assertUnreachable(action);
    }
  }

  private settleYield(value: YieldValue): void {
    this.settle({ type: "yielded", value });
  }

  /** The runner is at the top of a loop iteration, about to issue a request.
   * Whatever the supervisors produce is appended here, so it rides that
   * request: on the opening request it lands ahead of the caller's own
   * content, and on a continuation it folds into the message carrying the
   * tool results. */
  private async onBeforeRequest(): Promise<GateOutcome> {
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
      this.manager.appendUserMessage(
        content,
        isOpeningRequest ? undefined : { coalesce: true },
      );
      this.scheduleUpdate();
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

  /** The first `accept`/`reject` wins outright — later hooks are not
   * consulted, since the decision is made — and `send-message` texts
   * concatenate. */
  private async consultYieldSupervisors(
    value: YieldValue,
  ): Promise<YieldAction> {
    const texts: string[] = [];
    for (const hook of this.deps.getHooks().onYield) {
      const action = await hook(value);
      if (action.type === "accept" || action.type === "reject") return action;
      if (action.type === "send-message") texts.push(action.text);
    }
    if (texts.length === 0) return { type: "none" };
    return { type: "send-message", text: texts.join("\n\n") };
  }

  /** Consult the supervisors. Nothing is appended here: placing what they
   * produce — and ordering it against the turn's own content — belongs to the
   * one caller, `onBeforeRequest`. */
  private async composeBeforeRequest(
    isOpeningRequest: boolean,
  ): Promise<ComposedBeforeRequest> {
    const injections: AgentInput[] = [];
    const submissions: InputMessage[] = [];
    let suspend: SuspendReason | undefined;
    let counted = false;
    for (const hook of this.deps.getHooks().onBeforeRequest) {
      // Lazily, once, and never once the request is already suspended: a
      // count nobody will act on is a round trip for nothing.
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

    if (this.updateThrottleTimer) {
      clearTimeout(this.updateThrottleTimer);
    }

    try {
      await this.abort();
    } catch {
      // ignore
    }
  }
}
