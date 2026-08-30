import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import { type AgentsMap, extractSystemReminderBlock } from "./agents/agents.ts";
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
import type { SystemInfo, SystemPrompt } from "./providers/system-prompt.ts";
import {
  buildSystemReminder,
  type ReminderKind,
} from "./providers/system-reminders.ts";
import type {
  AgentHooks,
  OnUpdate,
  SendResult,
  YieldValue,
} from "./thread-api.ts";
import type {
  RequestContextKind,
  SuspendReason,
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
  /** A synchronous, read-only view of the tracked files. Read from inside
   * tool execution and from the markdown-reminder scan, so it cannot be a
   * hook. The owner hands in the very object its `FileContextSupervisor`
   * owns. */
  contextTracker: ContextTracker;
  /** The root thread's side conversations, needed by the `reply` tool. The
   * same store the owner's `CommentSupervisor` owns. */
  commentStore?: CommentStore | undefined;
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
  | { type: "reset-agent-state" }
  | { type: "mark-bash-output-abbreviated" }
  | { type: "activate-reminder"; text: string }
  | { type: "reset-bash-reminder" };

export type ThreadState = {
  title: string | undefined;
  threadType: ThreadType;
  systemPrompt: SystemPrompt;
  systemInfo: SystemInfo;
  mode: ThreadMode;
  edlRegisters: EdlRegisters;
  outputTokensSinceLastReminder: number;
  editedFilesThisTurn: { path: AbsFilePath; snapshot: string }[];
  pendingBashReminder: boolean;
  bashTokensSinceLastReminder: number;
  firstBashReminderPending: boolean;
  /** How the most recent turn ended. Kept for rendering an idle agent. */
  lastTurnResult: TurnResult | undefined;
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
  structuredToolResults: Map<ToolRequestId, ToolStructuredResult>;
  /** The owner's answers to the agent's three questions. Arbitration between
   * several policies is the owner's business (see `composeSupervisors`). */
  getHooks: () => AgentHooks;
  /** "Something visible moved." Unthrottled: the recipient coalesces with a
   * trailing-edge debounce. */
  onUpdate: OnUpdate;
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

export type SubmitOptions = {
  /** Which kind of request this is. A "continuation" (the requests issued out
   * of `handleStopped`) has already had `onBeforeRequest` consulted for it, so
   * the hook is not consulted again. Defaults to "submission". */
  requestKind?: "submission" | "continuation";
};

/** Outcome of consulting the before-request hooks. `injections` is non-empty
 * only when the caller asked to receive them (`injections: "return"`) instead
 * of having them appended to the log. */
export type BeforeRequestResult =
  | { type: "suspend"; reason: SuspendReason }
  | { type: "proceed"; injections: AgentInput[] };

export class Agent {
  public state: ThreadState;
  public runner: Runner;
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
      case "reset-agent-state":
        this.state.edlRegisters = { registers: new Map(), nextSavedId: 0 };
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

  /** Where the log stood before the in-flight request, so a failure can undo
   * it. Private: rollback is the agent's own business, and it completes
   * before the failure is reported. */
  private preSubmitNativeIdx: NativeMessageIdx | undefined;

  /** Roll the agent's history back to the snapshot taken before the in-flight
   * request. Idempotent: the snapshot is cleared, so a second failure cannot
   * truncate to a stale index. */
  private rollbackToPreSubmit(): void {
    if (this.preSubmitNativeIdx === undefined) {
      return;
    }
    const idx = this.preSubmitNativeIdx;
    this.preSubmitNativeIdx = undefined;
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
    | { type: "supervisor"; reason: SuspendReason }
    | undefined;

  /** Number of messages whose usage has already been folded into the
   * reminder token counters. */
  private usageAccountedCount = 0;

  /** Cumulative output tokens across the log. Messages without recorded usage
   * — user messages, and the assistant message still streaming — contribute
   * nothing rather than making the total unknown: this feeds a monotonic
   * "tokens since the last reminder" gate, where an under-count only delays a
   * reminder by one request, and an `undefined` total would stall it entirely. */
  private outputTokenCount(): number {
    let total = 0;
    for (const message of this.runner.log.messages) {
      total += message.usage?.outputTokens ?? 0;
    }
    return total;
  }

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
        this.handleStopped(result.stopReason);
        return;
      default:
        assertUnreachable(result);
    }
  }

  private async handleSuspend(): Promise<void> {
    const reason = this.suspendReason;
    this.suspendReason = undefined;
    if (!reason) return;
    if (reason.type === "supervisor") {
      this.settle({ type: "suspended", reason: reason.reason });
      return;
    }
    await this.handleYield(reason.result, reason.value);
  }

  /** Consult the before-request supervisors for the request the owner's loop
   * is about to issue (or decline to issue). Injections are held as the next
   * turn's prefix, since a stop is not itself a request. */
  applyStopHooks(
    kind: "continuation" | "turn-end",
    stopReason: StopReason,
  ): Promise<BeforeRequestResult> {
    return this.applyBeforeRequestActions({ kind, stopReason }, "prefix");
  }

  get lastAssistantMessage():
    | ReadonlyArray<ProviderMessageContent>
    | undefined {
    return this.getLastAssistantMessage();
  }

  /** A stop is the end of the agent's turn loop. Whether anything follows it
   * is the owner's decision, so the submission settles here. */
  private handleStopped(stopReason: StopReason): void {
    this.update({ type: "set-mode", mode: { type: "normal" } });
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

    this.deps.getHooks().onToolResults?.(results);

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
    if (beforeRequest.type === "suspend") {
      this.suspendReason = {
        type: "supervisor",
        reason: beforeRequest.reason,
      };
      return { type: "suspend", results };
    }

    return { type: "continue", results };
  }

  /** The runner has exhausted its retries. Roll the log back to where it stood
   * before the failed request, so the thread is left coherent and resumable,
   * and report the failure. Queued submissions are deliberately untouched:
   * they were never delivered, and they go out with whatever is sent next. */
  private handleErrorState(error: Error): void {
    this.rollbackToPreSubmit();
    this.context.logger.error(error);
    this.settle({ type: "failed", error, discardedSubmission: true });
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
  async abortAndWait(): Promise<void> {
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
  }

  private finishAbort(): void {
    this.abortRequested = false;
    this.deps.onUpdate();
    this.update({ type: "set-mode", mode: { type: "normal" } });
    this.settle({ type: "aborted" });
  }

  /** The submission currently in flight, settled at the moment the agent comes
   * to rest. Internal continuations — auto-respond, supervisor nudges, the
   * max_tokens continue-prompt, a rejected yield — deliberately leave it
   * pending, so exactly one outcome is delivered per `send`. */
  private submission: Defer<SendResult> | undefined;

  /** Issue a submission and resolve once the agent comes to rest.
   */
  send(
    inputMessages?: InputMessage[],
    opts: SubmitOptions = {},
  ): Promise<SendResult> {
    if (this.state.mode.type === "yielded" && this.state.mode.tornDown) {
      return Promise.reject(
        new Error(
          "This thread's container has been torn down. No further messages can be sent.",
        ),
      );
    }
    const deferred = new Defer<SendResult>();
    this.submission = deferred;
    this.submit(inputMessages, opts).catch((error: Error) => {
      this.handleSendMessageError(error);
      this.settle({ type: "failed", error, discardedSubmission: true });
    });
    return deferred.promise;
  }

  /** Deliver the outcome of the in-flight submission, if any. The final
   * `update` goes out first so a trailing-edge debouncer paints the terminal
   * state before the caller sees the result. */
  private settle(outcome: SendResult): void {
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
    this.state.editedFilesThisTurn = [];

    const beforeRequest: BeforeRequestResult =
      opts.requestKind === "continuation"
        ? { type: "proceed", injections: [] }
        : await this.applyBeforeRequestActions(
            { kind: "submission" },
            "return",
          );
    // After the hook: the file tracker's update is what refreshes the agent
    // view the markdown-reminder scan reads.
    const { content, reminder, hasContent } =
      this.prepareUserContent(inputMessages);
    if (beforeRequest.type === "suspend") {
      // The injections are already in the log; the user's own content has to
      // join them there so the snapshot handed over carries it too.
      this.runner.appendUserMessage(
        toAgentInput(reminder ? [reminder, ...content] : content),
        { coalesce: true },
      );
      this.settle({ type: "suspended", reason: beforeRequest.reason });
      return;
    }

    const injections = beforeRequest.injections;
    const hasPrefix = (this.pendingTurnPrefix?.length ?? 0) > 0;
    if (!hasContent && injections.length === 0 && !hasPrefix) {
      this.settle({ type: "completed", stopReason: undefined });
      return;
    }

    // The user's own message goes last, so it is the final thing the model
    // reads: everything else in the turn is preamble to it.
    const contentToSend: AgentInput[] = [...injections];
    if (reminder) {
      contentToSend.push(...toAgentInput([reminder]));
    }
    contentToSend.push(...toAgentInput(content));

    this.preSubmitNativeIdx = this.runner.getNativeMessageIdx();
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

  /** The union of transient get_files-read reminders and reminders derived from
   * markdown files currently in context, deduped on text. */
  private getActiveReminders(): string[] {
    const reminders = new Set(this.state.activeReminders);
    for (const key of Object.keys(this.context.contextTracker.files)) {
      const fileInfo = this.context.contextTracker.files[key as AbsFilePath];
      if (!fileInfo) continue;
      if (!key.toLowerCase().endsWith(".md")) continue;
      if (fileInfo.agentView?.type !== "text") continue;
      const reminder = extractSystemReminderBlock(fileInfo.agentView.content);
      if (reminder) reminders.add(reminder);
    }
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

    // Whatever the owner drained from its async queue for this request; the
    // agent orders it last and applies the reminder/token-reset rules to it,
    // which is why it does not arrive as an injection.
    const queuedForThisRequest = this.pendingSubmissions;
    this.pendingSubmissions = [];

    const contentToSend: AgentInput[] = [...this.pendingInjections];
    this.pendingInjections = [];

    if (queuedForThisRequest.length > 0) {
      const { content, reminder } =
        this.prepareUserContent(queuedForThisRequest);
      if (reminder) {
        contentToSend.push(...toAgentInput([reminder]));
      }
      contentToSend.push(...toAgentInput(content));
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

    return contentToSend;
  }

  private handleSendMessageError = (error: Error): void => {
    this.context.logger.error(error);
  };

  /** The user's own text is kept separate from the reminder that accompanies
   * it, so callers can order the turn's blocks with the user's message last. */
  private prepareUserContent(inputMessages?: InputMessage[]): {
    content: ProviderMessageContent[];
    reminder: ProviderMessageContent | undefined;
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

    let reminderContent: ProviderMessageContent | undefined;
    if (inputMessages?.length) {
      this.update({ type: "reset-output-tokens" }, { silent: true });
      const reminder = buildSystemReminder({
        threadType: this.state.threadType,
        subagentConfig: this.context.subagentConfig,
        kinds: ["subsequent"],
        extraReminders: this.getActiveReminders(),
      });
      if (reminder) {
        reminderContent = {
          type: "system_reminder",
          text: reminder,
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        };
      }
    }

    return {
      content: messageContent,
      reminder: reminderContent,
      hasContent: (inputMessages?.length ?? 0) > 0,
    };
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
   * so nothing the agent does next (a failure, an abort, a suspension) can
   * lose them. Returns the suspension the list asks for, if any. */
  /** Injections produced on the tool_use path, held until the tool results
   * have been written. Anthropic requires the tool_result blocks to
   * immediately follow the tool_use they answer, so injected content cannot be
   * appended between the two — it rides `buildToolResponseExtras` instead. */
  private pendingInjections: AgentInput[] = [];
  /** The user content the owner's `onBeforeRequest` handed over for the
   * tool_use request, held for the same reason as `pendingInjections`. */
  private pendingSubmissions: InputMessage[] = [];
  private async applyBeforeRequestActions(
    context: RequestContextKind,
    mode: "prefix" | "pending" | "return",
  ): Promise<BeforeRequestResult> {
    const onBeforeRequest = this.deps.getHooks().onBeforeRequest;
    if (!onBeforeRequest) return { type: "proceed", injections: [] };
    const composed = await onBeforeRequest({
      ...context,
      inputTokenCount: this.runner.log.inputTokenCount,
      outputTokenCount: this.outputTokenCount(),
      isFirstMessage: this.getProviderMessages().length === 0,
    });
    const injections: AgentInput[] = composed.injections.map((block) =>
      block.type === "text"
        ? {
            type: "text" as const,
            text: block.text,
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          }
        : block,
    );
    // A deferred injection would be dropped by a reset, so a suspension forces
    // the append: the content belongs in the snapshot handed over.
    if (composed.type === "suspend") {
      this.runner.appendUserMessage(injections, { coalesce: true });
      return { type: "suspend", reason: composed.reason };
    }
    switch (mode) {
      case "prefix":
        // A stop is not a request: whether a continuation follows is decided
        // after the hook runs. Queuing as the next turn's prefix lands the
        // content in the same user message as whatever goes out next —
        // including a `send` that arrives much later.
        this.prependToNextTurn(injections);
        return { type: "proceed", injections: [] };
      case "pending":
        this.pendingInjections.push(...injections);
        this.pendingSubmissions.push(...composed.submissions);
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
