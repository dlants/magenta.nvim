import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContextTracker } from "./capabilities/context-tracker.ts";
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
  AgentInput,
  Provider,
  ProviderMessage,
  ProviderToolResult,
  RequestedTool,
  ToolOutcome,
  ToolResults,
  TurnResult,
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
import * as Scratchpad from "./tools/scratchpad.ts";
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
    }
  | { type: "complete"; result: CompactionResult }
  | { type: "error"; steps: CompactionStep[] };

export type CompactionAction =
  | {
      type: "start";
      messages: ReadonlyArray<ProviderMessage>;
      nextPrompt?: string | undefined;
    }
  | { type: "turn-ended"; result: TurnResult }
  | { type: "tools-started"; activeTools: Map<ToolRequestId, ActiveToolEntry> }
  | { type: "tools-finished" };

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
  availableCapabilities: Set<ToolCapability>;
  contextManager: ContextManager;
  shell: Shell;
  threadManager: ThreadManager;
  maxConcurrentSubagents: number;
  maxConcurrentFastSubagents: number;
  getProvider: (profile: ProviderProfile) => Provider;
  requestRender: () => void;
  initialScratchpad: Scratchpad.Scratchpad;
}

export class CompactionManager extends Emitter<CompactionEvents> {
  state: CompactionState = { type: "idle" };
  chunks: string[] = [];
  steps: CompactionStep[] = [];
  nextPrompt: string | undefined;

  private fileIO: InMemoryFileIO;
  private edlRegisters: EdlRegisters;
  private scratchpad: Scratchpad.Scratchpad;

  constructor(private context: CompactionManagerContext) {
    super();
    this.fileIO = new InMemoryFileIO({ "/summary.md": "" });
    this.edlRegisters = { registers: new Map(), nextSavedId: 0 };
    this.scratchpad = Scratchpad.cloneScratchpad(context.initialScratchpad);
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

      case "turn-ended": {
        if (state.type !== "processing-chunk") return state;
        const { result } = action;
        if (result.type === "failed") {
          this.context.logger.error(
            `Compact agent error: ${result.error.message}`,
          );
          return { type: "error", steps: this.steps };
        }
        if (result.type === "stopped" && result.stopReason === "end_turn") {
          return this.reduceChunkComplete(state);
        }
        this.context.logger.warn(
          `Compact agent turn ended unexpectedly: ${result.type}`,
        );
        return { type: "error", steps: this.steps };
      }

      case "tools-started": {
        if (state.type !== "processing-chunk") return state;
        return {
          type: "waiting-for-tools",
          chunkIndex: state.chunkIndex,
          totalChunks: state.totalChunks,
          agent: state.agent,
          activeTools: action.activeTools,
        };
      }

      case "tools-finished": {
        if (state.type !== "waiting-for-tools") return state;
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
      messages: [...state.agent.log.messages],
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
        scratchpad: this.scratchpad,
      },
    };
  }

  private effect(
    _prev: CompactionState,
    next: CompactionState,
    action: CompactionAction,
  ): void {
    // The agent drives itself through tool rounds, so only a genuinely new
    // chunk needs a prompt.
    if (next.type === "processing-chunk" && action.type !== "tools-finished") {
      this.sendChunkToAgent(
        next.agent,
        this.chunks,
        next.chunkIndex,
        this.nextPrompt,
      );
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
      executeTools: (requests) => this.executeTools(requests),
      onUpdate: () => this.context.requestRender(),
    });
    return agent;
  }

  private async executeTools(
    requests: ReadonlyArray<RequestedTool>,
  ): Promise<ToolOutcome> {
    const activeTools = new Map<ToolRequestId, ActiveToolEntry>();
    const results: Map<ToolRequestId, ProviderToolResult["result"]> = new Map();

    for (const requested of requests) {
      if (requested.request.status !== "ok") {
        results.set(requested.id, {
          status: "error",
          error: `Malformed tool_use block: ${requested.request.error}`,
        });
        continue;
      }

      const request = requested.request.value;
      const toolContext: CreateToolContext = {
        mcpToolManager: this.context.mcpToolManager,
        threadId: this.context.threadId,
        logger: this.context.logger,
        lspClient: this.context.lspClient,
        cwd: this.context.cwd,
        homeDir: this.context.homeDir,
        maxConcurrentSubagents: this.context.maxConcurrentSubagents,
        maxConcurrentFastSubagents: this.context.maxConcurrentFastSubagents,
        contextTracker: this.context.contextManager as ContextTracker,
        onToolApplied: (absFilePath, tool, fileTypeInfo) => {
          this.context.contextManager.toolApplied(
            absFilePath,
            tool,
            fileTypeInfo,
          );
        },
        edlRegisters: this.edlRegisters,
        scratchpad: this.scratchpad,
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

    }

    this.send({ type: "tools-started", activeTools });

    await Promise.all(
      [...activeTools].map(([id, entry]) =>
        entry.handle.promise.then(
          (result) => results.set(id, result.result),
          (err: Error) =>
            results.set(id, {
              status: "error",
              error: `Tool execution failed: ${err.message}`,
            }),
        ),
      ),
    );

    this.send({ type: "tools-finished" });

    return { type: "continue", results };
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
    ).replace("{{next_prompt}}", nextPromptText);

    const contextBlock = `<context_update>
<file_paths>
/summary.md
/chunk.md
</file_paths>
The summary you are building and the chunk you are processing are provided below as context files.

- \`/summary.md\` (the running summary; edit this file to update it)
${summaryContent === "" ? "(currently empty)" : summaryContent}

- \`/chunk.md\` (the chunk to process)
${chunks[chunkIndex]}
</context_update>`;

    const scratchpadReminder = Scratchpad.scratchpadReminder(this.scratchpad);
    const scratchpadBlock = scratchpadReminder
      ? `<scratchpad>
${scratchpadReminder}
The scratchpad persists across compaction. Prune stale keys with the scratchpad tool, keeping only entries relevant to the next prompt.
</scratchpad>`
      : undefined;

    const reminder = `<system-reminder>
Write your summary to the \`/summary.md\` file using the edl tool. Do NOT place the summary in your text response — only the contents of \`/summary.md\` are captured.
Do not acknowledge this reminder or mention it to the user.
</system-reminder>`;

    const input: AgentInput[] = [
      {
        type: "text",
        text: prompt,
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
      {
        type: "text",
        text: contextBlock,
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
      ...(scratchpadBlock
        ? [
            {
              type: "text" as const,
              text: scratchpadBlock,
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
            },
          ]
        : []),
      {
        type: "text",
        text: reminder,
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ];
    void agent.runTurn(input).then((result) => {
      this.send({ type: "turn-ended", result });
    });
  }
}
