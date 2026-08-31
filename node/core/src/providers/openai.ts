import OpenAI, { APIError } from "openai";
import type {
  JSONSchemaObject,
  JSONSchemaType,
} from "openai/lib/jsonschema.mjs";
import type { AuthUI } from "../auth-ui.ts";
import type { Logger } from "../logger.ts";
import type { OpenAIAuth } from "../openai-auth.ts";
import type {
  ReasoningEffort,
  ReasoningSummary,
  ThinkingEffort,
} from "../provider-options.ts";
import type {
  ToolName,
  ToolRequest,
  ToolRequestId,
  ValidateInput,
} from "../tool-types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Result } from "../utils/result.ts";
import {
  describeError,
  flattenError,
  isAuthError,
  makeRefreshAuth,
  type RefreshAuth,
} from "./auth-refresh.ts";
import { AwsCredentials, resolveAwsRegion } from "./aws-credentials.ts";
import {
  bedrockMantleBaseUrl,
  createSigV4Fetch,
  DEFAULT_BEDROCK_MANTLE_REGION,
} from "./bedrock-sigv4.ts";
import { CodexAuthError, type CodexCredentials } from "./codex-auth.ts";
import { getRetryDelay, MAX_RETRY_DURATION } from "./inference-shared.ts";
import { OpenAIInferenceManager } from "./openai-inference.ts";
import {
  type AgentInput,
  type InferenceOptions,
  type NativeInferenceManager,
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  type Provider,
  type ProviderMessage,
  type ProviderMessageContent,
  type ProviderMetadata,
  type ProviderServerToolUseBlockStart,
  type ProviderStreamEvent,
  type ProviderToolSpec,
  type ProviderToolUseBlockStart,
  type ProviderToolUseRequest,
  type ProviderToolUseResponse,
  type ProviderWebSearchCitation,
  reasoningConfig,
  type StopReason,
  type Usage,
} from "./provider-types.ts";

export const DEFAULT_OPENAI_SYSTEM_PROMPT =
  "You are a helpful coding assistant.";

/** The Responses API has no `max_tokens`, and the codex backend rejects
 * `max_output_tokens` outright, so nothing analogous is ever sent. */

// ---------------------------------------------------------------------------
// Model capability helpers (ported from the pre-rewrite provider)
// ---------------------------------------------------------------------------

export function isGpt5(model: string): boolean {
  return /^gpt-5/i.test(model);
}

export function isReasoningModel(model: string): boolean {
  return /^(o1|o3|o4|o-)/i.test(model) || isGpt5(model);
}

export function supportsWebSearch(model: string): boolean {
  if (/^gpt-4o/i.test(model)) return true;
  if (/^gpt-4\.1/i.test(model)) return true;
  return isReasoningModel(model);
}

const UNSUPPORTED_SCHEMA_FORMATS = new Set([
  "uri",
  "uri-reference",
  "uri-template",
  "date-time",
  "date",
  "time",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uuid",
  "regex",
  "json-pointer",
]);

/** OpenAI rejects several JSON Schema `format` specifiers that Anthropic
 * accepts. Drop them, leaving a description hint so the meaning survives. */
export function sanitizeSchemaForOpenAI(
  schema: JSONSchemaType,
): JSONSchemaType {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return schema;
  }

  const sanitized = { ...schema } as JSONSchemaObject & {
    format?: unknown;
    description?: unknown;
  };

  if (
    typeof sanitized.format === "string" &&
    UNSUPPORTED_SCHEMA_FORMATS.has(sanitized.format)
  ) {
    const format = sanitized.format;
    delete sanitized.format;
    if (!sanitized.description) {
      switch (format) {
        case "uri":
        case "uri-reference":
          sanitized.description = "A valid URI string";
          break;
        case "date-time":
          sanitized.description =
            'A date-time string (e.g., "2023-12-01T10:30:00Z")';
          break;
        case "date":
          sanitized.description = 'A date string (e.g., "2023-12-01")';
          break;
        case "email":
          sanitized.description = "A valid email address";
          break;
        default:
          sanitized.description = `A string in ${JSON.stringify(format)} format`;
      }
    }
  }

  for (const [key, value] of Object.entries(sanitized)) {
    if (key !== "format" && typeof value === "object" && value !== null) {
      (sanitized as Record<string, unknown>)[key] = sanitizeSchemaForOpenAI(
        value as JSONSchemaType,
      );
    }
  }

  return sanitized as JSONSchemaType;
}

/** OpenAI's `strict: true` function schemas require every property to be
 * listed in `required` and `additionalProperties: false`. */
export function makeOpenAICompatible(spec: ProviderToolSpec): ProviderToolSpec {
  const sanitizedSchema = sanitizeSchemaForOpenAI(spec.input_schema);

  if (
    typeof sanitizedSchema !== "object" ||
    sanitizedSchema === null ||
    Array.isArray(sanitizedSchema) ||
    (sanitizedSchema as { type?: unknown }).type !== "object"
  ) {
    return { ...spec, input_schema: sanitizedSchema };
  }

  const compatibleSchema = JSON.parse(
    JSON.stringify(sanitizedSchema),
  ) as JSONSchemaObject;

  compatibleSchema.additionalProperties = false;
  compatibleSchema.required =
    compatibleSchema.properties &&
    typeof compatibleSchema.properties === "object"
      ? Object.keys(compatibleSchema.properties)
      : [];

  return { ...spec, input_schema: compatibleSchema };
}

function toOpenAITool(spec: ProviderToolSpec): OpenAI.Responses.Tool {
  const compatible = makeOpenAICompatible(spec);
  // Key order is fixed here rather than spread, so serialization is stable
  // turn to turn — the cached prefix covers `instructions` + `tools`.
  return {
    type: "function",
    name: compatible.name,
    description: compatible.description,
    parameters: compatible.input_schema as OpenAI.FunctionParameters,
    strict: false,
  };
}

// ---------------------------------------------------------------------------
// ProviderMessage[] -> Responses request
// ---------------------------------------------------------------------------

type ReasoningItem = OpenAI.Responses.ResponseReasoningItem;

function itemIdOf(content: {
  providerMetadata?: ProviderMetadata | undefined;
}): string | undefined {
  return content.providerMetadata?.provider === "openai"
    ? content.providerMetadata.itemId
    : undefined;
}

export function convertProviderMessagesToInput(
  messages: ProviderMessage[],
): OpenAI.Responses.ResponseInputItem[] {
  const input: OpenAI.Responses.ResponseInputItem[] = [];

  let pendingUser: OpenAI.Responses.ResponseInputItem.Message | undefined;

  const flushUser = () => {
    if (pendingUser && pendingUser.content.length > 0) {
      input.push(pendingUser);
    }
    pendingUser = undefined;
  };

  const pushUserContent = (content: OpenAI.Responses.ResponseInputContent) => {
    if (!pendingUser) {
      pendingUser = { type: "message", role: "user", content: [] };
    }
    pendingUser.content.push(content);
  };

  const pushItem = (item: OpenAI.Responses.ResponseInputItem) => {
    flushUser();
    input.push(item);
  };

  for (const message of messages) {
    // Reasoning summary parts of the same item must coalesce back into the
    // single item the server sent, keyed by item id.
    const reasoningItems: Record<string, ReasoningItem> = {};

    for (const content of message.content) {
      switch (content.type) {
        case "text": {
          if (!content.text.trim()) break;
          if (message.role === "user") {
            pushUserContent({ type: "input_text", text: content.text });
            break;
          }

          const annotations: OpenAI.Responses.ResponseOutputText.URLCitation[] =
            (content.citations || []).map((c) => ({
              type: "url_citation",
              start_index: 0,
              end_index: 0,
              title: c.title,
              url: c.url,
            }));

          const itemId = itemIdOf(content);
          if (itemId) {
            pushItem({
              type: "message",
              id: itemId,
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: content.text, annotations },
              ],
            } as OpenAI.Responses.ResponseOutputMessage);
          } else {
            // History from another provider (or a compacted thread) has no
            // item id; an easy message is still accepted.
            pushItem({ role: "assistant", content: content.text });
          }
          break;
        }

        case "system_reminder":
        case "system_info":
        case "comment_update":
        case "context_update":
        case "fork_notification":
          if (message.role === "user") {
            pushUserContent({ type: "input_text", text: content.text });
          } else {
            pushItem({ role: "assistant", content: content.text });
          }
          break;

        case "image":
          pushUserContent({
            type: "input_image",
            detail: "auto",
            image_url: `data:${content.source.media_type};base64,${content.source.data}`,
          });
          break;

        case "document":
          pushUserContent({
            type: "input_file",
            filename: content.title || "untitled.pdf",
            file_data: `data:${content.source.media_type};base64,${content.source.data}`,
          });
          break;

        case "tool_use":
          pushItem({
            type: "function_call",
            call_id: content.id,
            name: content.name,
            arguments: JSON.stringify(
              content.request.status === "ok"
                ? content.request.value.input
                : content.request.rawRequest,
            ),
          });
          break;

        case "server_tool_use": {
          const itemId = itemIdOf(content) ?? content.id;
          // Dropping this item makes the model re-run the search, which costs
          // far more than echoing it back.
          pushItem({
            type: "web_search_call",
            id: itemId,
            status: "completed",
            action: { type: "search", query: content.input.query },
          } as OpenAI.Responses.ResponseInputItem);
          break;
        }

        case "web_search_tool_result":
          // Only produced by Anthropic histories: OpenAI carries results as
          // annotations on the following message, so fold them into text.
          if (Array.isArray(content.content)) {
            const results = content.content
              .map(
                (result) =>
                  `Title: ${result.title}\nURL: ${result.url}\nContent: ${result.encrypted_content}`,
              )
              .join("\n\n");
            pushUserContent({
              type: "input_text",
              text: `Web search results:\n\n${results}`,
            });
          }
          break;

        case "tool_result":
          if (content.result.status === "ok") {
            const textParts: string[] = [];
            const trailing: OpenAI.Responses.ResponseInputContent[] = [];
            for (const resultContent of content.result.value) {
              switch (resultContent.type) {
                case "text":
                  textParts.push(resultContent.text);
                  break;
                case "image":
                  trailing.push({
                    type: "input_image",
                    detail: "auto",
                    image_url: `data:${resultContent.source.media_type};base64,${resultContent.source.data}`,
                  });
                  break;
                case "document":
                  trailing.push({
                    type: "input_file",
                    filename: resultContent.title || "untitled.pdf",
                    file_data: `data:${resultContent.source.media_type};base64,${resultContent.source.data}`,
                  });
                  break;
                default:
                  assertUnreachable(resultContent);
              }
            }
            pushItem({
              type: "function_call_output",
              call_id: content.id,
              output:
                textParts.join("\n") ||
                (trailing.length ? "Attachment follows:" : ""),
            });
            for (const attachment of trailing) {
              pushUserContent(attachment);
            }
          } else {
            pushItem({
              type: "function_call_output",
              call_id: content.id,
              output: content.result.error,
            });
          }
          break;

        case "thinking":
        case "redacted_thinking": {
          const itemId = itemIdOf(content);
          // Reasoning items cannot be reconstructed without their server id,
          // and the backend tolerates their absence, so drop rather than throw.
          if (!itemId) break;

          let item = reasoningItems[itemId];
          if (!item) {
            item = {
              type: "reasoning",
              id: itemId,
              encrypted_content: null,
              summary: [],
            };
            reasoningItems[itemId] = item;
            pushItem(item);
          }

          if (content.type === "thinking") {
            if (content.thinking.trim()) {
              item.summary.push({
                type: "summary_text",
                text: content.thinking,
              });
            }
            if (content.signature) {
              item.encrypted_content = content.signature;
            }
          } else {
            item.encrypted_content = content.data;
          }
          break;
        }

        default:
          assertUnreachable(content);
      }
    }

    flushUser();
  }

  flushUser();
  return input;
}

export type CreateStreamParametersOptions = {
  model: string;
  messages: ProviderMessage[];
  tools: ProviderToolSpec[];
  systemPrompt?: string | undefined;
  promptCacheKey?: string | undefined;
  includeWebSearch?: boolean | undefined;
  reasoning?:
    | {
        effort?: ReasoningEffort | undefined;
        summary?: ReasoningSummary | undefined;
      }
    | undefined;
};

function toOpenAIReasoningEffort(
  effort: ReasoningEffort,
): OpenAI.ReasoningEffort {
  switch (effort) {
    case "low":
    case "medium":
    case "high":
      return effort;
    case "xhigh":
      // The API accepts "xhigh" for gpt-5.x; the SDK's union lags it.
      return "xhigh" as OpenAI.ReasoningEffort;
    default:
      return assertUnreachable(effort);
  }
}

export function createStreamParameters({
  model,
  messages,
  tools,
  systemPrompt,
  includeWebSearch,
  reasoning,
  promptCacheKey,
}: CreateStreamParametersOptions): OpenAI.Responses.ResponseCreateParamsStreaming {
  // Tool order is part of the cached prefix and a reorder is a total miss, so
  // sort by name rather than trusting registration order.
  const sortedTools = [...tools].sort((a, b) => (a.name < b.name ? -1 : 1));
  const openaiTools: OpenAI.Responses.Tool[] = sortedTools.map(toOpenAITool);

  if (includeWebSearch && supportsWebSearch(model)) {
    openaiTools.push({ type: "web_search" } as OpenAI.Responses.Tool);
  }

  const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
    model,
    instructions: systemPrompt || DEFAULT_OPENAI_SYSTEM_PROMPT,
    input: convertProviderMessagesToInput(messages),
    tools: openaiTools,
    parallel_tool_calls: true,
    store: false,
    stream: true,
  };

  // Without a key each request is load-balanced to an arbitrary cache shard, so
  // hits oscillate between the full prefix and just instructions+tools. A key
  // that is stable for the life of a conversation keeps its turns on one shard.
  if (promptCacheKey) {
    params.prompt_cache_key = promptCacheKey;
  }

  if (isReasoningModel(model)) {
    // Without this the reasoning items come back with a null
    // encrypted_content and cannot be echoed for continuity.
    params.include = ["reasoning.encrypted_content"];
    if (reasoning) {
      const config: OpenAI.Reasoning = {};
      if (reasoning.effort) {
        config.effort = toOpenAIReasoningEffort(reasoning.effort);
      }
      if (reasoning.summary) {
        config.summary = reasoning.summary;
      }
      if (Object.keys(config).length > 0) {
        params.reasoning = config;
      }
    }
  }

  return params;
}

// ---------------------------------------------------------------------------
// Responses stream events -> ProviderStreamEvent
// ---------------------------------------------------------------------------

/** The installed SDK (5.23.2) omits `action` from `ResponseFunctionWebSearch`
 * and types stream annotations as `unknown`, though the API sends both. These
 * two helpers are the only places those payloads are narrowed. */
type WebSearchAction =
  | OpenAI.Responses.ResponseFunctionWebSearch.Search
  | OpenAI.Responses.ResponseFunctionWebSearch.OpenPage
  | OpenAI.Responses.ResponseFunctionWebSearch.Find;

export function webSearchQuery(
  item: OpenAI.Responses.ResponseFunctionWebSearch,
): string | undefined {
  const { action } = item as { action?: WebSearchAction };
  return action?.type === "search" ? action.query : undefined;
}

function urlCitationOf(
  annotation: unknown,
): OpenAI.Responses.ResponseOutputText.URLCitation | undefined {
  const candidate = annotation as
    | Partial<OpenAI.Responses.ResponseOutputText.URLCitation>
    | null
    | undefined;
  if (candidate?.type !== "url_citation") return undefined;
  if (
    typeof candidate.url !== "string" ||
    typeof candidate.title !== "string"
  ) {
    return undefined;
  }
  return candidate as OpenAI.Responses.ResponseOutputText.URLCitation;
}

function withItemId(itemId: string | undefined) {
  return itemId
    ? { providerMetadata: { provider: "openai", itemId } as ProviderMetadata }
    : {};
}

/** Translate one native Responses event into zero or more provider stream
 * events. Blocks are keyed by `output_index`; reasoning summary parts are
 * indexed independently (`summary_index`) and accumulate into the single
 * thinking block opened for their item. */
export function mapResponseStreamEvent(
  event: OpenAI.Responses.ResponseStreamEvent,
): ProviderStreamEvent[] {
  switch (event.type) {
    case "response.output_item.added":
      switch (event.item.type) {
        case "message":
          return [
            {
              type: "content_block_start",
              index: event.output_index,
              content_block: { type: "text", text: "", citations: null },
              ...withItemId(event.item.id),
            },
          ];
        case "function_call":
          return [
            {
              type: "content_block_start",
              index: event.output_index,
              content_block: {
                type: "tool_use",
                id: event.item.call_id,
                name: event.item.name,
                input: {},
              } satisfies ProviderToolUseBlockStart,
              ...withItemId(event.item.id),
            },
          ];
        case "web_search_call":
          return [
            {
              type: "content_block_start",
              index: event.output_index,
              content_block: {
                type: "server_tool_use",
                id: event.item.id,
                name: "web_search",
                input: {},
              } satisfies ProviderServerToolUseBlockStart,
              ...withItemId(event.item.id),
            },
          ];
        case "reasoning":
          return [
            {
              type: "content_block_start",
              index: event.output_index,
              content_block: { type: "thinking", thinking: "", signature: "" },
              ...withItemId(event.item.id),
            },
          ];
        default:
          return [];
      }

    case "response.output_text.delta":
      return [
        {
          type: "content_block_delta",
          index: event.output_index,
          delta: { type: "text_delta", text: event.delta },
        },
      ];

    case "response.function_call_arguments.delta":
      return [
        {
          type: "content_block_delta",
          index: event.output_index,
          delta: { type: "input_json_delta", partial_json: event.delta },
        },
      ];

    case "response.reasoning_summary_part.added":
      // A second part continues the same block; separate it visually rather
      // than opening a new one.
      return event.summary_index > 0
        ? [
            {
              type: "content_block_delta",
              index: event.output_index,
              delta: { type: "thinking_delta", thinking: "\n\n" },
            },
          ]
        : [];

    case "response.reasoning_summary_text.delta":
      return [
        {
          type: "content_block_delta",
          index: event.output_index,
          delta: { type: "thinking_delta", thinking: event.delta },
        },
      ];

    case "response.output_text.annotation.added": {
      const annotation = urlCitationOf(event.annotation);
      if (!annotation) return [];
      return [
        {
          type: "content_block_delta",
          index: event.output_index,
          delta: {
            type: "citations_delta",
            citation: {
              type: "web_search_result_location",
              cited_text: "",
              encrypted_index: "",
              title: annotation.title,
              url: annotation.url,
            },
          },
        },
      ];
    }

    case "response.output_item.done": {
      const events: ProviderStreamEvent[] = [];
      if (event.item.type === "reasoning") {
        // encrypted_content only exists on the completed item; carry it in the
        // thinking block's signature so it round-trips.
        if (event.item.encrypted_content) {
          events.push({
            type: "content_block_delta",
            index: event.output_index,
            delta: {
              type: "signature_delta",
              signature: event.item.encrypted_content,
            },
          });
        }
      } else if (event.item.type === "web_search_call") {
        const query = webSearchQuery(event.item);
        if (query !== undefined) {
          events.push({
            type: "content_block_delta",
            index: event.output_index,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify({ query }),
            },
          });
        }
      }
      events.push({ type: "content_block_stop", index: event.output_index });
      return events;
    }

    default:
      return [];
  }
}

export function usageFromResponse(response: OpenAI.Responses.Response): Usage {
  // openai reports input_tokens as the total prompt size, with cached_tokens as a
  // subset of it. Anthropic reports these as disjoint buckets, so subtract the
  // cached portion to keep Usage consistent across providers.
  const cached = response.usage?.input_tokens_details?.cached_tokens;
  const usage: Usage = {
    inputTokens: (response.usage?.input_tokens ?? 0) - (cached ?? 0),
    outputTokens: response.usage?.output_tokens ?? 0,
  };
  if (cached != null) {
    usage.cacheHits = cached;
  }
  return usage;
}

// ---------------------------------------------------------------------------
// Completed output items -> ProviderMessageContent (used for round-tripping)
// ---------------------------------------------------------------------------

export function convertResponseOutputToProviderContent(
  validateInput: ValidateInput,
  items: OpenAI.Responses.ResponseOutputItem[],
): ProviderMessageContent[] {
  const content: ProviderMessageContent[] = [];

  for (const item of items) {
    switch (item.type) {
      case "message":
        for (const part of item.content) {
          if (part.type !== "output_text") continue;
          const citations: ProviderWebSearchCitation[] = (
            part.annotations ?? []
          )
            .filter(
              (a): a is OpenAI.Responses.ResponseOutputText.URLCitation =>
                a.type === "url_citation",
            )
            .map((a) => ({
              type: "web_search_citation",
              cited_text: "",
              encrypted_index: "",
              title: a.title,
              url: a.url,
            }));
          content.push({
            type: "text",
            text: part.text,
            ...(citations.length ? { citations } : {}),
            providerMetadata: { provider: "openai", itemId: item.id },
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          });
        }
        break;

      case "reasoning":
        content.push({
          type: "thinking",
          thinking: item.summary.map((s) => s.text).join("\n\n"),
          ...(item.encrypted_content
            ? { signature: item.encrypted_content }
            : {}),
          providerMetadata: { provider: "openai", itemId: item.id },
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        });
        break;

      case "function_call": {
        content.push({
          type: "tool_use",
          id: item.call_id as ToolRequestId,
          name: item.name as ToolName,
          request: parseToolRequest(validateInput, item),
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        });
        break;
      }

      case "web_search_call": {
        // Only `search` actions carry a query; `open_page` / `find` have no
        // representation in ProviderServerToolUseContent, so they are dropped.
        const query = webSearchQuery(item);
        if (query !== undefined) {
          content.push({
            type: "server_tool_use",
            id: item.id,
            name: "web_search",
            input: { query },
            providerMetadata: { provider: "openai", itemId: item.id },
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          });
        }
        break;
      }

      default:
        break;
    }
  }

  return content;
}

export function parseToolRequest(
  validateInput: ValidateInput,
  item: { call_id: string; name: string; arguments: string },
): Result<ToolRequest, { rawRequest: unknown }> {
  try {
    const parsed = JSON.parse(item.arguments || "{}") as {
      [key: string]: unknown;
    };
    const input = validateInput(item.name as ToolName, parsed);
    if (input.status === "ok") {
      return {
        status: "ok",
        value: {
          toolName: item.name,
          id: item.call_id as ToolRequestId,
          input: input.value,
        } as ToolRequest,
      };
    }
    return { ...input, rawRequest: item.arguments };
  } catch (error) {
    return {
      status: "error",
      error: (error as Error).message,
      rawRequest: item.arguments,
    };
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function isRetryableOpenAIError(error: Error): boolean {
  return (
    error instanceof APIError &&
    (error.status === 429 ||
      error.status === 500 ||
      error.status === 502 ||
      error.status === 503 ||
      error.status === 529)
  );
}

/** ChatGPT-subscription tokens are only accepted by the codex backend. */
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

/** The codex backend only serves a subset of the gpt-5.x line: every
 * codex-family model is rejected for ChatGPT-account auth, as are plain
 * `gpt-5` through `gpt-5.3` and anything outside the gpt-5.x line (`gpt-4o` and
 * friends). Caught up front so the user gets an actionable message instead of
 * an opaque 400. Entitlements shift, so this is a blocklist rather than a
 * whitelist -- a newer gpt-5.x is assumed to work until the backend says
 * otherwise. */
function isChatGPTRejectedModel(model: string): boolean {
  if (/-codex/i.test(model)) return true;
  if (/^gpt-5(\.[0-3])?$/i.test(model)) return true;
  return !/^gpt-5\.\d/i.test(model);
}
const CHATGPT_KNOWN_GOOD_MODELS = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;

export function assertChatGPTModelSupported(model: string): void {
  if (isChatGPTRejectedModel(model)) {
    throw new Error(
      `Model "${model}" is not available with ChatGPT subscription auth. ` +
        `Known-working models: ${CHATGPT_KNOWN_GOOD_MODELS.join(", ")}. ` +
        `Set \`model\` / \`fastModel\` on the profile to one of these.`,
    );
  }
}

/** Auth mode and its dependencies, encoded together so that a ChatGPT-auth
 * provider cannot be constructed without credentials. */
export type OpenAIProviderOptions = {
  baseUrl?: string | undefined;
  includeWebSearch?: boolean | undefined;
} & (
  | { authType?: "key" | undefined; apiKeyEnvVar?: string | undefined }
  | { authType: "chatgpt"; auth: OpenAIAuth; authUI?: AuthUI | undefined }
  | {
      authType: "bedrock";
      env?: Record<string, string> | undefined;
      tokenRefreshCommand?: string | undefined;
    }
);

export class OpenAIProvider implements Provider {
  /** Public so tests can substitute a mock client, as the Anthropic tests do. */
  public client: OpenAI;
  readonly includeWebSearch: boolean;
  private authType: "key" | "chatgpt" | "bedrock";
  /** Bedrock-only: runs the profile's `tokenRefreshCommand` and discards the
   * memoized AWS credentials, so an expired SSO session can be recovered
   * without restarting. */
  private refreshAuth: RefreshAuth | undefined;

  constructor(
    protected logger: Logger,
    protected validateInput: ValidateInput,
    options?: OpenAIProviderOptions,
  ) {
    this.authType = options?.authType ?? "key";
    // The server-side tool only exists on the OpenAI platform: a custom
    // baseUrl points at a compatible-but-different API, and the bedrock
    // mantle endpoint rejects it.
    this.includeWebSearch =
      options?.includeWebSearch ??
      (!options?.baseUrl && this.authType !== "bedrock");

    if (options?.authType === "bedrock") {
      const region = resolveAwsRegion(
        options.env,
        DEFAULT_BEDROCK_MANTLE_REGION,
      );
      const credentials = new AwsCredentials(options.env);
      this.client = new OpenAI({
        // SigV4 signing supplies the credentials; the SDK still requires an
        // api key to be set.
        apiKey: "dummy-key-for-bedrock-auth",
        baseURL: options.baseUrl || bedrockMantleBaseUrl(region),
        fetch: createSigV4Fetch(region, credentials),
      });
      if (options.tokenRefreshCommand) {
        const refresh = makeRefreshAuth(options.tokenRefreshCommand, logger);
        this.refreshAuth = async () => {
          await refresh();
          credentials.reset();
        };
      }
      return;
    }

    if (options?.authType === "chatgpt") {
      this.client = new OpenAI({
        // The codex backend authenticates via headers; the SDK still requires
        // some api key to be set.
        apiKey: "dummy-key-for-chatgpt-auth",
        baseURL: options.baseUrl || CODEX_BASE_URL,
        fetch: this.createChatGPTFetch(options.auth, options.authUI),
      });
    } else {
      this.client = new OpenAI({
        apiKey: process.env[options?.apiKeyEnvVar || "OPENAI_API_KEY"],
        baseURL: options?.baseUrl || process.env.OPENAI_BASE_URL,
      });
    }
  }

  /** Installs the bearer token and account id, and reacts to a 401 with
   * exactly one refresh-and-retry before surfacing the failure. */
  private createChatGPTFetch(auth: OpenAIAuth, authUI: AuthUI | undefined) {
    const withCredentials = async (
      input: string | URL | Request,
      init: RequestInit | undefined,
      credentials: CodexCredentials,
    ) => {
      // init.headers is a Headers instance, so it must be copied through the
      // Headers constructor -- spreading it yields an empty object and drops
      // the SDK's content-type/accept, which the codex backend rejects with
      // "Unsupported content type".
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${credentials.accessToken}`);
      headers.set("chatgpt-account-id", credentials.accountId);
      return fetch(input, { ...init, headers });
    };

    return async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const signal = init?.signal ?? undefined;
      await this.ensureLoggedIn(auth, authUI, signal);
      const response = await withCredentials(
        input,
        init,
        await this.withRelogin(
          () => auth.getCredentials(),
          auth,
          authUI,
          signal,
        ),
      );
      if (response.status !== 401) return response;

      this.logger.info("ChatGPT credentials rejected; refreshing once");
      return withCredentials(
        input,
        init,
        await this.withRelogin(
          () => auth.refreshCredentials(),
          auth,
          authUI,
          signal,
        ),
      );
    };
  }

  /** A spent or rejected refresh token is indistinguishable from being logged
   * out, and `isAuthenticated` can't tell them apart — it only sees that token
   * strings exist on disk. Recover by logging in again rather than failing the
   * request, which the OpenAI SDK would otherwise report as an opaque
   * "Connection error." since this runs inside its `fetch`. */
  private async withRelogin(
    getCredentials: () => Promise<CodexCredentials>,
    auth: OpenAIAuth,
    authUI: AuthUI | undefined,
    signal: AbortSignal | undefined,
  ): Promise<CodexCredentials> {
    try {
      return await getCredentials();
    } catch (error) {
      if (
        !(error instanceof CodexAuthError) ||
        (error.kind !== "refresh-failed" && error.kind !== "not-logged-in")
      ) {
        this.logger.error(`ChatGPT auth failed: ${(error as Error).message}`);
        throw error;
      }
      this.logger.info(
        `ChatGPT credentials unusable (${error.kind}); logging in again`,
      );
      await this.login(auth, authUI, signal);
      return getCredentials();
    }
  }

  private async ensureLoggedIn(
    auth: OpenAIAuth,
    authUI: AuthUI | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (await auth.isAuthenticated()) return;
    await this.login(auth, authUI, signal);
  }

  private async login(
    auth: OpenAIAuth,
    authUI: AuthUI | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (!authUI) {
      throw new Error(
        "Not logged in to ChatGPT. Run `codex login` in a terminal.",
      );
    }
    // `codex login` is interactive and open-ended, so it is cancelled by
    // aborting the request that triggered it rather than by its own UI.
    await auth.login({
      onOutput: (chunk) => authUI.showLoginProgress(chunk),
      signal,
    });
  }

  createStreamParameters(
    options: CreateStreamParametersOptions,
  ): OpenAI.Responses.ResponseCreateParamsStreaming {
    return createStreamParameters(options);
  }

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
      effort?: ThinkingEffort;
    };
  }): ProviderToolUseRequest {
    const { model, input, spec, systemPrompt } = options;
    if (this.authType === "chatgpt") {
      assertChatGPTModelSupported(model);
    }
    let aborted = false;
    let retryAbortController: AbortController | undefined;
    const abortController = new AbortController();

    const messages: ProviderMessage[] = [
      {
        role: "user",
        content: input,
      },
    ];

    const streamParams = createStreamParameters({
      model,
      messages,
      tools: [spec],
      systemPrompt,
    });

    // The codex backend rejects stream: false outright ("Stream must be set to
    // true"), so even a one-shot forced tool call has to stream and be
    // reassembled from the terminal response.completed event.
    const requestParams: OpenAI.Responses.ResponseCreateParamsStreaming = {
      ...streamParams,
      tool_choice: { type: "function", name: spec.name },
    };

    const promise = (async (): Promise<ProviderToolUseResponse> => {
      const retryStart = Date.now();
      let attempt = 0;
      while (true) {
        try {
          const stream = await this.client.responses.create(requestParams, {
            signal: abortController.signal,
          });
          // The codex backend's terminal response.completed can carry an empty
          // `output`, so the items are collected from output_item.done and the
          // terminal event is used only for usage and failure detection.
          const output: OpenAI.Responses.ResponseOutputItem[] = [];
          let response: OpenAI.Responses.Response | undefined;
          for await (const event of stream) {
            if (event.type === "response.output_item.done") {
              output.push(event.item);
            } else if (
              event.type === "response.completed" ||
              event.type === "response.incomplete"
            ) {
              response = event.response;
            } else if (event.type === "response.failed") {
              throw new Error(
                event.response.error?.message ?? "response.failed",
              );
            }
          }
          if (!response) {
            throw new Error("Stream ended without a terminal response event");
          }

          if (aborted) {
            throw new Error("Aborted");
          }

          const call = output.find((item) => item.type === "function_call");

          let toolRequest: Result<ToolRequest, { rawRequest: unknown }>;
          if (!call) {
            toolRequest = {
              status: "error",
              error: `Expected a function_call response for '${spec.name}'`,
              rawRequest: output,
            };
          } else if (call.name !== spec.name) {
            toolRequest = {
              status: "error",
              error: `expected tool name to be '${spec.name}'`,
              rawRequest: call,
            };
          } else {
            toolRequest = parseToolRequest(this.validateInput, call);
          }

          return {
            toolRequest,
            stopReason: "tool_use",
            usage: usageFromResponse(response),
          };
        } catch (error) {
          if (aborted || !(error instanceof Error)) {
            throw error;
          }
          // Auth errors are retried outside the 429/5xx budget; the 30s guard
          // inside refreshAuth prevents tight loops.
          if (this.refreshAuth && isAuthError(error)) {
            try {
              await this.refreshAuth();
              continue;
            } catch (refreshErr) {
              const refreshMessage =
                refreshErr instanceof Error
                  ? refreshErr.message
                  : String(refreshErr);
              throw new Error(
                `Auth refresh failed: ${refreshMessage}. Original error: ${describeError(error)}`,
              );
            }
          }
          if (
            !isRetryableOpenAIError(error) ||
            Date.now() - retryStart >= MAX_RETRY_DURATION
          ) {
            throw flattenError(error);
          }

          const delay = getRetryDelay(attempt);
          retryAbortController = new AbortController();
          const signal = retryAbortController.signal;
          try {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, delay);
              signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  reject(new DOMException("Aborted", "AbortError"));
                },
                { once: true },
              );
            });
          } catch {
            throw error;
          }
          retryAbortController = undefined;
          attempt++;
        }
      }
    })();

    return {
      promise,
      aborted,
      abort: () => {
        aborted = true;
        retryAbortController?.abort();
        abortController.abort();
      },
    };
  }

  createInferenceManager(options: InferenceOptions): NativeInferenceManager {
    if (this.authType === "chatgpt") {
      assertChatGPTModelSupported(options.model);
    }
    return new OpenAIInferenceManager(options, this.client, {
      includeWebSearch: this.includeWebSearch,
      logger: this.logger,
      validateInput: this.validateInput,
      reasoning: reasoningConfig(options),
      refreshAuth: this.refreshAuth,
    });
  }
}

export type { StopReason };
