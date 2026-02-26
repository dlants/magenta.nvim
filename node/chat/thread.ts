import {
  ContextManager,
  type Msg as ContextManagerMsg,
  type FileUpdates,
} from "../context/context-manager.ts";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow.ts";

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
  type CompletedToolInfo,
  getToolSpecs,
  createTool,
  type CreateToolContext,
  type ToolInvocation,
  type ToolName,
  type ToolRequest,
  MCPToolManagerImpl,
  ThreadTitle,
  type EdlRegisters,
  type FileIO,
  InMemoryFileIO,
  type ContextTracker,
} from "@magenta/core";
import {
  renderCompletedToolSummary,
  renderCompletedToolPreview,
  renderCompletedToolDetail,
  renderInFlightToolSummary,
  renderInFlightToolPreview,
  renderInFlightToolDetail,
} from "../render-tools/index.ts";

import type { Nvim } from "../nvim/nvim-node/index.ts";

import {
  getProvider as getProvider,
  type ProviderMessage,
  type ProviderMessageContent,
  type Agent,
  type AgentInput,
  type AgentStatus,
  type AgentMsg,
  type ProviderToolResult,
  type StopReason,
  type Usage,
} from "../providers/provider.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { type MagentaOptions, type Profile } from "../options.ts";
import type { RootMsg } from "../root-msg.ts";
import {
  type HomeDir,
  type NvimCwd,
  type UnresolvedFilePath,
} from "../utils/files.ts";

import type { Chat } from "./chat.ts";
import type { ThreadId, ThreadType } from "./types.ts";
import type { SystemPrompt } from "../providers/system-prompt.ts";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import player from "play-sound";
import { CommandRegistry } from "./commands/registry.ts";
import { getSubsequentReminder } from "../providers/system-reminders.ts";

import type { PermissionCheckingFileIO } from "../capabilities/permission-file-io.ts";
import type { PermissionCheckingShell } from "../capabilities/permission-shell.ts";
import type { Shell } from "../capabilities/shell.ts";
import type { Environment } from "../environment.ts";
import {
  renderThreadToMarkdown,
  chunkMessages,
  CHARS_PER_TOKEN,
  TARGET_CHUNK_TOKENS,
  TOLERANCE_TOKENS,
} from "./compact-renderer.ts";

import { renderStreamdedTool } from "../render-tools/streaming.ts";
import { getContextWindowForModel } from "../providers/anthropic-agent.ts";

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
      type: "agent-msg";
      msg: AgentMsg;
    }
  | {
      type: "compact-agent-msg";
      msg: AgentMsg;
    }
  | {
      type: "permission-pending-change";
    }
  | {
      type: "tool-progress";
    }
  | {
      type: "toggle-compaction-record";
      recordIdx: number;
    }
  | {
      type: "toggle-compaction-step";
      recordIdx: number;
      stepIdx: number;
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

export type ActiveToolEntry = {
  handle: ToolInvocation;
  progress: unknown;
  toolName: ToolName;
  request: ToolRequest;
};

/** Cached lookup maps for tool results */
export type ToolCache = {
  results: Map<ToolRequestId, ProviderToolResult>;
};

export type CompactionStep = {
  chunkIndex: number;
  totalChunks: number;
  messages: ProviderMessage[];
};

export type CompactionRecord = {
  steps: CompactionStep[];
  finalSummary: string | undefined;
};
/** Thread-specific conversation mode (agent status is read directly from agent) */
export type ConversationMode =
  | { type: "normal" }
  | { type: "tool_use"; activeTools: Map<ToolRequestId, ActiveToolEntry> }
  | {
      type: "compacting";
      nextPrompt?: string;
      chunks: string[];
      currentChunkIndex: number;
      compactFileIO: InMemoryFileIO;
      compactAgent: Agent;
      compactActiveTools: Map<ToolRequestId, ActiveToolEntry>;
      compactEdlRegisters: EdlRegisters;
      steps: CompactionStep[];
    };

/** Minimum output tokens between system reminders during auto-respond loops */
const SYSTEM_REMINDER_MIN_TOKEN_INTERVAL = 2000;
export class Thread {
  public state: {
    title?: string | undefined;
    profile: Profile;
    threadType: ThreadType;
    systemPrompt: SystemPrompt;
    pendingMessages: InputMessage[];
    showSystemPrompt: boolean;
    /** View state per message, keyed by message index in agent */
    messageViewState: { [messageIdx: number]: MessageViewState };
    /** View state per tool, keyed by tool request ID */
    toolViewState: { [toolRequestId: ToolRequestId]: ToolViewState };

    /** Thread-specific mode (agent status is read directly from agent.getState().status) */
    mode: ConversationMode;
    /** Cached lookup maps for tool requests and results */
    toolCache: ToolCache;
    edlRegisters: EdlRegisters;
    outputTokensSinceLastReminder: number;
    yieldedResponse?: string;
    compactionHistory: CompactionRecord[];
    compactionViewState: {
      [recordIdx: number]: {
        expanded: boolean;
        expandedSteps: { [stepIdx: number]: boolean };
      };
    };
  };

  private myDispatch: Dispatch<Msg>;
  public contextManager: ContextManager;
  private commandRegistry: CommandRegistry;
  public agent: Agent;
  public permissionFileIO: PermissionCheckingFileIO | undefined;
  public fileIO: FileIO;
  public permissionShell: PermissionCheckingShell | undefined;
  public shell: Shell;

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
      contextManager: ContextManager;
      options: MagentaOptions;
      getDisplayWidth: () => number;
      environment: Environment;
    },
    clonedAgent?: Agent,
  ) {
    this.myDispatch = (msg) =>
      this.context.dispatch({
        type: "thread-msg",
        id: this.id,
        msg,
      });

    this.contextManager = this.context.contextManager;
    const env = this.context.environment;
    this.fileIO = env.fileIO;
    this.permissionFileIO = env.permissionFileIO;
    this.shell = env.shell;
    this.permissionShell = env.permissionShell;

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
      mode: { type: "normal" },
      toolCache: { results: new Map() },
      edlRegisters: { registers: new Map(), nextSavedId: 0 },
      outputTokensSinceLastReminder: 0,
      compactionHistory: [],
      compactionViewState: {},
    };

    if (clonedAgent) {
      this.agent = clonedAgent;
    } else {
      this.agent = this.createFreshAgent();
    }
  }

  private createFreshAgent(): Agent {
    const provider = getProvider(this.context.nvim, this.state.profile);
    return provider.createAgent(
      {
        model: this.state.profile.model,
        systemPrompt: this.state.systemPrompt,
        tools: getToolSpecs(
          this.state.threadType,
          this.context.mcpToolManager,
          this.context.environment.availableCapabilities,
        ),
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
      },
      (msg) => this.myDispatch({ type: "agent-msg", msg }),
    );
  }
  getProviderStatus(): AgentStatus {
    return this.agent.getState().status;
  }

  getProviderMessages(): ReadonlyArray<ProviderMessage> {
    return this.agent.getState().messages ?? [];
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
        this.handleSendMessageMsg(msg.messages).catch(
          this.handleSendMessageError.bind(this),
        );
        break;
      }

      case "context-manager-msg": {
        this.contextManager.update(msg.msg);
        return;
      }

      case "abort": {
        // Synchronously mark all tool invocations as aborted BEFORE the async
        // abortAndWait runs. This ensures the abort flag is set before
        // resolveThreadWaiters can fire (from child thread abort in chat.update).
        if (this.state.mode.type === "tool_use") {
          for (const [, entry] of this.state.mode.activeTools) {
            entry.handle.abort();
          }
        }
        this.abortAndWait().catch((e: Error) => {
          this.context.nvim.logger.error(`Error during abort: ${e.message}`);
        });
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

      case "agent-msg": {
        switch (msg.msg.type) {
          case "agent-content-updated":
            this.rebuildToolCache();
            return;
          case "agent-stopped":
            this.handleProviderStopped(msg.msg.stopReason);
            return;
          case "agent-error":
            this.handleErrorState(msg.msg.error);
            return;
          default:
            return assertUnreachable(msg.msg);
        }
      }

      case "permission-pending-change":
      case "tool-progress":
        // no-op: re-render is triggered by the dispatch itself
        return;
      case "compact-agent-msg":
        this.handleCompactAgentMsg(msg.msg);
        return;

      case "toggle-compaction-record": {
        const vs = this.state.compactionViewState[msg.recordIdx] || {
          expanded: false,
          expandedSteps: {},
        };
        vs.expanded = !vs.expanded;
        this.state.compactionViewState[msg.recordIdx] = vs;
        return;
      }

      case "toggle-compaction-step": {
        const vs = this.state.compactionViewState[msg.recordIdx] || {
          expanded: false,
          expandedSteps: {},
        };
        vs.expandedSteps[msg.stepIdx] = !vs.expandedSteps[msg.stepIdx];
        this.state.compactionViewState[msg.recordIdx] = vs;
        return;
      }

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
      throw new Error(
        `Cannot handleProviderStoppedWithToolUse when the last message is not of type assistant`,
      );
    }

    const activeTools = new Map<ToolRequestId, ActiveToolEntry>();

    for (const block of lastMessage.content) {
      if (block.type !== "tool_use") {
        continue;
      }

      if (block.request.status !== "ok") {
        this.agent.toolResult(block.id, {
          type: "tool_result",
          id: block.id,
          result: {
            status: "error",
            error: `Malformed tool_use block: ${block.request.error}`,
          },
        });
        continue;
      }

      const request = block.request.value;

      const toolContext: CreateToolContext = {
        mcpToolManager: this.context.mcpToolManager,
        threadId: this.id,
        logger: this.context.nvim.logger,
        lspClient: this.context.environment.lspClient,
        cwd: this.context.cwd,
        homeDir: this.context.homeDir,
        maxConcurrentSubagents:
          this.context.options.maxConcurrentSubagents || 3,
        contextTracker: this.contextManager as ContextTracker,
        onToolApplied: (absFilePath, tool, fileTypeInfo) => {
          this.contextManager.update({
            type: "tool-applied",
            absFilePath,
            tool,
            fileTypeInfo,
          });
        },
        diagnosticsProvider: this.context.environment.diagnosticsProvider,
        edlRegisters: this.state.edlRegisters,
        fileIO: this.fileIO,
        shell: this.shell,
        threadManager: this.context.chat,
        requestRender: () =>
          this.context.dispatch({
            type: "thread-msg",
            id: this.id,
            msg: { type: "tool-progress" },
          }),
      };

      const invocation = createTool(request, toolContext);
      activeTools.set(request.id, {
        handle: invocation,
        progress: "progress" in invocation ? invocation.progress : undefined,
        toolName: request.toolName,
        request,
      });

      void invocation.promise
        .then((result) => {
          this.state.toolCache.results.set(request.id, result);
        })
        .catch((err: Error) => {
          this.state.toolCache.results.set(request.id, {
            type: "tool_result",
            id: request.id,
            result: {
              status: "error",
              error: `Tool execution failed: ${err.message}`,
            },
          });
        })
        .then(() => {
          this.maybeAutoRespond();
        });
    }

    this.state.mode = {
      type: "tool_use",
      activeTools,
    };

    const autoRespondResult = this.maybeAutoRespond();

    if (autoRespondResult.type !== "did-autorespond") {
      this.playChimeIfNeeded();
    }
  }

  private async handleCompactComplete(
    summary: string,
    nextPrompt: string | undefined,
    steps: CompactionStep[],
  ): Promise<void> {
    this.state.compactionHistory.push({ steps, finalSummary: summary });
    await this.resetContextManager();

    this.agent = this.createFreshAgent();

    // Reset thread state for the fresh agent
    this.state.messageViewState = {};
    this.state.toolViewState = {};
    this.state.toolCache = { results: new Map() };
    this.state.edlRegisters = { registers: new Map(), nextSavedId: 0 };
    this.state.outputTokensSinceLastReminder = 0;

    // Send the summary as a raw message (no command processing)
    const summaryText = `<conversation-summary>\n${summary}\n</conversation-summary>`;
    this.agent.appendUserMessage([{ type: "text", text: summaryText }]);

    // Send the nextPrompt through normal sendMessage so commands like @file get processed
    if (nextPrompt) {
      await this.sendMessage([{ type: "user", text: nextPrompt }]);
    } else {
      await this.sendMessage([
        { type: "user", text: "Please continue from where you left off." },
      ]);
    }
  }

  /** Reset the context manager, optionally adding specified files */
  private async resetContextManager(contextFiles?: string[]): Promise<void> {
    this.contextManager = new ContextManager(
      (msg) =>
        this.context.dispatch({
          type: "thread-msg",
          id: this.id,
          msg: { type: "context-manager-msg", msg },
        }),
      {
        dispatch: this.context.dispatch,
        fileIO: this.fileIO,
        cwd: this.context.cwd,
        homeDir: this.context.homeDir,
        nvim: this.context.nvim,
        options: this.context.options,
      },
    );

    if (contextFiles && contextFiles.length > 0) {
      await this.contextManager.addFiles(contextFiles as UnresolvedFilePath[]);
    }

    this.context.contextManager = this.contextManager;
  }

  private shouldAutoCompact(): boolean {
    const inputTokenCount = this.agent.getState().inputTokenCount;
    if (inputTokenCount === undefined) return false;
    if (this.state.threadType === "compact") return false;

    const contextWindow = getContextWindowForModel(this.state.profile.model);
    return inputTokenCount >= contextWindow * 0.8;
  }

  private startCompaction(nextPrompt?: string): void {
    const { markdown, messageBoundaries } = renderThreadToMarkdown(
      this.getProviderMessages(),
    );

    const targetChunkChars = TARGET_CHUNK_TOKENS * CHARS_PER_TOKEN;
    const toleranceChars = TOLERANCE_TOKENS * CHARS_PER_TOKEN;
    const chunks = chunkMessages(
      markdown,
      messageBoundaries,
      targetChunkChars,
      toleranceChars,
    );

    if (chunks.length === 0) {
      this.context.nvim.logger.warn("No chunks to compact");
      return;
    }

    const compactFileIO = new InMemoryFileIO({ "/summary.md": "" });
    const compactEdlRegisters: EdlRegisters = {
      registers: new Map(),
      nextSavedId: 0,
    };
    const compactAgent = this.createCompactAgent();

    this.state.mode = {
      type: "compacting",
      ...(nextPrompt !== undefined && { nextPrompt }),
      chunks,
      currentChunkIndex: 0,
      compactFileIO,
      compactAgent,
      compactActiveTools: new Map(),
      compactEdlRegisters,
      steps: [],
    };

    this.sendCompactChunkToAgent(compactAgent, chunks, 0, nextPrompt);
  }

  private createCompactAgent(): Agent {
    const provider = getProvider(this.context.nvim, this.state.profile);
    return provider.createAgent(
      {
        model: this.state.profile.fastModel,
        systemPrompt:
          "You are a conversation compactor. Summarize conversation transcripts into concise summaries that preserve essential information for continuing the work.",
        tools: getToolSpecs(
          "compact",
          this.context.mcpToolManager,
          this.context.environment.availableCapabilities,
        ),
        skipPostFlightTokenCount: true,
      },
      (msg) => this.myDispatch({ type: "compact-agent-msg", msg }),
    );
  }

  private sendCompactChunkToAgent(
    agent: Agent,
    chunks: string[],
    chunkIndex: number,
    nextPrompt?: string,
  ): void {
    const mode = this.state.mode;
    if (mode.type !== "compacting") return;

    // Write the chunk to /chunk.md so EDL can cut/paste from it into /summary.md
    mode.compactFileIO.writeFileSync("/chunk.md", chunks[chunkIndex]);

    const isLastChunk = chunkIndex === chunks.length - 1;
    const chunkLabel = `chunk ${chunkIndex + 1} of ${chunks.length}`;

    const statusParts = [`This is ${chunkLabel}.`];
    if (chunkIndex === 0) {
      statusParts.push(
        "The file /summary.md is currently empty. Write the initial summary.",
      );
    } else {
      statusParts.push(
        "Fold the essential information from the new chunk into the existing /summary.md. Do NOT rewrite the summary from scratch.",
      );
    }
    if (isLastChunk) {
      statusParts.push(
        "This is the LAST chunk. Make sure the summary is complete and well-organized.",
      );
    }

    const nextPromptText = nextPrompt ?? "Continue from where you left off.";

    const summaryContent =
      chunkIndex > 0
        ? (mode.compactFileIO.getFileContents("/summary.md") ?? "")
        : "";

    const prompt = COMPACT_PROMPT_TEMPLATE.replace(
      "{{status}}",
      statusParts.join(" "),
    )
      .replace("{{next_prompt}}", nextPromptText)
      .replace("{{summary}}", summaryContent)
      .replace("{{chunk}}", chunks[chunkIndex]);

    agent.appendUserMessage([{ type: "text", text: prompt }]);
    agent.continueConversation();
  }

  private handleCompactAgentMsg(msg: AgentMsg): void {
    const mode = this.state.mode;
    if (mode.type !== "compacting") {
      this.context.nvim.logger.warn(
        "Received compact-agent-msg while not in compacting mode",
      );
      return;
    }

    switch (msg.type) {
      case "agent-content-updated":
        return;

      case "agent-error":
        this.context.nvim.logger.error(
          `Compact agent error: ${msg.error.message}`,
        );
        this.state.compactionHistory.push({
          steps: mode.steps,
          finalSummary: undefined,
        });
        this.state.mode = { type: "normal" };
        return;

      case "agent-stopped": {
        if (msg.stopReason === "tool_use") {
          this.handleCompactAgentToolUse(mode);
        } else if (msg.stopReason === "end_turn") {
          this.handleCompactChunkComplete(mode);
        } else {
          this.context.nvim.logger.warn(
            `Compact agent stopped with unexpected reason: ${msg.stopReason}`,
          );
          this.state.compactionHistory.push({
            steps: mode.steps,
            finalSummary: undefined,
          });
          this.state.mode = { type: "normal" };
        }
        return;
      }
    }
  }

  private handleCompactAgentToolUse(
    mode: Extract<ConversationMode, { type: "compacting" }>,
  ): void {
    const messages = mode.compactAgent.getState().messages;
    const lastMessage = messages[messages.length - 1];

    if (!lastMessage || lastMessage.role !== "assistant") {
      this.context.nvim.logger.error(
        "Compact agent tool_use but no assistant message",
      );
      this.state.mode = { type: "normal" };
      return;
    }

    const activeTools = new Map<ToolRequestId, ActiveToolEntry>();

    for (const block of lastMessage.content) {
      if (block.type !== "tool_use") {
        continue;
      }

      if (block.request.status !== "ok") {
        mode.compactAgent.toolResult(block.id, {
          type: "tool_result",
          id: block.id,
          result: {
            status: "error",
            error: `Malformed tool_use block: ${block.request.error}`,
          },
        });
        continue;
      }

      const request = block.request.value;
      const toolContext: CreateToolContext = {
        mcpToolManager: this.context.mcpToolManager,
        threadId: this.id,
        logger: this.context.nvim.logger,
        lspClient: this.context.environment.lspClient,
        cwd: this.context.cwd,
        homeDir: this.context.homeDir,
        maxConcurrentSubagents:
          this.context.options.maxConcurrentSubagents || 3,
        contextTracker: this.contextManager as ContextTracker,
        onToolApplied: (absFilePath, tool, fileTypeInfo) => {
          this.contextManager.update({
            type: "tool-applied",
            absFilePath,
            tool,
            fileTypeInfo,
          });
        },
        diagnosticsProvider: this.context.environment.diagnosticsProvider,
        edlRegisters: mode.compactEdlRegisters,
        fileIO: mode.compactFileIO,
        shell: this.shell,
        threadManager: this.context.chat,
        requestRender: () =>
          this.context.dispatch({
            type: "thread-msg",
            id: this.id,
            msg: { type: "tool-progress" },
          }),
      };

      const invocation = createTool(request, toolContext);
      activeTools.set(request.id, {
        handle: invocation,
        progress: "progress" in invocation ? invocation.progress : undefined,
        toolName: request.toolName,
        request,
      });

      void invocation.promise
        .then((result) => {
          this.state.toolCache.results.set(request.id, result);
        })
        .catch((err: Error) => {
          this.state.toolCache.results.set(request.id, {
            type: "tool_result",
            id: request.id,
            result: {
              status: "error",
              error: `Tool execution failed: ${err.message}`,
            },
          });
        })
        .then(() => {
          this.handleCompactToolCompletion();
        });
    }

    mode.compactActiveTools = activeTools;
  }

  private handleCompactToolCompletion(): void {
    const mode = this.state.mode;
    if (mode.type !== "compacting") {
      return;
    }

    // Check if all compact tools are done
    for (const [, entry] of mode.compactActiveTools) {
      if (!this.state.toolCache.results.has(entry.request.id)) return;
    }

    // All tools done — send results back to compact agent and continue
    for (const [toolId, entry] of mode.compactActiveTools) {
      const result = this.state.toolCache.results.get(entry.request.id);
      if (result) {
        mode.compactAgent.toolResult(toolId, result);
      }
    }
    mode.compactActiveTools = new Map();
    mode.compactAgent.continueConversation();
  }

  private handleCompactChunkComplete(
    mode: Extract<ConversationMode, { type: "compacting" }>,
  ): void {
    const nextChunkIndex = mode.currentChunkIndex + 1;

    // Snapshot the current agent's messages as a completed step
    mode.steps.push({
      chunkIndex: mode.currentChunkIndex,
      totalChunks: mode.chunks.length,
      messages: [...mode.compactAgent.getState().messages],
    });

    if (nextChunkIndex < mode.chunks.length) {
      // More chunks to process — create a new compact agent for the next chunk
      const newAgent = this.createCompactAgent();
      mode.compactAgent = newAgent;
      mode.currentChunkIndex = nextChunkIndex;
      mode.compactActiveTools = new Map();
      this.sendCompactChunkToAgent(
        newAgent,
        mode.chunks,
        nextChunkIndex,
        mode.nextPrompt,
      );
    } else {
      // All chunks processed — read the final summary
      const summary = mode.compactFileIO.getFileContents("/summary.md");
      if (summary === undefined || summary === "") {
        this.context.nvim.logger.error(
          "Compact agent finished but /summary.md is empty",
        );
        this.state.compactionHistory.push({
          steps: mode.steps,
          finalSummary: undefined,
        });
        this.state.mode = { type: "normal" };
        return;
      }

      const nextPrompt = mode.nextPrompt;
      const { steps } = mode;
      this.state.mode = { type: "normal" };
      this.handleCompactComplete(summary, nextPrompt, steps).catch(
        (e: Error) => {
          this.context.nvim.logger.error(
            `Failed during compact-complete: ${e.message}`,
          );
        },
      );
    }
  }

  private handleProviderStopped(stopReason: StopReason): void {
    // Accumulate output tokens for system reminder throttling
    const latestUsage = this.agent.getState().latestUsage;
    if (latestUsage) {
      this.state.outputTokensSinceLastReminder += latestUsage.outputTokens;
    }

    // Handle tool_use stop reason specially
    if (stopReason === "tool_use") {
      this.handleProviderStoppedWithToolUse();
      return;
    }

    this.state.mode = { type: "normal" };

    // Handle stopped state - check for pending messages
    const autoRespondResult = this.maybeAutoRespond();

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

  /** Abort in-progress operations and wait for completion.
   * Returns a promise that resolves when the agent is in a stable state.
   */
  async abortAndWait(): Promise<void> {
    // Abort the provider thread if streaming and wait for it to complete
    await this.agent.abort();

    // If we're in tool_use mode, abort all active tools and insert their results
    if (this.state.mode.type === "tool_use") {
      for (const [toolId, entry] of this.state.mode.activeTools) {
        entry.handle.abort();
        if (!this.state.toolCache.results.has(toolId)) {
          this.agent.toolResult(toolId, {
            type: "tool_result",
            id: toolId,
            result: {
              status: "error",
              error: "Request was aborted by the user.",
            },
          });
        }
      }

      // Mark agent as aborted after inserting all error tool results
      this.agent.abortToolUse();
      this.rebuildToolCache();
    }

    // Clear any pending permission checks so they don't block after abort
    this.permissionFileIO?.denyAll();
    this.permissionShell?.denyAll();

    // Transition to normal mode (agent status already reflects aborted)
    this.state.mode = { type: "normal" };
  }

  /** Handle send-message action - async handler for the entire flow */
  private async handleSendMessageMsg(messages: InputMessage[]): Promise<void> {
    // For compact threads, skip all command processing and send raw text
    if (this.state.threadType === "compact") {
      this.sendRawMessage(messages);
      return;
    }

    // Check if the first user message starts with @fork
    const firstUserMessage = messages.find((m) => m.type === "user");
    if (firstUserMessage?.text.trim().startsWith("@fork")) {
      // Strip @fork from the message and dispatch to Chat
      const strippedMessages = messages.map((m) => ({
        ...m,
        text: m.type === "user" ? m.text.replace(/^\s*@fork\s*/, "") : m.text,
      }));

      this.context.dispatch({
        type: "chat-msg",
        msg: {
          type: "fork-thread",
          sourceThreadId: this.id,
          strippedMessages,
        },
      });
      return;
    }

    // Check if the first user message starts with @compact
    if (firstUserMessage?.text.trim().startsWith("@compact")) {
      const nextPrompt = firstUserMessage.text
        .replace(/^\s*@compact\s*/, "")
        .trim();
      this.startCompaction(nextPrompt || undefined);
      return;
    }

    // Check if any message starts with @async
    const isAsync = messages.some(
      (m) => m.type === "user" && m.text.trim().startsWith("@async"),
    );

    const agentStatus = this.agent.getState().status;
    const isBusy =
      agentStatus.type === "streaming" || this.state.mode.type === "tool_use";

    if (isBusy) {
      if (isAsync) {
        const processedMessages = messages.map((m) => ({
          ...m,
          text:
            m.type === "user" ? m.text.replace(/^\s*@async\s*/, "") : m.text,
        }));
        this.state.pendingMessages.push(...processedMessages);
        return;
      } else {
        await this.abortAndWait();
      }
    }

    await this.sendMessage(messages);

    if (!this.state.title) {
      this.setThreadTitle(messages.map((m) => m.text).join("\n")).catch(
        (err: Error) =>
          this.context.nvim.logger.error(
            "Error getting thread title: " + err.message + "\n" + err.stack,
          ),
      );
    }

    if (messages.length) {
      setTimeout(() => {
        this.context.dispatch({
          type: "sidebar-msg",
          msg: {
            type: "scroll-to-last-user-message",
          },
        });
      }, 100);
    }
  }

  maybeAutoRespond():
    | { type: "did-autorespond" }
    | { type: "waiting-for-tool-input" }
    | { type: "yielded-to-parent" }
    | { type: "no-action-needed" } {
    const mode = this.state.mode;
    const agentStatus = this.agent.getState().status;

    // Don't auto-respond if yielded or aborted
    if (this.state.yieldedResponse !== undefined) {
      return { type: "yielded-to-parent" };
    }
    if (
      agentStatus.type === "stopped" &&
      agentStatus.stopReason === "aborted"
    ) {
      return { type: "no-action-needed" };
    }

    // Don't auto-respond while compact subagent is running
    if (mode.type === "compacting") {
      return { type: "no-action-needed" };
    }

    if (mode.type === "tool_use") {
      // Collect completed tools and check for blocking ones
      const completedTools: Array<{
        id: ToolRequestId;
        result: ProviderToolResult;
      }> = [];
      for (const [toolId, entry] of mode.activeTools) {
        if (entry.toolName === "yield_to_parent") {
          this.state.yieldedResponse = (
            entry.request.input as { result: string }
          ).result;
          return { type: "yielded-to-parent" };
        }

        const cachedResult = this.state.toolCache.results.get(toolId);
        if (!cachedResult) {
          return { type: "waiting-for-tool-input" };
        }

        completedTools.push({
          id: toolId,
          result: cachedResult,
        });
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
      agentStatus.type === "stopped" &&
      agentStatus.stopReason === "end_turn" &&
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

  private async getAndPrepareContextUpdates(): Promise<{
    content: AgentInput[];
    updates: FileUpdates | undefined;
  }> {
    const contextUpdates = await this.contextManager.getContextUpdate();
    if (Object.keys(contextUpdates).length === 0) {
      return { content: [], updates: undefined };
    }

    const contextContent =
      this.contextManager.contextUpdatesToContent(contextUpdates);
    const content: AgentInput[] = [];
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
      this.agent.toolResult(id, result);
    }

    // Reset mode as we transition away from tool_use
    this.state.mode = { type: "normal" };

    // If we have pending messages, send them via sendMessage
    if (pendingMessages.length > 0) {
      await this.sendMessage(pendingMessages);
      return;
    }

    // No pending messages - check for context updates
    const { content: contextContent, updates: contextUpdates } =
      await this.getAndPrepareContextUpdates();

    // Build content for the follow-up user message with system reminder
    const contentToSend: AgentInput[] = [...contextContent];

    // Only add system reminder if enough tokens have been generated since the last one
    if (
      this.state.outputTokensSinceLastReminder >=
      SYSTEM_REMINDER_MIN_TOKEN_INTERVAL
    ) {
      const reminder = getSubsequentReminder(this.state.threadType);
      if (reminder) {
        contentToSend.push({
          type: "text",
          text: reminder,
        });
      }
      this.state.outputTokensSinceLastReminder = 0;
    }

    if (contextUpdates) {
      const newMessageIdx = this.getProviderMessages().length;
      this.state.messageViewState[newMessageIdx] = {
        contextUpdates,
      };
    }

    // Auto-compact if approaching context window limit
    if (this.shouldAutoCompact()) {
      this.startCompaction();
      return;
    }

    if (contentToSend.length > 0) {
      this.agent.appendUserMessage(contentToSend);
    }
    this.agent.continueConversation();
  }

  private handleSendMessageError = (error: Error): void => {
    // Log the error - the provider thread will emit the error state
    this.context.nvim.logger.error(error);
  };

  private playChimeIfNeeded(): void {
    // Play chime when we need the user to do something:
    // 1. Agent stopped with end_turn (user needs to respond)
    // 2. We're blocked on a tool use that requires user action
    const agentStatus = this.agent.getState().status;

    if (
      agentStatus.type === "stopped" &&
      agentStatus.stopReason === "end_turn"
    ) {
      this.playChimeSound();
      return;
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
            homeDir: this.context.homeDir,
            contextManager: this.contextManager,
            options: this.context.options,
          });

        messageContent.push({
          type: "text",
          text: processedText,
        });

        // Add any additional content from commands
        messageContent.push(...additionalContent);
      } else {
        messageContent.push({
          type: "text",
          text: m.text,
        });
      }
    }

    // Always add system reminder for user-submitted messages and reset counter
    if (inputMessages?.length) {
      this.state.outputTokensSinceLastReminder = 0;
      const reminder = getSubsequentReminder(this.state.threadType);
      if (reminder) {
        messageContent.push({
          type: "system_reminder",
          text: reminder,
        });
      }
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
    const contentToSend: AgentInput[] = [...contextContent];

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

    // Auto-compact if approaching context window limit
    if (this.shouldAutoCompact()) {
      const rawText = inputMessages
        ?.filter((m) => m.type === "user")
        .map((m) => m.text)
        .join("\n");
      this.startCompaction(rawText || undefined);
      return;
    }

    // Send to provider thread and start response
    this.agent.appendUserMessage(contentToSend);
    this.agent.continueConversation();
  }

  /** Send messages as raw text, bypassing command processing and context updates.
   * Used for compact threads where message content should not be transformed.
   */
  private sendRawMessage(messages: InputMessage[]): void {
    const contentToSend: AgentInput[] = messages.map((m) => ({
      type: "text" as const,
      text: m.text,
    }));

    if (contentToSend.length === 0) return;

    this.agent.appendUserMessage(contentToSend);
    this.agent.continueConversation();
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
      spec: ThreadTitle.spec,
      systemPrompt: this.state.systemPrompt,
      disableCaching: true,
    });
    const result = await request.promise;
    if (result.toolRequest.status == "ok") {
      this.myDispatch({
        type: "set-title",
        title: (result.toolRequest.value.input as ThreadTitle.Input).title,
      });
    }
  }

  getLastStopTokenCount(): number {
    const state = this.agent.getState();
    if (state.inputTokenCount != undefined) {
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
 * Composes agent status with thread mode for complete display
 */
const renderStatus = (
  agentStatus: AgentStatus,
  mode: ConversationMode,
  latestUsage: Usage | undefined,
  yieldedResponse: string | undefined,
): VDOMNode => {
  // First check mode for thread-specific states
  if (mode.type === "tool_use") {
    return d`Executing tools...`;
  }
  if (yieldedResponse !== undefined) {
    return d`↗️ yielded to parent: ${yieldedResponse}`;
  }
  if (mode.type === "compacting") {
    return d`📦 Compacting thread...`;
  }

  // Then render based on agent status
  switch (agentStatus.type) {
    case "streaming":
      return d`Streaming response ${getAnimationFrame(agentStatus.startTime)}`;
    case "stopped":
      return renderStopReason(agentStatus.stopReason, latestUsage);
    case "error":
      return d`Error ${agentStatus.error.message}${
        agentStatus.error.stack ? "\n" + agentStatus.error.stack : ""
      }`;
    default:
      assertUnreachable(agentStatus);
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
  agentStatus: AgentStatus,
  mode: ConversationMode,
  contextManager: ContextManager,
): boolean => {
  return (
    agentStatus.type === "stopped" &&
    mode.type === "normal" &&
    !contextManager.isContextEmpty()
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

function renderCompactionHistory(
  history: CompactionRecord[],
  viewState: Thread["state"]["compactionViewState"],
  dispatch: Dispatch<Msg>,
): VDOMNode {
  if (history.length === 0) return d``;

  return d`${history.map((record, recordIdx) => {
    const rv = viewState[recordIdx];
    const isExpanded = rv?.expanded || false;
    const summaryLen = record.finalSummary?.length ?? 0;
    const status =
      record.finalSummary !== undefined
        ? `summary: ${summaryLen} chars`
        : "⚠️ failed";

    const header = withBindings(
      withExtmark(
        d`📦 [Compaction ${(recordIdx + 1).toString()} — ${record.steps.length.toString()} step${record.steps.length === 1 ? "" : "s"}, ${status}]\n`,
        { hl_group: "@comment" },
      ),
      {
        "<CR>": () => dispatch({ type: "toggle-compaction-record", recordIdx }),
      },
    );

    if (!isExpanded) return header;

    const stepsView = record.steps.map((step, stepIdx) => {
      const stepExpanded = rv?.expandedSteps[stepIdx] || false;
      const stepHeader = withBindings(
        withExtmark(
          d`  📄 [Step ${(step.chunkIndex + 1).toString()} of ${step.totalChunks.toString()}]\n`,
          { hl_group: "@comment" },
        ),
        {
          "<CR>": () =>
            dispatch({
              type: "toggle-compaction-step",
              recordIdx,
              stepIdx,
            }),
        },
      );

      if (!stepExpanded) return stepHeader;

      const { markdown } = renderThreadToMarkdown(step.messages);
      return d`${stepHeader}${withExtmark(d`${markdown}\n`, { hl_group: "@comment" })}`;
    });

    const summaryView =
      record.finalSummary !== undefined
        ? d`  📋 Final Summary:\n${withExtmark(d`${record.finalSummary}\n`, { hl_group: "@comment" })}`
        : d`  ⚠️ Compaction failed — no summary produced\n`;

    return d`${header}${stepsView}${summaryView}`;
  })}`;
}
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
  const agentStatus = thread.agent.getState().status;
  const mode = thread.state.mode;

  // Show logo when empty and not busy
  const isIdle =
    agentStatus.type === "stopped" && agentStatus.stopReason === "end_turn";
  if (messages.length === 0 && isIdle && mode.type === "normal") {
    return d`\
${titleView}
${systemPromptView}

${LOGO}

magenta is for agentic flow

${thread.context.contextManager.view()}`;
  }

  const latestUsage = thread.agent.getState().latestUsage;
  const statusView = renderStatus(
    agentStatus,
    mode,
    latestUsage,
    thread.state.yieldedResponse,
  );

  const contextManagerView = shouldShowContextManager(
    agentStatus,
    mode,
    thread.context.contextManager,
  )
    ? d`\n${thread.context.contextManager.view()}`
    : d``;

  const filePermissionView =
    thread.permissionFileIO &&
    thread.permissionFileIO.getPendingPermissions().size > 0
      ? d`\n${thread.permissionFileIO.view()}`
      : d``;
  const shellPermissionView =
    thread.permissionShell &&
    thread.permissionShell.getPendingPermissions().size > 0
      ? d`\n${thread.permissionShell.view()}`
      : d``;
  const permissionView = d`${filePermissionView}${shellPermissionView}`;
  const compactionHistoryView = renderCompactionHistory(
    thread.state.compactionHistory,
    thread.state.compactionViewState,
    dispatch,
  );
  const pendingMessagesView =
    thread.state.pendingMessages.length > 0
      ? d`\n✉️  ${thread.state.pendingMessages.length.toString()} pending message${thread.state.pendingMessages.length === 1 ? "" : "s"}`
      : d``;

  // Helper to check if a message is a tool-result-only user message
  const isToolResultOnlyMessage = (msg: ProviderMessage): boolean =>
    msg.role === "user" &&
    msg.content.every(
      (c) => c.type === "tool_result" || c.type === "system_reminder",
    );

  // Render messages from provider thread
  const messagesView = messages.map((message, messageIdx) => {
    // Skip user messages that only contain tool results (no system_reminder)
    if (
      message.role === "user" &&
      message.content.every((c) => c.type === "tool_result")
    ) {
      return d``;
    }

    // For user messages with only tool_result and system_reminder,
    // skip the header but show the system reminder inline
    const isToolResultWithReminder =
      message.role === "user" &&
      message.content.every(
        (c) => c.type === "tool_result" || c.type === "system_reminder",
      ) &&
      message.content.some((c) => c.type === "system_reminder");

    // Skip "# assistant:" header if this is a continuation of a tool-use turn
    // (i.e., previous message was a tool-result-only user message)
    const prevMessage = messageIdx > 0 ? messages[messageIdx - 1] : undefined;
    const isAssistantContinuation =
      message.role === "assistant" &&
      prevMessage &&
      isToolResultOnlyMessage(prevMessage);

    const roleHeader =
      isToolResultWithReminder || isAssistantContinuation
        ? d``
        : withExtmark(d`# ${message.role}:\n`, {
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
${roleHeader}\
${contextUpdateView}\
${contentView}`;
  });

  const streamingBlockView =
    agentStatus.type === "streaming"
      ? d`\n${renderStreamingBlock(thread)}\n`
      : d``;

  return d`\
${titleView}
${systemPromptView}
${compactionHistoryView}
${messagesView}\
${streamingBlockView}\
${contextManagerView}\
${permissionView}\
${pendingMessagesView}
${statusView}`;
};

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
          withExtmark(d`📋 [System Reminder]\n${content.text}\n`, {
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
        // Render inline (no newline) so checkpoint can follow on same line
        return withBindings(
          withExtmark(d`📋 [System Reminder]\n`, { hl_group: "@comment" }),
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
      const activeEntry =
        thread.state.mode.type === "tool_use" &&
        thread.state.mode.activeTools.get(request.id);

      if (activeEntry) {
        const displayContext = {
          cwd: thread.context.cwd,
          homeDir: thread.context.homeDir,
        };
        const renderContext = {
          getDisplayWidth: thread.context.getDisplayWidth,
          nvim: thread.context.nvim,
          cwd: thread.context.cwd,
          homeDir: thread.context.homeDir,
          options: thread.context.options,
          dispatch: thread.context.dispatch,
          chat: thread.context.chat,
        };

        const inFlightPreview = renderInFlightToolPreview(
          activeEntry.request,
          activeEntry.progress,
          renderContext,
        );

        return withBindings(
          d`${renderInFlightToolSummary(activeEntry.request, displayContext, activeEntry.progress)}${
            showDetails
              ? d`\n${renderInFlightToolDetail(activeEntry.request, activeEntry.progress, renderContext)}${usageInDetails}`
              : inFlightPreview
                ? d`\n${inFlightPreview}`
                : d``
          }\n`,
          {
            "<CR>": () =>
              dispatch({
                type: "toggle-tool-details",
                toolRequestId: request.id,
              }),
            t: () => activeEntry.handle.abort(),
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
        homeDir: thread.context.homeDir,
        options: thread.context.options,
        dispatch: thread.context.dispatch,
      };

      // Get preview content to check if it's empty
      const previewContent = renderCompletedToolPreview(
        completedInfo,
        renderContext,
      );

      // Don't add trailing newline - let the message template handle it
      return withBindings(
        d`${renderCompletedToolSummary(completedInfo, thread.context.dispatch, renderContext, thread.context.chat)}${
          showDetails
            ? d`\n${renderCompletedToolDetail(completedInfo, renderContext)}${usageInDetails}`
            : previewContent
              ? d`\n${previewContent}`
              : d``
        }\n`,
        {
          "<CR>": () => {
            dispatch({
              type: "toggle-tool-details",
              toolRequestId: request.id,
            });
          },
        },
      );
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

    case "web_search_tool_result": {
      const viewState = thread.state.messageViewState[messageIdx];
      const isExpanded = viewState?.expandedContent?.[contentIdx] || false;

      if (
        "type" in content.content &&
        content.content.type === "web_search_tool_result_error"
      ) {
        return d`🌐 Search error: ${withExtmark(d`${content.content.error_code}`, { hl_group: "ErrorMsg" })}\n`;
      }
      if (Array.isArray(content.content)) {
        const searchResults = content.content.filter(
          (
            r,
          ): r is Extract<
            (typeof content.content)[number],
            { type: "web_search_result" }
          > => r.type === "web_search_result",
        );
        if (isExpanded) {
          const results = searchResults.map(
            (r) =>
              d`  [${r.title}](${r.url})${r.page_age ? ` (${r.page_age})` : ""}\n`,
          );
          return withBindings(d`🌐 Search results\n${results}\n`, {
            "<CR>": () =>
              dispatch({
                type: "toggle-expand-content",
                messageIdx,
                contentIdx,
              }),
          });
        }
        return withBindings(
          d`🌐 ${searchResults.length.toString()} search result${searchResults.length === 1 ? "" : "s"}\n`,
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
      return d`🌐 Search results\n`;
    }

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
  const state = thread.agent.getState();
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

const COMPACT_PROMPT_TEMPLATE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "compact-system-prompt.md"),
  "utf-8",
);
export const LOGO = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "logo.txt"),
  "utf-8",
);

const MESSAGE_ANIMATION = ["⠁", "⠂", "⠄", "⠂"];
