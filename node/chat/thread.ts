import {
  ContextManager,
  type Msg as ContextManagerMsg,
  type FileUpdates,
} from "../context/context-manager.ts";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow.ts";
import { displaySnapshotDiff } from "../tools/display-snapshot-diff.ts";
import { type Dispatch } from "../tea/tea.ts";
import {
  d,
  type View,
  type VDOMNode,
  withBindings,
  withExtmark,
} from "../tea/view.ts";
import {
  type ToolRequestId,
  type Tool,
  type CompletedToolInfo,
  getToolSpecs,
  renderCompletedToolSummary,
  renderCompletedToolPreview,
  renderCompletedToolDetail,
} from "../tools/toolManager.ts";
import { createTool, type CreateToolContext } from "../tools/create-tool.ts";
import type { StaticTool, ToolMsg, ToolName } from "../tools/types.ts";
import { MCPToolManager } from "../tools/mcp/manager.ts";
import * as BashCommand from "../tools/bashCommand.ts";
import { FileSnapshots } from "../tools/file-snapshots.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { Lsp } from "../lsp.ts";
import {
  getProvider as getProvider,
  type NativeMessageIdx,
  type ProviderMessage,
  type ProviderMessageContent,
  type ProviderThread,
  type ProviderThreadInput,
  type ProviderThreadStatus,
  type ProviderToolResult,
  type StopReason,
  type Usage,
} from "../providers/provider.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { type MagentaOptions, type Profile } from "../options.ts";
import type { RootMsg } from "../root-msg.ts";
import {
  relativePath,
  type NvimCwd,
  type UnresolvedFilePath,
} from "../utils/files.ts";
import type { BufferTracker } from "../buffer-tracker.ts";
import {
  type Input as ThreadTitleInput,
  spec as threadTitleToolSpec,
} from "../tools/thread-title.ts";

import type { Chat } from "./chat.ts";
import type { ThreadId, ThreadType } from "./types.ts";
import type { SystemPrompt } from "../providers/system-prompt.ts";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import player from "play-sound";
import { CommandRegistry } from "./commands/registry.ts";
import { getSubsequentReminder } from "../providers/system-reminders.ts";
import { readGitignoreSync, type Gitignore } from "../tools/util.ts";
import { renderStreamdedTool } from "../tools/helpers.ts";

export type InputMessage =
  | {
      type: "user";
      text: string;
    }
  | {
      type: "system";
      text: string;
    };

export type Msg =
  | { type: "set-title"; title: string }
  | { type: "update-profile"; profile: Profile }
  | {
      type: "send-message";
      messages: InputMessage[];
    }
  | {
      type: "abort";
    }
  | {
      type: "take-file-snapshot";
      unresolvedFilePath: UnresolvedFilePath;
    }
  | {
      type: "tool-msg";
      id: ToolRequestId;
      toolName: ToolName;
      msg: ToolMsg;
    }
  | {
      type: "context-manager-msg";
      msg: ContextManagerMsg;
    }
  | {
      type: "toggle-system-prompt";
    }
  // View state messages
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
      type: "toggle-tool-details";
      toolRequestId: ToolRequestId;
    }
  | {
      type: "open-edit-file";
      filePath: UnresolvedFilePath;
    }
  | {
      type: "diff-snapshot";
      filePath: string;
    }
  | {
      type: "provider-thread-updated";
    };

export type ThreadMsg = {
  type: "thread-msg";
  id: ThreadId;
  msg: Msg;
};

/** View state for a single message, stored separately from provider thread content */
export type MessageViewState = {
  /** For user messages: context updates that were sent with this message */
  contextUpdates?: FileUpdates;
  /** Expansion state for context update entries */
  expandedUpdates?: { [absFilePath: string]: boolean };
  /** Expansion state for content blocks (e.g., thinking blocks) */
  expandedContent?: { [contentIdx: number]: boolean };
};

/** View state for tools, keyed by tool request ID */
export type ToolViewState = {
  details: boolean;
};

/** Edit tracking for files modified in this thread */
export type FileEditState = {
  requestIds: ToolRequestId[];
  status: { status: "pending" } | { status: "error"; message: string };
};

/** Edits for a single turn, keyed by file path */
export type TurnEdits = { [filePath: string]: FileEditState };

/** Edit tracking per turn, keyed by the message index when the agent yielded */
export type EditsByYield = {
  [yieldMessageIdx: number]: TurnEdits;
};

/** Map of active tool instances, keyed by tool request ID */
export type ActiveTools = Map<ToolRequestId, Tool>;

/** Cached lookup maps for tool results */
export type ToolCache = {
  results: Map<ToolRequestId, ProviderToolResult>;
};

/** Conversation state derived from provider status plus magenta-specific states */
export type ConversationState =
  | { type: "idle" }
  | { type: "streaming"; startTime: Date }
  | { type: "stopped"; stopReason: StopReason }
  | {
      type: "tool_use";
      activeTools: Map<ToolRequestId, Tool | StaticTool>;
    }
  | { type: "yielded"; response: string }
  | { type: "error"; error: Error };

export class Thread {
  public state: {
    title?: string | undefined;
    profile: Profile;
    threadType: ThreadType;
    systemPrompt: SystemPrompt;
    pendingMessages: InputMessage[];
    showSystemPrompt: boolean;
    /** View state per message, keyed by message index in providerThread */
    messageViewState: { [messageIdx: number]: MessageViewState };
    /** View state per tool, keyed by tool request ID */
    toolViewState: { [toolRequestId: ToolRequestId]: ToolViewState };
    /** Edits accumulating for the current turn (before yield) */
    currentEdits: TurnEdits;
    /** Edit turns keyed by the assistant message index when the agent yielded */
    editsByYield: EditsByYield;
    /** Conversation state derived from provider status plus magenta-specific states */
    conversationState: ConversationState;
    /** Cached lookup maps for tool requests and results */
    toolCache: ToolCache;
  };

  private myDispatch: Dispatch<Msg>;
  public fileSnapshots: FileSnapshots;
  public contextManager: ContextManager;
  public forkNextPrompt: string | undefined;
  public forkMessageIdx: NativeMessageIdx | undefined;
  private commandRegistry: CommandRegistry;
  public gitignore: Gitignore;
  public providerThread: ProviderThread;

  constructor(
    public id: ThreadId,
    threadType: ThreadType,
    systemPrompt: SystemPrompt,
    public context: {
      dispatch: Dispatch<RootMsg>;
      chat: Chat;
      mcpToolManager: MCPToolManager;
      bufferTracker: BufferTracker;
      profile: Profile;
      nvim: Nvim;
      cwd: NvimCwd;
      lsp: Lsp;
      contextManager: ContextManager;
      options: MagentaOptions;
      getDisplayWidth: () => number;
    },
  ) {
    this.myDispatch = (msg) =>
      this.context.dispatch({
        type: "thread-msg",
        id: this.id,
        msg,
      });

    this.gitignore = readGitignoreSync(this.context.cwd);
    this.fileSnapshots = new FileSnapshots(this.context.nvim, this.context.cwd);
    this.contextManager = this.context.contextManager;

    this.commandRegistry = new CommandRegistry();
    // Register custom commands from options
    if (this.context.options.customCommands) {
      for (const customCommand of this.context.options.customCommands) {
        this.commandRegistry.registerCustomCommand(customCommand);
      }
    }

    this.state = {
      profile: this.context.profile,
      threadType: threadType,
      systemPrompt: systemPrompt,
      pendingMessages: [],
      showSystemPrompt: false,
      messageViewState: {},
      toolViewState: {},
      currentEdits: {},
      editsByYield: {},
      conversationState: { type: "idle" },
      toolCache: { results: new Map() },
    };

    const provider = getProvider(this.context.nvim, this.state.profile);
    this.providerThread = provider.createThread({
      model: this.state.profile.model,
      systemPrompt: this.state.systemPrompt,
      tools: getToolSpecs(this.state.threadType, this.context.mcpToolManager),
      ...(this.state.profile.thinking &&
        (this.state.profile.provider === "anthropic" ||
          this.state.profile.provider === "mock") && {
          thinking: this.state.profile.thinking,
        }),
      ...(this.state.profile.reasoning &&
        (this.state.profile.provider === "openai" ||
          this.state.profile.provider === "mock") && {
          reasoning: this.state.profile.reasoning,
        }),
    });

    this.providerThread.on("status-changed", () => {
      const status = this.providerThread.getState().status;
      switch (status.type) {
        case "idle":
          this.state.conversationState = { type: "idle" };
          break;
        case "streaming":
          this.state.conversationState = {
            type: "streaming",
            startTime: status.startTime,
          };
          break;
        case "stopped":
          this.handleProviderStopped(status.stopReason);
          break;
        case "error":
          this.state.conversationState = {
            type: "error",
            error: status.error,
          };
          this.handleErrorState(status.error);
          break;
      }

      this.myDispatch({ type: "provider-thread-updated" });
    });
    this.providerThread.on("messages-updated", () => {
      this.rebuildToolCache();
      this.myDispatch({ type: "provider-thread-updated" });
    });
    this.providerThread.on("streaming-block-updated", () => {
      this.myDispatch({ type: "provider-thread-updated" });
    });
  }

  getProviderStatus(): ProviderThreadStatus {
    return this.providerThread.getState().status;
  }

  getProviderMessages(): ReadonlyArray<ProviderMessage> {
    return this.providerThread?.getState().messages ?? [];
  }

  truncateAndReset(): void {
    if (this.forkMessageIdx === undefined) {
      return;
    }

    // Reset conversation state BEFORE truncating since truncateMessages dispatches
    // events that are processed synchronously
    this.state.conversationState = { type: "idle" };

    // Clear view state for removed messages
    // Note: messageViewState is keyed by provider message indices which happen to
    // match native indices for Anthropic (1:1 mapping)
    const forkIdx = this.forkMessageIdx as number;
    for (const idx of Object.keys(this.state.messageViewState)) {
      const messageIdx = parseInt(idx, 10);
      if (messageIdx > forkIdx) {
        delete this.state.messageViewState[messageIdx];
      }
    }

    const nativeIdxToTruncateTo = this.forkMessageIdx;

    // Clear fork state
    this.forkNextPrompt = undefined;
    this.forkMessageIdx = undefined;

    // Truncate messages back to pre-fork state
    // This dispatches status-changed which triggers maybeAutoRespond
    this.providerThread.truncateMessages(nativeIdxToTruncateTo);
  }

  update(msg: RootMsg): void {
    if (msg.type == "thread-msg" && msg.id == this.id) {
      this.myUpdate(msg.msg);
    }
  }

  private myUpdate(msg: Msg): void {
    switch (msg.type) {
      case "update-profile":
        this.state.profile = msg.profile;
        break;

      case "send-message": {
        // Check if any message starts with @async
        const isAsync = msg.messages.some(
          (m) => m.type === "user" && m.text.trim().startsWith("@async"),
        );

        if (
          this.state.conversationState.type === "streaming" ||
          this.state.conversationState.type === "tool_use"
        ) {
          if (isAsync) {
            const processedMessages = msg.messages.map((m) => ({
              ...m,
              text:
                m.type === "user"
                  ? m.text.replace(/^\s*@async\s*/, "")
                  : m.text,
            }));
            this.state.pendingMessages.push(...processedMessages);
            break;
          } else {
            this.abortInProgressOperations();
          }
        }

        this.sendMessage(msg.messages).catch(
          this.handleSendMessageError.bind(this),
        );

        if (!this.state.title) {
          this.setThreadTitle(msg.messages.map((m) => m.text).join("\n")).catch(
            (err: Error) =>
              this.context.nvim.logger.error(
                "Error getting thread title: " + err.message + "\n" + err.stack,
              ),
          );
        }

        if (msg.messages.length) {
          setTimeout(() => {
            this.context.dispatch({
              type: "sidebar-msg",
              msg: {
                type: "scroll-to-last-user-message",
              },
            });
          }, 100);
        }
        break;
      }

      case "take-file-snapshot": {
        this.fileSnapshots
          .willEditFile(msg.unresolvedFilePath)
          .catch((e: Error) => {
            this.context.nvim.logger.error(
              `Failed to take file snapshot: ${e.message}`,
            );
          });
        return;
      }

      case "tool-msg": {
        if (
          this.state.conversationState.type == "stopped" &&
          this.state.conversationState.stopReason == "aborted"
        ) {
          // we aborted. Any further tool-msg stuff can be ignored
          return;
        }
        this.handleToolMsg(msg.id, msg.toolName, msg.msg);
        const autoRespondResult = this.maybeAutoRespond();
        // Play chime if tool completed but we didn't autorespond
        if (autoRespondResult.type !== "did-autorespond") {
          this.playChimeIfNeeded();
        }
        return;
      }

      case "context-manager-msg": {
        this.contextManager.update(msg.msg);
        return;
      }

      case "abort": {
        this.abortInProgressOperations();
        return;
      }

      case "set-title": {
        this.state.title = msg.title;
        return;
      }

      case "toggle-system-prompt": {
        this.state.showSystemPrompt = !this.state.showSystemPrompt;
        return;
      }

      // View state messages
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

      case "toggle-tool-details": {
        const toolState = this.state.toolViewState[msg.toolRequestId] || {
          details: false,
        };
        toolState.details = !toolState.details;
        this.state.toolViewState[msg.toolRequestId] = toolState;
        return;
      }

      case "open-edit-file": {
        openFileInNonMagentaWindow(msg.filePath, this.context).catch(
          (e: Error) => this.context.nvim.logger.error(e.message),
        );
        return;
      }

      case "diff-snapshot": {
        displaySnapshotDiff({
          unresolvedFilePath: msg.filePath as UnresolvedFilePath,
          nvim: this.context.nvim,
          cwd: this.context.cwd,
          fileSnapshots: this.fileSnapshots,
          getDisplayWidth: this.context.getDisplayWidth,
        }).catch((e: Error) => this.context.nvim.logger.error(e.message));
        return;
      }

      case "provider-thread-updated":
        // No-op: this message just triggers a re-render
        return;

      default:
        assertUnreachable(msg);
    }
  }

  private rebuildToolCache(): void {
    const results = new Map<ToolRequestId, ProviderToolResult>();

    for (const message of this.getProviderMessages()) {
      if (message.role !== "user") continue;

      for (const content of message.content) {
        if (content.type === "tool_result") {
          results.set(content.id, content);
        }
      }
    }

    this.state.toolCache = { results };
  }

  private handleProviderStoppedWithToolUse(): void {
    // Extract tool_use blocks from last assistant message
    const messages = this.getProviderMessages();
    const lastMessage = messages[messages.length - 1];

    if (!lastMessage || lastMessage.role !== "assistant") {
      // Shouldn't happen, but fall back to stopped state
      this.state.conversationState = {
        type: "stopped",
        stopReason: "tool_use",
      };
      return;
    }

    const activeTools = new Map<ToolRequestId, Tool | StaticTool>();
    let yieldResponse: string | undefined;

    for (const block of lastMessage.content) {
      if (block.type !== "tool_use") {
        continue;
      }

      if (block.request.status !== "ok") {
        continue;
      }

      const request = block.request.value;

      // Check for yield_to_parent
      if (request.toolName === "yield_to_parent") {
        yieldResponse = (request.input as { result: string }).result;
        // Still create the tool so we can track it
      }

      // Create tool context for createTool
      const toolContext: CreateToolContext = {
        dispatch: this.context.dispatch,
        mcpToolManager: this.context.mcpToolManager,
        bufferTracker: this.context.bufferTracker,
        getDisplayWidth: this.context.getDisplayWidth,
        threadId: this.id,
        nvim: this.context.nvim,
        lsp: this.context.lsp,
        cwd: this.context.cwd,
        options: this.context.options,
        chat: this.context.chat,
        gitignore: this.gitignore,
        contextManager: this.contextManager,
        threadDispatch: this.myDispatch,
      };

      // Create the dispatch function for this tool
      const toolDispatch = ({
        id,
        toolName,
        msg,
      }: {
        id: ToolRequestId;
        toolName: ToolName;
        msg: ToolMsg;
      }) =>
        this.myDispatch({
          type: "tool-msg",
          id,
          toolName,
          msg,
        });

      // Create static tool
      const tool = createTool(request, toolContext, toolDispatch);
      activeTools.set(request.id, tool);

      // Track edits for insert/replace tools
      if (request.toolName === "insert" || request.toolName === "replace") {
        const input = request.input as { filePath: string };
        const filePath = relativePath(
          this.context.cwd,
          input.filePath as UnresolvedFilePath,
        );

        if (!this.state.currentEdits[filePath]) {
          this.state.currentEdits[filePath] = {
            status: { status: "pending" },
            requestIds: [],
          };
        }
        this.state.currentEdits[filePath].requestIds.push(request.id);
      }
    }

    // Set conversation state based on whether we found yield_to_parent
    if (yieldResponse !== undefined) {
      this.state.conversationState = {
        type: "yielded",
        response: yieldResponse,
      };
    } else {
      this.state.conversationState = {
        type: "tool_use",
        activeTools,
      };
    }

    const autoRespondResult = this.maybeAutoRespond();

    if (autoRespondResult.type !== "did-autorespond") {
      this.playChimeIfNeeded();
    }
  }

  private handleProviderStopped(stopReason: StopReason): void {
    // Handle tool_use stop reason specially
    if (stopReason === "tool_use") {
      this.handleProviderStoppedWithToolUse();
      return;
    }

    // For all other stop reasons, set conversation state to stopped
    this.state.conversationState = { type: "stopped", stopReason };

    // Handle stopped state - check for pending messages
    const autoRespondResult = this.maybeAutoRespond();

    // Record a yield if we're not auto-responding and not waiting for tool input
    if (
      autoRespondResult.type !== "did-autorespond" &&
      autoRespondResult.type !== "waiting-for-tool-input"
    ) {
      this.fileSnapshots.startNewTurn();
      // Save current edits under the assistant message index where we yielded
      const yieldMessageIdx = this.getProviderMessages().length - 1;
      this.state.editsByYield[yieldMessageIdx] = this.state.currentEdits;
      this.state.currentEdits = {};
    }

    if (autoRespondResult.type !== "did-autorespond") {
      this.playChimeIfNeeded();
    }
  }

  private handleErrorState(error: Error): void {
    // On error, set up resubmit if we have a last user message
    const messages = this.getProviderMessages();
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === "user") {
      const textContent = lastMessage.content
        .filter(
          (c): c is Extract<typeof c, { type: "text" }> => c.type === "text",
        )
        .map((c) => c.text)
        .join("");
      if (textContent) {
        setTimeout(
          () =>
            this.context.dispatch({
              type: "sidebar-msg",
              msg: {
                type: "setup-resubmit",
                lastUserMessage: textContent,
              },
            }),
          1,
        );
      }
    }
    this.context.nvim.logger.error(error);
  }

  /** Handle a tool message by routing it to the appropriate tool */
  private handleToolMsg(
    id: ToolRequestId,
    toolName: ToolName,
    msg: ToolMsg,
  ): void {
    const conversationState = this.state.conversationState;

    if (conversationState.type != "tool_use") {
      throw new Error(`to handleToolMsg we have to be in tool_use state`);
    }
    const tool = conversationState.activeTools.get(id);
    if (!tool) {
      throw new Error(`Could not find tool with request id ${id}`);
    }

    // we know that the tool id <-> and msg type match
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (tool as any).update(msg);

    // Handle bash_command remember logic
    if (toolName === ("bash_command" as ToolName)) {
      const bashMsg = msg as unknown as BashCommand.Msg;
      if (
        bashMsg.type === "user-approval" &&
        bashMsg.approved &&
        bashMsg.remember
      ) {
        this.context.chat.rememberedCommands.add(
          (tool as unknown as BashCommand.BashCommandTool).request.input
            .command,
        );
      }
    }
  }

  private abortInProgressOperations(): void {
    // Abort the provider thread if streaming
    this.providerThread.abort();

    // If we're in tool_use state, abort all active tools and insert their results
    if (this.state.conversationState.type == "tool_use") {
      for (const [toolId, tool] of this.state.conversationState.activeTools) {
        if (!tool.isDone()) {
          // abort() returns the tool result synchronously
          const result = tool.abort();
          this.providerThread.toolResult(toolId, result);
        }
      }

      this.rebuildToolCache();
    }

    // Transition to aborted state
    this.state.conversationState = {
      type: "stopped",
      stopReason: "aborted",
    };
  }

  maybeAutoRespond():
    | { type: "did-autorespond" }
    | { type: "waiting-for-tool-input" }
    | { type: "yielded-to-parent" }
    | { type: "no-action-needed" } {
    const conversationState = this.state.conversationState;

    // Don't auto-respond if yielded or aborted
    if (conversationState.type === "yielded") {
      return { type: "yielded-to-parent" };
    }
    if (
      conversationState.type === "stopped" &&
      conversationState.stopReason === "aborted"
    ) {
      return { type: "no-action-needed" };
    }

    if (conversationState.type === "tool_use") {
      // Collect completed tools and check for blocking ones
      const completedTools: Array<{
        id: ToolRequestId;
        result: ProviderToolResult;
      }> = [];
      let hasAbortedTool = false;

      for (const [toolId, tool] of conversationState.activeTools) {
        if (tool.request.toolName === "yield_to_parent") {
          return { type: "yielded-to-parent" };
        }

        if (!tool.isDone()) {
          // terminate early if we have a blocking tool use
          return { type: "waiting-for-tool-input" };
        }

        // Check if this tool was aborted
        if (tool.aborted) {
          hasAbortedTool = true;
        }

        // Collect completed tool result
        completedTools.push({
          id: toolId,
          result: {
            type: "tool_result",
            id: toolId,
            result: tool.getToolResult().result,
          },
        });
      }

      // If any tool was aborted, send tool results but don't auto-respond
      if (hasAbortedTool) {
        for (const { id, result } of completedTools) {
          this.providerThread.toolResult(id, result);
        }
        this.state.conversationState = {
          type: "stopped",
          stopReason: "aborted",
        };
        this.rebuildToolCache();
        return { type: "no-action-needed" };
      }

      const pendingMessages = this.state.pendingMessages;
      this.state.pendingMessages = [];

      // Send tool results, then continue the conversation
      this.sendToolResultsAndContinue(completedTools, pendingMessages).catch(
        this.handleSendMessageError.bind(this),
      );
      this.rebuildToolCache();
      return { type: "did-autorespond" };
    } else if (
      conversationState.type === "stopped" &&
      conversationState.stopReason === "end_turn" &&
      this.state.pendingMessages.length
    ) {
      const pendingMessages = this.state.pendingMessages;
      this.state.pendingMessages = [];
      this.sendMessage(pendingMessages).catch(
        this.handleSendMessageError.bind(this),
      );
      return { type: "did-autorespond" };
    }
    return { type: "no-action-needed" };
  }

  /** Get context updates and convert to provider input format */
  private async getAndPrepareContextUpdates(): Promise<{
    content: ProviderThreadInput[];
    updates: FileUpdates | undefined;
  }> {
    const contextUpdates = await this.contextManager.getContextUpdate();
    if (Object.keys(contextUpdates).length === 0) {
      return { content: [], updates: undefined };
    }

    const contextContent =
      this.contextManager.contextUpdatesToContent(contextUpdates);
    const content: ProviderThreadInput[] = [];
    for (const c of contextContent) {
      if (c.type === "text") {
        content.push({ type: "text", text: c.text });
      }
    }

    return { content, updates: contextUpdates };
  }

  private async sendToolResultsAndContinue(
    toolResults: Array<{ id: ToolRequestId; result: ProviderToolResult }>,
    pendingMessages: InputMessage[],
  ): Promise<void> {
    // Send all tool results to the provider thread
    for (const { id, result } of toolResults) {
      this.providerThread.toolResult(id, result);
    }

    // Reset conversation state as we transition away from tool-use state
    this.state.conversationState = { type: "idle" };

    // If we have pending messages, send them via sendMessage
    if (pendingMessages.length > 0) {
      await this.sendMessage(pendingMessages);
      return;
    }

    // No pending messages - check for context updates
    const { content: contextContent, updates: contextUpdates } =
      await this.getAndPrepareContextUpdates();

    // Build content for the follow-up user message with system reminder
    const contentToSend: ProviderThreadInput[] = [...contextContent];

    // Always add system reminder when auto-responding
    contentToSend.push({
      type: "text",
      text: getSubsequentReminder(this.state.threadType),
    });

    if (contextUpdates) {
      const newMessageIdx = this.getProviderMessages().length;
      this.state.messageViewState[newMessageIdx] = {
        contextUpdates,
      };
    }

    this.providerThread.appendUserMessage(contentToSend);
    this.providerThread.continueConversation();
  }

  private handleSendMessageError = (error: Error): void => {
    // Log the error - the provider thread will emit the error state
    this.context.nvim.logger.error(error);
  };

  private playChimeIfNeeded(): void {
    // Play chime when we need the user to do something:
    // 1. Agent stopped with end_turn (user needs to respond)
    // 2. We're blocked on a tool use that requires user action
    const conversationState = this.state.conversationState;

    if (
      conversationState.type === "stopped" &&
      conversationState.stopReason === "end_turn"
    ) {
      this.playChimeSound();
      return;
    }

    if (conversationState.type === "tool_use") {
      for (const [, tool] of conversationState.activeTools) {
        if (tool.isPendingUserAction()) {
          this.playChimeSound();
          return;
        }
      }
    }
  }

  private playChimeSound(): void {
    const actualVolume = this.context.options.chimeVolume;

    if (!actualVolume) {
      return;
    }

    try {
      const play = player();
      const chimeFile = join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "chime.wav",
      );

      // Play sound with volume control (platform-specific options)
      const playOptions = {
        // For macOS afplay: volume range is 0-1, where 1 is full volume
        afplay: ["-v", actualVolume.toString()],
        // For Linux aplay: volume range is 0-100%
        aplay: ["-v", Math.round(actualVolume * 100).toString() + "%"],
        // For mpg123: volume range is 0-32768
        mpg123: ["-f", Math.round(actualVolume * 32768).toString()],
      };

      play.play(chimeFile, playOptions, (err: Error | null) => {
        if (err) {
          this.context.nvim.logger.error(
            `Failed to play chime sound: ${err.message}`,
          );
        }
      });
    } catch (error) {
      this.context.nvim.logger.error(
        `Error setting up chime sound: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Prepare user message content for sending to provider thread */
  private async prepareUserContent(inputMessages?: InputMessage[]): Promise<{
    content: ProviderMessageContent[];
    hasContent: boolean;
  }> {
    // Process messages to handle @file commands
    const messageContent: ProviderMessageContent[] = [];

    for (const m of inputMessages || []) {
      if (m.type === "user") {
        const { processedText, additionalContent } =
          await this.commandRegistry.processMessage(m.text, {
            nvim: this.context.nvim,
            cwd: this.context.cwd,
            contextManager: this.contextManager,
            options: this.context.options,
          });

        messageContent.push({
          type: "text",
          text: processedText,
        });

        // Add any additional content from commands
        messageContent.push(...additionalContent);

        // Check for @fork command in user messages
        if (m.text.includes("@fork")) {
          const forkText = m.text.replace(/@fork\s*/g, "").trim();
          messageContent[messageContent.length - 1 - additionalContent.length] =
            {
              type: "text",
              text: `\
My next prompt will be:
${forkText}

Use the fork_thread tool to start a new thread for this prompt.

- Carefully analyze the prompt
- Identify key concepts, patterns, files and decisions that may be relevant
- Include higly relevant files as contextFiles
- Name less relevant files that may be useful in the summary, but leave them out of contextFiles.
- Summarize ONLY information that directly supports addressing the next prompt, especially previous user instructions and observations that cannot be directly observable in the codebase.
- Prefer including files in contextFiles to copying code from those files into the summary. Do not repeat anything in the summary that can be learned directly from contextFiles.

You must use the fork_thread tool immediately, with only the information you already have. Do not use any other tools.`,
            };
          this.forkNextPrompt = forkText;
          this.forkMessageIdx = this.providerThread.getNativeMessageIdx();
        }
      } else {
        messageContent.push({
          type: "text",
          text: m.text,
        });
      }
    }

    // Add system reminder for user-submitted messages
    if (inputMessages?.length) {
      messageContent.push({
        type: "system_reminder",
        text: getSubsequentReminder(this.state.threadType),
      });
    }

    return {
      content: messageContent,
      hasContent: (inputMessages?.length ?? 0) > 0,
    };
  }

  async sendMessage(inputMessages?: InputMessage[]): Promise<void> {
    // Prepare user content
    const { content, hasContent } =
      await this.prepareUserContent(inputMessages);

    // Get context updates
    const { content: contextContent, updates: contextUpdates } =
      await this.getAndPrepareContextUpdates();

    if (!hasContent && contextContent.length === 0) {
      // No content to send - this shouldn't normally happen
      return;
    }

    // Store context updates in view state for the new user message
    const currentMessageCount = this.getProviderMessages().length;
    if (contextUpdates) {
      this.state.messageViewState[currentMessageCount] = {
        contextUpdates,
      };
    }

    // Build content to send to provider thread
    // Include context as text content, then user content
    const contentToSend: ProviderThreadInput[] = [...contextContent];

    // Add user content (filter to input types only)
    for (const c of content) {
      if (c.type === "text") {
        contentToSend.push({ type: "text", text: c.text });
      } else if (c.type === "image") {
        contentToSend.push(c);
      } else if (c.type === "document") {
        contentToSend.push(c);
      } else if (c.type === "system_reminder") {
        // Convert system_reminder to text for the provider
        contentToSend.push({ type: "text", text: c.text });
      }
    }

    // Send to provider thread and start response
    this.providerThread.appendUserMessage(contentToSend);
    this.providerThread.continueConversation();
  }

  /** Get messages in provider format - delegates to provider thread */
  getMessages(): ProviderMessage[] {
    return [...this.getProviderMessages()];
  }

  async setThreadTitle(userMessage: string) {
    // Create a profile with reasoning/thinking disabled for fast model
    const profileForRequest: Profile = {
      ...this.context.profile,
      thinking: undefined,
      reasoning: undefined,
    };

    const request = getProvider(
      this.context.nvim,
      profileForRequest,
    ).forceToolUse({
      model: this.context.profile.fastModel,
      input: [
        {
          type: "text",
          text: `\
The user has provided the following prompt:
${userMessage}

Come up with a succinct thread title for this prompt. It should be less than 80 characters long.
`,
        },
      ],
      spec: threadTitleToolSpec,
      systemPrompt: this.state.systemPrompt,
      disableCaching: true,
    });
    const result = await request.promise;
    if (result.toolRequest.status == "ok") {
      this.myDispatch({
        type: "set-title",
        title: (result.toolRequest.value.input as ThreadTitleInput).title,
      });
    }
  }

  getLastStopTokenCount(): number {
    const latestUsage = this.providerThread.getState().latestUsage;
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
}

/**
 * Helper function to render the animation frame for in-progress operations
 */
const getAnimationFrame = (sendDate: Date): string => {
  const frameIndex =
    Math.floor((new Date().getTime() - sendDate.getTime()) / 333) %
    MESSAGE_ANIMATION.length;

  return MESSAGE_ANIMATION[frameIndex];
};

/**
 * Helper function to render the status message
 */
const renderStatus = (
  conversationState: ConversationState,
  latestUsage: Usage | undefined,
): VDOMNode => {
  switch (conversationState.type) {
    case "idle":
      return renderStopReason("end_turn", latestUsage);
    case "streaming":
      return d`Streaming response ${getAnimationFrame(conversationState.startTime)}`;
    case "stopped":
      return renderStopReason(conversationState.stopReason, latestUsage);
    case "tool_use":
      return d`Executing tools...`;
    case "yielded":
      return d`↗️ yielded to parent: ${conversationState.response}`;
    case "error":
      return d`Error ${conversationState.error.message}${
        conversationState.error.stack
          ? "\n" + conversationState.error.stack
          : ""
      }`;
    default:
      assertUnreachable(conversationState);
  }
};

function renderStopReason(
  stopReason: StopReason,
  usage: Usage | undefined,
): VDOMNode {
  const usageView = usage ? d` ${renderUsage(usage)}` : d``;
  if (stopReason === "aborted") {
    return d`[ABORTED] ${usageView} `;
  }
  return d`Stopped (${stopReason}) ${usageView} `;
}

function renderUsage(usage: Usage): VDOMNode {
  return d`[input: ${usage.inputTokens.toString()}, output: ${usage.outputTokens.toString()}${
    usage.cacheHits !== undefined
      ? d`, cache hits: ${usage.cacheHits.toString()}`
      : ""
  }${
    usage.cacheMisses !== undefined
      ? d`, cache misses: ${usage.cacheMisses.toString()}`
      : ""
  }]`;
}

/**
 * Helper function to determine if context manager view should be shown
 */
const shouldShowContextManager = (
  conversationState: ConversationState,
  contextManager: ContextManager,
): boolean => {
  return (
    conversationState.type !== "streaming" && !contextManager.isContextEmpty()
  );
};

/**
 * Helper function to render the system prompt in collapsed/expanded state
 */
const renderSystemPrompt = (
  systemPrompt: SystemPrompt,
  showSystemPrompt: boolean,
  dispatch: Dispatch<Msg>,
): VDOMNode => {
  if (showSystemPrompt) {
    return withBindings(
      withExtmark(d`⚙️ [System Prompt]\n${systemPrompt}`, {
        hl_group: "@comment",
      }),
      {
        "<CR>": () => {
          dispatch({ type: "toggle-system-prompt" });
        },
      },
    );
  } else {
    const estimatedTokens = Math.round(systemPrompt.length / 4 / 1000) * 1000;
    const tokenDisplay =
      estimatedTokens >= 1000
        ? `~${(estimatedTokens / 1000).toString()}K`
        : `~${estimatedTokens.toString()}`;

    return withBindings(
      withExtmark(d`⚙️ [System Prompt ${tokenDisplay}]`, {
        hl_group: "@comment",
      }),
      {
        "<CR>": () => {
          dispatch({ type: "toggle-system-prompt" });
        },
      },
    );
  }
};

export const view: View<{
  thread: Thread;
  dispatch: Dispatch<Msg>;
}> = ({ thread, dispatch }) => {
  const titleView = thread.state.title
    ? d`# ${thread.state.title}`
    : d`# [ Untitled ]`;

  const systemPromptView = renderSystemPrompt(
    thread.state.systemPrompt,
    thread.state.showSystemPrompt,
    dispatch,
  );

  const messages = thread.getProviderMessages();
  const conversationState = thread.state.conversationState;

  if (
    messages.length === 0 &&
    (conversationState.type === "idle" ||
      (conversationState.type === "stopped" &&
        conversationState.stopReason === "end_turn"))
  ) {
    return d`\
${titleView}
${systemPromptView}

${LOGO}

magenta is for agentic flow

${thread.context.contextManager.view()}`;
  }

  const latestUsage = thread.providerThread.getState().latestUsage;
  const statusView = renderStatus(conversationState, latestUsage);

  const contextManagerView = shouldShowContextManager(
    conversationState,
    thread.context.contextManager,
  )
    ? d`\n${thread.context.contextManager.view()}`
    : d``;

  const pendingMessagesView =
    thread.state.pendingMessages.length > 0
      ? d`\n✉️  ${thread.state.pendingMessages.length.toString()} pending message${thread.state.pendingMessages.length === 1 ? "" : "s"}`
      : d``;

  // Render edit summary
  const editSummaryView = renderEditSummary(thread, dispatch);

  // Render messages from provider thread
  const messagesView = messages.map((message, messageIdx) => {
    // Skip user messages that only contain tool results
    if (
      message.role === "user" &&
      message.content.every((c) => c.type === "tool_result")
    ) {
      return d``;
    }

    // For user messages with only tool_result and system_reminder,
    // skip the header and just show the system reminder
    const isToolResultWithReminder =
      message.role === "user" &&
      message.content.every(
        (c) => c.type === "tool_result" || c.type === "system_reminder",
      ) &&
      message.content.some((c) => c.type === "system_reminder");

    const roleHeader = isToolResultWithReminder
      ? d``
      : withExtmark(d`# ${message.role}:`, {
          hl_group: "@markup.heading.1.markdown",
        });

    // Get view state for this message
    const viewState = thread.state.messageViewState[messageIdx];

    // Render context updates for user messages
    const contextUpdateView = viewState?.contextUpdates
      ? thread.contextManager.renderContextUpdate(viewState.contextUpdates)
      : d``;

    // Render content blocks
    const contentView = message.content.map((content, contentIdx) => {
      const isLastBlock = contentIdx === message.content.length - 1;
      return renderMessageContent(
        content,
        messageIdx,
        contentIdx,
        thread,
        dispatch,
        message.usage,
        isLastBlock,
      );
    });

    return d`\
${roleHeader}
${contextUpdateView}${contentView}
`;
  });

  const streamingBlockView =
    conversationState.type === "streaming"
      ? d`\n${renderStreamingBlock(thread)}\n`
      : d``;

  return d`\
${titleView}
${systemPromptView}

${messagesView}\
${streamingBlockView}\
${editSummaryView}\
${contextManagerView}\
${pendingMessagesView}
${statusView}`;
};

/** Render the edit summary for files modified in the current/last turn */
function renderEditSummary(thread: Thread, dispatch: Dispatch<Msg>): VDOMNode {
  const messages = thread.getProviderMessages();
  const lastMessage = messages[messages.length - 1];
  const lastMessageIdx = messages.length - 1;

  let edits: TurnEdits;

  // If the last message is an assistant message and it's in the yield map,
  // we're stopped and should show those edits
  if (
    lastMessage?.role === "assistant" &&
    thread.state.editsByYield[lastMessageIdx]
  ) {
    edits = thread.state.editsByYield[lastMessageIdx];
  } else {
    // Otherwise we're streaming or have pending user input, show currentEdits
    edits = thread.state.currentEdits;
  }

  if (Object.keys(edits).length === 0) {
    return d``;
  }

  const filePaths = Object.keys(edits);
  const editLines = filePaths.map((filePath) => {
    const editState = edits[filePath];
    const editCount = editState.requestIds.length;

    return withBindings(
      d`- \`${filePath}\` (${editCount.toString()} edits). [± diff snapshot]\n`,
      {
        "<CR>": () =>
          dispatch({
            type: "diff-snapshot",
            filePath,
          }),
      },
    );
  });

  return d`\nEdits:\n${editLines}`;
}

/** Render a single content block from a message */
function renderMessageContent(
  content: ProviderMessageContent,
  messageIdx: number,
  contentIdx: number,
  thread: Thread,
  dispatch: Dispatch<Msg>,
  messageUsage: Usage | undefined,
  isLastBlock: boolean,
): VDOMNode {
  switch (content.type) {
    case "text":
      return d`${content.text}\n`;

    case "thinking": {
      const viewState = thread.state.messageViewState[messageIdx];
      const isExpanded = viewState?.expandedContent?.[contentIdx] || false;

      if (isExpanded) {
        return withBindings(
          withExtmark(d`💭 [Thinking]\n${content.thinking}\n`, {
            hl_group: "@comment",
          }),
          {
            "<CR>": () => {
              dispatch({
                type: "toggle-expand-content",
                messageIdx,
                contentIdx,
              });
            },
          },
        );
      } else {
        return withBindings(
          withExtmark(d`💭 [Thinking]\n`, { hl_group: "@comment" }),
          {
            "<CR>": () =>
              dispatch({
                type: "toggle-expand-content",
                messageIdx,
                contentIdx,
              }),
          },
        );
      }
    }

    case "redacted_thinking":
      return withExtmark(d`💭 [Redacted Thinking]\n`, { hl_group: "@comment" });

    case "system_reminder": {
      const viewState = thread.state.messageViewState[messageIdx];
      const isExpanded = viewState?.expandedContent?.[contentIdx] || false;

      if (isExpanded) {
        return withBindings(
          withExtmark(d`📋 [System Reminder]\n${content.text}`, {
            hl_group: "@comment",
          }),
          {
            "<CR>": () => {
              dispatch({
                type: "toggle-expand-content",
                messageIdx,
                contentIdx,
              });
            },
          },
        );
      } else {
        return withBindings(
          withExtmark(d`📋 [System Reminder]`, { hl_group: "@comment" }),
          {
            "<CR>": () =>
              dispatch({
                type: "toggle-expand-content",
                messageIdx,
                contentIdx,
              }),
          },
        );
      }
    }

    case "tool_use": {
      if (content.request.status === "error") {
        return d`Malformed request: ${content.request.error}\n`;
      }

      const request = content.request.value;
      const toolViewState = thread.state.toolViewState[request.id];
      const showDetails = toolViewState?.details || false;

      // Show usage in details if this is the last block in the message
      const usageInDetails =
        showDetails && isLastBlock && messageUsage
          ? d`\n${renderUsage(messageUsage)}`
          : d``;

      // Check if tool is active (still running)
      const activeTool =
        thread.state.conversationState.type == "tool_use" &&
        thread.state.conversationState.activeTools.get(request.id);

      if (activeTool) {
        // Active tool - use the tool controller's render methods
        return withBindings(
          d`${activeTool.renderSummary()}${
            showDetails
              ? d`\n${activeTool.toolName}: ${activeTool.renderDetail ? activeTool.renderDetail() : JSON.stringify(activeTool.request.input, null, 2)}${usageInDetails}`
              : activeTool.renderPreview
                ? d`\n${activeTool.renderPreview()}`
                : ""
          }\n`,
          {
            "<CR>": () =>
              dispatch({
                type: "toggle-tool-details",
                toolRequestId: request.id,
              }),
          },
        );
      }

      // Completed tool - find the result and use tool-renderers
      const toolResult = findToolResult(thread, request.id);
      if (!toolResult) {
        return d`⚠️ tool result for ${request.id} not found\n`;
      }

      const completedInfo: CompletedToolInfo = {
        request: request,
        result: toolResult,
      };

      const renderContext = {
        getDisplayWidth: thread.context.getDisplayWidth,
        nvim: thread.context.nvim,
        cwd: thread.context.cwd,
        options: thread.context.options,
      };

      return d`${renderCompletedToolSummary(completedInfo, thread.context.dispatch)}${withBindings(
        d`${
          showDetails
            ? d`\n${renderCompletedToolDetail(completedInfo, renderContext)}${usageInDetails}`
            : d`\n${renderCompletedToolPreview(completedInfo, renderContext)}`
        }`,
        {
          "<CR>": () => {
            dispatch({
              type: "toggle-tool-details",
              toolRequestId: request.id,
            });
          },
        },
      )}\n`;
    }

    case "tool_result":
      // Tool results are rendered with their corresponding tool_use
      return d``;

    case "image":
      return d`[Image]\n`;

    case "document":
      return d`[Document${content.title ? `: ${content.title}` : ""}]\n`;

    case "server_tool_use":
      return d`🔍 Searching ${withExtmark(d`${content.input.query}`, { hl_group: "@string" })}...\n`;

    case "web_search_tool_result":
      if (
        "type" in content.content &&
        content.content.type === "web_search_tool_result_error"
      ) {
        return d`🌐 Search error: ${withExtmark(d`${content.content.error_code}`, { hl_group: "ErrorMsg" })}\n`;
      }
      // content.content is an array of web search results
      if (Array.isArray(content.content)) {
        const results = content.content
          .filter(
            (
              r,
            ): r is Extract<
              (typeof content.content)[number],
              { type: "web_search_result" }
            > => r.type === "web_search_result",
          )
          .map(
            (r) =>
              d`  [${r.title}](${r.url})${r.page_age ? ` (${r.page_age})` : ""}`,
          );
        return d`🌐 Search results\n${results}\n`;
      }
      return d`🌐 Search results\n`;

    case "context_update":
      // Context updates are rendered via thread.state.messageViewState
      return d``;

    default:
      return d`[Unknown content type]\n`;
  }
}

/** Find the tool result for a given tool request ID using the cached map */
export function findToolResult(
  thread: Thread,
  toolRequestId: ToolRequestId,
): ProviderToolResult | undefined {
  return thread.state.toolCache.results.get(toolRequestId);
}

function renderStreamingBlock(thread: Thread): string | VDOMNode {
  const state = thread.providerThread.getState();
  const block = state.streamingBlock;
  if (!block) return d``;

  switch (block.type) {
    case "text":
      return d`${block.text}`;
    case "thinking": {
      const lastLine = block.thinking.slice(
        block.thinking.lastIndexOf("\n") + 1,
      );
      return withExtmark(d`\n💭 [Thinking] ${lastLine}`, {
        hl_group: "@comment",
      });
    }
    case "tool_use": {
      return renderStreamdedTool(block);
    }
  }
}

export const LOGO = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "logo.txt"),
  "utf-8",
);

const MESSAGE_ANIMATION = ["⠁", "⠂", "⠄", "⠂"];
