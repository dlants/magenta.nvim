import OpenAI, { APIError } from "openai";
import type {
  JSONSchemaObject,
  JSONSchemaType,
} from "openai/lib/jsonschema.mjs";
import type { Logger } from "../logger.ts";
import type {
  ToolName,
  ToolRequest,
  ToolRequestId,
  ValidateInput,
} from "../tool-types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Result } from "../utils/result.ts";
import { getRetryDelay, MAX_RETRY_DURATION } from "./anthropic-agent.ts";
import {
  type Agent,
  type AgentInput,
  type AgentOptions,
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  type Provider,
  type ProviderMessage,
  type ProviderMessageContent,
  type ProviderStreamEvent,
  type ProviderToolSpec,
  type ProviderToolUseRequest,
  type ProviderToolUseResponse,
  type ProviderWebSearchCitation,
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
  providerMetadata?: { openai?: { itemId?: string | undefined } } | undefined;
}): string | undefined {
  return content.providerMetadata?.openai?.itemId;
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
  includeWebSearch?: boolean | undefined;
  reasoning?:
    | {
        effort?: "low" | "medium" | "high" | "xhigh" | undefined;
        summary?: string | undefined;
      }
    | undefined;
};

export function createStreamParameters({
  model,
  messages,
  tools,
  systemPrompt,
  includeWebSearch,
  reasoning,
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

  if (isReasoningModel(model)) {
    // Without this the reasoning items come back with a null
    // encrypted_content and cannot be echoed for continuity.
    params.include = ["reasoning.encrypted_content"];
    if (reasoning) {
      const config: OpenAI.Reasoning = {};
      if (reasoning.effort) {
        config.effort = reasoning.effort as OpenAI.ReasoningEffort;
      }
      if (reasoning.summary) {
        config.summary = reasoning.summary as NonNullable<
          OpenAI.Reasoning["summary"]
        >;
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

function withItemId(itemId: string | undefined) {
  return itemId ? { providerMetadata: { openai: { itemId } } } : {};
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
              } as never,
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
              } as never,
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
      const annotation = event.annotation as {
        type?: string;
        url?: string;
        title?: string;
      };
      if (annotation?.type !== "url_citation") return [];
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
              title: annotation.title ?? "",
              url: annotation.url ?? "",
            },
          } as never,
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
            } as never,
          });
        }
      } else if (event.item.type === "web_search_call") {
        const action = (event.item as { action?: { query?: string } }).action;
        events.push({
          type: "content_block_delta",
          index: event.output_index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify({ query: action?.query ?? "" }),
          },
        });
      }
      events.push({ type: "content_block_stop", index: event.output_index });
      return events;
    }

    default:
      return [];
  }
}

export function usageFromResponse(response: OpenAI.Responses.Response): Usage {
  const usage: Usage = {
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };
  const cached = response.usage?.input_tokens_details?.cached_tokens;
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
            providerMetadata: { openai: { itemId: item.id } },
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          });
        }
        break;

      case "reasoning":
        content.push({
          type: "thinking",
          thinking: item.summary.map((s) => s.text).join("\n\n"),
          signature: item.encrypted_content ?? "",
          providerMetadata: { openai: { itemId: item.id } },
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
        const action = (item as { action?: { query?: string } }).action;
        content.push({
          type: "server_tool_use",
          id: item.id,
          name: "web_search",
          input: { query: action?.query ?? "" },
          providerMetadata: { openai: { itemId: item.id } },
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        });
        break;
      }

      default:
        break;
    }
  }

  return content;
}

function parseToolRequest(
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

export type OpenAIProviderOptions = {
  baseUrl?: string | undefined;
  apiKeyEnvVar?: string | undefined;
};

export class OpenAIProvider implements Provider {
  /** Public so tests can substitute a mock client, as the Anthropic tests do. */
  public client: OpenAI;

  constructor(
    protected logger: Logger,
    protected validateInput: ValidateInput,
    options?: OpenAIProviderOptions,
  ) {
    this.client = new OpenAI({
      apiKey: process.env[options?.apiKeyEnvVar || "OPENAI_API_KEY"],
      baseURL: options?.baseUrl || process.env.OPENAI_BASE_URL,
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
    contextAgent?: Agent;
    thinking?: {
      enabled: boolean;
      budgetTokens?: number;
      displayThinking?: boolean;
      effort?: "low" | "medium" | "high" | "xhigh" | "max";
    };
  }): ProviderToolUseRequest {
    const { model, input, spec, systemPrompt, contextAgent } = options;
    let aborted = false;
    let retryAbortController: AbortController | undefined;
    const abortController = new AbortController();

    const messages: ProviderMessage[] = [
      ...(contextAgent ? contextAgent.getState().messages : []),
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

    const requestParams: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
      ...streamParams,
      stream: false,
      tool_choice: { type: "function", name: spec.name },
    };

    const promise = (async (): Promise<ProviderToolUseResponse> => {
      const retryStart = Date.now();
      let attempt = 0;
      while (true) {
        try {
          const response = await this.client.responses.create(requestParams, {
            signal: abortController.signal,
          });

          if (aborted) {
            throw new Error("Aborted");
          }

          const call = response.output.find(
            (item) => item.type === "function_call",
          );

          let toolRequest: Result<ToolRequest, { rawRequest: unknown }>;
          if (!call) {
            toolRequest = {
              status: "error",
              error: `Expected a function_call response for '${spec.name}'`,
              rawRequest: response.output,
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
          if (
            !isRetryableOpenAIError(error) ||
            Date.now() - retryStart >= MAX_RETRY_DURATION
          ) {
            throw error;
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

  createAgent(_options: AgentOptions): Agent {
    throw new Error("OpenAIAgent is not implemented yet");
  }
}

export type { StopReason };
