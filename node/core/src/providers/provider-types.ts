import type Anthropic from "@anthropic-ai/sdk";
import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import type { YieldValue } from "../thread-api.ts";
import type { SuspendReason } from "../thread-supervisor.ts";
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

import type {
  ProviderName,
  ReasoningEffort,
  ReasoningSummary,
} from "../provider-options.ts";

export type ProviderSetting = {
  provider: ProviderName;
  model: string;
  baseUrl?: string;
  apiKeyEnvVar?: string;
  promptCaching?: boolean;
};

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "pause_turn"
  | "content"
  | "refusal"
  | "model_context_window_exceeded"
  | "stop_sequence";

export type StreamStopReason = StopReason | "tool_use";

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheHits?: number;
  cacheMisses?: number;
};

export type ProviderMessage = {
  role: "user" | "assistant";
  content: Array<ProviderMessageContent>;
  /** Absent when the message was never finished — an aborted assistant turn
   * has no provider-reported stop reason. */
  stopReason?: StreamStopReason;
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

export type ProviderSystemInfoContent = {
  type: "system_info";
  text: string;
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderContextUpdateContent = {
  type: "context_update";
  text: string;
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderCommentUpdateContent = {
  type: "comment_update";
  text: string;
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderForkNotificationContent = {
  type: "fork_notification";
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
  title?: string | undefined;
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
  | ProviderSystemInfoContent
  | ProviderContextUpdateContent
  | ProviderCommentUpdateContent
  | ProviderForkNotificationContent;

export interface Provider {
  forceToolUse(options: {
    model: string;
    input: AgentInput[];
    spec: ProviderToolSpec;
    systemPrompt?: string;
    disableCaching?: boolean;
    thinking?: {
      enabled: boolean;
      budgetTokens?: number;
      displayThinking?: boolean;
      effort?: "low" | "medium" | "high" | "xhigh" | "max";
    };
  }): ProviderToolUseRequest;

  createInferenceManager(options: InferenceOptions): NativeInferenceManager;
}

export type ProviderToolUseBlockStart = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};
export type ProviderServerToolUseBlockStart = {
  type: "server_tool_use";
  id: string;
  name: "web_search";
  input: unknown;
};
export type ProviderContentBlockStart =
  | Anthropic.RawContentBlockStartEvent["content_block"]
  | ProviderToolUseBlockStart
  | ProviderServerToolUseBlockStart;
export type ProviderBlockStartEvent = {
  type: "content_block_start";
  index: number;
  content_block: ProviderContentBlockStart;
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
    stopReason: StreamStopReason;
    usage: Usage;
  }>;
}

export type ProviderToolUseResponse = {
  toolRequest: Result<ToolRequest, { rawRequest: unknown }>;
  stopReason: StreamStopReason;
  usage: Usage;
};

export interface ProviderToolUseRequest {
  abort(): void;
  aborted: boolean;
  promise: Promise<ProviderToolUseResponse>;
}

export type RetryStatus = {
  attempt: number;
  nextRetryAt: Date;
  error: Error;
};

export type NativeMessageIdx = number & { __nativeMessageIdx: true };

export const PLACEHOLDER_NATIVE_MESSAGE_IDX = -1 as NativeMessageIdx;

export type StreamingBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | {
      type: "tool_use";
      id: ToolManager.ToolRequestId;
      name: ToolName;
      inputJson: string;
    };

export type AgentInput =
  | ProviderTextContent
  | ProviderImageContent
  | ProviderDocumentContent;

export type RequestedTool = {
  id: ToolManager.ToolRequestId;
  request: Result<ToolRequest, { rawRequest: unknown }>;
};

export type TurnResult =
  | { type: "stopped"; stopReason: StopReason }
  | { type: "suspended"; reason: SuspendReason }
  /** The model called `yield_to_parent`. The tool is never executed: the
   * agent answers every tool_use of that request itself and stops. */
  | { type: "yielded"; value: YieldValue }
  | { type: "aborted" }
  | { type: "failed"; error: Error };

export type ToolResults = ReadonlyMap<
  ToolManager.ToolRequestId,
  ProviderToolResult["result"]
>;

export type AgentLog = {
  readonly messages: ReadonlyArray<ProviderMessage>;
  readonly latestUsage: Usage | undefined;
};

export type RequestResult =
  | { type: "tool_use"; requested: RequestedTool[] }
  | { type: "stopped"; stopReason: StopReason }
  | { type: "aborted" }
  | { type: "error"; error: Error };

export type RequestUpdate =
  | { type: "streaming-block"; streamingBlock: StreamingBlock }
  | { type: "block-finished" }
  | { type: "retry-scheduled"; retry: RetryStatus }
  | { type: "attempt-started" };

export type OnRequestUpdate = (update: RequestUpdate) => void;

export interface NativeInferenceManager {
  readonly log: AgentLog;
  appendUserMessage(content: AgentInput[]): void;
  appendToolResults(
    requested: ReadonlyArray<RequestedTool>,
    results: ToolResults,
  ): void;
  getNativeMessageIdx(): NativeMessageIdx;
  truncateMessages(messageIdx: NativeMessageIdx): void;
  clone(): NativeInferenceManager;
  countTokens?(): Promise<number>;
  sendRequest(onUpdate: OnRequestUpdate): Promise<RequestResult>;
  abort(): void;

  /** Leave the history in a shape the provider will accept: no dangling
   * tool_use or half-streamed blocks. */
  finalize(reason: FinalizeReason): void;
}

export type FinalizeReason =
  | { type: "aborted" }
  | { type: "error"; error: Error };

export type ThinkingEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type ThinkingConfig =
  | { enabled: false }
  | {
      enabled: true;
      budgetTokens?: number;
      displayThinking?: boolean;
      effort?: ThinkingEffort;
    };

export type ReasoningConfig = {
  effort?: ReasoningEffort;
  summary?: ReasoningSummary;
};

export type ProviderInferenceConfig =
  | { type: "thinking"; thinking: ThinkingConfig }
  | { type: "reasoning"; reasoning: ReasoningConfig };

export interface InferenceOptions {
  model: string;
  systemPrompt: string;
  tools: ProviderToolSpec[];
  config?: ProviderInferenceConfig;
}

export function thinkingConfig(
  options: InferenceOptions,
): ThinkingConfig | undefined {
  return options.config?.type === "thinking"
    ? options.config.thinking
    : undefined;
}

export function reasoningConfig(
  options: InferenceOptions,
): ReasoningConfig | undefined {
  return options.config?.type === "reasoning"
    ? options.config.reasoning
    : undefined;
}
