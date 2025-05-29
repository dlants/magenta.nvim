import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import * as ToolManager from "../tools/toolManager.ts";
import type { ToolName } from "../tools/tool-registry.ts";
import type { Result } from "../utils/result";
import Anthropic from "@anthropic-ai/sdk";

export const PROVIDER_NAMES = ["anthropic", "openai", "bedrock"] as const;
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

export type ProviderToolUseContent = {
  type: "tool_use";
  id: ToolManager.ToolRequestId;
  name: ToolName;
  request: Result<ToolManager.ToolRequest, { rawRequest: unknown }>;
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

export type ProviderToolResultContent = {
  type: "tool_result";
  id: ToolManager.ToolRequestId;
  result: Result<string>;
};

export type ProviderToolSpec = {
  name: ToolName;
  description: string;
  input_schema: JSONSchemaType;
};

export type ProviderMessageContent =
  | ProviderTextContent
  | ProviderToolUseContent
  | ProviderServerToolUseContent
  | ProviderWebSearchToolResult
  | ProviderToolResultContent;

export interface Provider {
  setModel(model: string): void;
  createStreamParameters(
    messages: Array<ProviderMessage>,
    tools: Array<ProviderToolSpec>,
    options?: { disableCaching?: boolean },
  ): unknown;
  countTokens(
    messages: Array<ProviderMessage>,
    tools: Array<ProviderToolSpec>,
  ): number;
  forceToolUse(
    messages: Array<ProviderMessage>,
    spec: ProviderToolSpec,
  ): ProviderToolUseRequest;

  sendMessage(
    messages: Array<ProviderMessage>,
    onStreamEvent: (event: ProviderStreamEvent) => void,
    tools: Array<ProviderToolSpec>,
  ): ProviderStreamRequest;
}

/** Using Anthropic types for now since they're the most mature / well documented
 */
export type ProviderStreamEvent = Extract<
  Anthropic.RawMessageStreamEvent,
  { type: "content_block_start" | "content_block_delta" | "content_block_stop" }
>;

export type ProviderBlockStartEvent = Extract<
  ProviderStreamEvent,
  { type: "content_block_start" }
>;

export interface ProviderStreamRequest {
  abort(): void;
  promise: Promise<{
    stopReason: StopReason;
    usage: Usage;
  }>;
}

export type ProviderToolUseResponse = {
  toolRequest: Result<ToolManager.ToolRequest, { rawRequest: unknown }>;
  stopReason: StopReason;
  usage: Usage;
};

export interface ProviderToolUseRequest {
  abort(): void;
  promise: Promise<ProviderToolUseResponse>;
}
