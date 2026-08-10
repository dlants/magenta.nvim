import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import { type AgentsMap, extractSystemReminderBlock } from "./agents/agents.ts";
import type { ContextTracker } from "./capabilities/context-tracker.ts";
import type { FileIO } from "./capabilities/file-io.ts";
import type { GitClient, GitState } from "./capabilities/git-client.ts";
import type { LspClient } from "./capabilities/lsp-client.ts";
import type { LuaExecutor } from "./capabilities/lua-executor.ts";
import type { ScriptRunner } from "./capabilities/script-runner.ts";
import type { Shell } from "./capabilities/shell.ts";
import type { ThreadManager } from "./capabilities/thread-manager.ts";
import type { SubagentConfig, ThreadId, ThreadType } from "./chat-types.ts";
import type {
  CompactionRecord,
  CompactionResult,
  CompactionStep,
} from "./compaction-controller.ts";
import { CompactionManager } from "./compaction-manager.ts";
import {
  buildClonedFiles,
  ContextManager,
  type Files,
} from "./context/context-manager.ts";
import {
  type GitContextUpdate,
  GitTracker,
  gitUpdateToText,
} from "./context/git-tracker.ts";
import type { EdlRegisters } from "./edl/index.ts";
import { Emitter } from "./emitter.ts";
import type { Logger } from "./logger.ts";
import type { ProviderProfile } from "./provider-options.ts";
import {
  getRetryDelay,
  isRetryableError,
  MAX_RETRY_DURATION,
} from "./providers/anthropic-agent.ts";
import type {
  Agent,
  AgentInput,
  AgentPhase,
  NativeMessageIdx,
  Provider,
  ProviderMessage,
  ProviderMessageContent,
  ProviderToolResult,
  ProviderToolSpec,
  RequestedTool,
  StopReason,
  StreamStopReason,
  ToolOutcome,
  ToolResults,
  TurnResult,
} from "./providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./providers/provider-types.ts";
import {
  formatSystemInfo,
  type SystemInfo,
  type SystemPrompt,
} from "./providers/system-prompt.ts";
import {
  buildSystemReminder,
  type ReminderKind,
} from "./providers/system-reminders.ts";
import { type ForkProvenance, ThreadLogger } from "./thread-logger.ts";
import type {
  EndTurnAction,
  EndTurnContext,
  HandoffAction,
  ThreadSupervisor,
  YieldAction,
} from "./thread-supervisor.ts";
import type {
  ToolInvocation,
  ToolName,
  ToolRequest,
  ToolRequestId,
  ToolStructuredResult,
} from "./tool-types.ts";
import { type CreateToolContext, createTool } from "./tools/create-tool.ts";
import type { MCPToolManager as MCPToolManagerImpl } from "./tools/mcp/manager.ts";
import * as Scratchpad from "./tools/scratchpad.ts";
import * as ThreadTitle from "./tools/thread-title.ts";
import type { ToolCapability } from "./tools/tool-registry.ts";
import { getToolSpecs } from "./tools/toolManager.ts";
import { assertUnreachable } from "./utils/assertUnreachable.ts";
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

/** `system_reminder` blocks are a magenta-side annotation; the provider only
 * ever sees plain text. */
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

export type ThreadMode =
  | { type: "normal" }
  | { type: "tool_use"; activeTools: Map<ToolRequestId, ActiveToolEntry> }
  | { type: "compacting"; chunkIndex: number; totalChunks: number }
  | {
      type: "yielded";
      response: string;
      tornDown?: boolean;
      teardownMessage?: string;
    };

export type EnvironmentConfig =
  | { type: "local"; cwd?: NvimCwd }
  | { type: "docker"; container: string; cwd: string };

export type TurnEndReason = "end_turn" | "aborted" | "error";

export type ThreadCoreEvents = {
  update: [];
  playChime: [];
  scrollToLastMessage: [];
  setupResubmit: [threadId: ThreadId, lastUserMessage: string];
  aborting: [];
  recoverPendingMessages: [threadId: ThreadId, text: string];
  pendingUpdatesChanged: [];
  turnEnded: [{ reason: TurnEndReason }];

  contextUpdatesSent: [updates: Record<string, unknown>];
  gitContextUpdateSent: [update: GitContextUpdate];
};

export interface ThreadCoreContext {
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
  initialGitState?: GitState | undefined;
  lspClient: LspClient;
  luaExecutor?: LuaExecutor | undefined;
  availableCapabilities: Set<ToolCapability>;
  environmentConfig: EnvironmentConfig;
  subagentDockerfile?: string;
  maxConcurrentSubagents: number;
  maxConcurrentFastSubagents: number;
  getAgents: () => AgentsMap;
  getProvider: (profile: ProviderProfile) => Provider;
  initialFiles?: Files;
  yieldSchema?: JSONSchemaType;
  /** Base dir for the conversation archive. Defaults to MAGENTA_TEMP_DIR. */
  conversationLogBaseDir?: string;
  /** Name of the magenta script that spawned this thread, if any. */
  scriptName?: string;
}

/** Minimum output tokens between system reminders during auto-respond loops */
const SYSTEM_REMINDER_MIN_TOKEN_INTERVAL = 2000;

/** Minimum output tokens between bash-summary reminders. */
const BASH_REMINDER_TOKEN_INTERVAL = 5000;

const CONTEXT_MANAGER_POLL_INTERVAL_MS = 1000;

export type ThreadCoreAction =
  | { type: "set-title"; title: string }
  | { type: "set-mode"; mode: ThreadMode }
  | {
      type: "set-active-tool-result";
      id: ToolRequestId;
      result: ProviderToolResult;
    }
  | { type: "increment-output-tokens"; tokens: number }
  | { type: "reset-output-tokens" }
  | { type: "set-teardown-message"; message: string }
  | { type: "push-pending-messages"; messages: InputMessage[] }
  | { type: "drain-pending-messages" }
  | { type: "push-pending-next-messages"; messages: InputMessage[] }
  | { type: "drain-pending-next-messages" }
  | { type: "push-compaction-record"; record: CompactionRecord }
  | { type: "reset-after-compaction" }
  | { type: "mark-bash-output-abbreviated" }
  | { type: "activate-reminder"; text: string }
  | { type: "reset-bash-reminder" }
  | {
      type: "set-failed-submit";
      value: { userMessage: string; errorMessage: string } | undefined;
    }
  | {
      type: "set-pre-submit-native-idx";
      idx: NativeMessageIdx | undefined;
    };

export class ThreadCore extends Emitter<ThreadCoreEvents> {
  public state: {
    title?: string;
    threadType: ThreadType;
    systemPrompt: SystemPrompt;
    systemInfo: SystemInfo;
    pendingMessages: InputMessage[];
    pendingNextMessages: InputMessage[];
    mode: ThreadMode;
    edlRegisters: EdlRegisters;
    scratchpad: Scratchpad.Scratchpad;
    outputTokensSinceLastReminder: number;
    compactionHistory: CompactionRecord[];
    editedFilesThisTurn: { path: AbsFilePath; snapshot: string }[];
    pendingBashReminder: boolean;
    bashTokensSinceLastReminder: number;
    firstBashReminderPending: boolean;
    failedSubmit: { userMessage: string; errorMessage: string } | undefined;
    /** How the most recent turn ended. Kept for rendering an idle agent. */
    lastTurnResult: TurnResult | undefined;
    preSubmitNativeIdx: NativeMessageIdx | undefined;
    activeReminders: Set<string>;
    toolSpecs: ProviderToolSpec[];
  };

  public agent: Agent;
  public contextManager: ContextManager;
  public gitTracker: GitTracker;
  public compactionController: CompactionManager | undefined;
  public supervisors: ThreadSupervisor[] = [];
  private threadLogger: ThreadLogger;

  constructor(
    public id: ThreadId,
    private context: ThreadCoreContext,
    clonedAgent?: Agent,
    forkProvenance?: ForkProvenance,
    initialState?: {
      scratchpad?: Scratchpad.Scratchpad;
      edlRegisters?: EdlRegisters;
    },
  ) {
    super();
    this.threadLogger = new ThreadLogger(
      id,
      context.threadType,
      () => this.getProviderMessages(),
      () => this.getProviderMessages().length,
      context.logger,
      {
        ...(context.conversationLogBaseDir !== undefined
          ? { baseDir: context.conversationLogBaseDir }
          : {}),
        ...(context.scriptName !== undefined
          ? { scriptName: context.scriptName }
          : {}),
        cwd: context.cwd,
        ...(forkProvenance ? { forkedFrom: forkProvenance } : {}),
      },
    );
    this.on("update", () => this.threadLogger.onUpdate());
    this.on("turnEnded", () => this.threadLogger.onTurnEnded());
    this.contextManager = new ContextManager(
      context.logger,
      context.fileIO,
      context.cwd,
      context.homeDir,
      context.initialFiles,
      CONTEXT_MANAGER_POLL_INTERVAL_MS,
    );
    this.contextManager.start();
    this.gitTracker = new GitTracker(
      context.gitClient,
      context.initialGitState,
      context.logger,
    );
    this.state = {
      threadType: context.threadType,
      systemPrompt: context.systemPrompt,
      systemInfo: context.systemInfo,
      pendingMessages: [],
      pendingNextMessages: [],
      mode: { type: "normal" },
      edlRegisters: initialState?.edlRegisters ?? {
        registers: new Map(),
        nextSavedId: 0,
      },
      scratchpad: initialState?.scratchpad ?? Scratchpad.emptyScratchpad(),
      outputTokensSinceLastReminder: 0,
      compactionHistory: [],
      editedFilesThisTurn: [],
      pendingBashReminder: false,
      bashTokensSinceLastReminder: 0,
      firstBashReminderPending: true,
      failedSubmit: undefined,
      lastTurnResult: undefined,
      preSubmitNativeIdx: undefined,
      activeReminders: new Set(),
      toolSpecs: [],
    };
    this.refreshToolSpecs();

    this.listenToContextManager();

    if (clonedAgent) {
      this.agent = clonedAgent;
      this.bindAgent(this.agent);
    } else {
      this.agent = this.createFreshAgent();
    }
  }

  /** Build an independent copy of `sourceCore` that resumes the conversation
   * frozen at `nativeMessageIdx`. The cloned agent is created exactly once
   * here and ownership is transferred to the new ThreadCore. The source is
   * not aborted and shares no mutable state with the result. */
  static async clone(args: {
    sourceCore: ThreadCore;
    newId: ThreadId;
    nativeMessageIdx: NativeMessageIdx;
    context: ThreadCoreContext;
  }): Promise<ThreadCore> {
    const { sourceCore, newId, nativeMessageIdx, context } = args;
    const agent = sourceCore.agent.clone();
    agent.truncateMessages(nativeMessageIdx);
    const initialFiles = await buildClonedFiles(
      sourceCore.contextManager.files,
      context.fileIO,
    );
    const contextWithFiles: ThreadCoreContext = {
      ...context,
      initialFiles,
      initialGitState: sourceCore.gitTracker.getAgentView(),
    };
    const cloned = new ThreadCore(
      newId,
      contextWithFiles,
      agent,
      {
        fromThreadId: sourceCore.id,
        nativeMessageIdx,
      },
      {
        scratchpad: Scratchpad.cloneScratchpad(sourceCore.state.scratchpad),
        edlRegisters: {
          registers: new Map(sourceCore.state.edlRegisters.registers),
          nextSavedId: sourceCore.state.edlRegisters.nextSavedId,
        },
      },
    );
    for (const [id, structured] of sourceCore.structuredToolResults) {
      cloned.structuredToolResults.set(id, structured);
    }
    return cloned;
  }

  private contextManagerListeners:
    | {
        fileAdded: () => void;
        fileRemoved: () => void;
        pendingUpdatesChanged: () => void;
      }
    | undefined;

  private listenToContextManager(): void {
    const listeners = {
      fileAdded: () => this.emit("update"),
      fileRemoved: () => this.emit("update"),
      pendingUpdatesChanged: () => this.emit("pendingUpdatesChanged"),
    };
    this.contextManagerListeners = listeners;
    this.contextManager.on("fileAdded", listeners.fileAdded);
    this.contextManager.on("fileRemoved", listeners.fileRemoved);
    this.contextManager.on(
      "pendingUpdatesChanged",
      listeners.pendingUpdatesChanged,
    );
  }

  private unlistenContextManager(): void {
    if (this.contextManagerListeners) {
      this.contextManager.off(
        "fileAdded",
        this.contextManagerListeners.fileAdded,
      );
      this.contextManager.off(
        "fileRemoved",
        this.contextManagerListeners.fileRemoved,
      );
      this.contextManager.off(
        "pendingUpdatesChanged",
        this.contextManagerListeners.pendingUpdatesChanged,
      );
      this.contextManagerListeners = undefined;
    }
  }

  private updateThrottleTimer: ReturnType<typeof setTimeout> | undefined;
  private updatePending = false;

  /** Bounded auto-resubmit bookkeeping for non-user-facing threads (subagent/
   * compact) recovering from a recoverable agent error. undefined means no
   * retry episode is in progress. Reset whenever the agent successfully
   * stops (see handleProviderStopped). Kept as a single struct so that
   * `attempt`/`firstErrorAt`/`timer` can never drift out of sync with each
   * other. */
  private errorRetry:
    | {
        timer: ReturnType<typeof setTimeout> | undefined;
        attempt: number;
        firstErrorAt: number;
      }
    | undefined;

  private clearErrorRetryTimer(): void {
    if (this.errorRetry?.timer) {
      clearTimeout(this.errorRetry.timer);
      this.errorRetry.timer = undefined;
    }
  }

  private resetErrorRetryState(): void {
    this.clearErrorRetryTimer();
    this.errorRetry = undefined;
  }

  private flushUpdate(): void {
    if (this.updatePending) {
      this.updatePending = false;
      this.emit("update");
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

  /** Flush any throttled update immediately. Used at turn boundaries so the
   * view reflects the final state before turn-end side effects run. */
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
  update(
    action: ThreadCoreAction,
    { silent }: { silent?: boolean } = {},
  ): void {
    switch (action.type) {
      case "set-title":
        this.state.title = action.title;
        this.threadLogger.recordTitle(action.title);
        break;
      case "set-mode":
        this.state.mode = action.mode;
        break;
      case "set-active-tool-result":
        if (action.result.result.status === "ok") {
          this.structuredToolResults.set(
            action.id,
            action.result.result.structuredResult,
          );
        }
        if (this.state.mode.type === "tool_use") {
          const entry = this.state.mode.activeTools.get(action.id);
          if (entry) {
            entry.result = action.result;
          }
        }
        break;
      case "increment-output-tokens":
        this.state.outputTokensSinceLastReminder += action.tokens;
        this.state.bashTokensSinceLastReminder += action.tokens;
        break;
      case "reset-output-tokens":
        this.state.outputTokensSinceLastReminder = 0;
        break;
      case "set-teardown-message":
        if (this.state.mode.type === "yielded") {
          this.state.mode.teardownMessage = action.message;
        }
        break;
      case "push-pending-messages":
        this.state.pendingMessages.push(...action.messages);
        break;
      case "drain-pending-messages":
        this.state.pendingMessages = [];
        break;
      case "push-pending-next-messages":
        this.state.pendingNextMessages.push(...action.messages);
        break;
      case "drain-pending-next-messages":
        this.state.pendingNextMessages = [];
        break;
      case "push-compaction-record":
        this.state.compactionHistory.push(action.record);
        break;
      case "reset-after-compaction":
        this.state.edlRegisters = { registers: new Map(), nextSavedId: 0 };
        this.state.scratchpad = Scratchpad.emptyScratchpad();
        this.state.outputTokensSinceLastReminder = 0;
        this.state.editedFilesThisTurn = [];
        this.state.pendingBashReminder = false;
        this.state.bashTokensSinceLastReminder = 0;
        this.state.firstBashReminderPending = true;
        this.state.activeReminders = new Set();
        break;
      case "mark-bash-output-abbreviated":
        this.state.pendingBashReminder = true;
        break;
      case "activate-reminder":
        this.state.activeReminders.add(action.text);
        break;
      case "reset-bash-reminder":
        this.state.pendingBashReminder = false;
        this.state.bashTokensSinceLastReminder = 0;
        this.state.firstBashReminderPending = false;
        break;
      case "set-failed-submit":
        this.state.failedSubmit = action.value;
        break;
      case "set-pre-submit-native-idx":
        this.state.preSubmitNativeIdx = action.idx;
        break;
      default:
        assertUnreachable(action);
    }
    if (!silent) {
      this.emit("update");
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

  /** Point an agent's collaborators at this thread. */
  private bindAgent(agent: Agent): void {
    agent.bindHooks({
      executeTools: (requests) => this.executeTools(requests),
      onUpdate: () => this.scheduleUpdate(),
    });
    this.usageAccountedCount = agent.log.messages.length;
    agent.onBeforeToolResponse = (args) => this.buildToolResponseExtras(args);
  }

  private createFreshAgent(): Agent {
    this.refreshToolSpecs();
    const provider = this.context.getProvider(this.context.profile);
    const agent = provider.createAgent({
      model: this.context.profile.model,
      systemPrompt: this.state.systemPrompt,
      executeTools: (requests) => this.executeTools(requests),
      onUpdate: () => this.scheduleUpdate(),
      tools: this.getToolSpecs(),
      ...((this.context.profile.provider === "anthropic" ||
        this.context.profile.provider === "bedrock" ||
        this.context.profile.provider === "mock") &&
        (() => {
          const effortOverride = this.context.subagentConfig?.effort;
          const baseThinking = this.context.profile.thinking;
          if (effortOverride) {
            return {
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
          if (baseThinking) {
            return { thinking: baseThinking };
          }
          return {};
        })()),
      ...(this.context.profile.reasoning &&
        (this.context.profile.provider === "openai" ||
          this.context.profile.provider === "mock") && {
          reasoning: this.context.profile.reasoning,
        }),
    });
    agent.onBeforeToolResponse = (args) => this.buildToolResponseExtras(args);
    this.usageAccountedCount = agent.log.messages.length;
    return agent;
  }

  getProviderStatus(): AgentPhase {
    return this.agent.phase;
  }

  /** For tests: await pending best-effort archive writes. */
  async awaitArchiveFlush(): Promise<void> {
    await this.threadLogger.flushed();
  }

  /** Structured tool results by request id, kept for the lifetime of the
   * thread. The provider strips `structuredResult` when serializing a tool
   * result to native form, so the rich renderers need this side channel. */
  readonly structuredToolResults = new Map<
    ToolRequestId,
    ToolStructuredResult
  >();

  getProviderMessages(): ReadonlyArray<ProviderMessage> {
    return this.agent.log.messages;
  }

  /** After a non-retryable error, roll back the agent's history to the
   * pre-submit snapshot captured by sendMessage. Used by the setup-resubmit
   * handler when populating the input buffer for the failing thread. */
  discardFailedSubmit(): void {
    if (this.state.preSubmitNativeIdx === undefined) {
      return;
    }
    const idx = this.state.preSubmitNativeIdx;
    this.update(
      { type: "set-pre-submit-native-idx", idx: undefined },
      { silent: true },
    );
    this.agent.truncateMessages(idx);
    this.emit("update");
  }

  getMessages(): ProviderMessage[] {
    return [...this.getProviderMessages()];
  }

  getLastStopTokenCount(): number {
    const state = this.agent.log;
    if (state.inputTokenCount !== undefined) {
      return state.inputTokenCount;
    }

    const latestUsage = state.latestUsage;
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

  setTitle(title: string): void {
    this.update({ type: "set-title", title });
  }

  /** The in-flight turn, if any. `runTurn` is the only thing that drives the
   * agent forward, so this is exactly "is this thread busy". */
  private currentTurn: Promise<void> | undefined;

  /** Content to lead the next turn's input with. Used by compaction to seed a
   * fresh agent with the summary before its first request. */
  private pendingTurnPrefix: AgentInput[] | undefined;

  /** Lead the next turn's input with `content`. Used to inject a marker (fork
   * notification, compaction summary) that has no turn of its own. */
  /** Content queued by `prependToNextTurn`, not yet handed to the agent. */
  get pendingTurnContent(): ReadonlyArray<AgentInput> {
    return this.pendingTurnPrefix ?? [];
  }

  prependToNextTurn(content: AgentInput[]): void {
    this.pendingTurnPrefix = [...(this.pendingTurnPrefix ?? []), ...content];
  }

  /** Set between the start of an abort and the resolution of the turn it
   * unwinds, so the tool executor knows to report `aborted`. */
  private abortRequested = false;

  /** Why the executor parked the agent. The agent never learns this; it comes
   * back out here when the turn resolves `suspended`. */
  private suspendReason:
    | { type: "yield"; result: string }
    | { type: "compact"; nextPrompt: string | undefined }
    | undefined;

  /** Number of messages whose usage has already been folded into the
   * reminder token counters. */
  private usageAccountedCount = 0;

  private accountUsage(): void {
    const messages = this.agent.log.messages;
    if (this.usageAccountedCount > messages.length) {
      this.usageAccountedCount = messages.length;
    }
    let outputTokens = 0;
    for (let i = this.usageAccountedCount; i < messages.length; i++) {
      outputTokens += messages[i].usage?.outputTokens ?? 0;
    }
    this.usageAccountedCount = messages.length;
    if (outputTokens > 0) {
      this.update(
        { type: "increment-output-tokens", tokens: outputTokens },
        { silent: true },
      );
    }
  }

  /** Drive the agent until it stops, then act on why it stopped. */
  private runTurn(input: AgentInput[]): Promise<void> {
    const prefix = this.pendingTurnPrefix ?? [];
    this.pendingTurnPrefix = undefined;
    const turn = this.agent
      .runTurn([...prefix, ...input])
      .then((result) => {
        this.currentTurn = undefined;
        this.flushUpdateNow();
        this.accountUsage();
        return this.handleTurnResult(result);
      })
      .catch(this.handleSendMessageError);
    this.currentTurn = turn;
    return turn;
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
        await this.handleSuspend();
        return;
      case "stopped":
        await this.handleStopped(result.stopReason);
        return;
      default:
        assertUnreachable(result);
    }
  }

  private async handleSuspend(): Promise<void> {
    const reason = this.suspendReason;
    this.suspendReason = undefined;
    if (!reason) return;
    if (reason.type === "compact") {
      this.startCompaction(reason.nextPrompt);
      return;
    }
    await this.handleYield(reason.result);
  }

  private async handleStopped(stopReason: StopReason): Promise<void> {
    this.resetErrorRetryState();
    this.update({ type: "set-mode", mode: { type: "normal" } });

    const handoff = this.consultHandoffSupervisors(stopReason);
    if (handoff.type === "compact") {
      this.startCompaction(handoff.nextPrompt);
      return;
    }

    if (stopReason === "max_tokens") {
      await this.sendMessage([
        {
          type: "system",
          text: "Your previous response was truncated due to the output token limit. Please continue where you left off.",
        },
      ]);
      return;
    }

    if (
      stopReason === "end_turn" &&
      (this.state.pendingMessages.length ||
        this.state.pendingNextMessages.length)
    ) {
      const pendingMessages = [
        ...this.state.pendingMessages,
        ...this.state.pendingNextMessages,
      ];
      this.update({ type: "drain-pending-messages" }, { silent: true });
      this.update({ type: "drain-pending-next-messages" }, { silent: true });
      await this.sendMessage(pendingMessages);
      return;
    }

    const action = this.consultEndTurnSupervisors({
      stopReason,
      lastAssistantMessage: this.getLastAssistantMessage(),
    });
    if (action.type === "send-message") {
      await this.sendMessage([{ type: "system", text: action.text }]);
      return;
    }

    this.emit("playChime");
    this.emit("turnEnded", { reason: "end_turn" });
  }

  private createToolContext(): CreateToolContext {
    return {
      mcpToolManager: this.context.mcpToolManager,
      threadId: this.id,
      logger: this.context.logger,
      lspClient: this.context.lspClient,
      cwd: this.context.cwd,
      homeDir: this.context.homeDir,
      maxConcurrentSubagents: this.context.maxConcurrentSubagents,
      maxConcurrentFastSubagents: this.context.maxConcurrentFastSubagents,
      contextTracker: this.contextManager as ContextTracker,
      onToolApplied: (absFilePath, tool, fileTypeInfo) => {
        this.contextManager.toolApplied(absFilePath, tool, fileTypeInfo);
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
      scratchpad: this.state.scratchpad,
      fileIO: this.context.fileIO,
      shell: this.context.shell,
      threadManager: this.context.threadManager,
      scriptRunner: this.context.getScriptRunner?.(),
      luaExecutor: this.context.luaExecutor,
      requestRender: () => this.emit("update"),
      getAgents: () => this.context.getAgents(),
    };
  }

  /** The agent's `executeTools` collaborator: run every requested tool to
   * completion, then say whether the conversation proceeds. */
  private async executeTools(
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
      const invocation = createTool(request, this.createToolContext());
      activeTools.set(request.id, {
        handle: invocation,
        progress: "progress" in invocation ? invocation.progress : undefined,
        toolName: request.toolName,
        request,
      });
    }

    this.update({ type: "set-mode", mode: { type: "tool_use", activeTools } });
    if (activeTools.size > 0) {
      this.emit("playChime");
    }

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
    for (const [id, entry] of activeTools) {
      if (entry.toolName === "yield_to_parent") {
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

    this.update({ type: "set-mode", mode: { type: "normal" } });

    if (this.abortRequested) {
      return { type: "aborted", results };
    }

    if (yieldResult !== undefined) {
      this.suspendReason = { type: "yield", result: yieldResult };
      return { type: "suspend", results };
    }

    const handoff = this.consultHandoffSupervisors("tool_use");
    if (handoff.type === "compact") {
      this.suspendReason = { type: "compact", nextPrompt: handoff.nextPrompt };
      return { type: "suspend", results };
    }

    return { type: "continue", results };
  }

  private handleErrorState(error: Error): void {
    const isUserFacing =
      this.state.threadType === "root" ||
      this.state.threadType === "docker_root";

    // Roll back to the pre-submit snapshot's user text for every thread
    // type, not just user-facing ones: subagent/compact threads need the
    // same text to auto-resubmit with (see maybeAutoResubmitAfterError).
    const pendingText = [
      ...this.state.pendingMessages,
      ...this.state.pendingNextMessages,
    ]
      .filter((m) => m.type === "user")
      .map((m) => m.text)
      .join("\n");
    this.update({ type: "drain-pending-messages" });
    this.update({ type: "drain-pending-next-messages" });

    const messages = this.getProviderMessages();
    const lastMessage = messages[messages.length - 1];
    const baseText =
      lastMessage?.role === "user"
        ? lastMessage.content
            .filter(
              (c): c is Extract<typeof c, { type: "text" }> =>
                c.type === "text",
            )
            .map((c) => c.text)
            .join("")
        : "";
    const userMessage = pendingText
      ? baseText
        ? `${baseText}\n${pendingText}`
        : pendingText
      : baseText;

    if (isUserFacing) {
      if (userMessage) {
        this.update(
          {
            type: "set-failed-submit",
            value: { userMessage, errorMessage: error.message },
          },
          { silent: true },
        );
        setTimeout(() => this.emit("setupResubmit", this.id, userMessage), 1);
      }
    } else {
      this.maybeAutoResubmitAfterError(error, userMessage);
    }
    this.context.logger.error(error);
    this.emit("turnEnded", { reason: "error" });
  }

  /** For subagent/compact threads (no human to manually resubmit), retry a
   * recoverable error automatically by rolling back the failed submit and
   * resending the same user message, following the same bounded-backoff
   * shape as the agent's own mid-stream retries (RETRY_DELAYS, capped by
   * MAX_RETRY_DURATION). Non-recoverable errors, or errors that persist past
   * the retry budget, leave the thread parked in its error/pending state —
   * the same as an aborted thread that is never resumed. */
  private maybeAutoResubmitAfterError(error: Error, userMessage: string): void {
    if (!userMessage) {
      this.resetErrorRetryState();
      return;
    }

    const now = Date.now();
    const firstErrorAt = this.errorRetry?.firstErrorAt ?? now;
    const elapsed = now - firstErrorAt;

    if (!isRetryableError(error) || elapsed >= MAX_RETRY_DURATION) {
      this.resetErrorRetryState();
      return;
    }

    const attempt = this.errorRetry?.attempt ?? 0;
    const delay = getRetryDelay(attempt);
    this.clearErrorRetryTimer();
    this.errorRetry = {
      firstErrorAt,
      attempt: attempt + 1,
      timer: setTimeout(() => {
        if (this.errorRetry) {
          this.errorRetry.timer = undefined;
        }
        this.discardFailedSubmit();
        this.sendMessage([{ type: "user", text: userMessage }]).catch(
          this.handleSendMessageError.bind(this),
        );
      }, delay),
    };
  }

  async abort(): Promise<void> {
    // A yielded thread has already completed its work — don't overwrite its state.
    if (this.state.mode.type === "yielded") {
      return;
    }
    await this.abortAndWait();
  }

  /** Cancel whichever of the two things the turn can be waiting on — the
   * in-flight inference request (the agent's own resource) or the running
   * tools (ours) — and wait for the turn to unwind. */
  private async abortAndWait(): Promise<void> {
    this.resetErrorRetryState();
    this.abortRequested = true;
    this.emit("aborting");

    if (this.state.mode.type === "tool_use") {
      for (const [, entry] of this.state.mode.activeTools) {
        entry.handle.abort();
      }
    }
    this.agent.abort();

    const turn = this.currentTurn;
    if (turn) {
      await turn;
    } else {
      this.finishAbort();
    }
  }

  private finishAbort(): void {
    this.abortRequested = false;
    this.emit("update");
    this.recoverPendingMessagesOnAbort();
    this.update({ type: "set-mode", mode: { type: "normal" } });
    this.emit("turnEnded", { reason: "aborted" });
  }

  private recoverPendingMessagesOnAbort(): void {
    const pendingText = [
      ...this.state.pendingMessages,
      ...this.state.pendingNextMessages,
    ]
      .filter((m) => m.type === "user")
      .map((m) => m.text)
      .join("\n");

    this.update({ type: "drain-pending-messages" });
    this.update({ type: "drain-pending-next-messages" });

    const isUserFacing =
      this.state.threadType === "root" ||
      this.state.threadType === "docker_root";
    if (isUserFacing && pendingText) {
      this.emit("recoverPendingMessages", this.id, pendingText);
    }
  }

  async sendMessage(inputMessages?: InputMessage[]): Promise<void> {
    if (this.state.mode.type === "yielded" && this.state.mode.tornDown) {
      throw new Error(
        "This thread's container has been torn down. No further messages can be sent.",
      );
    }

    if (this.state.failedSubmit !== undefined) {
      this.update(
        { type: "set-failed-submit", value: undefined },
        { silent: true },
      );
    }

    this.state.editedFilesThisTurn = [];

    const {
      content: contextContent,
      updates: contextUpdates,
      gitUpdate,
    } = await this.getAndPrepareContextUpdates();

    const { content, hasContent } = this.prepareUserContent(inputMessages);

    if (!hasContent && contextContent.length === 0) {
      return;
    }

    if (contextUpdates) {
      this.emit("contextUpdatesSent", contextUpdates);
    }
    if (gitUpdate) {
      this.emit("gitContextUpdateSent", gitUpdate);
    }

    const isFirstMessage = this.getProviderMessages().length === 0;
    const contentToSend: AgentInput[] = [...contextContent];

    contentToSend.push(...toAgentInput(content));

    if (isFirstMessage) {
      contentToSend.push({
        type: "text",
        text: formatSystemInfo(this.context.systemInfo),
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      });
    }

    this.update(
      {
        type: "set-pre-submit-native-idx",
        idx: this.agent.getNativeMessageIdx(),
      },
      { silent: true },
    );
    this.emit("update");
    void this.runTurn(contentToSend);
  }

  async handleSendMessageRequest(
    messages: InputMessage[],
    queue?: "async" | "next",
  ): Promise<void> {
    if (this.state.threadType === "compact") {
      this.sendRawMessage(messages);
      return;
    }

    const isBusy =
      this.currentTurn !== undefined || this.state.mode.type === "tool_use";

    if (isBusy) {
      if (queue === "async") {
        this.update(
          { type: "push-pending-messages", messages },
          { silent: true },
        );
        return;
      } else if (queue === "next") {
        this.update(
          { type: "push-pending-next-messages", messages },
          { silent: true },
        );
        return;
      } else {
        await this.abortAndWait();
      }
    }

    await this.sendMessage(messages);

    if (!this.state.title) {
      this.setThreadTitle(messages.map((m) => m.text).join("\n")).catch(
        (err: Error) =>
          this.context.logger.error(
            `Error getting thread title: ${err.message}\n${err.stack}`,
          ),
      );
    }

    if (messages.length) {
      setTimeout(() => this.emit("scrollToLastMessage"), 100);
    }
  }

  private getLastAssistantMessage():
    | ReadonlyArray<ProviderMessageContent>
    | undefined {
    const messages = this.agent.log.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        return messages[i].content;
      }
    }
    return undefined;
  }

  private async handleYield(yieldResult: string): Promise<void> {
    const action = await this.consultYieldSupervisors(yieldResult);
    switch (action.type) {
      case "accept": {
        const response = action.resultPrefix
          ? `${action.resultPrefix}\n\n${yieldResult}`
          : yieldResult;
        this.update({
          type: "set-mode",
          mode: { type: "yielded", response, tornDown: true },
        });
        break;
      }
      case "none":
        this.update({
          type: "set-mode",
          mode: { type: "yielded", response: yieldResult },
        });
        break;
      case "reject":
        await this.sendMessage([{ type: "system", text: action.message }]);
        return;
      case "send-message":
        await this.sendMessage([{ type: "system", text: action.text }]);
        return;
      default:
        assertUnreachable(action);
    }
  }

  private async getAndPrepareContextUpdates(): Promise<{
    content: AgentInput[];
    updates: Record<string, unknown> | undefined;
    gitUpdate: GitContextUpdate | undefined;
  }> {
    const content: AgentInput[] = [];

    const gitUpdate = await this.gitTracker.getUpdate();
    if (gitUpdate) {
      content.push({
        type: "text",
        text: gitUpdateToText(gitUpdate),
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      });
    }

    const contextUpdates = await this.contextManager.getContextUpdate();
    if (Object.keys(contextUpdates).length === 0) {
      return { content, updates: undefined, gitUpdate };
    }

    const contextContent =
      this.contextManager.contextUpdatesToContent(contextUpdates);
    for (const c of contextContent) {
      if (c.type === "text") {
        content.push({
          type: "text",
          text: c.text,
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        });
      } else if (c.type === "image" || c.type === "document") {
        content.push(c);
      }
    }

    return { content, updates: contextUpdates, gitUpdate };
  }

  /** The union of transient get_files-read reminders and reminders derived from
   * markdown files currently in context, deduped on text. */
  private getActiveReminders(): string[] {
    const reminders = new Set(this.state.activeReminders);
    for (const key of Object.keys(this.contextManager.files)) {
      const fileInfo = this.contextManager.files[key as AbsFilePath];
      if (!fileInfo) continue;
      if (!key.toLowerCase().endsWith(".md")) continue;
      if (fileInfo.agentView?.type !== "text") continue;
      const reminder = extractSystemReminderBlock(fileInfo.agentView.content);
      if (reminder) reminders.add(reminder);
    }
    const scratchpadLine = Scratchpad.scratchpadReminder(this.state.scratchpad);
    if (scratchpadLine) reminders.add(scratchpadLine);
    return [...reminders];
  }

  /** The agent's `onBeforeToolResponse` hook: extra content to ride along
   * with the request that carries the tool results. */
  private async buildToolResponseExtras(args: {
    stopReason: StreamStopReason;
    results: ToolResults;
  }): Promise<AgentInput[]> {
    this.accountUsage();

    for (const result of args.results.values()) {
      if (result.status === "ok") {
        const structured = result.structuredResult;
        if (
          structured.toolName === "bash_command" &&
          "wasAbbreviated" in structured &&
          structured.wasAbbreviated
        ) {
          this.update(
            { type: "mark-bash-output-abbreviated" },
            { silent: true },
          );
        }
        if (structured.toolName === "get_files" && "files" in structured) {
          for (const file of structured.files) {
            if (file.systemReminder) {
              this.update(
                { type: "activate-reminder", text: file.systemReminder },
                { silent: true },
              );
            }
          }
        }
      }
    }

    const pendingMessages = this.state.pendingMessages;
    if (pendingMessages.length > 0) {
      this.update({ type: "drain-pending-messages" }, { silent: true });
    }

    const {
      content: contextContent,
      updates: contextUpdates,
      gitUpdate,
    } = await this.getAndPrepareContextUpdates();

    const contentToSend: AgentInput[] = [...contextContent];

    if (pendingMessages.length > 0) {
      const { content } = this.prepareUserContent(pendingMessages);
      contentToSend.push(...toAgentInput(content));
      if (contextUpdates) {
        this.emit("contextUpdatesSent", contextUpdates);
      }
      if (gitUpdate) {
        this.emit("gitContextUpdateSent", gitUpdate);
      }
      return contentToSend;
    }

    const reminderKinds: ReminderKind[] = [];
    const subsequentReminderFires =
      this.state.outputTokensSinceLastReminder >=
      SYSTEM_REMINDER_MIN_TOKEN_INTERVAL;
    const bashReminderFires =
      this.state.pendingBashReminder &&
      (this.state.firstBashReminderPending ||
        this.state.bashTokensSinceLastReminder >= BASH_REMINDER_TOKEN_INTERVAL);

    if (subsequentReminderFires) reminderKinds.push("subsequent");
    if (bashReminderFires) reminderKinds.push("bashSummary");

    if (reminderKinds.length > 0) {
      const reminder = buildSystemReminder({
        threadType: this.state.threadType,
        subagentConfig: this.context.subagentConfig,
        kinds: reminderKinds,
        extraReminders: this.getActiveReminders(),
      });
      if (reminder) {
        contentToSend.push({
          type: "text",
          text: reminder,
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        });
      }
      if (subsequentReminderFires) {
        this.update({ type: "reset-output-tokens" }, { silent: true });
      }
      if (bashReminderFires) {
        this.update({ type: "reset-bash-reminder" }, { silent: true });
      }
    }

    if (contextUpdates) {
      this.emit("contextUpdatesSent", contextUpdates);
    }
    if (gitUpdate) {
      this.emit("gitContextUpdateSent", gitUpdate);
    }

    return contentToSend;
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
    if (inputMessages?.length) {
      this.update({ type: "reset-output-tokens" }, { silent: true });
      const reminder = buildSystemReminder({
        threadType: this.state.threadType,
        subagentConfig: this.context.subagentConfig,
        kinds: ["subsequent"],
        extraReminders: this.getActiveReminders(),
      });
      if (reminder) {
        messageContent.push({
          type: "system_reminder",
          text: reminder,
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        });
      }
    }

    return {
      content: messageContent,
      hasContent: (inputMessages?.length ?? 0) > 0,
    };
  }

  private sendRawMessage(messages: InputMessage[]): void {
    const contentToSend: AgentInput[] = messages.map((m) => ({
      type: "text" as const,
      text: m.text,
      nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
    }));

    if (contentToSend.length === 0) return;

    void this.runTurn(contentToSend);
  }

  startCompaction(nextPrompt?: string): void {
    const manager = new CompactionManager({
      logger: this.context.logger,
      profile: this.context.profile,
      mcpToolManager: this.context.mcpToolManager,
      threadId: this.id,
      cwd: this.context.cwd,
      homeDir: this.context.homeDir,
      lspClient: this.context.lspClient,
      availableCapabilities: this.context.availableCapabilities,
      contextManager: this.contextManager,
      shell: this.context.shell,
      threadManager: this.context.threadManager,
      maxConcurrentSubagents: this.context.maxConcurrentSubagents,
      maxConcurrentFastSubagents: this.context.maxConcurrentFastSubagents,
      getProvider: this.context.getProvider,
      requestRender: () => this.emit("update"),
      initialScratchpad: Scratchpad.cloneScratchpad(this.state.scratchpad),
    });
    manager.on("transition", (_prev, next) => {
      if (next.type === "complete") {
        this.handleCompactionResult(next.result);
      } else if (next.type === "error") {
        this.handleCompactionResult({ type: "error", steps: next.steps });
      } else if (
        next.type === "processing-chunk" ||
        next.type === "waiting-for-tools"
      ) {
        this.update({
          type: "set-mode",
          mode: {
            type: "compacting",
            chunkIndex: next.chunkIndex,
            totalChunks: next.totalChunks,
          },
        });
      }
    });
    this.compactionController = manager;
    manager.start(this.getProviderMessages(), nextPrompt);
  }

  private handleCompactionResult(result: CompactionResult): void {
    this.compactionController = undefined;
    this.update({ type: "set-mode", mode: { type: "normal" } });

    if (result.type === "complete") {
      this.handleCompactComplete(
        result.summary,
        result.nextPrompt,
        result.steps,
        result.scratchpad,
      ).catch((e: Error) => {
        this.context.logger.error(
          `Failed during compact-complete: ${e.message}`,
        );
      });
    } else {
      this.update({
        type: "push-compaction-record",
        record: { steps: result.steps, finalSummary: undefined },
      });
    }
  }

  private async handleCompactComplete(
    summary: string,
    nextPrompt: string | undefined,
    steps: CompactionStep[],
    scratchpad: Scratchpad.Scratchpad,
  ): Promise<void> {
    this.update({
      type: "push-compaction-record",
      record: { steps, finalSummary: summary },
    });

    this.unlistenContextManager();
    this.contextManager.destroy();
    this.contextManager = new ContextManager(
      this.context.logger,
      this.context.fileIO,
      this.context.cwd,
      this.context.homeDir,
      undefined,
      CONTEXT_MANAGER_POLL_INTERVAL_MS,
    );
    this.contextManager.start();
    this.listenToContextManager();

    this.agent = this.createFreshAgent();
    this.threadLogger.recordCompaction({ summary, chunkCount: steps.length });
    this.threadLogger.resetCursor();

    this.update({ type: "reset-after-compaction" });
    this.state.scratchpad = scratchpad;

    const summaryText = `<conversation-summary>\n${summary}\n</conversation-summary>`;
    this.pendingTurnPrefix = [
      {
        type: "text",
        text: summaryText,
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ];

    if (nextPrompt) {
      await this.sendMessage([{ type: "user", text: nextPrompt }]);
    } else {
      await this.sendMessage([
        { type: "user", text: "Please continue from where you left off." },
      ]);
    }
  }

  private consultEndTurnSupervisors(context: EndTurnContext): EndTurnAction {
    const texts: string[] = [];
    for (const sup of this.supervisors) {
      const action = sup.onEndTurnWithoutYield?.(context);
      if (action && action.type === "send-message") texts.push(action.text);
    }
    if (texts.length === 0) return { type: "none" };
    return { type: "send-message", text: texts.join("\n\n") };
  }

  private async consultYieldSupervisors(result: string): Promise<YieldAction> {
    const texts: string[] = [];
    for (const sup of this.supervisors) {
      const action = await sup.onYield?.(result);
      if (!action) continue;
      if (action.type === "accept" || action.type === "reject") return action;
      if (action.type === "send-message") texts.push(action.text);
    }
    if (texts.length === 0) return { type: "none" };
    return { type: "send-message", text: texts.join("\n\n") };
  }

  private consultHandoffSupervisors(
    stopReason: StreamStopReason,
  ): HandoffAction {
    const inputTokenCount = this.agent.log.inputTokenCount;
    const prompts: string[] = [];
    let shouldCompact = false;
    for (const sup of this.supervisors) {
      const action = sup.onHandoff?.({ inputTokenCount, stopReason });
      if (action && action.type === "compact") {
        shouldCompact = true;
        if (action.nextPrompt !== undefined) prompts.push(action.nextPrompt);
      }
    }
    if (!shouldCompact) return { type: "none" };
    return prompts.length > 0
      ? { type: "compact", nextPrompt: prompts.join("\n\n") }
      : { type: "compact" };
  }

  async setThreadTitle(userMessage: string): Promise<void> {
    const profileForRequest: ProviderProfile = {
      ...this.context.profile,
      thinking: undefined,
      reasoning: undefined,
    };

    const request = this.context.getProvider(profileForRequest).forceToolUse({
      model: this.context.profile.fastModel,
      input: [
        {
          type: "text",
          text: `\
The user has provided the following prompt:
${userMessage}

Come up with a succinct thread title for this prompt. It must be a single line (no newlines) and a few words long (ideally around 40 characters or fewer).
`,
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ],
      spec: ThreadTitle.spec,
      systemPrompt: this.state.systemPrompt,
      disableCaching: true,
    });
    const result = await request.promise;
    if (result.toolRequest.status === "ok") {
      this.setTitle(
        (result.toolRequest.value.input as ThreadTitle.Input).title,
      );
    }
  }

  private destroyed = false;

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    this.clearErrorRetryTimer();

    if (this.updateThrottleTimer) {
      clearTimeout(this.updateThrottleTimer);
    }

    try {
      await this.abort();
    } catch {
      // ignore
    }

    this.unlistenContextManager();
    this.contextManager.destroy();

    this.removeAllListeners();
  }
}
