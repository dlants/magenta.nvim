import type {
  GitState,
  ScriptSandboxRoot,
  SubagentConfig,
  SystemInfo,
  ToolResultInput,
} from "@magenta/server";
import {
  type AgentInput,
  activeTools,
  type CompactionRunId,
  type ContextFiles,
  type MCPToolManagerImpl,
  type NativeMessageIdx,
  renderPending,
  type Submission,
  type SubmissionResult,
  type Thread,
  type ThreadCompactor,
  type ThreadId,
  type ToolRequestId,
} from "@magenta/server";
import * as diff from "diff";
import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import type { SandboxViolationHandler } from "../capabilities/sandbox-violation-handler.ts";
import type { Environment } from "../environment.ts";
import { displaySnapshotDiff } from "../nvim/displaySnapshotDiff.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow.ts";
import type { MagentaOptions, Profile } from "../options.ts";
import type { RootMsg } from "../root-msg.ts";
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

/** Bypass state of a tree's root, owned by whoever owns that root (today: a
 * script invocation in the session's ScriptManager). */
export type SandboxRoot = ScriptSandboxRoot;

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
      type: "submission-ended";
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
    toolResultMap: Map<ToolRequestId, ToolResultInput>;
    forkedTo: { childThreadId: ThreadId; atMessageIdx: NativeMessageIdx }[];
  };

  private myDispatch: Dispatch<Msg>;
  private lastAppliedTitle: string | undefined;
  public sandboxViolationHandler: SandboxViolationHandler | undefined;

  /** Bypass belongs to the root of the thread tree, which the session knows. */
  get isSandboxBypassed(): boolean {
    return this.context.chat.isSandboxBypassed(this.id);
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

  /** Observe one complete submission for UI completion and error presentation. */
  private observeSubmission(start: () => Promise<SubmissionResult>): void {
    start().then(
      (result) => this.handleSendResult(result),
      (e: Error) => this.context.nvim.logger.error(e),
    );
  }

  private beginSubmission(text: string): void {
    this.submission = { type: "in-flight", text };
  }

  private handleSendResult(result: SubmissionResult): void {
    this.myDispatch({ type: "submission-ended" });
    if (result.type === "completed" || result.type === "failed") {
      notifyUser(
        { nvim: this.context.nvim, options: this.context.options },
        "thread-submission-end",
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
    const next = new Map<ToolRequestId, ToolResultInput>();
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
    const active = activeTools(this.thread.state);
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

  /** A send that preempts the tool loop in flight also drops that loop's pending
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
        this.scrollAfterMessageCount = this.thread.getProviderMessages().length;
        // A deferred submission with nothing in flight has no request to ride,
        // so it goes out now; otherwise it is queued and the submission that
        // carries it reports for it.
        if (delivery !== "now" && this.thread.isBusy) {
          this.thread.enqueue({ type: "raw", message }, delivery);
          return;
        }
        this.rejectPendingSandboxApprovals();
        this.beginSubmission(message);
        this.observeSubmission(() =>
          this.thread.submit({ type: "raw", message }),
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
        for (const entry of activeTools(this.thread.state)?.values() ?? []) {
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

      case "submission-ended":
        return;

      case "toggle-compaction-record": {
        const vs = this.state.compactionViewState[msg.runId] ?? {
          expanded: false,
        };
        vs.expanded = !vs.expanded;
        this.state.compactionViewState[msg.runId] = vs;
        return;
      }
      case "toggle-sandbox-bypass":
        this.context.chat.toggleSandboxBypass(this.id);
        return;

      case "fork-message":
        // Handled at the Magenta dispatch level; ignored here.
        return;

      default:
        assertUnreachable(msg);
    }
  }

  /** Abort this thread and its descendants. Only this thread's unsent input
   * comes back to the input buffer; a descendant's input is not the user's to
   * resume here. */
  async abortAndWait(): Promise<void> {
    const { unsent } = await this.context.chat.abortThread(this.id);
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
