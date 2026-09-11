import * as fs from "node:fs/promises";
import type {
  GitContextUpdate,
  GitState,
  NativeInferenceManager,
  ProviderToolResult,
  SubagentConfig,
  ThreadSupervisor,
} from "@magenta/server";
import {
  type AgentInput,
  type CompactionRunId,
  type ContextFiles,
  composeSupervisors,
  type FileSupervisor,
  type GitSupervisor,
  loadAgents,
  loopActiveTools,
  MaxTokensSupervisor,
  type MCPToolManagerImpl,
  type NativeMessageIdx,
  type PendingMessage,
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  parseCompact,
  type ResolvedSubmission,
  renderPending,
  resolveAsText,
  runSubmission,
  type Submission,
  Thread,
  type ThreadCallbacks,
  ThreadCompactor,
  type ThreadContextDelivery,
  type ThreadId,
  type ThreadSendResult,
  type ThreadType,
  type ToolRequestId,
} from "@magenta/server";
import * as diff from "diff";
import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import type { Lsp } from "../capabilities/lsp.ts";
import type { SandboxViolationHandler } from "../capabilities/sandbox-violation-handler.ts";
import type { FileUpdates } from "../context/context-manager.ts";
import { createLocalEnvironment, type Environment } from "../environment.ts";
import { displaySnapshotDiff } from "../nvim/displaySnapshotDiff.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import type { MagentaOptions, Profile } from "../options.ts";
import {
  getProvider,
  type ProviderMessage,
  type ThreadLoopState,
} from "../providers/provider.ts";
import type { SystemInfo, SystemPrompt } from "../providers/system-prompt.ts";
import type { RootMsg } from "../root-msg.ts";
import type { Sandbox } from "../sandbox-manager.ts";
import type { Dispatch } from "../tea/tea.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { getBufferIfOpen } from "../utils/buffers.ts";
import type {
  AbsFilePath,
  HomeDir,
  NvimCwd,
  UnresolvedFilePath,
} from "../utils/files.ts";
import { displayPath } from "../utils/files.ts";
import type { Chat } from "./chat.ts";
import type { CommandRegistry } from "./commands/registry.ts";
import { notifyUser } from "./notify.ts";

/** Trailing-edge coalescing window for core updates. The core no longer
 * throttles; a render cadence is a view decision. */
const RENDER_DEBOUNCE_MS = 32;

/** One frame per spinner step (see `spinnerFrame`), which is also fine for
 * second-resolution timers. */
const ANIMATION_TICK_MS = 333;
/** The view needs the new message to exist before it can scroll to it. */
const SCROLL_DELAY_MS = 100;

export type SandboxRoot = {
  readonly isSandboxBypassed: boolean;
  toggle?: () => void;
};

export type Msg =
  | { type: "set-title"; title: string }
  | {
      /** Content composed programmatically (comments, thread bootstrap):
       * already resolved, and always delivered now. User text goes through
       * `submit-message` instead. */
      type: "send-message";
      messages: AgentInput[];
    }
  | {
      /** User text, parsed but not resolved: its commands run at delivery
       * (or, for a `compact` intent, when the handoff is opened). */
      type: "submit-message";
      submission: Submission;
    }
  | {
      /** Re-issue the request the last failure ended on. The log still holds
       * the submission, so the retry carries no content of its own. */
      type: "retry";
    }
  | {
      type: "abort";
    }
  | {
      type: "toggle-system-prompt";
    }
  | {
      type: "toggle-tool-definitions";
    }
  | {
      type: "toggle-tool-definition";
      toolName: string;
    }
  | {
      type: "toggle-context-files-expanded";
    }
  | {
      type: "toggle-pending-message";
      index: number;
    }
  | {
      type: "toggle-expand-content";
      messageIdx: number;
      contentIdx: number;
    }
  | {
      type: "toggle-expand-update";
      messageIdx: number;
      filePath: string;
    }
  | {
      type: "toggle-tool-input-summary";
      toolRequestId: ToolRequestId;
    }
  | {
      type: "toggle-tool-input";
      toolRequestId: ToolRequestId;
    }
  | {
      type: "toggle-tool-progress";
      toolRequestId: ToolRequestId;
    }
  | {
      type: "toggle-tool-result-summary";
      toolRequestId: ToolRequestId;
    }
  | {
      type: "toggle-tool-result";
      toolRequestId: ToolRequestId;
    }
  | {
      type: "toggle-tool-result-item";
      toolRequestId: ToolRequestId;
      itemKey: string;
    }
  | {
      type: "toggle-tool-progress-item";
      toolRequestId: ToolRequestId;
      itemKey: string;
    }
  | {
      type: "open-edit-file";
      filePath: UnresolvedFilePath | AbsFilePath;
    }
  | {
      type: "toggle-edited-file-expanded";
      filePath: AbsFilePath;
    }
  | {
      type: "open-edit-file-diff";
      filePath: AbsFilePath;
      snapshot: string;
    }
  | {
      type: "permission-pending-change";
    }
  | {
      type: "tool-progress";
    }
  | {
      type: "animation-tick";
    }
  | {
      type: "turn-ended";
    }
  | {
      type: "toggle-compaction-record";
      runId: CompactionRunId;
    }
  | {
      type: "toggle-sandbox-bypass";
    }
  | {
      type: "fork-message";
      nativeMessageIdx: NativeMessageIdx;
      prepopulate?: string[];
    };

export type ThreadMsg = {
  type: "thread-msg";
  id: ThreadId;
  msg: Msg;
};

/** View state for a single message, stored separately from provider thread content */
export type MessageViewState = {
  contextUpdates?: FileUpdates;
  gitUpdate?: GitContextUpdate;
  forkedFrom?: ThreadId;
  expandedUpdates?: { [absFilePath: string]: boolean };
  expandedContent?: { [contentIdx: number]: boolean };
};

/** View state for tools, keyed by tool request ID */
export type ToolViewState = {
  inputSummaryExpanded: boolean;
  inputExpanded: boolean;
  progressExpanded: boolean;
  resultSummaryExpanded: boolean;
  resultExpanded: boolean;
  resultItemExpanded?: { [key: string]: boolean };
  progressItemExpanded?: { [key: string]: boolean };
};

export class NvimThread {
  public state: {
    showSystemPrompt: boolean;
    showToolDefinitions: boolean;
    expandedToolDefinitions: { [toolName: string]: boolean };
    contextFilesExpanded: boolean;
    pendingMessagesExpanded: { [index: number]: boolean };
    editedFilesExpanded: { [path: AbsFilePath]: { patch: string } };
    messageViewState: { [messageIdx: number]: MessageViewState };
    toolViewState: { [toolRequestId: ToolRequestId]: ToolViewState };
    compactionViewState: {
      [runId: CompactionRunId]: { expanded: boolean };
    };
    toolResultMap: Map<ToolRequestId, ProviderToolResult>;
    forkedTo: { childThreadId: ThreadId; atMessageIdx: NativeMessageIdx }[];
  };

  public core: Thread;
  /** The summarizing pass this thread's submissions hand off to. Absent on
   * compact threads: a compaction must never be able to compact itself. */
  public readonly compactor: ThreadCompactor | undefined;
  private myDispatch: Dispatch<Msg>;
  private lastAppliedTitle: string | undefined;
  public sandboxViolationHandler: SandboxViolationHandler | undefined;
  public sandboxBypassed = false;

  get fileSupervisor(): FileSupervisor {
    return this.core.core.fileSupervisor;
  }
  get gitSupervisor(): GitSupervisor {
    return this.core.core.gitSupervisor!;
  }

  get agent(): NativeInferenceManager {
    return this.core.inferenceManager;
  }

  /** The supervisor list this thread's hooks were composed from. Kept so the
   * wiring is inspectable; the core only ever sees the composed hooks. */
  public supervisors: ThreadSupervisor[] = [];

  get isSandboxBypassed(): boolean {
    const sandboxRoot = this.context.getSandboxRoot?.();
    if (sandboxRoot) return sandboxRoot.isSandboxBypassed;
    const parent = this.context.getParentThread?.();
    if (parent) return parent.isSandboxBypassed;
    return this.sandboxBypassed;
  }

  constructor(
    public id: ThreadId,
    threadType: ThreadType,
    systemPrompt: SystemPrompt,
    public context: {
      dispatch: Dispatch<RootMsg>;
      chat: Chat;
      mcpToolManager: MCPToolManagerImpl;
      profile: Profile;
      nvim: Nvim;
      cwd: NvimCwd;
      homeDir: HomeDir;
      options: MagentaOptions;
      getDisplayWidth: () => number;
      getParentThread?: () => NvimThread | undefined;
      getSandboxRoot?: () => SandboxRoot | undefined;
      yieldSchema?: JSONSchemaType;
      scriptName?: string;
      environment: Environment;
      initialFiles?: ContextFiles;
      initialGitState?: GitState | undefined;
      subagentConfig?: SubagentConfig;
      systemInfo: SystemInfo;
      commandRegistry: CommandRegistry;
    },
    /** The core fork owns the cloned history and tracked-file state before
     * this display wrapper exists. */
    preBuilt?: {
      core: Thread;
    },
  ) {
    this.myDispatch = (msg) =>
      this.context.dispatch({
        type: "thread-msg",
        id: this.id,
        msg,
      });

    const env = this.context.environment;
    this.sandboxViolationHandler = env.sandboxViolationHandler;

    this.state = {
      showSystemPrompt: false,
      showToolDefinitions: false,
      expandedToolDefinitions: {},
      contextFilesExpanded: false,
      pendingMessagesExpanded: {},
      editedFilesExpanded: {},
      messageViewState: {},
      toolViewState: {},
      compactionViewState: {},
      toolResultMap: new Map(),
      forkedTo: [],
    };

    const isDocker = env.environmentConfig.type === "docker";
    const cwd = isDocker ? env.cwd : context.cwd;
    const homeDir = isDocker ? env.homeDir : context.homeDir;

    const contextDelivery: ThreadContextDelivery = preBuilt?.core.context
      .contextDelivery ?? {
      ...(context.initialFiles ? { initialFiles: context.initialFiles } : {}),
      initialGitState: context.initialGitState,
    };
    contextDelivery.onFilesSent = (updates) =>
      this.recordMessageViewState({ contextUpdates: updates });
    contextDelivery.onGitSent = (update) =>
      this.recordMessageViewState({ gitUpdate: update });
    if (preBuilt) {
      this.core = preBuilt.core;
      this.core.callbacks = this.coreCallbacks();
    } else {
      this.core = new Thread(
        id,
        {
          logger: context.nvim.logger,
          profile: context.profile,
          cwd,
          homeDir,
          threadType,
          contextDelivery,
          ...(context.subagentConfig
            ? { subagentConfig: context.subagentConfig }
            : {}),
          systemPrompt,
          systemInfo: context.systemInfo,
          mcpToolManager: context.mcpToolManager,
          threadManager: context.chat,
          getScriptRunner: () => context.chat.scriptRunner,
          fileIO: env.fileIO,
          shell: env.shell,
          gitClient: env.gitClient,
          lspClient: env.lspClient,
          ...(env.luaExecutor !== undefined
            ? { luaExecutor: env.luaExecutor }
            : {}),
          availableCapabilities: env.availableCapabilities,
          environmentConfig: env.environmentConfig,
          maxConcurrentSubagents: context.options.maxConcurrentSubagents || 3,
          maxConcurrentFastSubagents:
            context.options.maxConcurrentFastSubagents || 8,
          ...(context.options.dockerfile
            ? { subagentDockerfile: context.options.dockerfile }
            : {}),
          ...(context.yieldSchema ? { yieldSchema: context.yieldSchema } : {}),
          getAgents: () =>
            loadAgents({
              cwd,
              logger: context.nvim.logger,
              options: context.options,
            }),
          provider: getProvider(context.nvim, context.profile),
        },
        this.coreCallbacks(),
        context.scriptName ? { scriptName: context.scriptName } : {},
      );
    }

    this.compactor =
      threadType === "compact" ? undefined : new ThreadCompactor(this.core);
    // The status line and the history section both read the compactor, so a
    // chunk boundary has to repaint even though nothing on the thread moved.
    this.compactor?.on("transition", () => this.onCoreUpdate());

    this.core.hooks = composeSupervisors(() => [
      new MaxTokensSupervisor(),
      ...this.supervisors,
    ]);

    this.rebuildToolResultMap();
  }

  /** Coalesce the core's unthrottled `onUpdate` into at most one dispatch per
   * frame. Trailing-edge on purpose: the core fires once more after the
   * thread comes to rest, and a leading-edge throttle would drop exactly that
   * call and leave a stale streaming block on screen forever. */
  private renderDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  /** Pull-based animation clock: a view that renders time-dependent content
   * (a spinner, an elapsed timer) calls this as it renders, which schedules
   * one more render — so an animation runs for exactly as long as it is on
   * screen, and nothing has to guess from state whether one is. */
  requestAnimationTick = (): void => {
    if (this.animationTimer || this.destroyed) return;
    this.animationTimer = setTimeout(() => {
      this.animationTimer = undefined;
      if (this.destroyed) return;
      this.myDispatch({ type: "animation-tick" });
    }, ANIMATION_TICK_MS);
  };

  private animationTimer: ReturnType<typeof setTimeout> | undefined;

  private onCoreUpdate(): void {
    if (this.renderDebounceTimer) return;
    this.renderDebounceTimer = setTimeout(() => {
      this.renderDebounceTimer = undefined;
      if (this.destroyed) return;
      this.rebuildToolResultMap();
      const title = this.core.title;
      if (title !== undefined && title !== this.lastAppliedTitle) {
        this.lastAppliedTitle = title;
        this.context.dispatch({
          type: "set-thread-title-effect",
          id: this.core.id,
          title,
        });
      }
      this.myDispatch({ type: "tool-progress" });
      this.maybeScrollToSubmission();
    }, RENDER_DEBOUNCE_MS);
  }

  /** The most recent submission and how it is doing. One field rather than
   * two, so "failed" cannot be represented without the text that failed: the
   * text is kept so a failure can put it back in the input buffer, and the
   * failed variant is what the trailing error block renders. */
  submission:
    | { type: "in-flight"; text: string }
    | { type: "failed"; text: string; error: Error }
    | undefined;

  /** The message count when the pending submission was issued, if a send is
   * waiting to be scrolled into view. The scroll belongs to the actor that
   * submitted, and has to wait until the message it is scrolling to exists. */
  private scrollAfterMessageCount: number | undefined;

  private maybeScrollToSubmission(): void {
    if (this.scrollAfterMessageCount === undefined) return;
    if (
      this.core.getProviderMessages().length <= this.scrollAfterMessageCount
    ) {
      return;
    }
    this.scrollAfterMessageCount = undefined;
    setTimeout(
      () =>
        this.context.dispatch({
          type: "sidebar-msg",
          msg: { type: "scroll-to-last-user-message" },
        }),
      SCROLL_DELAY_MS,
    );
  }

  /** Attach a tracker's structured record to the message its injection is
   * about to produce. */
  private recordMessageViewState(patch: MessageViewState): void {
    const messageCount = this.core.getProviderMessages().length;
    this.state.messageViewState[messageCount] = {
      ...this.state.messageViewState[messageCount],
      ...patch,
    };
  }

  /** The callbacks the core needs. Everything else it used to broadcast is
   * now the return value of the `send`/`abort` this thread itself issued. */
  private coreCallbacks(): ThreadCallbacks {
    return {
      onUpdate: () => this.onCoreUpdate(),
      resolve: (message) => this.resolveSubmission(message),
    };
  }

  /** The nvim half of a submission: expand commands (`@file:`, `@diff`, ...)
   * against the world as it is *now*. Called at delivery, so a message queued
   * behind a long turn sees the current file contents, not the ones it was
   * typed against. */
  private async resolveSubmission(
    message: PendingMessage,
  ): Promise<ResolvedSubmission> {
    // A compact thread has no compactor — it *is* a compaction — so
    // `@compact` typed into one is ordinary text.
    const { compact, rest } = this.compactor
      ? parseCompact(message)
      : { compact: false, rest: message };
    const { processedText, additionalContent, reminders } =
      await this.context.commandRegistry.processMessage(rest, {
        nvim: this.context.nvim,
        cwd: this.context.environment.cwd,
        homeDir: this.context.environment.homeDir,
        fileSupervisor: this.fileSupervisor,
        options: this.context.options,
      });
    const messages: AgentInput[] = [
      {
        type: "text",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        text: processedText,
      },
    ];
    for (const content of additionalContent) {
      if (
        content.type === "text" ||
        content.type === "image" ||
        content.type === "document"
      ) {
        messages.push(content);
      }
    }
    return { compact, messages, reminders };
  }

  /** Turn a finished submission into the effects that used to be broadcast
   * events: the turn-end notification and the rolled-back input text. */
  /** Every submission this thread issues goes through the compaction loop —
   * there is no path that reaches `core.send` directly, or auto-compaction
   * would silently stop working for it. */
  private runSubmission(start: () => Promise<ThreadSendResult>): void {
    runSubmission({ thread: this.core, compactor: this.compactor, start }).then(
      (result) => this.handleSendResult(result),
      (e: Error) => this.context.nvim.logger.error(e),
    );
  }

  private beginSubmission(text: string): void {
    this.submission = { type: "in-flight", text };
  }

  private handleSendResult(result: ThreadSendResult): void {
    if (result.type === "queued") return;
    this.myDispatch({ type: "turn-ended" });
    if (result.type === "completed" || result.type === "failed") {
      notifyUser(
        { nvim: this.context.nvim, options: this.context.options },
        "thread-turn-end",
      );
    }
    const submission = this.submission;
    if (result.type === "failed" && submission !== undefined) {
      // The submission is still in the log — nothing to retype, so the input
      // buffer is left alone and an empty send retries the failed request.
      this.submission = {
        type: "failed",
        text: submission.text,
        error: result.error,
      };
    }
  }

  /** Walks the agent's provider messages and collects the tool results.
   * Structured (display-only) data is not carried here — it lives in
   * `core.structuredToolResults` and is looked up at render time. */
  rebuildToolResultMap(): void {
    const next = new Map<ToolRequestId, ProviderToolResult>();
    for (const message of this.core.getProviderMessages()) {
      if (message.role !== "user") continue;
      for (const content of message.content) {
        if (content.type === "tool_result") {
          next.set(content.id, content);
        }
      }
    }
    // Include results from active tool entries whose results haven't yet been
    // submitted back to the agent (e.g. mid tool_use turn while other tools
    // are still running). The rendering layer needs these to display custom
    // result summaries as soon as the tool completes.
    const active = loopActiveTools(this.core.loopState);
    if (active) {
      for (const entry of active.values()) {
        if (entry.result && !next.has(entry.request.id)) {
          next.set(entry.request.id, entry.result);
        }
      }
    }
    this.state.toolResultMap = next;
  }

  /** Build an independent fork of `sourceThread` frozen at `nativeMessageIdx`.
   * The cloned agent is created exactly once (by Agent.clone). The source
   * is not aborted, no auto-context is re-resolved, and no system prompt is
   * regenerated. The result is a new NvimThread with its own environment and
   * Layer 3 view state, ready to continue from the snapshot. */
  static async cloneFromNativeMessageIdx(args: {
    sourceThread: NvimThread;
    newThreadId: ThreadId;
    nativeMessageIdx: NativeMessageIdx;
    chat: Chat;
    mcpToolManager: MCPToolManagerImpl;
    dispatch: Dispatch<RootMsg>;
    nvim: Nvim;
    cwd: NvimCwd;
    homeDir: HomeDir;
    lsp: Lsp;
    sandbox: Sandbox;
    getOptions: () => MagentaOptions;
    getDisplayWidth: () => number;
  }): Promise<NvimThread> {
    const {
      sourceThread,
      newThreadId,
      nativeMessageIdx,
      chat,
      mcpToolManager,
      dispatch,
      nvim,
      cwd,
      homeDir,
      lsp,
      sandbox,
      getOptions,
      getDisplayWidth,
    } = args;

    const sourceEnvConfig = sourceThread.context.environment.environmentConfig;
    if (sourceEnvConfig.type !== "local") {
      throw new Error(
        `Thread.cloneFromNativeMessageIdx only supports local-source forks for MVP (got ${sourceEnvConfig.type}). Docker-source forks are a follow-up.`,
      );
    }

    const bypassRef = { get: () => false as boolean };

    const environment = createLocalEnvironment({
      nvim,
      lsp,
      cwd,
      homeDir,
      getOptions,
      threadId: newThreadId,
      sandbox,
      onPendingChange: () =>
        dispatch({
          type: "thread-msg",
          id: newThreadId,
          msg: { type: "permission-pending-change" },
        }),
      isBypassed: () => bypassRef.get(),
    });

    const sourceCore = sourceThread.core;
    const profile = sourceThread.context.profile;
    const sourceCoreState = sourceCore;
    const preserveDelivery =
      !sourceCore.isBusy &&
      nativeMessageIdx === sourceCore.inferenceManager.getNativeMessageIdx();
    const initialGitState = preserveDelivery
      ? structuredClone(sourceThread.gitSupervisor.gitTracker.getAgentView())
      : undefined;

    const threadType = sourceCoreState.threadType;
    // No awaits above: native history and delivery must describe the same instant.
    const core = await Thread.clone({
      sourceThread: sourceCore,
      newId: newThreadId,
      nativeMessageIdx,
      context: {
        logger: nvim.logger,
        profile,
        cwd: environment.cwd,
        homeDir: environment.homeDir,
        threadType,
        contextDelivery: {
          initialGitState,
        },
        ...(sourceThread.context.subagentConfig
          ? { subagentConfig: sourceThread.context.subagentConfig }
          : {}),
        systemPrompt: sourceCoreState.systemPrompt,
        systemInfo: sourceCoreState.systemInfo,
        mcpToolManager,
        threadManager: chat,
        fileIO: environment.fileIO,
        shell: environment.shell,
        gitClient: environment.gitClient,
        lspClient: environment.lspClient,
        ...(environment.luaExecutor !== undefined
          ? { luaExecutor: environment.luaExecutor }
          : {}),
        availableCapabilities: environment.availableCapabilities,
        environmentConfig: environment.environmentConfig,
        maxConcurrentSubagents: getOptions().maxConcurrentSubagents || 3,
        maxConcurrentFastSubagents:
          getOptions().maxConcurrentFastSubagents || 8,
        ...(getOptions().dockerfile
          ? { subagentDockerfile: getOptions().dockerfile }
          : {}),
        getAgents: () =>
          loadAgents({
            cwd: environment.cwd,
            logger: nvim.logger,
            options: getOptions(),
          }),
        provider: getProvider(nvim, profile),
      },
      // Replaced by the wrapper's own callbacks as soon as it exists; a fork
      // has to clone the source's history before there is a wrapper to talk to.
      callbacks: { onUpdate: () => {}, resolve: resolveAsText },
    });

    const thread = new NvimThread(
      newThreadId,
      sourceCoreState.threadType,
      sourceCoreState.systemPrompt,
      {
        dispatch,
        chat,
        mcpToolManager,
        profile,
        commandRegistry: sourceThread.context.commandRegistry,
        nvim,
        cwd,
        homeDir,
        options: getOptions(),
        getDisplayWidth,
        environment,
        systemInfo: sourceCoreState.systemInfo,
        initialGitState,
        ...(sourceThread.context.subagentConfig
          ? { subagentConfig: sourceThread.context.subagentConfig }
          : {}),
      },
      { core },
    );

    thread.sandboxBypassed = sourceThread.isSandboxBypassed;
    bypassRef.get = () => thread.isSandboxBypassed;

    thread.rebuildToolResultMap();

    for (const [idxStr, viewState] of Object.entries(
      sourceThread.state.messageViewState,
    )) {
      const idx = Number(idxStr);
      if (idx <= nativeMessageIdx) {
        thread.state.messageViewState[idx] = {
          ...(viewState.contextUpdates
            ? { contextUpdates: { ...viewState.contextUpdates } }
            : {}),
          ...(viewState.gitUpdate ? { gitUpdate: viewState.gitUpdate } : {}),
          ...(viewState.expandedUpdates
            ? { expandedUpdates: { ...viewState.expandedUpdates } }
            : {}),
          ...(viewState.expandedContent
            ? { expandedContent: { ...viewState.expandedContent } }
            : {}),
        };
      }
    }

    return thread;
  }

  private destroyed = false;

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.renderDebounceTimer) {
      clearTimeout(this.renderDebounceTimer);
      this.renderDebounceTimer = undefined;
    }

    if (this.animationTimer) {
      clearTimeout(this.animationTimer);
      this.animationTimer = undefined;
    }

    await this.core.destroy();
  }

  get loopState(): ThreadLoopState {
    return this.core.loopState;
  }

  getProviderMessages(): ReadonlyArray<ProviderMessage> {
    return this.core.getProviderMessages();
  }

  getMessages(): ProviderMessage[] {
    return this.core.getMessages();
  }

  getLastStopTokenCount(): number {
    return this.core.getLastStopTokenCount();
  }

  private async readCurrentFileContent(filePath: AbsFilePath): Promise<string> {
    const bufResult = await getBufferIfOpen({
      unresolvedPath: filePath,
      context: this.context,
    });
    if (bufResult.status === "ok") {
      const lines = await bufResult.buffer.getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });
      return lines.join("\n");
    }
    return await fs.readFile(filePath, "utf-8");
  }

  update(msg: RootMsg): void {
    if (msg.type === "thread-msg" && msg.id === this.id) {
      this.myUpdate(msg.msg);
    }
  }

  /** A send that preempts the turn in flight also drops that turn's pending
   * sandbox approvals: they belong to the work being abandoned. */
  private rejectPendingSandboxApprovals(): void {
    if (this.core.isBusy) {
      this.sandboxViolationHandler?.rejectAll();
    }
  }

  private myUpdate(msg: Msg): void {
    switch (msg.type) {
      case "send-message":
        this.rejectPendingSandboxApprovals();
        if (msg.messages.length) {
          this.scrollAfterMessageCount = this.core.getProviderMessages().length;
        }
        this.beginSubmission(
          msg.messages
            .filter((m) => m.type === "text")
            .map((m) => m.text)
            .join("\n"),
        );
        this.runSubmission(() => this.core.send(msg.messages));
        return;

      case "submit-message": {
        const { delivery, message } = msg.submission;
        if (delivery === "now") {
          this.rejectPendingSandboxApprovals();
          // A deferred submission is not the one in flight, so it must not
          // displace the text a failure would restore.
          this.beginSubmission(message);
        }
        this.scrollAfterMessageCount = this.core.getProviderMessages().length;
        // A `@compact` in the message surfaces as a suspension out of
        // `submit`, which `runSubmission` turns into the same handoff the
        // token threshold produces.
        this.runSubmission(() => this.core.submit(message, delivery));
        return;
      }

      case "retry": {
        if (this.submission?.type !== "failed") return;
        this.beginSubmission(this.submission.text);
        this.runSubmission(() => this.core.send([], { force: true }));
        return;
      }
      case "abort": {
        for (const entry of loopActiveTools(this.core.loopState)?.values() ??
          []) {
          entry.handle.abort();
        }
        this.abortAndWait().catch((e: Error) => {
          this.context.nvim.logger.error(`Error during abort: ${e.message}`);
        });
        return;
      }

      case "set-title":
        this.core.setTitle(msg.title);
        return;

      case "toggle-system-prompt":
        this.state.showSystemPrompt = !this.state.showSystemPrompt;
        return;

      case "toggle-tool-definitions":
        this.state.showToolDefinitions = !this.state.showToolDefinitions;
        if (!this.state.showToolDefinitions) {
          this.state.expandedToolDefinitions = {};
        }
        return;

      case "toggle-tool-definition":
        this.state.expandedToolDefinitions[msg.toolName] =
          !this.state.expandedToolDefinitions[msg.toolName];
        return;

      case "toggle-context-files-expanded":
        this.state.contextFilesExpanded = !this.state.contextFilesExpanded;
        return;

      case "toggle-pending-message":
        this.state.pendingMessagesExpanded[msg.index] =
          !this.state.pendingMessagesExpanded[msg.index];
        return;

      case "toggle-expand-content": {
        const viewState = this.state.messageViewState[msg.messageIdx] || {};
        viewState.expandedContent = viewState.expandedContent || {};
        viewState.expandedContent[msg.contentIdx] =
          !viewState.expandedContent[msg.contentIdx];
        this.state.messageViewState[msg.messageIdx] = viewState;
        return;
      }

      case "toggle-expand-update": {
        const viewState = this.state.messageViewState[msg.messageIdx] || {};
        viewState.expandedUpdates = viewState.expandedUpdates || {};
        viewState.expandedUpdates[msg.filePath] =
          !viewState.expandedUpdates[msg.filePath];
        this.state.messageViewState[msg.messageIdx] = viewState;
        return;
      }

      case "toggle-tool-input-summary":
      case "toggle-tool-input":
      case "toggle-tool-progress":
      case "toggle-tool-result-summary":
      case "toggle-tool-result": {
        const field = {
          "toggle-tool-input-summary": "inputSummaryExpanded",
          "toggle-tool-input": "inputExpanded",
          "toggle-tool-progress": "progressExpanded",
          "toggle-tool-result-summary": "resultSummaryExpanded",
          "toggle-tool-result": "resultExpanded",
        } as const;
        const toolState = this.state.toolViewState[msg.toolRequestId] || {
          inputSummaryExpanded: false,
          inputExpanded: false,
          progressExpanded: false,
          resultSummaryExpanded: false,
          resultExpanded: false,
        };
        const key = field[msg.type];
        toolState[key] = !toolState[key];
        this.state.toolViewState[msg.toolRequestId] = toolState;
        return;
      }

      case "toggle-tool-progress-item": {
        const toolState = this.state.toolViewState[msg.toolRequestId] || {
          inputSummaryExpanded: false,
          inputExpanded: false,
          progressExpanded: false,
          resultSummaryExpanded: false,
          resultExpanded: false,
        };
        const itemExpanded = toolState.progressItemExpanded || {};
        itemExpanded[msg.itemKey] = !itemExpanded[msg.itemKey];
        toolState.progressItemExpanded = itemExpanded;
        this.state.toolViewState[msg.toolRequestId] = toolState;
        return;
      }

      case "toggle-tool-result-item": {
        const toolState = this.state.toolViewState[msg.toolRequestId] || {
          inputSummaryExpanded: false,
          inputExpanded: false,
          progressExpanded: false,
          resultSummaryExpanded: false,
          resultExpanded: false,
        };
        const itemExpanded = toolState.resultItemExpanded || {};
        itemExpanded[msg.itemKey] = !itemExpanded[msg.itemKey];
        toolState.resultItemExpanded = itemExpanded;
        this.state.toolViewState[msg.toolRequestId] = toolState;
        return;
      }

      case "open-edit-file":
        openFileInNonMagentaWindow(msg.filePath, this.context).catch(
          (e: Error) => this.context.nvim.logger.error(e.message),
        );
        return;

      case "toggle-edited-file-expanded": {
        const key = msg.filePath;
        if (this.state.editedFilesExpanded[key]) {
          delete this.state.editedFilesExpanded[key];
          return;
        }
        const entry = this.core.editedFilesThisTurn.find(
          (e) => e.path === msg.filePath,
        );
        if (!entry) return;
        this.readCurrentFileContent(msg.filePath)
          .then((current) => {
            const patch = diff.createPatch(
              displayPath(this.context.cwd, msg.filePath, this.context.homeDir),
              entry.snapshot,
              current,
              "snapshot",
              "current",
              { context: 2 },
            );
            this.state.editedFilesExpanded[key] = { patch };
            this.myDispatch({ type: "turn-ended" });
          })
          .catch((e: Error) => this.context.nvim.logger.error(e.message));
        return;
      }

      case "open-edit-file-diff":
        displaySnapshotDiff({
          filePath: msg.filePath,
          snapshot: msg.snapshot,
          nvim: this.context.nvim,
          cwd: this.context.cwd,
          homeDir: this.context.homeDir,
          getDisplayWidth: this.context.getDisplayWidth,
        }).catch((e: Error) => this.context.nvim.logger.error(e.message));
        return;

      case "permission-pending-change":
        notifyUser(
          { nvim: this.context.nvim, options: this.context.options },
          "thread-attention",
        );
        return;

      case "animation-tick":
        return;
      case "tool-progress":
        if (this.core.queuedCount === 0) {
          this.state.pendingMessagesExpanded = {};
        }
        return;

      case "turn-ended":
        return;

      case "toggle-compaction-record": {
        const vs = this.state.compactionViewState[msg.runId] ?? {
          expanded: false,
        };
        vs.expanded = !vs.expanded;
        this.state.compactionViewState[msg.runId] = vs;
        return;
      }
      case "toggle-sandbox-bypass": {
        let root: NvimThread = this;
        let parentThread = root.context.getParentThread?.();
        while (parentThread) {
          root = parentThread;
          parentThread = root.context.getParentThread?.();
        }
        const sandboxRoot = root.context.getSandboxRoot?.();
        if (sandboxRoot?.toggle) {
          sandboxRoot.toggle();
        } else {
          root.sandboxBypassed = !root.sandboxBypassed;
        }
        if (root.isSandboxBypassed) {
          root.context.chat.approveAllPendingInSubtree(root.id);
        }
        return;
      }

      case "fork-message":
        // Handled at the Magenta dispatch level; ignored here.
        return;

      default:
        assertUnreachable(msg);
    }
  }

  async abortAndWait(): Promise<void> {
    this.sandboxViolationHandler?.rejectAll();
    const { unsent } = await this.core.abort();
    const isUserFacing =
      this.core.threadType === "root" || this.core.threadType === "docker_root";
    if (!isUserFacing) return;
    const text = unsent.map((q) => renderPending(q.message)).join("\n");
    if (!text) return;
    this.context.dispatch({
      type: "sidebar-msg",
      msg: { type: "append-to-input", threadId: this.id, text },
    });
  }
}
