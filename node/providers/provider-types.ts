import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import * as ToolManager from "../tools/toolManager.ts";
import type { Result } from "../utils/result";
import Anthropic from "@anthropic-ai/sdk";
import type { ToolName, ToolRequest } from "../tools/types.ts";

export const PROVIDER_NAMES = [
  "anthropic",
  "openai",
  "bedrock",
  "ollama",
  "copilot",
  "mock",
] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

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
};

export type ProviderThinkingContent = {
  type: "thinking";
  thinking: string;
  signature: string;
};

export type ProviderRedactedThinkingContent = {
  type: "redacted_thinking";
  data: string;
};

export type ProviderSystemReminderContent = {
  type: "system_reminder";
  text: string;
};

export type ProviderContextUpdateContent = {
  type: "context_update";
  text: string;
};

export type ProviderImageContent = {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    data: string;
  };
};

export type ProviderDocumentContent = {
  type: "document";
  source: {
    type: "base64";
    media_type: "application/pdf";
    data: string;
  };
  title?: string | null;
};

export type ProviderToolUseContent = {
  type: "tool_use";
  id: ToolManager.ToolRequestId;
  name: ToolName;
  request: Result<ToolRequest, { rawRequest: unknown }>;
};

export type ProviderServerToolUseContent = {
  type: "server_tool_use";
  id: string;
  name: "web_search";
  input: {
    query: string;
  };
};

export type ProviderWebSearchToolResult = {
  type: "web_search_tool_result";
  tool_use_id: string;
  content: Anthropic.WebSearchToolResultBlockContent;
};

export type ProviderToolResultContent =
  | ProviderTextContent
  | ProviderImageContent
  | ProviderDocumentContent;

export type ProviderToolResult = {
  type: "tool_result";
  id: ToolManager.ToolRequestId;
  result: Result<ProviderToolResultContent[]>;
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
    input: ProviderThreadInput[];
    spec: ProviderToolSpec;
    systemPrompt?: string;
    disableCaching?: boolean;
    contextThread?: ProviderThread;
  }): ProviderToolUseRequest;

  createThread(options: ProviderThreadOptions): ProviderThread;
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
// ProviderThread - Stateful conversation thread interface
// ============================================================================

export type ProviderThreadStatus =
  | { type: "idle" }
  | { type: "streaming"; startTime: Date }
  | { type: "stopped"; stopReason: StopReason }
  | { type: "error"; error: Error };

/** Branded type for native message index within a ProviderThread.
 * This is opaque to external code - only the ProviderThread knows how to use it.
 */
export type NativeMessageIdx = number & { __nativeMessageIdx: true };

export type ProviderStreamingBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | {
      type: "tool_use";
      id: ToolManager.ToolRequestId;
      name: ToolName;
      inputJson: string;
    };

export interface ProviderThreadState {
  status: ProviderThreadStatus;
  messages: ReadonlyArray<ProviderMessage>;
  streamingBlock?: ProviderStreamingBlock | undefined;
  latestUsage?: Usage | undefined;
}

export type ProviderThreadInput =
  | ProviderTextContent
  | ProviderImageContent
  | ProviderDocumentContent;

export type ProviderThreadEvents = {
  "messages-updated": [];
  "streaming-block-updated": [];
  "status-changed": [];
};

export interface ProviderThread {
  getState(): ProviderThreadState;

  getProviderStreamingBlock(): ProviderStreamingBlock | undefined;

  /** Get the current native message index. Use this to capture a position
   * that can later be passed to truncateMessages.
   */
  getNativeMessageIdx(): NativeMessageIdx;

  appendUserMessage(content: ProviderThreadInput[]): void;

  toolResult(
    toolUseId: ToolManager.ToolRequestId,
    result: ProviderToolResult,
  ): void;

  /** Start streaming a response. Throws if the last message is from the assistant. */
  continueConversation(): void;

  abort(): void;

  /** Truncate messages to keep only messages 0..messageIdx (inclusive).
   * Sets status to stopped with end_turn.
   */
  truncateMessages(messageIdx: NativeMessageIdx): void;

  on<E extends keyof ProviderThreadEvents>(
    event: E,
    listener: (...args: ProviderThreadEvents[E]) => void,
  ): void;

  off<E extends keyof ProviderThreadEvents>(
    event: E,
    listener: (...args: ProviderThreadEvents[E]) => void,
  ): void;
}

export interface ProviderThreadOptions {
  model: string;
  systemPrompt: string;
  tools: ProviderToolSpec[];
  thinking?: { enabled: boolean; budgetTokens?: number };
  reasoning?: { effort?: "low" | "medium" | "high"; summary?: string };
}
