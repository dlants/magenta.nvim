import Anthropic from "@anthropic-ai/sdk";
import { extendError, type Result } from "../utils/result.ts";
import type { ToolRequestId } from "../tools/toolManager.ts";
import type { Nvim } from "../nvim/nvim-node";
import {
  type Provider,
  type ProviderMessage,
  type Usage,
  type ProviderStreamRequest,
  type ProviderToolSpec,
  type ProviderToolUseRequest,
  type ProviderStreamEvent,
  type ProviderTextContent,
} from "./provider-types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.ts";
import { validateInput } from "../tools/helpers.ts";
import type { ToolRequest } from "../tools/types.ts";

function mapProviderTextToAnthropicText(
  providerText: ProviderTextContent,
): Anthropic.Messages.TextBlockParam {
  return {
    ...providerText,
    citations: providerText.citations
      ? providerText.citations.map((providerCitation) => ({
          ...providerCitation,
          type: "web_search_result_location",
        }))
      : null,
  };
}

export type MessageParam = Omit<Anthropic.MessageParam, "content"> & {
  content: Array<Anthropic.Messages.ContentBlockParam>;
};

// Bedrock does not support the disable_parallel_tool_use flag
// Force accept undefined as the value to be able to unset it when using it
type MessageStreamParams = Omit<
  Anthropic.Messages.MessageStreamParams,
  "tool_choice"
> & {
  tool_choice: Omit<
    Anthropic.Messages.ToolChoice,
    "disable_parallel_tool_use"
  > & {
    disable_parallel_tool_use: boolean | undefined;
  };
};

export class AnthropicProvider implements Provider {
  protected client: Anthropic;
  protected model: string;

  constructor(
    protected nvim: Nvim,
    options?: {
      baseUrl?: string | undefined;
      apiKeyEnvVar?: string | undefined;
      awsAPIKey?: boolean | undefined;
      promptCaching?: boolean | undefined;
      disableParallelToolUseFlag?: boolean;
    },
  ) {
    const apiKeyEnvVar = options?.apiKeyEnvVar || "ANTHROPIC_API_KEY";
    const apiKey = process.env[apiKeyEnvVar];
    this.model = "claude-3-7-sonnet-latest";

    if (!options?.awsAPIKey && !apiKey) {
      throw new Error(
        `Anthropic API key ${apiKeyEnvVar} not found in environment`,
      );
    }

    this.client = new Anthropic({
      apiKey,
      baseURL: options?.baseUrl,
    });
  }

  private promptCaching = true;
  private disableParallelToolUseFlag = true;

  setModel(model: string): void {
    this.model = model;
  }

  createStreamParameters(
    messages: ProviderMessage[],
    tools: Array<ProviderToolSpec>,
    options?: {
      disableCaching?: boolean;
      systemPrompt?: string | undefined;
    },
  ): MessageStreamParams {
    const anthropicMessages = messages.map((m): MessageParam => {
      let content: Anthropic.Messages.ContentBlockParam[];
      if (typeof m.content == "string") {
        content = [
          {
            type: "text",
            text: m.content,
          },
        ];
      } else {
        content = [];
        for (const c of m.content) {
          switch (c.type) {
            case "text":
              // important to create a new object here so when we attach ephemeral
              // cache_control markers we won't mutate the content.
              content.push(mapProviderTextToAnthropicText(c));
              break;

            case "web_search_tool_result":
              content.push({
                ...c,
              });
              break;

            case "tool_use":
              content.push(
                c.request.status == "ok"
                  ? {
                      id: c.id,
                      input: c.request.value.input,
                      name: c.request.value.toolName,
                      type: "tool_use",
                    }
                  : {
                      id: c.id,
                      input: c.request.rawRequest,
                      name: c.name,
                      type: "tool_use",
                    },
              );
              break;

            case "server_tool_use":
              content.push({
                type: "server_tool_use",
                id: c.id,
                name: c.name,
                input: c.input,
              });
              break;

            case "tool_result":
              if (c.result.status == "ok") {
                for (const resultContent of c.result.value) {
                  switch (resultContent.type) {
                    case "text":
                      content.push({
                        tool_use_id: c.id,
                        type: "tool_result",
                        content: [
                          mapProviderTextToAnthropicText(resultContent),
                        ],
                        is_error: false,
                      });
                      break;
                    case "image":
                      content.push({
                        tool_use_id: c.id,
                        type: "tool_result",
                        content: [resultContent],
                        is_error: false,
                      });
                      break;
                    case "document":
                      content.push({
                        tool_use_id: c.id,
                        type: "tool_result",
                        content: "Document content follows:",
                        is_error: false,
                      });
                      content.push({
                        type: "document",
                        source: resultContent.source,
                        title: resultContent.title || null,
                      });
                      break;
                    default:
                      assertUnreachable(resultContent);
                  }
                }
              } else {
                content.push({
                  tool_use_id: c.id,
                  type: "tool_result",
                  content: c.result.error,
                  is_error: true,
                });
              }
              break;

            case "image":
              content.push({
                type: "image",
                source: c.source,
              });
              break;

            case "document":
              content.push({
                type: "document",
                source: c.source,
                title: c.title || null,
              });
              break;

            default:
              assertUnreachable(c);
          }
        }
      }

      return {
        role: m.role,
        content,
      };
    });

    // Use the promptCaching class property but allow it to be overridden by options parameter
    const useCaching = options?.disableCaching !== true && this.promptCaching;

    if (useCaching) {
      placeCacheBreakpoints(anthropicMessages);
    }

    const anthropicTools: Anthropic.Tool[] = tools.map((t): Anthropic.Tool => {
      return {
        ...t,
        input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
      };
    });

    return {
      messages: anthropicMessages,
      model: this.model,
      max_tokens: 32000,
      system: [
        {
          type: "text",
          text: options?.systemPrompt
            ? options.systemPrompt
            : DEFAULT_SYSTEM_PROMPT,
          // the prompt appears in the following order:
          // tools
          // system
          // messages
          // This ensures the tools + system prompt (which is approx 1400 tokens) is cached.
          cache_control: useCaching ? { type: "ephemeral" } : null,
        },
      ],
      tool_choice: {
        type: "auto",
        disable_parallel_tool_use: this.disableParallelToolUseFlag || undefined,
      },
      tools: [
        ...anthropicTools,
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 5,
        } as unknown as Anthropic.Messages.Tool,
      ],
    };
  }

  countTokens(
    messages: Array<ProviderMessage>,
    tools: Array<ProviderToolSpec>,
    options?: { systemPrompt?: string | undefined },
  ): number {
    const CHARS_PER_TOKEN = 4;

    let charCount = (
      options?.systemPrompt ? options.systemPrompt : DEFAULT_SYSTEM_PROMPT
    ).length;
    charCount += JSON.stringify(tools).length;
    charCount += JSON.stringify(messages).length;

    return Math.ceil(charCount / CHARS_PER_TOKEN);
  }

  forceToolUse(
    messages: Array<ProviderMessage>,
    spec: ProviderToolSpec,
    options?: { systemPrompt?: string | undefined },
  ): ProviderToolUseRequest {
    const request = this.client.messages.stream({
      ...this.createStreamParameters(messages, [], {
        disableCaching: true,
        systemPrompt: options?.systemPrompt,
      }),
      tools: [
        {
          ...spec,
          input_schema:
            spec.input_schema as Anthropic.Messages.Tool.InputSchema,
        },
      ],
      tool_choice: {
        type: "tool",
        name: spec.name,
        disable_parallel_tool_use: this.disableParallelToolUseFlag || undefined,
      },
    } as Anthropic.Messages.MessageStreamParams);

    const promise = (async () => {
      const response: Anthropic.Message = await request.finalMessage();

      if (response.stop_reason === "max_tokens") {
        throw new Error("Response exceeded max_tokens limit");
      }

      if (response.content.length != 1) {
        throw new Error(
          `Expected a single response but got ${response.content.length}`,
        );
      }

      const contentBlock = response.content[0];

      const toolRequest = extendError(
        ((): Result<ToolRequest> => {
          if (contentBlock.type != "tool_use") {
            throw new Error(
              `Expected a tool_use response but got ${response.type}`,
            );
          }

          if (typeof contentBlock != "object" || contentBlock == null) {
            return { status: "error", error: "received a non-object" };
          }

          const name = (
            contentBlock as unknown as { [key: string]: unknown } | undefined
          )?.["name"];

          if (name != spec.name) {
            return {
              status: "error",
              error: `expected contentBlock.name to be '${spec.name}'`,
            };
          }

          const req2 = contentBlock as unknown as { [key: string]: unknown };

          if (req2.type != "tool_use") {
            return {
              status: "error",
              error: "expected contentBlock.type to be tool_use",
            };
          }

          if (typeof req2.id != "string") {
            return {
              status: "error",
              error: "expected contentBlock.id to be a string",
            };
          }

          if (typeof req2.input != "object" || req2.input == null) {
            return {
              status: "error",
              error: "expected contentBlock.input to be an object",
            };
          }

          const input = validateInput(
            spec.name,
            req2.input as { [key: string]: unknown },
          );

          if (input.status == "ok") {
            return {
              status: "ok",
              value: {
                toolName: spec.name,
                id: req2.id as unknown as ToolRequestId,
                input: input.value,
              } as ToolRequest,
            };
          } else {
            return input;
          }
        })(),
        { rawRequest: contentBlock },
      );

      const usage: Usage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
      if (response.usage.cache_read_input_tokens != undefined) {
        usage.cacheHits = response.usage.cache_read_input_tokens;
      }
      if (response.usage.cache_creation_input_tokens != undefined) {
        usage.cacheMisses = response.usage.cache_creation_input_tokens;
      }

      return {
        toolRequest,
        stopReason: response.stop_reason || "end_turn",
        usage,
      };
    })();

    return {
      promise,
      abort: () => {
        request.abort();
      },
    };
  }

  /**
   * Example of stream events from anthropic https://docs.anthropic.com/en/api/messages-streaming
   */
  sendMessage(
    messages: Array<ProviderMessage>,
    onStreamEvent: (event: ProviderStreamEvent) => void,
    tools: Array<ProviderToolSpec>,
    options?: { systemPrompt?: string | undefined },
  ): ProviderStreamRequest {
    let requestActive = true;
    const request = this.client.messages
      .stream(
        this.createStreamParameters(messages, tools, {
          systemPrompt: options?.systemPrompt,
        }) as Anthropic.Messages.MessageStreamParams,
      )
      .on("streamEvent", (e) => {
        if (
          requestActive &&
          (e.type == "content_block_start" ||
            e.type == "content_block_delta" ||
            e.type == "content_block_stop")
        ) {
          onStreamEvent(e);
        }
      });

    const promise = (async () => {
      const response: Anthropic.Message = await request.finalMessage();

      if (response.stop_reason === "max_tokens") {
        throw new Error("Response exceeded max_tokens limit");
      }

      const usage: Usage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
      if (response.usage.cache_read_input_tokens != undefined) {
        usage.cacheHits = response.usage.cache_read_input_tokens;
      }
      if (response.usage.cache_creation_input_tokens != undefined) {
        usage.cacheMisses = response.usage.cache_creation_input_tokens;
      }

      return {
        stopReason: response.stop_reason || "end_turn",
        usage,
      };
    })();

    return {
      abort: () => {
        request.abort();
        requestActive = false;
      },
      promise,
    };
  }
}

/** We only ever need to place a cache header on the last block, since anthropic now can compute the longest reusable
 * prefix.
 * https://www.anthropic.com/news/token-saving-updates
 */
export function placeCacheBreakpoints(messages: MessageParam[]): void {
  if (messages.length === 0) {
    return;
  }

  // Find the last eligible block by searching backwards through messages
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex--
  ) {
    const message = messages[messageIndex];

    for (
      let blockIndex = message.content.length - 1;
      blockIndex >= 0;
      blockIndex--
    ) {
      const block = message.content[blockIndex];

      // Check if this block is eligible for caching
      if (
        block &&
        block.type !== "thinking" &&
        block.type !== "redacted_thinking"
      ) {
        block.cache_control = { type: "ephemeral" };
        return;
      }
    }
  }
}
