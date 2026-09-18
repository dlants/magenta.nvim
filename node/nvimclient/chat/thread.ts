import type {
  GitContextUpdate,
  GitState,
  ProviderToolResult,
  SubagentConfig,
} from "@magenta/server";
import {
  type AgentInput,
  assembleThread,
  type CompactionRunId,
  type ContextFileAccess,
  type ContextFiles,
  clientToolCreator,
  loadAgents,
  loopActiveTools,
  type MCPToolManagerImpl,
  type NativeMessageIdx,
  type PendingMessage,
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  type PreparedThreadContext,
  parseCompact,
  type ResolvedSubmission,
  renderPending,
  type Submission,
  type Thread,
  type ThreadCallbacks,
  type ThreadCompactor,
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
import type { DockerSpawnConfig } from "../capabilities/thread-manager.ts";
import type { FileUpdates } from "../context/context-manager.ts";
import { createLocalEnvironment, type Environment } from "../environment.ts";
import { displaySnapshotDiff } from "../nvim/displaySnapshotDiff.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow.ts";
import type { MagentaOptions, Profile } from "../options.ts";
import { getProvider } from "../providers/provider.ts";
import type { SystemInfo, SystemPrompt } from "../providers/system-prompt.ts";
import type { RootMsg } from "../root-msg.ts";
import type { Sandbox } from "../sandbox-manager.ts";
import type { Dispatch } from "../tea/tea.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
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

/** Trailing-edge coalescing window for Thread updates. Render cadence is a
 * view decision; server notifications are unthrottled. */
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
      groupId: number;
      filePath: AbsFilePath;
    }
  | {
      type: "open-edit-file-diff";
      filePath: AbsFilePath;
      snapshot: string;
      content: string;
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

export type NvimThreadContext = {
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
  onFileAdded: (path: AbsFilePath) => void;
  initialFiles?: ContextFiles;
  initialGitState?: GitState | undefined;
  subagentConfig?: SubagentConfig;
  systemInfo: SystemInfo;
  commandRegistry: CommandRegistry;
};

export class NvimThread {
  public state: {
    showSystemPrompt: boolean;
    showToolDefinitions: boolean;
    expandedToolDefinitions: { [toolName: string]: boolean };
    contextFilesExpanded: boolean;
    pendingMessagesExpanded: { [index: number]: boolean };
    editedFilesExpanded: { [key: string]: { patch: string } };
    messageViewState: { [messageIdx: number]: MessageViewState };
    toolViewState: { [toolRequestId: ToolRequestId]: ToolViewState };
    compactionViewState: {
      [runId: CompactionRunId]: { expanded: boolean };
    };
    toolResultMap: Map<ToolRequestId, ProviderToolResult>;
    forkedTo: { childThreadId: ThreadId; atMessageIdx: NativeMessageIdx }[];
  };

  private myDispatch: Dispatch<Msg>;
  private lastAppliedTitle: string | undefined;
  public sandboxViolationHandler: SandboxViolationHandler | undefined;
  public sandboxBypassed = false;

  get isSandboxBypassed(): boolean {
    const sandboxRoot = this.context.getSandboxRoot?.();
    if (sandboxRoot) return sandboxRoot.isSandboxBypassed;
    const parent = this.context.getParentThread?.();
    if (parent) return parent.isSandboxBypassed;
    return this.sandboxBypassed;
  }

  constructor(
    public id: ThreadId,
    public readonly thread: Thread,
    public readonly compactor: ThreadCompactor | undefined,
    public context: NvimThreadContext,
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

    // The status line and the history section both read the compactor, so a
    // chunk boundary has to repaint even though nothing on the thread moved.
    this.compactor?.on("transition", () => this.onThreadUpdate());

    this.rebuildToolResultMap();
  }

  /** Coalesce Thread's unthrottled `onUpdate` into at most one dispatch per
   * frame. Trailing-edge on purpose: Thread fires once more after the
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

  onThreadUpdate(): void {
    if (this.renderDebounceTimer) return;
    this.renderDebounceTimer = setTimeout(() => {
      this.renderDebounceTimer = undefined;
      if (this.destroyed) return;
      this.rebuildToolResultMap();
      const title = this.thread.title;
      if (title !== undefined && title !== this.lastAppliedTitle) {
        this.lastAppliedTitle = title;
        this.context.dispatch({
          type: "set-thread-title-effect",
          id: this.thread.id,
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
      this.thread.getProviderMessages().length <= this.scrollAfterMessageCount
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
  recordMessageViewState(patch: MessageViewState): void {
    const messageCount = this.thread.getProviderMessages().length;
    this.state.messageViewState[messageCount] = {
      ...this.state.messageViewState[messageCount],
      ...patch,
    };
  }

  /** Observe one complete submission for UI completion and error presentation. */
  private observeSubmission(start: () => Promise<ThreadSendResult>): void {
    start().then(
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
   * `thread.completedTools` and is looked up at render time. */
  rebuildToolResultMap(): void {
    const next = new Map<ToolRequestId, ProviderToolResult>();
    for (const message of this.thread.getProviderMessages()) {
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
    const active = loopActiveTools(this.thread.loopState);
    if (active) {
      for (const entry of active.values()) {
        if (entry.result && !next.has(entry.request.id)) {
          next.set(entry.request.id, entry.result);
        }
      }
    }
    this.state.toolResultMap = next;
  }

  private destroyed = false;

  /** Release view-local resources (render/animation timers). The Thread is
   * owned by whoever created it and is destroyed explicitly there. */
  dispose(): void {
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
  }

  /** Dispose the view and destroy the underlying Thread. */
  async destroy(): Promise<void> {
    this.dispose();
    await this.thread.destroy();
  }

  update(msg: RootMsg): void {
    if (msg.type === "thread-msg" && msg.id === this.id) {
      this.myUpdate(msg.msg);
    }
  }

  /** A send that preempts the turn in flight also drops that turn's pending
   * sandbox approvals: they belong to the work being abandoned. */
  private rejectPendingSandboxApprovals(): void {
    if (this.thread.isBusy) {
      this.sandboxViolationHandler?.rejectAll();
    }
  }

  private myUpdate(msg: Msg): void {
    switch (msg.type) {
      case "send-message":
        this.rejectPendingSandboxApprovals();
        if (msg.messages.length) {
          this.scrollAfterMessageCount =
            this.thread.getProviderMessages().length;
        }
        this.beginSubmission(
          msg.messages
            .filter((m) => m.type === "text")
            .map((m) => m.text)
            .join("\n"),
        );
        this.observeSubmission(() =>
          this.thread.submit({ type: "resolved", messages: msg.messages }),
        );
        return;

      case "submit-message": {
        const { delivery, message } = msg.submission;
        if (delivery === "now") {
          this.rejectPendingSandboxApprovals();
          // A deferred submission is not the one in flight, so it must not
          // displace the text a failure would restore.
          this.beginSubmission(message);
        }
        this.scrollAfterMessageCount = this.thread.getProviderMessages().length;
        this.observeSubmission(() =>
          this.thread.submit({ type: "raw", message }, delivery),
        );
        return;
      }

      case "retry": {
        if (this.submission?.type !== "failed") return;
        this.beginSubmission(this.submission.text);
        this.observeSubmission(() => this.thread.retry());
        return;
      }
      case "abort": {
        for (const entry of loopActiveTools(this.thread.loopState)?.values() ??
          []) {
          entry.handle.abort();
        }
        this.abortAndWait().catch((e: Error) => {
          this.context.nvim.logger.error(`Error during abort: ${e.message}`);
        });
        return;
      }

      case "set-title":
        this.thread.setTitle(msg.title);
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
        const key = `${msg.groupId}:${msg.filePath}`;
        if (this.state.editedFilesExpanded[key]) {
          delete this.state.editedFilesExpanded[key];
          return;
        }
        const entry = this.thread.editedFileGroups
          .find((group) => group.id === msg.groupId)
          ?.files.find((file) => file.path === msg.filePath);
        if (!entry) return;
        this.state.editedFilesExpanded[key] = {
          patch: diff.createPatch(
            displayPath(this.context.cwd, msg.filePath, this.context.homeDir),
            entry.snapshot,
            entry.content,
            "before",
            "after",
            { context: 2 },
          ),
        };
        return;
      }

      case "open-edit-file-diff":
        displaySnapshotDiff({
          filePath: msg.filePath,
          snapshot: msg.snapshot,
          content: msg.content,
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
        if (
          !this.thread.queued.async.length &&
          !this.thread.queued.next.length
        ) {
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
    const { unsent } = await this.thread.abort();
    const isUserFacing =
      this.thread.threadType === "root" ||
      this.thread.threadType === "docker_root";
    if (!isUserFacing) return;
    const text = unsent.map((q) => renderPending(q.message)).join("\n");
    if (!text) return;
    this.context.dispatch({
      type: "sidebar-msg",
      msg: { type: "append-to-input", threadId: this.id, text },
    });
  }
}

/** Prepare the editor-dependent dependencies a thread needs, hand them to
 * server-side assembly, and wrap the resulting handles for the UI. Everything
 * server-typed (supervisor ordering, compactor wiring, title generation) lives
 * in `assembleThread`; this adapter only supplies collaborators. */
export function createNvimThread(
  id: ThreadId,
  initialization:
    | { type: "fresh"; threadType: ThreadType }
    | {
        type: "fork";
        sourceThread: Thread;
        nativeMessageIdx: NativeMessageIdx;
      },
  systemPrompt: SystemPrompt,
  context: NvimThreadContext,
  /** Only consulted for fresh conversation threads; a fork inherits the
   * source's compaction settings and a compaction thread has none. */
  policy: {
    docker?: DockerSpawnConfig;
    onDockerProgress?: (message: string) => void;
    autoCompactThreshold?: number;
    autoCompactPrompt?: string;
  } = {},
): NvimThread {
  let wrapper!: NvimThread;
  let threadRef: Thread | undefined;
  const callbacks: ThreadCallbacks = {
    onUpdate: () => wrapper.onThreadUpdate(),
    onFileAdded: context.onFileAdded,
    onFilesSent: (updates) =>
      wrapper.recordMessageViewState({ contextUpdates: updates }),
    onGitSent: (update) =>
      wrapper.recordMessageViewState({ gitUpdate: update }),
  };
  // Neither construction path invokes callbacks or resolves submissions. These
  // closures bind to the completed objects before any asynchronous work starts.
  const archiveOptions = context.scriptName
    ? { archiveOptions: { scriptName: context.scriptName } }
    : {};
  const { thread, compactor } = assembleThread({
    id,
    initialization:
      initialization.type !== "fresh"
        ? initialization
        : initialization.threadType === "compact"
          ? { type: "fresh", threadType: "compact", ...archiveOptions }
          : {
              type: "fresh",
              threadType: initialization.threadType,
              ...archiveOptions,
              policy: {
                ...(policy.docker
                  ? {
                      docker: {
                        ...policy.docker,
                        ...(policy.onDockerProgress
                          ? { onProgress: policy.onDockerProgress }
                          : {}),
                      },
                    }
                  : {}),
                autoCompactThreshold:
                  policy.autoCompactThreshold ??
                  context.options.autoCompactThreshold,
                autoCompactPrompt:
                  policy.autoCompactPrompt ?? context.options.autoCompactPrompt,
              },
            },
    context: prepareThreadContext(
      systemPrompt,
      context,
      () => threadRef as Thread,
    ),
    callbacks,
  });
  threadRef = thread;
  wrapper = new NvimThread(id, thread, compactor, context);
  return wrapper;
}

/** The root adapter: editor-backed collaborators in server-typed shape. */
function prepareThreadContext(
  systemPrompt: SystemPrompt,
  context: NvimThreadContext,
  getThread: () => Thread,
): PreparedThreadContext {
  const env = context.environment;
  const isDocker = env.environmentConfig.type === "docker";
  const cwd = isDocker ? env.cwd : context.cwd;
  const homeDir = isDocker ? env.homeDir : context.homeDir;
  const contextDelivery: ThreadContextDelivery = {
    ...(context.initialFiles ? { initialFiles: context.initialFiles } : {}),
    initialGitState: context.initialGitState,
  };
  const getAgents = () =>
    loadAgents({
      cwd,
      logger: context.nvim.logger,
      options: context.options,
    });
  const getScriptRunner = () => context.chat.scriptRunner;
  const maxConcurrentSubagents = context.options.maxConcurrentSubagents || 3;
  const maxConcurrentFastSubagents =
    context.options.maxConcurrentFastSubagents || 8;
  return {
    logger: context.nvim.logger,
    profile: context.profile,
    cwd,
    homeDir,
    contextDelivery,
    ...(context.subagentConfig
      ? { subagentConfig: context.subagentConfig }
      : {}),
    systemPrompt,
    systemInfo: context.systemInfo,
    mcpToolManager: context.mcpToolManager,
    threadManager: context.chat,
    getScriptRunner,
    fileIO: env.fileIO,
    gitClient: env.gitClient,
    clientToolCreator: clientToolCreator({
      logger: context.nvim.logger,
      lspClient: env.lspClient,
      ...(env.luaExecutor !== undefined
        ? { luaExecutor: env.luaExecutor }
        : {}),
      mcpToolManager: context.mcpToolManager,
      cwd,
      homeDir,
      maxConcurrentSubagents,
      maxConcurrentFastSubagents,
      fileIO: env.fileIO,
      shell: env.shell,
      threadManager: context.chat,
      getScriptRunner,
      getAgents,
    }),
    availableCapabilities: env.availableCapabilities,
    environmentConfig: env.environmentConfig,
    ...(context.options.dockerfile
      ? { subagentDockerfile: context.options.dockerfile }
      : {}),
    ...(context.yieldSchema ? { yieldSchema: context.yieldSchema } : {}),
    getAgents,
    provider: getProvider(context.nvim, context.profile),
    resolve: (message: PendingMessage) =>
      resolveSubmission(
        message,
        context,
        () => getThread().contextFiles,
        getThread().threadType !== "compact",
      ),
  };
}

async function resolveSubmission(
  message: PendingMessage,
  context: NvimThreadContext,
  getContextFileAccess: () => ContextFileAccess,
  canCompact: boolean,
): Promise<ResolvedSubmission> {
  // A compact thread has no compactor — it *is* a compaction — so
  // `@compact` typed into one is ordinary text.
  const { compact, rest } = canCompact
    ? parseCompact(message)
    : { compact: false, rest: message };
  const { processedText, additionalContent, reminders } =
    await context.commandRegistry.processMessage(rest, {
      nvim: context.nvim,
      cwd: context.environment.cwd,
      homeDir: context.environment.homeDir,
      fileSupervisor: getContextFileAccess(),
      options: context.options,
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

/** Build an independent fork of `sourceThread` frozen at `nativeMessageIdx`.
 * Native and context histories are cloned synchronously. The source
 * is not aborted, no auto-context is re-resolved, and no system prompt is
 * regenerated. The result is a new NvimThread with its own environment and
 * UI state, ready to continue from the snapshot. */
export async function cloneFromNativeMessageIdx(args: {
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
  onFileAdded: (path: AbsFilePath) => void;
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

  const sourceServerThread = sourceThread.thread;
  const profile = sourceThread.context.profile;
  // No awaits above: native history and delivery must describe the same instant.
  const thread = createNvimThread(
    newThreadId,
    { type: "fork", sourceThread: sourceServerThread, nativeMessageIdx },
    sourceServerThread.systemPrompt,
    {
      dispatch,
      chat,
      mcpToolManager,
      profile,
      commandRegistry: sourceThread.context.commandRegistry,
      onFileAdded: args.onFileAdded,
      nvim,
      cwd,
      homeDir,
      options: getOptions(),
      getDisplayWidth,
      environment,
      systemInfo: sourceServerThread.systemInfo,
      ...(sourceThread.context.yieldSchema
        ? { yieldSchema: sourceThread.context.yieldSchema }
        : {}),
      ...(sourceThread.context.scriptName
        ? { scriptName: sourceThread.context.scriptName }
        : {}),
      ...(sourceThread.context.subagentConfig
        ? { subagentConfig: sourceThread.context.subagentConfig }
        : {}),
    },
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
