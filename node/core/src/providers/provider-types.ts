import type Anthropic from "@anthropic-ai/sdk";
import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import type * as ToolManager from "../tool-types.ts";
import type { ToolName, ToolRequest } from "../tool-types.ts";
import type { Result } from "../utils/result.ts";

export const PROVIDER_NAMES = [
  "anthropic",
  "openai",
  "bedrock",
  "ollama",
  "copilot",
  "mock",
] as const;
export type { ProviderName } from "../provider-options.ts";

import type { ProviderName } from "../provider-options.ts";

export type ProviderSetting = {
  provider: ProviderName;
  model: string;
  baseUrl?: string;
  apiKeyEnvVar?: string;
  promptCaching?: boolean;
};

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "pause_turn"
  | "content"
  | "refusal"
  | "aborted"
  | "model_context_window_exceeded"
  | "stop_sequence";

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheHits?: number;
  cacheMisses?: number;
};

export type ProviderMessage = {
  role: "user" | "assistant";
  content: Array<ProviderMessageContent>;
  stopReason?: StopReason;
  usage?: Usage;
};

export type ProviderWebSearchCitation = {
  cited_text: string;
  encrypted_index: string;
  title: string;
  type: "web_search_citation";
  url: string;
};

export type ProviderTextContent = {
  type: "text";
  text: string;
  citations?: ProviderWebSearchCitation[] | undefined;
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderThinkingContent = {
  type: "thinking";
  thinking: string;
  signature: string;
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderRedactedThinkingContent = {
  type: "redacted_thinking";
  data: string;
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderSystemReminderContent = {
  type: "system_reminder";
  text: string;
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderContextUpdateContent = {
  type: "context_update";
  text: string;
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderImageContent = {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    data: string;
  };
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderDocumentContent = {
  type: "document";
  source: {
    type: "base64";
    media_type: "application/pdf";
    data: string;
  };
  title?: string | null;
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderToolUseContent = {
  type: "tool_use";
  id: ToolManager.ToolRequestId;
  name: ToolName;
  request: Result<ToolRequest, { rawRequest: unknown }>;
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderServerToolUseContent = {
  type: "server_tool_use";
  id: string;
  name: "web_search";
  input: {
    query: string;
  };
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderWebSearchToolResult = {
  type: "web_search_tool_result";
  tool_use_id: string;
  content: Anthropic.WebSearchToolResultBlockContent;
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderToolResultContent =
  | ProviderTextContent
  | ProviderImageContent
  | ProviderDocumentContent;

export type ProviderToolResult = {
  type: "tool_result";
  id: ToolManager.ToolRequestId;
  result:
    | {
        status: "ok";
        value: ProviderToolResultContent[];
        structuredResult: ToolManager.ToolStructuredResult;
      }
    | { status: "error"; error: string };
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderToolSpec = {
  name: ToolName;
  description: string;
  input_schema: JSONSchemaType;
};

export type ProviderMessageContent =
  | ProviderTextContent
  | ProviderImageContent
  | ProviderDocumentContent
  | ProviderToolUseContent
  | ProviderServerToolUseContent
  | ProviderWebSearchToolResult
  | ProviderToolResult
  | ProviderThinkingContent
  | ProviderRedactedThinkingContent
  | ProviderSystemReminderContent
  | ProviderContextUpdateContent;

export interface Provider {
  forceToolUse(options: {
    model: string;
    input: AgentInput[];
    spec: ProviderToolSpec;
    systemPrompt?: string;
    disableCaching?: boolean;
    contextAgent?: Agent;
    thinking?: {
      enabled: boolean;
      budgetTokens?: number;
      displayThinking?: boolean;
      effort?: "low" | "medium" | "high" | "xhigh" | "max";
    };
  }): ProviderToolUseRequest;

  createAgent(options: AgentOptions): Agent;
}

export type ProviderMetadata = {
  openai?: {
    itemId?: string | undefined;
  };
};

export type ProviderBlockStartEvent = Anthropic.RawContentBlockStartEvent & {
  providerMetadata?: ProviderMetadata;
};

export type ProviderBlockDeltaEvent = Anthropic.RawContentBlockDeltaEvent;

export type ProviderBlockStopEvent = Anthropic.RawContentBlockStopEvent;

export type ProviderStreamEvent =
  | ProviderBlockStartEvent
  | ProviderBlockDeltaEvent
  | ProviderBlockStopEvent;

export interface ProviderStreamRequest {
  abort(): void;
  aborted: boolean;
  promise: Promise<{
    stopReason: StopReason;
    usage: Usage;
  }>;
}

export type ProviderToolUseResponse = {
  toolRequest: Result<ToolRequest, { rawRequest: unknown }>;
  stopReason: StopReason;
  usage: Usage;
};

export interface ProviderToolUseRequest {
  abort(): void;
  aborted: boolean;
  promise: Promise<ProviderToolUseResponse>;
}

// ============================================================================
// Agent - Stateful conversation agent interface
// ============================================================================

export type RetryStatus = {
  attempt: number;
  nextRetryAt: Date;
  error: Error;
};

export type AgentStatus =
  | { type: "streaming"; startTime: Date; retryStatus?: RetryStatus }
  | { type: "stopped"; stopReason: StopReason }
  | { type: "error"; error: Error };

/** Branded type for native message index within an Agent.
 * This is opaque to external code - only the Agent knows how to use it.
 */
export type NativeMessageIdx = number & { __nativeMessageIdx: true };

/** Placeholder used when constructing content blocks before they are attached
 * to a native message array (e.g. tool results, AgentInput). The actual
 * `nativeMessageIdx` is stamped by `convertAnthropicMessagesToProvider` on the
 * agent's `cachedProviderMessages`, so the input value is discarded. */
export const PLACEHOLDER_NATIVE_MESSAGE_IDX = -1 as NativeMessageIdx;

export type AgentStreamingBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | {
      type: "tool_use";
      id: ToolManager.ToolRequestId;
      name: ToolName;
      inputJson: string;
    };

export interface AgentState {
  status: AgentStatus;
  messages: ReadonlyArray<ProviderMessage>;
  streamingBlock?: AgentStreamingBlock | undefined;
  latestUsage?: Usage | undefined;
  inputTokenCount?: number | undefined;
}

export type AgentInput =
  | ProviderTextContent
  | ProviderImageContent
  | ProviderDocumentContent;

/** Messages dispatched from Agent to Thread */
export type AgentMsg =
  | { type: "agent-content-updated" }
  | { type: "agent-stopped"; stopReason: StopReason; usage?: Usage }
  | { type: "agent-error"; error: Error };

export type AgentEvents = {
  didUpdate: [];
  stopped: [stopReason: StopReason, usage: Usage | undefined];
  error: [error: Error];
};

export interface Agent {
  on<K extends keyof AgentEvents>(
    event: K,
    listener: (...args: AgentEvents[K]) => void,
  ): void;
  off<K extends keyof AgentEvents>(
    event: K,
    listener: (...args: AgentEvents[K]) => void,
  ): void;

  getState(): AgentState;

  getStreamingBlock(): AgentStreamingBlock | undefined;

  /** Get the current native message index. Use this to capture a position
   * that can later be passed to truncateMessages.
   */
  getNativeMessageIdx(): NativeMessageIdx;

  appendUserMessage(content: AgentInput[]): void;

  toolResult(
    toolUseId: ToolManager.ToolRequestId,
    result: ProviderToolResult,
  ): void;

  continueConversation(): void;

  /** Abort the current operation.
   * Returns a promise that resolves when the abort is complete.
   * - If streaming: resolves when the stream is terminated
   * - If not streaming: resolves immediately
   */
  abort(): Promise<void>;

  /** Transition from stopped/tool_use to stopped/aborted.
   * Call this after providing all tool results during an abort.
   * @throws Error if not in stopped/tool_use state
   */
  abortToolUse(): void;

  /** Truncate messages to keep only messages 0..messageIdx (inclusive).
   * Sets status to stopped with end_turn.
   */
  truncateMessages(messageIdx: NativeMessageIdx): void;

  /** Create a deep copy of this agent.
   * Can be called in any state (stopped, streaming, tool_use).
   * The cloned agent will always be in stopped/end_turn state.
   * Incomplete blocks and pending tool_use are cleaned up in the clone.
   */
  clone(): Agent;
}

export interface AgentOptions {
  model: string;
  systemPrompt: string;
  tools: ProviderToolSpec[];
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
    displayThinking?: boolean;
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
  };
  reasoning?: {
    effort?: "low" | "medium" | "high" | "xhigh";
    summary?: string;
  };
  skipPostFlightTokenCount?: boolean;
}
