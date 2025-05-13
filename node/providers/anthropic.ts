import Anthropic from "@anthropic-ai/sdk";
import * as ToolManager from "../tools/toolManager.ts";
import { extendError, type Result } from "../utils/result.ts";
import type { Nvim } from "../nvim/nvim-node";
import {
  type Provider,
  type ProviderMessage,
  type Usage,
  type ProviderStreamRequest,
  type ProviderToolSpec,
  type ProviderToolUseRequest,
} from "./provider-types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { DEFAULT_SYSTEM_PROMPT } from "./constants.ts";
import type { ToolRequest, ToolRequestId } from "../tools/toolManager.ts";
import { validateInput } from "../tools/helpers.ts";

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

  createStreamParameters(messages: ProviderMessage[]): MessageStreamParams {
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
        content = m.content.map((c): Anthropic.ContentBlockParam => {
          switch (c.type) {
            case "web_search_tool_result":
            case "text":
              // important to create a new object here so when we attach ephemeral
              // cache_control markers we won't mutate the content.
              return {
                ...c,
              };
            case "tool_use":
              return c.request.status == "ok"
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
                  };

            case "server_tool_use":
              return {
                type: "server_tool_use",
                id: c.id,
                name: c.name,
                input: c.input,
              };

            case "tool_result":
              return {
                tool_use_id: c.id,
                type: "tool_result",
                content:
                  c.result.status == "ok" ? c.result.value : c.result.error,
                is_error: c.result.status == "error",
              };
            default:
              assertUnreachable(c);
          }
        });
      }

      return {
        role: m.role,
        content,
      };
    });

    let cacheControlItemsPlaced = 0;
    if (this.promptCaching) {
      cacheControlItemsPlaced = placeCacheBreakpoints(anthropicMessages);
    }

    const tools: Anthropic.Tool[] = ToolManager.CHAT_TOOL_SPECS.map(
      (t): Anthropic.Tool => {
        return {
          ...t,
          input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
        };
      },
    );

    this.nvim.logger?.error(`anthropic model: ${this.model}`);
    return {
      messages: anthropicMessages,
      model: this.model,
      max_tokens: 64000,
      system: [
        {
          type: "text",
          text: DEFAULT_SYSTEM_PROMPT,
          // the prompt appears in the following order:
          // tools
          // system
          // messages
          // This ensures the tools + system prompt (which is approx 1400 tokens) is cached.
          cache_control: this.promptCaching
            ? cacheControlItemsPlaced < 4
              ? { type: "ephemeral" }
              : null
            : null,
        },
      ],
      tool_choice: {
        type: "auto",
        disable_parallel_tool_use: this.disableParallelToolUseFlag || undefined,
      },
      tools: [
        ...tools,
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 5,
        } as unknown as Anthropic.Messages.Tool,
      ],
    };
  }

  async countTokens(messages: Array<ProviderMessage>): Promise<number> {
    const params = this.createStreamParameters(messages);
    const lastMessage = params.messages[params.messages.length - 1];
    if (!lastMessage || lastMessage.role != "user") {
      params.messages.push({ role: "user", content: "test" });
    }
    const res = await this.client.messages.countTokens({
      messages: params.messages,
      model: params.model,
      system: params.system as Anthropic.TextBlockParam[],
      tools: params.tools as Anthropic.Tool[],
    });
    return res.input_tokens;
  }

  forceToolUse(
    messages: Array<ProviderMessage>,
    spec: ProviderToolSpec,
  ): ProviderToolUseRequest {
    const request = this.client.messages.stream({
      ...this.createStreamParameters(messages),
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
            spec,
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
    onStreamEvent: (event: Anthropic.RawMessageStreamEvent) => void,
  ): ProviderStreamRequest {
    let requestActive = true;
    const request = this.client.messages
      .stream(
        this.createStreamParameters(
          messages,
        ) as Anthropic.Messages.MessageStreamParams,
      )
      .on("streamEvent", (e) => {
        if (requestActive) {
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

export function placeCacheBreakpoints(messages: MessageParam[]): number {
  // when we scan the messages, keep track of where each part ends.
  const blocks: { block: Anthropic.Messages.ContentBlockParam; acc: number }[] =
    [];

  let lengthAcc = 0;
  for (const message of messages) {
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          lengthAcc += block.text.length;
          break;
        case "image": {
          const source = block.source;
          lengthAcc +=
            source.type == "base64" ? source.data.length : source.url.length;
          break;
        }
        case "tool_use":
          lengthAcc += JSON.stringify(block.input).length;
          break;
        case "tool_result":
          if (block.content) {
            if (typeof block.content == "string") {
              lengthAcc += block.content.length;
            } else {
              let blockLength = 0;
              for (const blockContent of block.content) {
                switch (blockContent.type) {
                  case "text":
                    blockLength += blockContent.text.length;
                    break;
                  case "image": {
                    const source = blockContent.source;
                    blockLength +=
                      source.type == "base64"
                        ? source.data.length
                        : source.url.length;
                    break;
                  }
                }
              }

              lengthAcc += blockLength;
            }
          }
          break;
        case "document":
          if ("data" in block.source) {
            lengthAcc += block.source.data.length;
          }
      }

      blocks.push({ block, acc: lengthAcc });
    }
  }

  // estimating 4 characters per token.
  const tokens = Math.floor(lengthAcc / STR_CHARS_PER_TOKEN);

  // Anthropic allows for placing up to 4 cache control markers.
  // It will not cache anything less than 1024 tokens for sonnet 3.5
  // https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
  // this is pretty rough estimate, due to the conversion between string length and tokens.
  // however, since we are not accounting for tools or the system prompt, and generally code and technical writing
  // tend to have a lower coefficient of string length to tokens (about 3.5 average sting length per token), this means
  // that the first cache control should be past the 1024 mark and should be cached.
  const powers = highestPowersOfTwo(tokens, 4).filter((n) => n >= 1024);
  for (const power of powers) {
    const targetLength = power * STR_CHARS_PER_TOKEN; // power is in tokens, but we want string chars instead
    // find the first block where we are past the target power
    const blockEntry = blocks.find((b) => b.acc > targetLength);
    if (
      blockEntry &&
      blockEntry.block.type !== "thinking" &&
      blockEntry.block.type !== "redacted_thinking"
    ) {
      blockEntry.block.cache_control = { type: "ephemeral" };
    }
  }

  return powers.length;
}

const STR_CHARS_PER_TOKEN = 4;

export function highestPowersOfTwo(n: number, len: number): number[] {
  const result: number[] = [];
  let currentPower = Math.floor(Math.log2(n));

  while (result.length < len && currentPower >= 0) {
    const value = Math.pow(2, currentPower);
    if (value <= n) {
      result.push(value);
    }
    currentPower--;
  }
  return result;
}
