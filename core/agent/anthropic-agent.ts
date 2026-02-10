import Anthropic from "@anthropic-ai/sdk";
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream.mjs";
import type {
  Agent,
  AgentInput,
  AgentMsg,
  AgentOptions,
  AgentState,
  AgentStatus,
  AgentStreamingBlock,
  CompactRequest,
  NativeMessageIdx,
  ProviderMessage,
  ProviderToolResult,
} from "./provider-types.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { ToolRequestId } from "../tools/toolManager.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { ToolName } from "../tools/types.ts";
import { validateInput } from "../tools/helpers.ts";

export type AnthropicAgentOptions = {
  authType: "key" | "max";
  includeWebSearch: boolean;
  disableParallelToolUseFlag: boolean;
};

// Internal streaming block type for all Anthropic block types
type AnthropicStreamingBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: ToolRequestId; name: ToolName; inputJson: string }
  | {
      type: "server_tool_use";
      id: string;
      name: "web_search";
      inputJson: string;
    }
  | {
      type: "web_search_tool_result";
      tool_use_id: string;
      content: Anthropic.WebSearchToolResultBlockContent;
    };

import type { StopReason, Usage } from "./provider-types.ts";

type MessageStopInfo = {
  stopReason: StopReason;
  usage: Usage;
};

/** Actions that trigger state transitions in the agent */
type Action =
  | { type: "start-streaming" }
  | {
      type: "block-started";
      index: number;
      block: Anthropic.Messages.ContentBlock;
    }
  | {
      type: "block-delta";
      index: number;
      delta: Anthropic.Messages.ContentBlockDeltaEvent["delta"];
    }
  | { type: "block-finished"; index: number }
  | { type: "stream-completed"; response: Anthropic.Message }
  | { type: "stream-error"; error: Error }
  | { type: "stream-aborted" };

export class AnthropicAgent implements Agent {
  private messages: Anthropic.MessageParam[] = [];
  private currentRequest: MessageStream | undefined;
  private params: Omit<Anthropic.Messages.MessageStreamParams, "messages">;
  private currentAnthropicBlock: AnthropicStreamingBlock | undefined;
  private status: AgentStatus = { type: "stopped", stopReason: "end_turn" };
  private latestUsage: Usage | undefined;
  /** Stop info for each assistant message, keyed by message index */
  private messageStopInfo: Map<number, MessageStopInfo> = new Map();
  /** Cached provider messages to avoid expensive conversion on every getState() */
  private cachedProviderMessages: ProviderMessage[] = [];
  /** Current block index during streaming, -1 when not streaming a block */
  private currentBlockIndex: number = -1;
  /** Assistant message being built during streaming */
  private currentAssistantMessage: Anthropic.MessageParam | undefined;
  /** Stored for cloning */
  private anthropicOptions: AnthropicAgentOptions;
  /** Promise that resolves when streaming stops, and its resolver */
  private streamingEndPromise: Promise<void> | undefined;
  private streamingEndResolver: (() => void) | undefined;

  constructor(
    private options: AgentOptions,
    private client: Anthropic,
    private dispatch: Dispatch<AgentMsg>,
    anthropicOptions: AnthropicAgentOptions,
  ) {
    this.anthropicOptions = anthropicOptions;
    this.params = this.createNativeStreamParameters(anthropicOptions);
  }

  private dispatchAsync(msg: AgentMsg): void {
    queueMicrotask(() => {
      this.dispatch(msg);
    });
  }

  private update(action: Action): void {
    switch (action.type) {
      case "start-streaming":
        this.status = { type: "streaming", startTime: new Date() };
        this.currentBlockIndex = -1;
        this.currentAssistantMessage = undefined;
        this.streamingEndPromise = new Promise((resolve) => {
          this.streamingEndResolver = resolve;
        });
        this.dispatchAsync({ type: "agent-content-updated" });
        break;

      case "block-started":
        if (this.currentBlockIndex !== -1) {
          throw new Error(
            `Received content_block_start at index ${action.index} while block ${this.currentBlockIndex} is still open`,
          );
        }
        this.currentBlockIndex = action.index;
        this.currentAnthropicBlock = this.initAnthropicStreamingBlock(
          action.block,
        );
        this.dispatchAsync({ type: "agent-content-updated" });
        break;

      case "block-delta":
        if (action.index !== this.currentBlockIndex) {
          throw new Error(
            `Received content_block_delta for index ${action.index} but current block is ${this.currentBlockIndex}`,
          );
        }
        if (this.currentAnthropicBlock) {
          this.currentAnthropicBlock = this.applyAnthropicDelta(
            this.currentAnthropicBlock,
            action.delta,
          );
          const streamingBlock = this.getStreamingBlock();
          if (streamingBlock) {
            this.dispatchAsync({ type: "agent-content-updated" });
          }
        }
        break;

      case "block-finished": {
        if (action.index !== this.currentBlockIndex) {
          throw new Error(
            `Received content_block_stop for index ${action.index} but current block is ${this.currentBlockIndex}`,
          );
        }

        if (!this.currentAssistantMessage) {
          this.currentAssistantMessage = {
            role: "assistant",
            content: [],
          };
          this.messages.push(this.currentAssistantMessage);
        }

        const content = this.currentAssistantMessage
          .content as Anthropic.Messages.ContentBlockParam[];
        if (this.currentAnthropicBlock) {
          content.push(
            this.anthropicStreamingBlockToParam(this.currentAnthropicBlock),
          );
        }
        this.currentAnthropicBlock = undefined;
        this.updateCachedProviderMessages();
        this.currentBlockIndex = -1;
        break;
      }

      case "stream-completed": {
        this.currentRequest = undefined;
        const response = action.response;

        if (!this.currentAssistantMessage) {
          this.currentAssistantMessage = {
            role: "assistant",
            content: [],
          };
          this.messages.push(this.currentAssistantMessage);
        }

        (
          this.currentAssistantMessage
            .content as Anthropic.Messages.ContentBlockParam[]
        ).length = 0;
        for (const block of response.content) {
          (
            this.currentAssistantMessage
              .content as Anthropic.Messages.ContentBlockParam[]
          ).push(this.responseBlockToParam(block));
        }
        this.updateCachedProviderMessages();

        const usage: Usage = {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        };
        if (response.usage.cache_read_input_tokens != null) {
          usage.cacheHits = response.usage.cache_read_input_tokens;
        }
        if (response.usage.cache_creation_input_tokens != null) {
          usage.cacheMisses = response.usage.cache_creation_input_tokens;
        }

        this.latestUsage = usage;
        const stopReason = response.stop_reason || "end_turn";
        const messageIndex = this.messages.indexOf(
          this.currentAssistantMessage,
        );
        this.messageStopInfo.set(messageIndex, { stopReason, usage });

        this.currentAssistantMessage = undefined;
        this.status = { type: "stopped", stopReason };
        this.resolveStreamingEnd();
        this.dispatchAsync({ type: "agent-stopped", stopReason, usage });
        break;
      }

      case "stream-error": {
        this.currentRequest = undefined;
        this.cleanup({ type: "error", error: action.error });
        this.currentAssistantMessage = undefined;
        this.status = { type: "error", error: action.error };
        this.resolveStreamingEnd();
        this.dispatchAsync({ type: "agent-error", error: action.error });
        break;
      }

      case "stream-aborted":
        this.currentRequest = undefined;
        this.cleanup({ type: "aborted" });
        this.currentAssistantMessage = undefined;
        this.status = { type: "stopped", stopReason: "aborted" };
        this.resolveStreamingEnd();
        this.dispatchAsync({ type: "agent-stopped", stopReason: "aborted" });
        break;

      default:
        assertUnreachable(action);
    }
  }

  getState(): AgentState {
    return {
      status: this.status,
      messages: this.cachedProviderMessages,
      streamingBlock: this.getStreamingBlock(),
      latestUsage: this.latestUsage,
    };
  }

  getStreamingBlock(): AgentStreamingBlock | undefined {
    if (!this.currentAnthropicBlock) {
      return undefined;
    }
    // Only expose types that AgentStreamingBlock supports
    switch (this.currentAnthropicBlock.type) {
      case "text":
      case "thinking":
      case "tool_use":
        return this.currentAnthropicBlock;
      default:
        return undefined;
    }
  }

  /** Get a copy of the native Anthropic messages for use in context piping */
  getNativeMessages(): Anthropic.MessageParam[] {
    return [...this.messages];
  }

  getNativeMessageIdx(): NativeMessageIdx {
    return (this.messages.length - 1) as NativeMessageIdx;
  }

  appendUserMessage(content: AgentInput[]): void {
    const nativeContent = this.convertInputToNative(content);
    this.messages.push({
      role: "user",
      content: nativeContent,
    });
    this.updateCachedProviderMessages();
  }

  toolResult(toolUseId: ToolRequestId, result: ProviderToolResult): void {
    // Validate that we're in the correct state to receive a tool result
    if (
      this.status.type !== "stopped" ||
      this.status.stopReason !== "tool_use"
    ) {
      throw new Error(
        `Cannot provide tool result: expected status stopped with stopReason tool_use, but got ${JSON.stringify(this.status)}`,
      );
    }

    const lastMessage = this.messages[this.messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") {
      throw new Error(
        `Cannot provide tool result: expected last message to be from assistant, but got ${lastMessage?.role ?? "no message"}`,
      );
    }

    const assistantContent = lastMessage.content;
    if (typeof assistantContent === "string") {
      throw new Error(
        `Cannot provide tool result: assistant message has string content instead of blocks`,
      );
    }

    const hasMatchingToolUse = assistantContent.some(
      (block) => block.type === "tool_use" && block.id === toolUseId,
    );
    if (!hasMatchingToolUse) {
      throw new Error(
        `Cannot provide tool result: no tool_use block with id ${toolUseId} found in assistant message`,
      );
    }

    const nativeContent = this.convertToolResultToNative(toolUseId, result);

    // Tool results go in a user message
    this.messages.push({
      role: "user",
      content: nativeContent,
    });
    this.updateCachedProviderMessages();
  }

  abort(): Promise<void> {
    if (this.currentRequest) {
      this.currentRequest.abort();
      // The catch block in continueConversation will handle the status update
      // Return the promise that will resolve when streaming ends
      return this.streamingEndPromise || Promise.resolve();
    }
    return Promise.resolve();
  }

  abortToolUse(): void {
    if (
      this.status.type !== "stopped" ||
      this.status.stopReason !== "tool_use"
    ) {
      throw new Error(
        `Cannot abortToolUse: expected status stopped with stopReason tool_use, but got ${JSON.stringify(this.status)}`,
      );
    }
    this.status = { type: "stopped", stopReason: "aborted" };
    this.dispatchAsync({ type: "agent-stopped", stopReason: "aborted" });
  }

  private resolveStreamingEnd(): void {
    if (this.streamingEndResolver) {
      this.streamingEndResolver();
      this.streamingEndResolver = undefined;
      this.streamingEndPromise = undefined;
    }
  }

  continueConversation(): void {
    this.update({ type: "start-streaming" });

    const messagesWithCache = withCacheControl(this.messages);
    this.currentRequest = this.client.messages.stream({
      ...this.params,
      messages: messagesWithCache,
    });

    this.currentRequest.on("streamEvent", (event) => {
      switch (event.type) {
        case "content_block_start":
          this.update({
            type: "block-started",
            index: event.index,
            block: event.content_block,
          });
          break;

        case "content_block_delta":
          this.update({
            type: "block-delta",
            index: event.index,
            delta: event.delta,
          });
          break;

        case "content_block_stop":
          this.update({ type: "block-finished", index: event.index });
          break;
      }
    });

    this.currentRequest
      .finalMessage()
      .then((response) => {
        this.update({ type: "stream-completed", response });
      })
      .catch((error: Error) => {
        const aborted = this.currentRequest?.controller.signal.aborted;
        if (aborted) {
          this.update({ type: "stream-aborted" });
        } else {
          this.update({ type: "stream-error", error });
        }
      });
  }

  truncateMessages(messageIdx: NativeMessageIdx): void {
    // Keep messages 0..messageIdx (inclusive), remove everything after
    this.messages.length = messageIdx + 1;

    // Clean up messageStopInfo for removed messages
    for (const idx of this.messageStopInfo.keys()) {
      if (idx > messageIdx) {
        this.messageStopInfo.delete(idx);
      }
    }

    this.status = { type: "stopped", stopReason: "end_turn" };
    this.updateCachedProviderMessages();
    this.dispatchAsync({ type: "agent-stopped", stopReason: "end_turn" });
  }

  clone(dispatch: Dispatch<AgentMsg>): AnthropicAgent {
    const cloned = new AnthropicAgent(
      this.options,
      this.client,
      dispatch,
      this.anthropicOptions,
    );

    // Deep copy messages — during streaming, this.messages already contains
    // a reference to currentAssistantMessage with all finalized blocks
    // (but not the in-progress currentAnthropicBlock)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    cloned.messages = JSON.parse(JSON.stringify(this.messages));

    // Clean up the cloned messages to handle incomplete state
    AnthropicAgent.cleanupClonedMessages(cloned.messages);

    // Deep copy messageStopInfo
    cloned.messageStopInfo = new Map(
      Array.from(this.messageStopInfo.entries()).map(([k, v]) => [
        k,
        { ...v, usage: { ...v.usage } },
      ]),
    );

    // Cloned agent is always in stopped/end_turn state
    cloned.status = { type: "stopped", stopReason: "end_turn" };

    // Copy latestUsage if present
    if (this.latestUsage) {
      cloned.latestUsage = { ...this.latestUsage };
    }

    // Rebuild cached provider messages from the cloned data
    cloned.cachedProviderMessages = convertAnthropicMessagesToProvider(
      cloned.messages,
      cloned.messageStopInfo,
    );

    return cloned;
  }

  compact(request: CompactRequest, truncateIdx?: NativeMessageIdx): void {
    // Run compaction async so Thread can set state before we dispatch events
    queueMicrotask(() => {
      this.executeCompact(request, truncateIdx);
    });
  }

  private executeCompact(
    request: CompactRequest,
    truncateIdx?: NativeMessageIdx,
  ): void {
    const { summary } = request;

    // If truncateIdx is provided (user-initiated @compact), first truncate to that point
    // This removes the @compact user message and the agent's compact response
    if (truncateIdx !== undefined) {
      this.messages.length = truncateIdx + 1;
      // Clean up messageStopInfo for removed messages
      for (const idx of this.messageStopInfo.keys()) {
        if (idx > truncateIdx) {
          this.messageStopInfo.delete(idx);
        }
      }
    } else {
      // Agent-initiated: just trim the compact tool_use from the last assistant message
      this.trimCompactToolUse();
    }

    // Build new messages array with just the summary as assistant message
    const newMessages: Anthropic.MessageParam[] = [];

    if (summary.trim()) {
      newMessages.push({
        role: "assistant",
        content: [{ type: "text", text: summary }],
      });
    }

    // Ensure conversation alternates properly
    this.messages = this.ensureValidMessageSequence(newMessages);

    // Clean up messageStopInfo
    this.messageStopInfo.clear();

    // Update cached messages
    this.updateCachedProviderMessages();

    // Set status to stopped/end_turn and dispatch
    this.status = { type: "stopped", stopReason: "end_turn" };
    this.dispatchAsync({ type: "agent-stopped", stopReason: "end_turn" });
  }

  /** Remove the compact tool_use block from the last assistant message */
  private trimCompactToolUse(): void {
    const lastMessage = this.messages[this.messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") {
      return;
    }

    if (typeof lastMessage.content === "string") {
      return;
    }

    // Filter out compact tool_use blocks
    const filteredContent = lastMessage.content.filter((block) => {
      if (block.type !== "tool_use") {
        return true;
      }
      return block.name !== "compact";
    });

    // Update the message content
    if (filteredContent.length === 0) {
      // Remove the entire message if no content remains
      this.messages.pop();
    } else {
      lastMessage.content = filteredContent;
    }
  }

  private ensureValidMessageSequence(
    messages: Anthropic.MessageParam[],
  ): Anthropic.MessageParam[] {
    if (messages.length === 0) return messages;

    const result: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      const lastMsg = result[result.length - 1];

      // If same role as last message, merge content
      if (lastMsg && lastMsg.role === msg.role) {
        if (typeof lastMsg.content === "string") {
          lastMsg.content = [{ type: "text", text: lastMsg.content }];
        }
        if (typeof msg.content === "string") {
          lastMsg.content.push({
            type: "text",
            text: msg.content,
          });
        } else {
          lastMsg.content.push(...msg.content);
        }
      } else {
        result.push({
          role: msg.role,
          content:
            typeof msg.content === "string"
              ? [{ type: "text", text: msg.content }]
              : [...msg.content],
        });
      }
    }

    return result;
  }

  /** Clean up a deep-copied messages array for use in a cloned agent.
   * Handles: dropping server_tool_use blocks, adding error tool_results
   * for tool_use blocks, filtering empty blocks, and removing empty messages.
   */
  private static cleanupClonedMessages(
    messages: Anthropic.MessageParam[],
  ): void {
    if (messages.length === 0) return;

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") return;

    const lastMessageContent = lastMessage.content;
    if (typeof lastMessageContent === "string") return;

    // Collect tool_use IDs that need error tool_results
    const toolUseIds: { id: string }[] = [];

    // Filter out server_tool_use blocks and empty/incomplete blocks
    lastMessage.content = lastMessageContent.filter((block) => {
      if ((block as { type: string }).type === "server_tool_use") return false;
      if (block.type === "text" && !block.text) return false;
      if (block.type === "thinking" && !block.thinking) return false;
      if (block.type === "tool_use") {
        toolUseIds.push({ id: block.id });
      }
      return true;
    });

    // If the assistant message is now empty, remove it
    if (lastMessage.content.length === 0) {
      messages.pop();
    } else if (toolUseIds.length > 0) {
      // Add error tool_results for each tool_use block
      messages.push({
        role: "user",
        content: toolUseIds.map((t) => ({
          type: "tool_result" as const,
          tool_use_id: t.id,
          content: "The thread was forked before the tool could execute.",
          is_error: true,
        })),
      });
    }
  }

  private cleanup(
    reason: { type: "aborted" } | { type: "error"; error: Error },
  ): void {
    this.currentAnthropicBlock = undefined;

    const lastMessage = this.messages[this.messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") {
      return;
    }

    const lastMessageContent = lastMessage.content;
    if (
      typeof lastMessageContent !== "string" &&
      lastMessageContent.length > 0
    ) {
      const lastBlock = lastMessageContent[lastMessageContent.length - 1];

      if ((lastBlock as { type: string }).type === "server_tool_use") {
        lastMessageContent.pop();
      } else if (lastBlock.type === "tool_use") {
        const errorMessage =
          reason.type === "aborted"
            ? "Request was aborted by the user before tool execution completed."
            : `Stream error occurred: ${reason.error.message}`;

        this.messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: lastBlock.id,
              content: errorMessage,
              is_error: true,
            },
          ],
        });
        this.updateCachedProviderMessages();
        return;
      }

      // Filter out empty/incomplete blocks that can result from aborting mid-stream.
      // Anthropic rejects empty text blocks with 400 "text content blocks must be non-empty".
      lastMessage.content = lastMessageContent.filter((block) => {
        if (block.type === "text" && !block.text) return false;
        if (block.type === "thinking" && !block.thinking) return false;
        return true;
      });
    }

    if (
      (typeof lastMessage.content === "string" && !lastMessage.content) ||
      (typeof lastMessage.content !== "string" &&
        lastMessage.content.length === 0)
    ) {
      this.messages.pop();
    }

    this.updateCachedProviderMessages();
  }

  private createNativeStreamParameters(
    anthropicOptions: AnthropicAgentOptions,
  ): Omit<Anthropic.Messages.MessageStreamParams, "messages"> {
    const { authType, includeWebSearch, disableParallelToolUseFlag } =
      anthropicOptions;
    const { model, tools, systemPrompt, thinking } = this.options;

    const anthropicTools: Anthropic.Tool[] = tools.map((t): Anthropic.Tool => {
      return {
        ...t,
        input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
      };
    });

    const systemBlocks: Anthropic.Messages.MessageStreamParams["system"] = [
      {
        type: "text" as const,
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ];

    if (authType === "max") {
      systemBlocks.unshift({
        type: "text" as const,
        text: CLAUDE_CODE_SPOOF_PROMPT,
      });
    }

    const builtInTools: Anthropic.Messages.Tool[] = [];
    if (includeWebSearch) {
      builtInTools.push({
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 5,
      } as unknown as Anthropic.Messages.Tool);
    }

    const toolChoice: Anthropic.Messages.ToolChoice = disableParallelToolUseFlag
      ? { type: "auto", disable_parallel_tool_use: true }
      : { type: "auto" };

    const params: Omit<Anthropic.Messages.MessageStreamParams, "messages"> = {
      model: model,
      max_tokens: getMaxTokensForModel(model),
      system: systemBlocks,
      tool_choice: toolChoice,
      tools: [...anthropicTools, ...builtInTools],
    };

    if (thinking?.enabled) {
      params.thinking = {
        type: "enabled",
        budget_tokens: thinking.budgetTokens || 1024,
      };
    }

    return params;
  }

  private initAnthropicStreamingBlock(
    contentBlock: Anthropic.Messages.ContentBlock,
  ): AnthropicStreamingBlock | undefined {
    switch (contentBlock.type) {
      case "text":
        return { type: "text", text: contentBlock.text };
      case "thinking":
        return {
          type: "thinking",
          thinking: contentBlock.thinking,
          signature: "",
        };
      case "tool_use":
        return {
          type: "tool_use",
          id: contentBlock.id as ToolRequestId,
          name: contentBlock.name as ToolName,
          inputJson: "",
        };
      default:
        // Handle server_tool_use and web_search_tool_result
        if ((contentBlock as { type: string }).type === "server_tool_use") {
          return {
            type: "server_tool_use",
            id: (contentBlock as { id: string }).id,
            name: "web_search",
            inputJson: "",
          };
        }
        if (
          (contentBlock as { type: string }).type === "web_search_tool_result"
        ) {
          const block = contentBlock as {
            type: "web_search_tool_result";
            tool_use_id: string;
            content: Anthropic.WebSearchToolResultBlockContent;
          };
          return {
            type: "web_search_tool_result",
            tool_use_id: block.tool_use_id,
            content: block.content,
          };
        }
        return undefined;
    }
  }

  private applyAnthropicDelta(
    block: AnthropicStreamingBlock,
    delta: Anthropic.Messages.ContentBlockDeltaEvent["delta"],
  ): AnthropicStreamingBlock {
    switch (delta.type) {
      case "text_delta":
        if (block.type === "text") {
          return { ...block, text: block.text + delta.text };
        }
        break;
      case "thinking_delta":
        if (block.type === "thinking") {
          return { ...block, thinking: block.thinking + delta.thinking };
        }
        break;
      case "signature_delta":
        if (block.type === "thinking") {
          return { ...block, signature: block.signature + delta.signature };
        }
        break;
      case "input_json_delta":
        if (block.type === "tool_use" || block.type === "server_tool_use") {
          return {
            ...block,
            inputJson: block.inputJson + delta.partial_json,
          };
        }
        break;
    }
    return block;
  }

  private anthropicStreamingBlockToParam(
    block: AnthropicStreamingBlock,
  ): Anthropic.Messages.ContentBlockParam {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text, citations: null };
      case "thinking":
        return {
          type: "thinking",
          thinking: block.thinking,
          signature: block.signature,
        };
      case "tool_use": {
        let input: Record<string, unknown> = {};
        try {
          if (block.inputJson) {
            input = JSON.parse(block.inputJson) as Record<string, unknown>;
          }
        } catch {
          // If JSON is incomplete/invalid, store what we have
        }
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input,
        };
      }
      case "server_tool_use": {
        let input: Record<string, unknown> = {};
        try {
          if (block.inputJson) {
            input = JSON.parse(block.inputJson) as Record<string, unknown>;
          }
        } catch {
          // If JSON is incomplete/invalid, store what we have
        }
        return {
          type: "server_tool_use",
          id: block.id,
          name: block.name,
          input,
        } as unknown as Anthropic.Messages.ContentBlockParam;
      }
      case "web_search_tool_result":
        return {
          type: "web_search_tool_result",
          tool_use_id: block.tool_use_id,
          content: block.content,
        } as unknown as Anthropic.Messages.ContentBlockParam;
    }
  }

  private responseBlockToParam(
    block: Anthropic.Messages.ContentBlock,
  ): Anthropic.Messages.ContentBlockParam {
    switch (block.type) {
      case "text":
        return {
          type: "text",
          text: block.text,
          citations: block.citations?.length ? block.citations : null,
        };
      case "thinking":
        return {
          type: "thinking",
          thinking: block.thinking,
          signature: block.signature,
        };
      case "redacted_thinking":
        return {
          type: "redacted_thinking",
          data: block.data,
        };
      case "tool_use":
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        };
      default:
        // For server_tool_use, web_search_tool_result, etc.
        return block as Anthropic.Messages.ContentBlockParam;
    }
  }

  private convertInputToNative(
    content: AgentInput[],
  ): Anthropic.MessageParam["content"] {
    return content.map((c): Anthropic.Messages.ContentBlockParam => {
      switch (c.type) {
        case "text":
          return { type: "text", text: c.text };
        case "image":
          return { type: "image", source: c.source };
        case "document":
          return {
            type: "document",
            source: c.source,
            title: c.title || null,
          };
        default:
          assertUnreachable(c);
      }
    });
  }

  private convertToolResultToNative(
    toolUseId: ToolRequestId,
    result: ProviderToolResult,
  ): Anthropic.Messages.ContentBlockParam[] {
    if (result.result.status === "ok") {
      const contents: Array<
        Anthropic.Messages.TextBlockParam | Anthropic.Messages.ImageBlockParam
      > = [];

      for (const content of result.result.value) {
        switch (content.type) {
          case "text":
            contents.push({ type: "text", text: content.text });
            break;
          case "image":
            contents.push({ type: "image", source: content.source });
            break;
          case "document":
            // Documents need special handling - return as separate blocks
            // For now, skip and handle documents separately below
            break;
          default:
            assertUnreachable(content);
        }
      }

      const blocks: Anthropic.Messages.ContentBlockParam[] = [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: contents,
          is_error: false,
        },
      ];

      // Add document blocks separately
      for (const content of result.result.value) {
        if (content.type === "document") {
          blocks.push({
            type: "document",
            source: content.source,
            title: content.title || null,
          });
        }
      }

      return blocks;
    } else {
      return [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: result.result.error,
          is_error: true,
        },
      ];
    }
  }

  private updateCachedProviderMessages(): void {
    this.cachedProviderMessages = convertAnthropicMessagesToProvider(
      this.messages,
      this.messageStopInfo,
    );
    this.dispatchAsync({ type: "agent-content-updated" });
  }
}

/** Convert Anthropic messages to ProviderMessages. Exported for use in tests. */
export function convertAnthropicMessagesToProvider(
  messages: Anthropic.MessageParam[],
  messageStopInfo?: Map<number, MessageStopInfo>,
): ProviderMessage[] {
  return messages.map((msg, msgIndex): ProviderMessage => {
    const stopInfo = messageStopInfo?.get(msgIndex);
    const content =
      typeof msg.content == "string"
        ? [{ type: "text" as const, text: msg.content }]
        : msg.content.map((block) => convertBlockToProvider(block));

    const result: ProviderMessage = {
      role: msg.role,
      content,
    };

    // Attach stop info to assistant messages
    if (stopInfo && msg.role === "assistant") {
      result.stopReason = stopInfo.stopReason;
      result.usage = stopInfo.usage;
    }

    return result;
  });
}

function convertBlockToProvider(
  block: Anthropic.Messages.ContentBlockParam,
): ProviderMessage["content"][number] {
  switch (block.type) {
    case "text": {
      // Detect system_reminder blocks (converted to text with <system-reminder> tags)
      if (block.text.includes("<system-reminder>")) {
        return {
          type: "system_reminder",
          text: block.text,
        };
      }
      // Detect context_update blocks (converted to text with <context_update> tags)
      if (block.text.includes("<context_update>")) {
        return {
          type: "context_update",
          text: block.text,
        };
      }
      return {
        type: "text",
        text: block.text,
        citations: block.citations
          ? block.citations
              .filter(
                (
                  c,
                ): c is Extract<
                  (typeof block.citations)[number],
                  { url: string }
                > => "url" in c,
              )
              .map((c) => ({
                type: "web_search_citation" as const,
                cited_text: c.cited_text,
                encrypted_index: c.encrypted_index,
                title: c.title || "",
                url: c.url,
              }))
          : undefined,
      };
    }

    case "image":
      return {
        type: "image",
        source: block.source as {
          type: "base64";
          media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
          data: string;
        },
      };

    case "document":
      return {
        type: "document",
        source: block.source as {
          type: "base64";
          media_type: "application/pdf";
          data: string;
        },
        title: block.title ?? null,
      };

    case "tool_use": {
      const inputResult = validateInput(
        block.name as ToolName,
        block.input as Record<string, unknown>,
      );
      return {
        type: "tool_use",
        id: block.id as ToolRequestId,
        name: block.name as ToolName,
        request:
          inputResult.status === "ok"
            ? {
                status: "ok" as const,
                value: {
                  id: block.id as ToolRequestId,
                  toolName: block.name as ToolName,
                  input: inputResult.value,
                },
              }
            : { ...inputResult, rawRequest: block.input },
      };
    }

    case "tool_result": {
      let contents: ProviderToolResult["result"];

      if (typeof block.content === "string") {
        contents = block.is_error
          ? { status: "error", error: block.content }
          : { status: "ok", value: [{ type: "text", text: block.content }] };
      } else if (block.is_error) {
        const textBlock = block.content?.find((c) => c.type === "text") as
          | { type: "text"; text: string }
          | undefined;
        contents = {
          status: "error",
          error: textBlock?.text || "Unknown error",
        };
      } else {
        const blockContent = block.content || [];
        contents = {
          status: "ok",
          value: blockContent
            .filter(
              (
                c,
              ): c is
                | Anthropic.Messages.TextBlockParam
                | Anthropic.Messages.ImageBlockParam =>
                c.type === "text" || c.type === "image",
            )
            .map((c) => {
              if (c.type === "text") {
                return { type: "text" as const, text: c.text };
              } else {
                return {
                  type: "image" as const,
                  source: c.source as {
                    type: "base64";
                    media_type:
                      | "image/jpeg"
                      | "image/png"
                      | "image/gif"
                      | "image/webp";
                    data: string;
                  },
                };
              }
            }),
        };
      }

      return {
        type: "tool_result",
        id: block.tool_use_id as ToolRequestId,
        result: contents,
      };
    }

    case "thinking":
      return {
        type: "thinking",
        thinking: block.thinking,
        signature: block.signature,
      };

    case "redacted_thinking":
      return {
        type: "redacted_thinking",
        data: block.data,
      };

    default:
      // Handle server_tool_use, web_search_tool_result etc.
      if ((block as { type: string }).type === "server_tool_use") {
        const serverBlock = block as {
          type: "server_tool_use";
          id: string;
          name: string;
          input: { query: string };
        };
        return {
          type: "server_tool_use",
          id: serverBlock.id,
          name: "web_search",
          input: serverBlock.input,
        };
      }
      if ((block as { type: string }).type === "web_search_tool_result") {
        const resultBlock = block as {
          type: "web_search_tool_result";
          tool_use_id: string;
          content: Anthropic.WebSearchToolResultBlockContent;
        };
        return {
          type: "web_search_tool_result",
          tool_use_id: resultBlock.tool_use_id,
          content: resultBlock.content,
        };
      }
      // Fallback for unknown types
      return {
        type: "text",
        text: `[Unknown block type: ${(block as { type: string }).type}]`,
      };
  }
}

/** We only ever need to place a cache header on the last block, since anthropic now can compute the longest reusable
 * prefix.
 * https://www.anthropic.com/news/token-saving-updates
 */
export function withCacheControl(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  // Find the last eligible block by searching backwards through messages
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex--
  ) {
    const message = messages[messageIndex];
    if (typeof message.content == "string") {
      continue;
    }

    for (
      let blockIndex = message.content.length - 1;
      blockIndex >= 0;
      blockIndex--
    ) {
      const block = message.content[blockIndex];

      // Check if this block is eligible for caching
      if (
        block &&
        typeof block != "string" &&
        block.type !== "thinking" &&
        block.type !== "redacted_thinking"
      ) {
        const result = [...messages];
        // Create new array with updated message containing the cache_control block
        const newContent = [...message.content];
        newContent[blockIndex] = {
          ...block,
          cache_control: { type: "ephemeral" },
        };

        result[messageIndex] = {
          ...message,
          content: newContent,
        };
        return result;
      }
    }
  }

  return messages;
}

export function getMaxTokensForModel(model: string): number {
  // Claude 4.5 models (Opus, Sonnet, Haiku) - use high limits
  if (model.match(/^claude-(opus-4-5|opus-4-6|sonnet-4-5|haiku-4-5)/)) {
    return 32000;
  }

  // Claude 4 models - use high limits
  if (model.match(/^claude-(opus-4|sonnet-4|4-opus|4-sonnet)/)) {
    return 32000;
  }

  // Claude 3.7 Sonnet - supports up to 128k with beta header
  if (model.match(/^claude-3-7-sonnet/)) {
    return 32000; // Conservative default, can be increased to 128k with beta header
  }

  // Claude 3.5 Sonnet - 8k limit
  if (model.match(/^claude-3-5-sonnet/)) {
    return 8192;
  }

  // Claude 3.5 Haiku - 8k limit (same as Sonnet)
  if (model.match(/^claude-3-5-haiku/)) {
    return 8192;
  }

  // Legacy Claude 3 models (Opus, Sonnet, Haiku) - 4k limit
  if (model.match(/^claude-3-(opus|sonnet|haiku)/)) {
    return 4096;
  }

  // Legacy Claude 2.x models - 4k limit
  if (model.match(/^claude-2\./)) {
    return 4096;
  }

  // Default for unknown models - conservative 4k limit
  return 4096;
}

export const CLAUDE_CODE_SPOOF_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude.";
