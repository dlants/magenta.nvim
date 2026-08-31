import type Anthropic from "@anthropic-ai/sdk";
import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
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
  providerMetadata?: ProviderMetadata | undefined;
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderThinkingContent = {
  type: "thinking";
  thinking: string;
  /** Anthropic's thinking signature, or OpenAI's `encrypted_content`. Absent
   * when the provider did not supply one. */
  signature?: string | undefined;
  providerMetadata?: ProviderMetadata | undefined;
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderRedactedThinkingContent = {
  type: "redacted_thinking";
  data: string;
  providerMetadata?: ProviderMetadata | undefined;
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

/** Like `context_update`, this is only ever *constructed* by
 * `classifyTextContent`: the block leaves as plain text (the wire format has
 * nothing else), and is re-tagged on the way back into `ProviderMessage[]` so
 * the view can suppress it rather than render it verbatim. */
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
  providerMetadata?: ProviderMetadata | undefined;
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
    contextAgent?: NativeInferenceManager;
    thinking?: {
      enabled: boolean;
      budgetTokens?: number;
      displayThinking?: boolean;
      effort?: "low" | "medium" | "high" | "xhigh" | "max";
    };
  }): ProviderToolUseRequest;

  createAgent(options: AgentOptions): NativeInferenceManager;
}

export type ProviderMetadata = { provider: "openai"; itemId: string };

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
  | { type: "thinking"; thinking: string; signature: string }
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
  | { type: "suspended"; reason?: SuspendReason | undefined }
  | { type: "aborted" }
  | { type: "failed"; error: Error };
export type ToolResults = ReadonlyMap<
  ToolManager.ToolRequestId,
  ProviderToolResult["result"]
>;

/** ToolResults are always inserted into the runner, so we always end in a valid state.
 * This means we can later send another request, or append more messages.
 */
export type ToolOutcome =
  | { type: "continue"; results: ToolResults }
  | { type: "suspend"; results: ToolResults }
  | { type: "aborted"; results: ToolResults };

export type ToolExecutor = (
  requests: ReadonlyArray<RequestedTool>,
) => Promise<ToolOutcome>;

export type AgentLog = {
  readonly messages: ReadonlyArray<ProviderMessage>;
  readonly latestUsage: Usage | undefined;
};

/** What one provider request produced. Retries are internal to the request, so
 * `error` means permanently failed. */
export type RequestResult =
  | {
      type: "completed";
      stopReason: StreamStopReason;
      /** tool_use blocks accumulated during this request. */
      requested: RequestedTool[];
    }
  | { type: "aborted" }
  | { type: "error"; error: Error };

/** What the manager reports while a request is in flight. Deliberately narrow:
 * the finished content is read off `log.messages`. */
export type RequestUpdate =
  | { type: "streaming-block"; streamingBlock: StreamingBlock }
  | { type: "block-finished" }
  /** A retryable failure; the manager is backing off and will try again. */
  | { type: "retry-scheduled"; retry: RetryStatus }
  /** A fresh attempt is going out, which clears any retry countdown. */
  | { type: "attempt-started" };

export type OnRequestUpdate = (update: RequestUpdate) => void;

/** The provider-specific half of a conversation: the native message array, its
 * conversion to `ProviderMessage`, and one request at a time. The turn loop
 * lives in `Agent`, not here. */
export interface NativeInferenceManager {
  readonly log: AgentLog;
  appendUserMessage(content: AgentInput[], opts?: { coalesce?: true }): void;
  /** Every requested tool gets exactly one result block, including ids the
   * executor omitted. */
  appendToolResults(
    requested: ReadonlyArray<RequestedTool>,
    results: ToolResults,
  ): void;
  getNativeMessageIdx(): NativeMessageIdx;
  truncateMessages(messageIdx: NativeMessageIdx): void;
  clone(): NativeInferenceManager;
  /** Count the conversation as it would be sent right now. Only providers
   * that support it implement it; `Agent` issues it lazily, at most once per
   * request, and only when a before-request hook asks for it. */
  countTokens?(): Promise<number>;
  sendRequest(onUpdate: OnRequestUpdate): Promise<RequestResult>;
  /** Cancels an in-flight request or a pending retry wait; a no-op otherwise. */
  abort(): void;
  /** Leave the history in a shape the provider will accept: no dangling
   * tool_use or half-streamed blocks. */
  finalize(reason: FinalizeReason): void;
}

/** Why a request stopped short of a completed response. */
export type FinalizeReason =
  | { type: "aborted" }
  | { type: "error"; error: Error };
export type OnBeforeRequest = () => Promise<BeforeRequestDecision>;
export type BeforeRequestDecision =
  | { type: "proceed" }
  | { type: "suspend"; reason: SuspendReason };
export interface AgentOptions {
  model: string;
  systemPrompt: string;
  tools: ProviderToolSpec[];
  /** Survives until the token count is preflight (stage 3). */
  onUpdate: () => void;
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
    displayThinking?: boolean;
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
  };
  reasoning?: {
    effort?: ReasoningEffort;
    summary?: ReasoningSummary;
  };
}
