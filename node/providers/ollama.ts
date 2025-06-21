import {
  type AbortableAsyncIterator,
  Ollama,
  type ChatRequest,
  type ChatResponse,
  type Message,
  type Tool,
  type ToolCall,
} from "ollama";

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
  ProviderTextContent,
} from "./provider-types.ts";
import type { Nvim } from "../nvim/nvim-node";
import {
  DEFAULT_SYSTEM_PROMPT,
  type SubagentSystemPrompt,
  getSubagentSystemPrompt,
} from "./system-prompt.ts";
import { validateInput } from "../tools/helpers.ts";
import type { Result } from "../utils/result.ts";
import type { ToolRequestId } from "../tools/toolManager.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { ToolRequest } from "../tools/types.ts";

export type OllamaOptions = {
  model: string;
};

export class OllamaProvider implements Provider {
  private client: Ollama;
  private model: string;

  constructor(
    private nvim: Nvim,
    options?: {
      baseUrl?: string | undefined;
      apiKeyEnvVar?: string | undefined;
    },
  ) {
    this.client = new Ollama({
      host: options?.baseUrl || "http://127.0.0.1:11434",
    });

    this.model = "llama3";
  }

  setModel(model: string): void {
    // It is possible to set the model to a model that is not downloaded or does not exist
    // Ollama itself returns an error if it can't find a model, so seperate checking here is not necessary
    this.model = model;
  }

  countTokens(
    messages: Array<ProviderMessage>,
    tools: Array<ProviderToolSpec>,
    options?: { systemPrompt?: SubagentSystemPrompt | undefined },
  ): number {
    const CHARS_PER_TOKEN = 4;
    let charCount = (
      options?.systemPrompt
        ? getSubagentSystemPrompt(options.systemPrompt)
        : DEFAULT_SYSTEM_PROMPT
    ).length;
    charCount += JSON.stringify(tools).length;
    charCount += JSON.stringify(messages).length;
    return Math.ceil(charCount / CHARS_PER_TOKEN);
  }

  createStreamParameters(
    messages: Array<ProviderMessage>,
    tools: Array<ProviderToolSpec>,
    options?: {
      disableCaching?: boolean;
      systemPrompt?: SubagentSystemPrompt | undefined;
    },
  ): ChatRequest & { stream: true } {
    const ollamaMessages: Message[] = [
      {
        role: "system",
        content: options?.systemPrompt
          ? getSubagentSystemPrompt(options.systemPrompt)
          : DEFAULT_SYSTEM_PROMPT,
      },
    ];

    for (const m of messages) {
      for (const content of m.content) {
        switch (content.type) {
          case "text":
            ollamaMessages.push({ role: m.role, content: content.text });
            break;

          case "tool_use": {
            let args: Record<string, unknown>;
            if (content.request.status === "ok") {
              args = content.request.value.input as Record<string, unknown>;
            } else {
              args = content.request.rawRequest as Record<string, unknown>;
            }

            const toolCall: ToolCall = {
              function: {
                name: content.name,
                arguments: args,
              },
            };

            ollamaMessages.push({
              role: "assistant",
              content: "",
              tool_calls: [toolCall],
            });
            break;
          }

          case "tool_result": {
            const result =
              content.result.status === "ok"
                ? content.result.value
                : content.result.error;

            ollamaMessages.push({
              role: "tool",
              content:
                typeof result === "string" ? result : JSON.stringify(result),
            });
            break;
          }

          case "server_tool_use":
            throw new Error("NOT IMPLEMENTED");

          case "web_search_tool_result":
            throw new Error("NOT IMPLEMENTED");

          case "image":
            throw new Error(
              "Image content is not supported by Ollama provider",
            );

          case "document":
            throw new Error(
              "Document content is not supported by Ollama provider",
            );

          default:
            assertUnreachable(content);
        }
      }
    }

    const ollamaTools = tools.map((s) => ({
      type: "function",
      function: {
        name: s.name,
        description: s.description,
        parameters: s.input_schema,
      },
    })) as Tool[];

    return {
      model: this.model,
      stream: true,
      messages: ollamaMessages,
      tools: ollamaTools,
    };
  }

  forceToolUse(
    messages: Array<ProviderMessage>,
    spec: ProviderToolSpec,
    options?: { systemPrompt?: SubagentSystemPrompt | undefined },
  ): ProviderToolUseRequest {
    let aborted = false;
    const promise = (async (): Promise<ProviderToolUseResponse> => {
      // Ollama doesn't support tool_choice (although it is in the roadmap)
      // For now, we can use structured outputs to simulate forced tool use
      const systemPrompt = options?.systemPrompt
        ? getSubagentSystemPrompt(options.systemPrompt)
        : DEFAULT_SYSTEM_PROMPT;

      const response = await this.client.chat({
        model: this.model,
        messages: [
          {
            role: "system",
            content: `${systemPrompt}\n\nYou must use the ${spec.name} tool. Respond only with the tool arguments.`,
          },
          ...messages.flatMap((message) =>
            message.content
              .filter(
                (content): content is ProviderTextContent =>
                  content.type === "text",
              )
              .map((content) => ({
                role: message.role,
                content: content.text,
              })),
          ),
        ],
        format: JSON.stringify(spec.input_schema),
        stream: false,
      });

      let toolRequest: Result<ToolRequest, { rawRequest: unknown }>;
      try {
        const args = JSON.parse(response.message.content) as Record<
          string,
          unknown
        >;

        const input = validateInput(spec.name, args);

        toolRequest =
          input.status === "ok"
            ? {
                status: "ok" as const,
                value: {
                  toolName: spec.name,
                  id: `tool-${Date.now()}` as ToolRequestId,
                  input: input.value,
                } as ToolRequest,
              }
            : { ...input, rawRequest: args };
      } catch (error) {
        toolRequest = {
          status: "error",
          error: (error as Error).message,
          rawRequest: response.message.content,
        };
      }

      const usage: Usage = {
        inputTokens: response.prompt_eval_count || 0,
        outputTokens: response.eval_count || 0,
      };

      if (aborted) {
        throw new Error("Aborted");
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
    options?: { systemPrompt?: SubagentSystemPrompt | undefined },
  ): ProviderStreamRequest {
    let request: AbortableAsyncIterator<ChatResponse>;
    let stopReason: StopReason | undefined;
    let usage: Usage | undefined;
    let currentContentBlockIndex = 0;

    const promise = (async (): Promise<{
      usage: Usage;
      stopReason: StopReason;
    }> => {
      request = await this.client.chat(
        this.createStreamParameters(messages, tools, {
          systemPrompt: options?.systemPrompt,
        }),
      );

      let blockStarted = false;

      onStreamEvent({
        type: "content_block_start",
        index: currentContentBlockIndex,
        content_block: {
          type: "text",
          text: "",
          citations: null,
        },
      });
      blockStarted = true;

      for await (const chunk of request) {
        this.nvim.logger?.info(`ollama chunk: ${JSON.stringify(chunk)}`);

        if (chunk.message?.content) {
          onStreamEvent({
            type: "content_block_delta",
            index: currentContentBlockIndex,
            delta: {
              type: "text_delta",
              text: chunk.message.content,
            },
          });
        }

        if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
          if (blockStarted) {
            onStreamEvent({
              type: "content_block_stop",
              index: currentContentBlockIndex,
            });
          }

          currentContentBlockIndex++;
          // Although we only access the first tool call, this is okay because Ollama sends the tool calls in seperate chunks in the stream
          // So no need to seperately iterate through tool_calls here
          const toolCall = chunk.message.tool_calls[0];
          stopReason = "tool_use";

          const toolId = `tool-${Date.now()}`;

          onStreamEvent({
            type: "content_block_start",
            index: currentContentBlockIndex,
            content_block: {
              type: "tool_use",
              id: toolId,
              name: toolCall.function.name,
              input: {},
            },
          });

          onStreamEvent({
            type: "content_block_delta",
            index: currentContentBlockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(toolCall.function.arguments),
            },
          });

          onStreamEvent({
            type: "content_block_stop",
            index: currentContentBlockIndex,
          });
          blockStarted = false;
        }

        if (chunk.done) {
          stopReason = stopReason || "end_turn";
          usage = {
            inputTokens: chunk.prompt_eval_count || 0,
            outputTokens: chunk.eval_count || 0,
          };
        }
      }

      if (blockStarted) {
        onStreamEvent({
          type: "content_block_stop",
          index: currentContentBlockIndex,
        });
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
        request?.abort();
      },
      promise,
    };
  }
}
