import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContextTracker } from "./capabilities/context-tracker.ts";
import type { DiagnosticsProvider } from "./capabilities/diagnostics-provider.ts";
import type { HelpTagsProvider } from "./capabilities/help-tags-provider.ts";
import type { LspClient } from "./capabilities/lsp-client.ts";
import type { Shell } from "./capabilities/shell.ts";
import type { ThreadManager } from "./capabilities/thread-manager.ts";
import type { ThreadId } from "./chat-types.ts";
import {
  CHARS_PER_TOKEN,
  chunkMessages,
  renderThreadToMarkdown,
  TARGET_CHUNK_TOKENS,
  TOLERANCE_TOKENS,
} from "./compact-renderer.ts";
import type {
  CompactionResult,
  CompactionStep,
} from "./compaction-controller.ts";
import type { ContextManager } from "./context/context-manager.ts";
import { InMemoryFileIO } from "./edl/in-memory-file-io.ts";
import type { EdlRegisters } from "./edl/index.ts";
import { Emitter } from "./emitter.ts";
import type { Logger } from "./logger.ts";
import type { ProviderProfile } from "./provider-options.ts";
import type {
  Agent,
  Provider,
  ProviderMessage,
  ProviderToolResult,
  StopReason,
} from "./providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./providers/provider-types.ts";
import type {
  ToolInvocation,
  ToolName,
  ToolRequest,
  ToolRequestId,
} from "./tool-types.ts";
import { type CreateToolContext, createTool } from "./tools/create-tool.ts";
import type { MCPToolManager as MCPToolManagerImpl } from "./tools/mcp/manager.ts";
import type { ToolCapability } from "./tools/tool-registry.ts";
import { getToolSpecs } from "./tools/toolManager.ts";
import type { HomeDir, NvimCwd } from "./utils/files.ts";

const COMPACT_PROMPT_TEMPLATE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "compact-system-prompt.md"),
  "utf-8",
);

type ActiveToolEntry = {
  handle: ToolInvocation;
  progress: unknown;
  toolName: ToolName;
  request: ToolRequest;
};

export type CompactionState =
  | { type: "idle" }
  | {
      type: "processing-chunk";
      chunkIndex: number;
      totalChunks: number;
      agent: Agent;
    }
  | {
      type: "waiting-for-tools";
      chunkIndex: number;
      totalChunks: number;
      agent: Agent;
      activeTools: Map<ToolRequestId, ActiveToolEntry>;
      toolResults: Map<ToolRequestId, ProviderToolResult>;
    }
  | { type: "complete"; result: CompactionResult }
  | { type: "error"; steps: CompactionStep[] };

export type CompactionAction =
  | {
      type: "start";
      messages: ReadonlyArray<ProviderMessage>;
      nextPrompt?: string | undefined;
    }
  | { type: "agent-stopped"; stopReason: StopReason }
  | { type: "agent-error"; error: Error }
  | {
      type: "tool-complete";
      id: ToolRequestId;
      result: ProviderToolResult;
    };

export type CompactionEvents = {
  transition: [prev: CompactionState, next: CompactionState];
};
export interface CompactionManagerContext {
  logger: Logger;
  profile: ProviderProfile;
  mcpToolManager: MCPToolManagerImpl;
  threadId: ThreadId;
  cwd: NvimCwd;
  homeDir: HomeDir;
  lspClient: LspClient;
  diagnosticsProvider: DiagnosticsProvider;
  helpTagsProvider: HelpTagsProvider;
  availableCapabilities: Set<ToolCapability>;
  contextManager: ContextManager;
  shell: Shell;
  threadManager: ThreadManager;
  maxConcurrentSubagents: number;
  getProvider: (profile: ProviderProfile) => Provider;
  requestRender: () => void;
}

export class CompactionManager extends Emitter<CompactionEvents> {
  state: CompactionState = { type: "idle" };
  chunks: string[] = [];
  steps: CompactionStep[] = [];
  nextPrompt: string | undefined;

  private fileIO: InMemoryFileIO;
  private edlRegisters: EdlRegisters;

  constructor(private context: CompactionManagerContext) {
    super();
    this.fileIO = new InMemoryFileIO({ "/summary.md": "" });
    this.edlRegisters = { registers: new Map(), nextSavedId: 0 };
  }

  send(action: CompactionAction): void {
    const prev = this.state;
    this.state = this.reduce(prev, action);
    if (prev !== this.state) {
      this.emit("transition", prev, this.state);
      this.effect(prev, this.state, action);
    }
  }

  start(messages: ReadonlyArray<ProviderMessage>, nextPrompt?: string): void {
    this.send({ type: "start", messages, nextPrompt });
  }

  private reduce(
    state: CompactionState,
    action: CompactionAction,
  ): CompactionState {
    switch (action.type) {
      case "start": {
        if (state.type !== "idle") return state;

        const { markdown, messageBoundaries } = renderThreadToMarkdown(
          action.messages,
        );
        const targetChunkChars = TARGET_CHUNK_TOKENS * CHARS_PER_TOKEN;
        const toleranceChars = TOLERANCE_TOKENS * CHARS_PER_TOKEN;
        this.chunks = chunkMessages(
          markdown,
          messageBoundaries,
          targetChunkChars,
          toleranceChars,
        );

        if (this.chunks.length === 0) {
          this.context.logger.warn("No chunks to compact");
          return state;
        }

        this.nextPrompt = action.nextPrompt;
        this.steps = [];

        const agent = this.createCompactAgent();
        return {
          type: "processing-chunk",
          chunkIndex: 0,
          totalChunks: this.chunks.length,
          agent,
        };
      }

      case "agent-error": {
        this.context.logger.error(
          `Compact agent error: ${action.error.message}`,
        );
        return { type: "error", steps: this.steps };
      }

      case "agent-stopped": {
        if (action.stopReason === "tool_use") {
          if (state.type !== "processing-chunk") {
            return state;
          }
          const { activeTools, malformedResults } = this.buildToolEntries(
            state.agent,
          );
          for (const r of malformedResults) {
            state.agent.toolResult(r.id, r);
          }
          return {
            type: "waiting-for-tools",
            chunkIndex: state.chunkIndex,
            totalChunks: state.totalChunks,
            agent: state.agent,
            activeTools,
            toolResults: new Map(),
          };
        }

        if (action.stopReason === "end_turn") {
          if (state.type !== "processing-chunk") {
            return state;
          }
          return this.reduceChunkComplete(state);
        }

        this.context.logger.warn(
          `Compact agent stopped with unexpected reason: ${action.stopReason}`,
        );
        return { type: "error", steps: this.steps };
      }

      case "tool-complete": {
        if (state.type !== "waiting-for-tools") return state;
        state.toolResults.set(action.id, action.result);

        // Check if all tools are done
        for (const [, entry] of state.activeTools) {
          if (!state.toolResults.has(entry.request.id)) return state;
        }

        // All tools done — feed results back and continue
        for (const [toolId, entry] of state.activeTools) {
          const result = state.toolResults.get(entry.request.id);
          if (result) {
            state.agent.toolResult(toolId, result);
          }
        }

        return {
          type: "processing-chunk",
          chunkIndex: state.chunkIndex,
          totalChunks: state.totalChunks,
          agent: state.agent,
        };
      }

      default: {
        const _exhaustive: never = action;
        return _exhaustive;
      }
    }
  }

  private reduceChunkComplete(
    state: Extract<CompactionState, { type: "processing-chunk" }>,
  ): CompactionState {
    this.steps.push({
      chunkIndex: state.chunkIndex,
      totalChunks: state.totalChunks,
      messages: [...state.agent.getState().messages],
    });

    const nextChunkIndex = state.chunkIndex + 1;

    if (nextChunkIndex < state.totalChunks) {
      const newAgent = this.createCompactAgent();
      return {
        type: "processing-chunk",
        chunkIndex: nextChunkIndex,
        totalChunks: state.totalChunks,
        agent: newAgent,
      };
    }

    const summary = this.fileIO.getFileContents("/summary.md");
    if (summary === undefined || summary === "") {
      this.context.logger.error(
        "Compact agent finished but /summary.md is empty",
      );
      return { type: "error", steps: this.steps };
    }

    return {
      type: "complete",
      result: {
        type: "complete",
        summary,
        steps: this.steps,
        nextPrompt: this.nextPrompt,
      },
    };
  }

  private effect(
    _prev: CompactionState,
    next: CompactionState,
    action: CompactionAction,
  ): void {
    if (next.type === "processing-chunk") {
      if (action.type === "tool-complete") {
        // All tools finished — resume the conversation
        next.agent.continueConversation();
      } else {
        // Entering a new chunk (from start or chunk-complete) — send it
        this.sendChunkToAgent(
          next.agent,
          this.chunks,
          next.chunkIndex,
          this.nextPrompt,
        );
      }
    }
  }

  private createCompactAgent(): Agent {
    const provider = this.context.getProvider(this.context.profile);
    const agent = provider.createAgent({
      model: this.context.profile.fastModel,
      systemPrompt:
        "You are a conversation compactor. Summarize conversation transcripts into concise summaries that preserve essential information for continuing the work.",
      tools: getToolSpecs(
        "compact",
        this.context.mcpToolManager,
        this.context.availableCapabilities,
      ),
      skipPostFlightTokenCount: true,
    });
    agent.on("stopped", (stopReason) => {
      this.send({ type: "agent-stopped", stopReason });
    });
    agent.on("error", (error) => {
      this.send({ type: "agent-error", error });
    });
    return agent;
  }

  private buildToolEntries(agent: Agent): {
    activeTools: Map<ToolRequestId, ActiveToolEntry>;
    malformedResults: ProviderToolResult[];
  } {
    const messages = agent.getState().messages;
    const lastMessage = messages[messages.length - 1];
    const activeTools = new Map<ToolRequestId, ActiveToolEntry>();
    const malformedResults: ProviderToolResult[] = [];

    if (!lastMessage || lastMessage.role !== "assistant") {
      this.context.logger.error(
        "Compact agent tool_use but no assistant message",
      );
      return { activeTools, malformedResults };
    }

    for (const block of lastMessage.content) {
      if (block.type !== "tool_use") continue;

      if (block.request.status !== "ok") {
        malformedResults.push({
          type: "tool_result",
          id: block.id,
          result: {
            status: "error",
            error: `Malformed tool_use block: ${block.request.error}`,
          },
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        });
        continue;
      }

      const request = block.request.value;
      const toolContext: CreateToolContext = {
        mcpToolManager: this.context.mcpToolManager,
        threadId: this.context.threadId,
        logger: this.context.logger,
        lspClient: this.context.lspClient,
        cwd: this.context.cwd,
        homeDir: this.context.homeDir,
        maxConcurrentSubagents: this.context.maxConcurrentSubagents,
        contextTracker: this.context.contextManager as ContextTracker,
        onToolApplied: (absFilePath, tool, fileTypeInfo) => {
          this.context.contextManager.toolApplied(
            absFilePath,
            tool,
            fileTypeInfo,
          );
        },
        diagnosticsProvider: this.context.diagnosticsProvider,
        helpTagsProvider: this.context.helpTagsProvider,
        edlRegisters: this.edlRegisters,
        fileIO: this.fileIO,
        shell: this.context.shell,
        threadManager: this.context.threadManager,
        requestRender: () => this.context.requestRender(),
        getAgents: () => ({}),
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
          this.send({ type: "tool-complete", id: request.id, result });
        })
        .catch((err: Error) => {
          this.send({
            type: "tool-complete",
            id: request.id,
            result: {
              type: "tool_result",
              id: request.id,
              result: {
                status: "error",
                error: `Tool execution failed: ${err.message}`,
              },
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
            },
          });
        });
    }

    return { activeTools, malformedResults };
  }

  private sendChunkToAgent(
    agent: Agent,
    chunks: string[],
    chunkIndex: number,
    nextPrompt?: string,
  ): void {
    this.fileIO.writeFileSync("/chunk.md", chunks[chunkIndex]);

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
      chunkIndex > 0 ? (this.fileIO.getFileContents("/summary.md") ?? "") : "";

    const prompt = COMPACT_PROMPT_TEMPLATE.replace(
      "{{status}}",
      statusParts.join(" "),
    )
      .replace("{{next_prompt}}", nextPromptText)
      .replace("{{summary}}", summaryContent)
      .replace("{{chunk}}", chunks[chunkIndex]);

    agent.appendUserMessage([{ type: "text", text: prompt, nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }]);
    agent.continueConversation();
  }
}
