import OpenAI from "openai";
import { type Result } from "../utils/result.ts";
import type { ToolRequest, ToolRequestId } from "../tools/toolManager.ts";
import type {
  StopReason,
  Provider,
  ProviderMessage,
  Usage,
  ProviderStreamRequest,
  ProviderToolSpec,
  ProviderStreamEvent,
  ProviderToolUseRequest,
  ProviderToolUseResponse,
} from "./provider-types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { Stream } from "openai/streaming.mjs";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.ts";
import { validateInput } from "../tools/helpers.ts";

export type OpenAIOptions = {
  model: "gpt-4o";
};

export class OpenAIProvider implements Provider {
  private client: OpenAI;
  private model: string;

  constructor(
    private nvim: Nvim,
    options?: {
      baseUrl?: string | undefined;
      apiKeyEnvVar?: string | undefined;
    },
  ) {
    const apiKeyEnvVar = options?.apiKeyEnvVar || "OPENAI_API_KEY";
    const apiKey = process.env[apiKeyEnvVar];

    if (!apiKey) {
      throw new Error(`${apiKeyEnvVar} not found in environment`);
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: options?.baseUrl || process.env.OPENAI_BASE_URL,
    });

    this.model = "gpt-4o";
  }

  setModel(model: string): void {
    this.model = model;
  }

  countTokens(
    messages: Array<ProviderMessage>,
    tools: Array<ProviderToolSpec>,
  ): number {
    const CHARS_PER_TOKEN = 4;
    let charCount = DEFAULT_SYSTEM_PROMPT.length;
    charCount += JSON.stringify(tools).length;
    charCount += JSON.stringify(messages).length;
    return Math.ceil(charCount / CHARS_PER_TOKEN);
  }

  createStreamParameters(
    messages: Array<ProviderMessage>,
    tools: Array<ProviderToolSpec>,
    _options?: { disableCaching?: boolean },
  ): OpenAI.Responses.ResponseCreateParamsStreaming {
    const openaiMessages: OpenAI.Responses.ResponseInputItem[] = [
      {
        role: "system",
        content: DEFAULT_SYSTEM_PROMPT,
      },
    ];

    for (const m of messages) {
      for (const content of m.content) {
        switch (content.type) {
          case "text":
            openaiMessages.push({
              role: m.role,
              content: content.text,
            });
            break;
          case "tool_use":
            openaiMessages.push(
              content.request.status == "ok"
                ? {
                    type: "function_call",
                    call_id: content.id,
                    name: content.name,
                    arguments: JSON.stringify(content.request.value.input),
                  }
                : {
                    type: "function_call",
                    call_id: content.id,
                    name: content.name,
                    arguments: JSON.stringify(content.request.rawRequest),
                  },
            );
            break;
          case "tool_result":
            openaiMessages.push({
              type: "function_call_output",
              call_id: content.id,
              output:
                content.result.status == "ok"
                  ? content.result.value
                  : content.result.error,
            });
            break;
          case "server_tool_use":
            throw new Error("NOT IMPLEMENTED");

          case "web_search_tool_result":
            throw new Error("NOT IMPLEMENTED");

          default:
            assertUnreachable(content);
        }
      }
    }

    return {
      model: this.model,
      stream: true,
      input: openaiMessages,
      // see https://platform.openai.com/docs/guides/function-calling#parallel-function-calling-and-structured-outputs
      // this recommends disabling parallel tool calls when strict adherence to schema is needed
      parallel_tool_calls: false,
      tools: tools.map((s): OpenAI.Responses.Tool => {
        return {
          type: "function",
          name: s.name,
          description: s.description,
          strict: true,
          parameters: s.input_schema as OpenAI.FunctionParameters,
        };
      }),
    };
  }

  forceToolUse(
    messages: Array<ProviderMessage>,
    spec: ProviderToolSpec,
  ): ProviderToolUseRequest {
    let aborted = false;
    const promise = (async (): Promise<ProviderToolUseResponse> => {
      const params = this.createStreamParameters(messages, [spec]);
      const response = await this.client.responses.create({
        ...params,
        tool_choice: "required",
        stream: false,
        tools: [
          {
            type: "function",
            name: spec.name,
            description: spec.description,
            strict: true,
            parameters: spec.input_schema as OpenAI.FunctionParameters,
          },
        ],
      });

      const tool = response.output[0];
      let toolRequest: Result<ToolRequest, { rawRequest: unknown }>;
      try {
        if (!(tool && tool.type == "function_call")) {
          throw new Error(
            `Failed to respond with tool call of type 'function'.`,
          );
        }
        if (tool.name !== spec.name) {
          throw new Error(`expected tool name to be '${spec.name}'`);
        }

        const input = validateInput(
          spec.name,
          JSON.parse(tool.arguments || "{}") as { [key: string]: unknown },
        );

        toolRequest =
          input.status === "ok"
            ? {
                status: "ok" as const,
                value: {
                  toolName: tool.name,
                  id: tool.call_id as unknown as ToolRequestId,
                  input: input.value,
                } as ToolRequest,
              }
            : { ...input, rawRequest: tool.arguments };
      } catch (error) {
        toolRequest = {
          status: "error",
          error: (error as Error).message,
          rawRequest: tool,
        };
      }

      const usage: Usage = response.usage
        ? {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          }
        : {
            inputTokens: 0,
            outputTokens: 0,
          };

      if (aborted) {
        throw new Error(`Aborted`);
      }

      return {
        toolRequest,
        stopReason: "tool_use" as const,
        usage,
      };
    })();

    return {
      abort: () => {
        aborted = true;
      },
      promise,
    };
  }

  sendMessage(
    messages: Array<ProviderMessage>,
    onStreamEvent: (event: ProviderStreamEvent) => void,
    tools: Array<ProviderToolSpec>,
  ): ProviderStreamRequest {
    let request: Stream<OpenAI.Responses.ResponseStreamEvent>;
    let stopReason: StopReason | undefined;
    let usage: Usage | undefined;

    const promise = (async (): Promise<{
      usage: Usage;
      stopReason: StopReason;
    }> => {
      request = await this.client.responses.create(
        this.createStreamParameters(messages, tools),
      );

      for await (const event of request) {
        this.nvim.logger?.info(`event.type: ${event.type}`);
        switch (event.type) {
          case "response.output_item.added":
            switch (event.item.type) {
              case "message":
                onStreamEvent({
                  type: "content_block_start",
                  index: event.output_index,
                  content_block: {
                    type: "text",
                    text: "",
                    citations: null,
                  },
                });
                break;
              case "function_call":
                onStreamEvent({
                  type: "content_block_start",
                  index: event.output_index,
                  content_block: {
                    type: "tool_use",
                    id: event.item.call_id,
                    name: event.item.name,
                    input: {},
                  },
                });
                break;
              default:
                throw new Error(
                  `output_item.added ${event.item.type} not implemented`,
                );
            }
            break;

          case "response.output_text.delta":
            onStreamEvent({
              type: "content_block_delta",
              index: event.output_index,
              delta: {
                type: "text_delta",
                text: event.delta,
              },
            });
            break;

          case "response.function_call_arguments.delta":
            onStreamEvent({
              type: "content_block_delta",
              index: event.output_index,
              delta: {
                type: "input_json_delta",
                partial_json: event.delta,
              },
            });
            break;

          case "response.output_item.done":
            if (event.item.type === "function_call") {
              stopReason = "tool_use";
            }
            onStreamEvent({
              type: "content_block_stop",
              index: event.output_index,
            });
            break;

          case "response.completed":
            stopReason = "end_turn";
            usage = event.response.usage && {
              inputTokens: event.response.usage.input_tokens,
              outputTokens: event.response.usage.output_tokens,
            };
            break;
        }
      }

      return {
        stopReason: stopReason || "end_turn",
        usage: usage || {
          inputTokens: 0,
          outputTokens: 0,
        },
      };
    })();

    return {
      abort: () => {
        request?.controller.abort();
      },
      promise,
    };
  }
}
