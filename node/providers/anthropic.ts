import Anthropic from "@anthropic-ai/sdk";
import * as ToolManager from "../tools/toolManager.ts";
import { extendError, type Result } from "../utils/result.ts";
import type { Nvim } from "nvim-node";
import {
  type StopReason,
  type Provider,
  type ProviderMessage,
  type Usage,
} from "./provider-types.ts";
import type { ToolRequestId } from "../tools/toolManager.ts";
import * as InlineEdit from "../inline-edit/inline-edit-tool.ts";
import * as ReplaceSelection from "../inline-edit/replace-selection-tool.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream.mjs";
import { DEFAULT_SYSTEM_PROMPT } from "./constants.ts";

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
  protected request: MessageStream | undefined;
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

  abort() {
    if (this.request) {
      this.request.abort();
      this.request = undefined;
    }
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
            case "text":
              // important to create a new object here so when we attach ephemeral
              // cache_control markers we won't mutate the content.
              return {
                ...c,
              };
            case "tool_use":
              return {
                id: c.request.id,
                input: c.request.input,
                name: c.request.toolName,
                type: "tool_use",
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

    const tools: Anthropic.Tool[] = ToolManager.TOOL_SPECS.map(
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
      tools,
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

  async inlineEdit(messages: Array<ProviderMessage>): Promise<{
    inlineEdit: Result<
      InlineEdit.InlineEditToolRequest,
      { rawRequest: unknown }
    >;
    stopReason: StopReason;
    usage: Usage;
  }> {
    try {
      this.request = this.client.messages.stream({
        ...this.createStreamParameters(messages),
        tools: [
          {
            ...InlineEdit.spec,
            input_schema: InlineEdit.spec
              .input_schema as Anthropic.Messages.Tool.InputSchema,
          },
        ],
        tool_choice: {
          type: "tool",
          name: InlineEdit.spec.name,
          disable_parallel_tool_use:
            this.disableParallelToolUseFlag || undefined,
        },
      } as Anthropic.Messages.MessageStreamParams);

      const response: Anthropic.Message = await this.request.finalMessage();

      if (response.stop_reason === "max_tokens") {
        throw new Error("Response exceeded max_tokens limit");
      }

      if (response.content.length != 1) {
        throw new Error(
          `Expected a single response but got ${response.content.length}`,
        );
      }

      const contentBlock = response.content[0];

      const inlineEdit: Result<
        InlineEdit.InlineEditToolRequest,
        { rawRequest: unknown }
      > = extendError(
        ((): Result<InlineEdit.InlineEditToolRequest> => {
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

          if (name != "inline-edit") {
            return {
              status: "error",
              error: "expected contentBlock.name to be 'inline-edit'",
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

          const input = InlineEdit.validateInput(
            req2.input as { [key: string]: unknown },
          );

          if (input.status == "ok") {
            return {
              status: "ok",
              value: {
                name: "inline-edit",
                id: req2.id as unknown as ToolRequestId,
                input: input.value,
              },
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
        inlineEdit,
        stopReason: response.stop_reason || "end_turn",
        usage,
      };
    } finally {
      this.request = undefined;
    }
  }

  async replaceSelection(messages: Array<ProviderMessage>): Promise<{
    replaceSelection: Result<
      ReplaceSelection.ReplaceSelectionToolRequest,
      { rawRequest: unknown }
    >;
    stopReason: StopReason;
    usage: Usage;
  }> {
    try {
      this.request = this.client.messages.stream({
        ...this.createStreamParameters(messages),
        tools: [
          {
            ...ReplaceSelection.spec,
            input_schema: ReplaceSelection.spec
              .input_schema as Anthropic.Messages.Tool.InputSchema,
          },
        ],
        tool_choice: {
          type: "tool",
          name: ReplaceSelection.spec.name,
          disable_parallel_tool_use:
            this.disableParallelToolUseFlag || undefined,
        },
      } as Anthropic.Messages.MessageStreamParams);

      const response: Anthropic.Message = await this.request.finalMessage();

      if (response.stop_reason === "max_tokens") {
        throw new Error("Response exceeded max_tokens limit");
      }

      if (response.content.length != 1) {
        throw new Error(
          `Expected a single response but got ${response.content.length}`,
        );
      }

      const contentBlock = response.content[0];

      const replaceSelection: Result<
        ReplaceSelection.ReplaceSelectionToolRequest,
        { rawRequest: unknown }
      > = extendError(
        ((): Result<ReplaceSelection.ReplaceSelectionToolRequest> => {
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

          if (name != ReplaceSelection.spec.name) {
            return {
              status: "error",
              error: `expected contentBlock.name to be ${ReplaceSelection.spec.name}`,
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

          const input = ReplaceSelection.validateInput(
            req2.input as { [key: string]: unknown },
          );

          if (input.status == "ok") {
            return {
              status: "ok",
              value: {
                name: "replace-selection",
                id: req2.id as unknown as ToolRequestId,
                input: input.value,
              },
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
        replaceSelection,
        stopReason: response.stop_reason || "end_turn",
        usage,
      };
    } finally {
      this.request = undefined;
    }
  }

  async sendMessage(
    messages: Array<ProviderMessage>,
    onText: (text: string) => void,
  ): Promise<{
    toolRequests: Result<ToolManager.ToolRequest, { rawRequest: unknown }>[];
    stopReason: StopReason;
    usage: Usage;
  }> {
    const buf: string[] = [];
    let flushInProgress: boolean = false;

    const flushBuffer = () => {
      if (buf.length && !flushInProgress) {
        const text = buf.join("");
        buf.splice(0);

        flushInProgress = true;

        try {
          onText(text);
        } finally {
          flushInProgress = false;
          setInterval(flushBuffer, 1);
        }
      }
    };

    let requestActive = true;
    try {
      this.request = this.client.messages
        .stream(
          this.createStreamParameters(
            messages,
          ) as Anthropic.Messages.MessageStreamParams,
        )
        .on("text", (text: string) => {
          if (!requestActive) {
            return;
          }
          buf.push(text);
          flushBuffer();
        })
        .on("inputJson", (_delta, snapshot) => {
          if (!requestActive) {
            return;
          }
          this.nvim.logger?.debug(
            `anthropic stream inputJson: ${JSON.stringify(snapshot)}`,
          );
        });

      const response: Anthropic.Message = await this.request.finalMessage();

      if (response.stop_reason === "max_tokens") {
        throw new Error("Response exceeded max_tokens limit");
      }

      const toolRequests: Result<
        ToolManager.ToolRequest,
        { rawRequest: unknown }
      >[] = response.content
        .filter((req) => req.type == "tool_use")
        .map((req) => {
          const result = ((): Result<ToolManager.ToolRequest> => {
            if (typeof req != "object" || req == null) {
              return { status: "error", error: "received a non-object" };
            }

            const name = (
              req as unknown as { [key: string]: unknown } | undefined
            )?.["name"];

            if (typeof req.name != "string") {
              return {
                status: "error",
                error: "expected req.name to be string",
              };
            }

            const req2 = req as unknown as { [key: string]: unknown };

            if (req2.type != "tool_use") {
              return {
                status: "error",
                error: "expected req.type to be tool_use",
              };
            }

            if (typeof req2.id != "string") {
              return {
                status: "error",
                error: "expected req.id to be a string",
              };
            }

            if (typeof req2.input != "object" || req2.input == null) {
              return {
                status: "error",
                error: "expected req.input to be an object",
              };
            }

            const input = ToolManager.validateToolInput(
              name,
              req2.input as { [key: string]: unknown },
            );

            if (input.status == "ok") {
              return {
                status: "ok",
                value: {
                  toolName: name,
                  id: req2.id,
                  input: input.value,
                } as ToolManager.ToolRequest,
              };
            } else {
              return input;
            }
          })();

          return extendError(result, { rawRequest: req });
        });

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

      if (!requestActive) {
        throw new Error(`request no longer active`);
      }

      return {
        toolRequests,
        stopReason: response.stop_reason || "end_turn",
        usage,
      };
    } finally {
      requestActive = false;
      if (this.request) {
        this.request.abort();
      }
      this.request = undefined;
    }
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
        case "image":
          lengthAcc += block.source.data.length;
          break;
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
                  case "image":
                    blockLength += blockContent.source.data.length;
                    break;
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
