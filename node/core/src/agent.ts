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
import type { CompactionRecord } from "./compaction-controller.ts";
import type {
  CommentStore,
  CommentUpdateEntry,
} from "./context/comment-store.ts";
import type {
  ContextManager,
  Files,
  FileUpdates,
} from "./context/context-manager.ts";
import {
  type GitContextUpdate,
  type GitTracker,
  gitUpdateToText,
} from "./context/git-tracker.ts";
import type { EdlRegisters } from "./edl/index.ts";
import type { Logger } from "./logger.ts";
import type { ProviderProfile } from "./provider-options.ts";
import {
  getRetryDelay,
  isRetryableError,
  MAX_RETRY_DURATION,
} from "./providers/anthropic-runner.ts";
import type {
  AgentInput,
  AgentPhase,
  NativeMessageIdx,
  Provider,
  ProviderMessage,
  ProviderMessageContent,
  ProviderToolResult,
  ProviderToolSpec,
  RequestedTool,
  Runner,
  RunnerHooks,
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
import type {
  AgentHooks,
  OnUpdate,
  QueuedMessage,
  SendResult,
  YieldValue,
} from "./thread-api.ts";
import type {
  EndTurnAction,
  EndTurnContext,
  RequestContextKind,
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
      /** What this thread yields. Minted where the yield tool's input was
       * still structured, so nothing has to parse `response` back out. */
      value: YieldValue;
      tornDown?: boolean;
    };

export type EnvironmentConfig =
  | { type: "local"; cwd?: NvimCwd }
  | { type: "docker"; container: string; cwd: string };

/** Structured records the owning `Thread` wants attached to the message an
 * injection produced. Stage 6 turns these into `onBeforeRequest` injections
 * that ride on the message; until then they are two narrow callbacks rather
 * than a broadcast channel. */
export type ContextUpdateSink = {
  onContextUpdatesSent?: (updates: FileUpdates) => void;
  onCommentUpdatesSent?: (entries: CommentUpdateEntry[]) => void;
  onGitContextUpdateSent?: (update: GitContextUpdate) => void;
};
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
}

/** Minimum output tokens between system reminders during auto-respond loops */
const SYSTEM_REMINDER_MIN_TOKEN_INTERVAL = 2000;

/** Minimum output tokens between bash-summary reminders. */
const BASH_REMINDER_TOKEN_INTERVAL = 5000;

export type AgentAction =
  | { type: "set-title"; title: string }
  | { type: "set-mode"; mode: ThreadMode }
  | {
      type: "set-active-tool-result";
      id: ToolRequestId;
      result: ProviderToolResult;
    }
  | { type: "increment-output-tokens"; tokens: number }
  | { type: "reset-output-tokens" }
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
      value: { userMessage: string; error: Error } | undefined;
    }
  | {
      type: "set-pre-submit-native-idx";
      idx: NativeMessageIdx | undefined;
    };

export type ThreadState = {
  title: string | undefined;
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
  failedSubmit: { userMessage: string; error: Error } | undefined;
  /** How the most recent turn ended. Kept for rendering an idle agent. */
  lastTurnResult: TurnResult | undefined;
  preSubmitNativeIdx: NativeMessageIdx | undefined;
  activeReminders: Set<string>;
  toolSpecs: ProviderToolSpec[];
};

/** Collaborators the owning `Thread` supplies. An `Agent` is ephemeral —
 * compaction replaces it — so everything durable (identity, the queue, the
 * context managers, the archive) lives on the `Thread` and is handed in. */
export interface AgentDeps {
  /** Only used to stamp tool contexts and outgoing events; the agent has no
   * identity of its own. */
  threadId: ThreadId;
  state: ThreadState;
  contextManager: ContextManager;
  gitTracker: GitTracker;
  structuredToolResults: Map<ToolRequestId, ToolStructuredResult>;
  /** The owner's answers to the agent's three questions. Arbitration between
   * several policies is the owner's business (see `composeSupervisors`). */
  getHooks: () => AgentHooks;
  /** "Something visible moved." Unthrottled: the recipient coalesces with a
   * trailing-edge debounce. */
  onUpdate: OnUpdate;
  /** The root thread's side conversations, drained alongside the context
   * update. A function because the owning `Thread` may be handed one after
   * its first agent exists, and compaction swaps the agent underneath. */
  getCommentStore: () => CommentStore | undefined;
  contextUpdateSink: ContextUpdateSink;
  /** Whether this agent drives a brand-new runner or one cloned from another
   * thread's history. */
  runnerInit:
    | { type: "new" }
    | {
        /** The source runner is cloned by this agent, so that the clone is
         * born with this agent's hooks and never points at its source's. */
        type: "cloned";
        cloneFrom: Runner;
        truncateTo: NativeMessageIdx;
      };
}

/** Where a submission ends up. `compact` is not a `SendResult`: the agent has
 * stopped, but the submission is not over — the owning `Thread` runs the
 * handoff and keeps the caller's promise pending across it. */
export type SubmitOptions = {
  /** Skip context updates, reminders and failed-submit bookkeeping: the caller
   * has composed the exact content (the compact thread). */
  raw?: boolean;
  /** Which kind of request this is. A "continuation" (the requests issued out
   * of `handleStopped`) has already had `onBeforeRequest` consulted for it, so
   * the hook is not consulted again. Defaults to "submission". */
  requestKind?: "submission" | "continuation";
};

/** A handoff to a fresh, compacted agent. `nextPrompt` is what the new agent
 * is asked to do first, if anything. */
export type Compaction = { nextPrompt: string | undefined };
export type AgentSendOutcome = SendResult | ({ type: "compact" } & Compaction);

/** Outcome of consulting the before-request hooks. `injections` is non-empty
 * only when the caller asked to receive them (`injections: "return"`) instead
 * of having them appended to the log. */
type BeforeRequestResult =
  | { type: "compact"; compaction: Compaction }
  | { type: "proceed"; injections: AgentInput[] };

export class Agent {
  public state: ThreadState;
  public runner: Runner;
  public readonly contextManager: ContextManager;
  public readonly gitTracker: GitTracker;
  /** Structured tool results by request id, kept for the lifetime of the
   * thread (so it outlives this agent). The provider strips
   * `structuredResult` when serializing a tool result to native form, so the
   * rich renderers need this side channel. */
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
    this.contextManager = deps.contextManager;
    this.gitTracker = deps.gitTracker;
    this.structuredToolResults = deps.structuredToolResults;
    this.refreshToolSpecs();

    if (deps.runnerInit.type === "cloned") {
      this.runner = deps.runnerInit.cloneFrom.clone(this.runnerHooks());
      this.runner.truncateMessages(deps.runnerInit.truncateTo);
      this.usageAccountedCount = this.runner.log.messages.length;
    } else {
      this.runner = this.createRunner();
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
  update(action: AgentAction, { silent }: { silent?: boolean } = {}): void {
    switch (action.type) {
      case "set-title":
        this.state.title = action.title;
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

  /** The collaborators every runner this agent creates is bound to. */
  private runnerHooks(): RunnerHooks {
    return {
      executeTools: (requests) => this.executeTools(requests),
      onUpdate: () => this.scheduleUpdate(),
      onBeforeToolResponse: (args) => this.buildToolResponseExtras(args),
    };
  }

  private createRunner(): Runner {
    this.refreshToolSpecs();
    const provider = this.context.getProvider(this.context.profile);
    const agent = provider.createAgent({
      model: this.context.profile.model,
      systemPrompt: this.state.systemPrompt,
      ...this.runnerHooks(),
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
    this.usageAccountedCount = agent.log.messages.length;
    return agent;
  }

  getProviderStatus(): AgentPhase {
    return this.runner.phase;
  }

  getProviderMessages(): ReadonlyArray<ProviderMessage> {
    return this.runner.log.messages;
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
    this.runner.truncateMessages(idx);
    this.deps.onUpdate();
  }

  getMessages(): ProviderMessage[] {
    return [...this.getProviderMessages()];
  }

  getLastStopTokenCount(): number {
    const state = this.runner.log;
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

  /** The in-flight turn, if any. `runTurn` is the only thing that drives the
   * agent forward, so this is exactly "is this thread busy". */
  private currentTurn: Promise<void> | undefined;

  /** `runTurn` is the only thing that drives the runner forward, so this is
   * exactly "is this agent busy". */
  get isBusy(): boolean {
    return (
      this.currentTurn !== undefined || this.state.mode.type === "tool_use"
    );
  }

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
    | { type: "yield"; result: string; value: YieldValue }
    | ({ type: "compact" } & Compaction)
    | undefined;

  /** Number of messages whose usage has already been folded into the
   * reminder token counters. */
  private usageAccountedCount = 0;

  private accountUsage(): void {
    const messages = this.runner.log.messages;
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
    const turn = this.runner
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
      this.settle({ type: "compact", nextPrompt: reason.nextPrompt });
      return;
    }
    await this.handleYield(reason.result, reason.value);
  }

  private async handleStopped(stopReason: StopReason): Promise<void> {
    this.resetErrorRetryState();
    this.update({ type: "set-mode", mode: { type: "normal" } });

    const beforeRequest = await this.applyBeforeRequestActions(
      { kind: "continuation", stopReason },
      "append",
    );
    if (beforeRequest.type === "compact") {
      // The submission is not over: the owning Thread runs the handoff and
      // continues it on the replacement agent.
      this.settle({
        type: "compact",
        nextPrompt: beforeRequest.compaction.nextPrompt,
      });
      return;
    }

    if (stopReason === "max_tokens") {
      await this.submit(
        [
          {
            type: "system",
            text: "Your previous response was truncated due to the output token limit. Please continue where you left off.",
          },
        ],
        { requestKind: "continuation" },
      );
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
      await this.submit(pendingMessages, { requestKind: "continuation" });
      return;
    }

    const action = this.consultEndTurnSupervisors({
      stopReason,
      lastAssistantMessage: this.getLastAssistantMessage(),
    });
    if (action.type === "send-message") {
      await this.submit([{ type: "system", text: action.text }], {
        requestKind: "continuation",
      });
      return;
    }

    this.settle({ type: "completed" });
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
      contextTracker: this.contextManager as ContextTracker,
      onToolApplied: (absFilePath, tool, fileTypeInfo) => {
        this.contextManager.toolApplied(absFilePath, tool, fileTypeInfo);
        try {
          this.deps.getHooks().onToolApplied?.(absFilePath, tool, fileTypeInfo);
        } catch (error) {
          // fire-and-forget: a throwing subscriber must not break the
          // editedFilesThisTurn bookkeeping below.
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
      scratchpad: this.state.scratchpad,
      fileIO: this.context.fileIO,
      shell: this.context.shell,
      threadManager: this.context.threadManager,
      scriptRunner: this.context.getScriptRunner?.(),
      luaExecutor: this.context.luaExecutor,
      commentStore: this.deps.getCommentStore(),
      requestRender: () => this.deps.onUpdate(),
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
      let invocation;
      try {
        invocation = createTool(request, this.createToolContext());
      } catch (err) {
        // a tool whose capability is missing must surface as a tool error
        // rather than tearing down the turn
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

    this.update({ type: "set-mode", mode: { type: "tool_use", activeTools } });

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

    this.update({ type: "set-mode", mode: { type: "normal" } });

    if (this.abortRequested) {
      return { type: "aborted", results };
    }

    if (yieldResult !== undefined && yieldValue !== undefined) {
      this.suspendReason = {
        type: "yield",
        result: yieldResult,
        value: yieldValue,
      };
      return { type: "suspend", results };
    }

    const beforeRequest = await this.applyBeforeRequestActions(
      { kind: "continuation", stopReason: "tool_use" },
      "pending",
    );
    if (beforeRequest.type === "compact") {
      this.suspendReason = {
        type: "compact",
        nextPrompt: beforeRequest.compaction.nextPrompt,
      };
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
            value: { userMessage, error },
          },
          { silent: true },
        );
      }
    } else {
      this.maybeAutoResubmitAfterError(error, userMessage);
    }
    this.context.logger.error(error);
    // A scheduled auto-resubmit means the submission is still going; only a
    // submission that has come to rest in an error state settles.
    if (this.errorRetry?.timer === undefined) {
      this.settle({
        type: "failed",
        error,
        resubmit: isUserFacing && userMessage ? userMessage : undefined,
      });
    }
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
        this.submit([{ type: "user", text: userMessage }]).catch(
          this.handleSendMessageError.bind(this),
        );
      }, delay),
    };
  }

  /** The queue drained by the abort in flight, handed to whoever aborted. */
  private unsentOnAbort: QueuedMessage[] = [];

  async abort(): Promise<{ unsent: QueuedMessage[] }> {
    // A yielded thread has already completed its work — don't overwrite its state.
    if (this.state.mode.type === "yielded") {
      return { unsent: [] };
    }
    return await this.abortAndWait();
  }

  /** Cancel whichever of the two things the turn can be waiting on — the
   * in-flight inference request (the agent's own resource) or the running
   * tools (ours) — and wait for the turn to unwind. */
  async abortAndWait(): Promise<{ unsent: QueuedMessage[] }> {
    this.unsentOnAbort = [];
    this.resetErrorRetryState();
    this.abortRequested = true;

    if (this.state.mode.type === "tool_use") {
      for (const [, entry] of this.state.mode.activeTools) {
        entry.handle.abort();
      }
    }
    this.runner.abort();

    const turn = this.currentTurn;
    if (turn) {
      await turn;
    } else {
      this.finishAbort();
    }
    return { unsent: this.unsentOnAbort };
  }

  private finishAbort(): void {
    this.abortRequested = false;
    this.deps.onUpdate();
    this.drainQueueOnAbort();
    this.update({ type: "set-mode", mode: { type: "normal" } });
    this.settle({ type: "aborted" });
  }

  /** Drain the queue on abort and hand the debris back to whoever aborted.
   * Nothing is broadcast: the caller gets its own return value. */
  private drainQueueOnAbort(): void {
    this.unsentOnAbort = [
      ...this.state.pendingMessages.map(
        (m): QueuedMessage => ({ when: "async", messages: [m] }),
      ),
      ...this.state.pendingNextMessages.map(
        (m): QueuedMessage => ({ when: "next", messages: [m] }),
      ),
    ];
    this.update({ type: "drain-pending-messages" });
    this.update({ type: "drain-pending-next-messages" });
  }

  /** The submission currently in flight, settled at the moment the agent comes
   * to rest. Internal continuations — auto-respond, supervisor nudges, the
   * max_tokens continue-prompt, a rejected yield — deliberately leave it
   * pending, so exactly one outcome is delivered per `send`. */
  private submission: Defer<AgentSendOutcome> | undefined;

  /** Issue a submission and resolve once the agent comes to rest.
   *
   * `raw` skips context updates, reminders and the failed-submit bookkeeping:
   * it is how the compact thread talks to the provider, where the caller has
   * already composed the exact content. */
  send(
    inputMessages?: InputMessage[],
    opts: SubmitOptions = {},
  ): Promise<AgentSendOutcome> {
    if (this.state.mode.type === "yielded" && this.state.mode.tornDown) {
      return Promise.reject(
        new Error(
          "This thread's container has been torn down. No further messages can be sent.",
        ),
      );
    }
    const deferred = new Defer<AgentSendOutcome>();
    this.submission = deferred;
    this.submit(inputMessages, opts).catch((error: Error) => {
      this.handleSendMessageError(error);
      this.settle({ type: "failed", error, resubmit: undefined });
    });
    return deferred.promise;
  }

  /** Deliver the outcome of the in-flight submission, if any. The final
   * `update` goes out first so a trailing-edge debouncer paints the terminal
   * state before the caller sees the result. */
  private settle(outcome: AgentSendOutcome): void {
    const deferred = this.submission;
    this.submission = undefined;
    this.deps.onUpdate();
    deferred?.resolve(outcome);
  }

  /** Compose and issue one provider request. Called both by `send` and by the
   * internal continuations, which is why it never touches `submission`. */
  private async submit(
    inputMessages?: InputMessage[],
    opts: SubmitOptions = {},
  ): Promise<void> {
    if (opts.raw) {
      const rawContent: AgentInput[] = (inputMessages ?? []).map((m) => ({
        type: "text" as const,
        text: m.text,
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      }));
      if (rawContent.length === 0) {
        this.settle({ type: "completed" });
        return;
      }
      void this.runTurn(rawContent);
      return;
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

    const beforeRequest: BeforeRequestResult =
      opts.requestKind === "continuation"
        ? { type: "proceed", injections: [] }
        : await this.applyBeforeRequestActions(
            { kind: "submission" },
            "return",
          );
    if (beforeRequest.type === "compact") {
      // The injections are already in the log; the user's own content has to
      // join them there so the compaction snapshot carries it too.
      this.runner.appendUserMessage(
        [...contextContent, ...toAgentInput(content)],
        { coalesce: true },
      );
      this.settle({
        type: "compact",
        nextPrompt: beforeRequest.compaction.nextPrompt,
      });
      return;
    }

    const injections = beforeRequest.injections;
    if (!hasContent && contextContent.length === 0 && injections.length === 0) {
      this.settle({ type: "completed" });
      return;
    }

    if (contextUpdates) {
      this.deps.contextUpdateSink.onContextUpdatesSent?.(contextUpdates);
    }
    if (gitUpdate) {
      this.deps.contextUpdateSink.onGitContextUpdateSent?.(gitUpdate);
    }
    this.commitCommentUpdates();

    const isFirstMessage = this.getProviderMessages().length === 0;
    const contentToSend: AgentInput[] = [...contextContent, ...injections];

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
        idx: this.runner.getNativeMessageIdx(),
      },
      { silent: true },
    );
    this.deps.onUpdate();
    void this.runTurn(contentToSend);
  }

  private getLastAssistantMessage():
    | ReadonlyArray<ProviderMessageContent>
    | undefined {
    const messages = this.runner.log.messages;
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
        // A prefixed text yield reports the prefixed text; a structured yield
        // is what the schema says it is, prefix or not.
        const value: YieldValue =
          yieldValue.type === "structured"
            ? yieldValue
            : { type: "text", text: response };
        this.update({
          type: "set-mode",
          mode: { type: "yielded", response, value, tornDown: true },
        });
        this.settleYield(value);
        break;
      }
      case "none":
        this.update({
          type: "set-mode",
          mode: { type: "yielded", response: yieldResult, value: yieldValue },
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

  /** A yield is the end of the submission that produced it. The value was
   * minted where the tool's input was still structured, so nothing here has to
   * parse the response text back. */
  private settleYield(value: YieldValue): void {
    this.settle({ type: "yielded", value });
  }

  private async getAndPrepareContextUpdates(): Promise<{
    content: AgentInput[];
    updates: FileUpdates | undefined;
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
      this.appendCommentUpdates(content);
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

    this.appendCommentUpdates(content);
    return { content, updates: contextUpdates, gitUpdate };
  }

  /** The `<comment_update>` block, if the user has undelivered comments. Pure:
   * nothing is marked delivered until `commitCommentUpdates` runs, past the
   * early-settle guard. */
  private appendCommentUpdates(content: AgentInput[]): void {
    const text = this.deps.getCommentStore()?.getPendingUpdate();
    if (text === undefined) return;
    content.push({
      type: "text",
      text,
      nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
    });
  }

  /** Mark the comment messages that rode out on this request as delivered, and
   * hand the structured entries to the owner's display ledger. */
  private commitCommentUpdates(): void {
    const store = this.deps.getCommentStore();
    if (!store) return;
    const entries = store.commitPending();
    if (entries.length) {
      this.deps.contextUpdateSink.onCommentUpdatesSent?.(entries);
    }
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

    const contentToSend: AgentInput[] = [
      ...this.pendingInjections,
      ...contextContent,
    ];
    this.pendingInjections = [];

    if (pendingMessages.length > 0) {
      const { content } = this.prepareUserContent(pendingMessages);
      contentToSend.push(...toAgentInput(content));
      if (contextUpdates) {
        this.deps.contextUpdateSink.onContextUpdatesSent?.(contextUpdates);
      }
      if (gitUpdate) {
        this.deps.contextUpdateSink.onGitContextUpdateSent?.(gitUpdate);
      }
      this.commitCommentUpdates();
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
      this.deps.contextUpdateSink.onContextUpdatesSent?.(contextUpdates);
    }
    if (gitUpdate) {
      this.deps.contextUpdateSink.onGitContextUpdateSent?.(gitUpdate);
    }
    this.commitCommentUpdates();

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

  private consultEndTurnSupervisors(context: EndTurnContext): EndTurnAction {
    return this.deps.getHooks().onEndTurn?.(context) ?? { type: "none" };
  }

  private async consultYieldSupervisors(
    value: YieldValue,
  ): Promise<YieldAction> {
    const onYield = this.deps.getHooks().onYield;
    if (!onYield) return { type: "none" };
    return await onYield(value);
  }

  /** Consult the before-request hooks and apply their actions in order.
   * Injections are appended to the message log immediately — unconditionally,
   * so nothing the agent does next (a failure, an abort, a compaction handoff)
   * can lose them. Returns the compaction the list asks for, if any. */
  /** Injections produced on the tool_use path, held until the tool results
   * have been written. Anthropic requires the tool_result blocks to
   * immediately follow the tool_use they answer, so injected content cannot be
   * appended between the two — it rides `buildToolResponseExtras` instead. */
  private pendingInjections: AgentInput[] = [];
  private async applyBeforeRequestActions(
    context: RequestContextKind,
    mode: "append" | "pending" | "return",
  ): Promise<BeforeRequestResult> {
    const onBeforeRequest = this.deps.getHooks().onBeforeRequest;
    if (!onBeforeRequest) return { type: "proceed", injections: [] };
    const plan = await onBeforeRequest({
      ...context,
      inputTokenCount: this.runner.log.inputTokenCount,
    });
    const injections: AgentInput[] = plan.injections.map((content) =>
      content.type === "text"
        ? {
            type: "text" as const,
            text: content.text,
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          }
        : content,
    );
    // A deferred injection would be dropped by the agent swap, so a compaction
    // forces the append: the content belongs in the snapshot handed over.
    if (plan.compaction) {
      this.runner.appendUserMessage(injections, { coalesce: true });
      return { type: "compact", compaction: plan.compaction };
    }
    switch (mode) {
      case "append":
        this.runner.appendUserMessage(injections, { coalesce: true });
        return { type: "proceed", injections: [] };
      case "pending":
        this.pendingInjections.push(...injections);
        return { type: "proceed", injections: [] };
      case "return":
        return { type: "proceed", injections };
    }
  }

  private disposed = false;

  /** Abort and release this agent's own resources. The durable collaborators
   * (context manager, git tracker, archive) belong to the owning `Thread` and
   * are deliberately untouched: compaction disposes an agent and builds
   * another one against the same collaborators. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    this.clearErrorRetryTimer();

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
