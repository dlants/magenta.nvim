import Anthropic from "@anthropic-ai/sdk";
import { extendError, type Result } from "../utils/result.ts";
import type { ToolRequestId } from "../tools/toolManager.ts";
import type { Logger } from "../logger.ts";
import type {
  Provider,
  ProviderMessage,
  Usage,
  ProviderToolSpec,
  ProviderToolUseRequest,
  ProviderTextContent,
  Agent,
  AgentOptions,
  AgentInput,
  AgentMsg,
} from "./provider-types.ts";
import type { Dispatch } from "../tea/tea.ts";
import {
  AnthropicAgent,
  CLAUDE_CODE_SPOOF_PROMPT,
  getMaxTokensForModel,
  withCacheControl,
} from "./anthropic-agent.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.ts";
import { validateInput } from "../tools/helpers.ts";
import type { ToolRequest } from "../tools/types.ts";
import * as AnthropicAuth from "../auth/anthropic.ts";
import open from "open";

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
  private authType: "key" | "max";
  private oauthFlowHandler: ((authUrl: string) => Promise<string>) | undefined;

  constructor(
    protected logger: Logger,
    options?: {
      baseUrl?: string | undefined;
      apiKeyEnvVar?: string | undefined;
      authType?: "key" | "max" | undefined;
      disableParallelToolUseFlag?: boolean;
      showOAuthFlow?: (authUrl: string) => Promise<string>;
    },
  ) {
    this.authType = options?.authType || "key";
    this.oauthFlowHandler = options?.showOAuthFlow;

    if (this.authType === "max") {
      this.client = new Anthropic({
        apiKey: "dummy-key-for-oauth",
        baseURL: options?.baseUrl,
        fetch: this.createOAuthFetch(),
      });
    } else {
      const apiKeyEnvVar = options?.apiKeyEnvVar || "ANTHROPIC_API_KEY";
      const apiKey = process.env[apiKeyEnvVar];

      this.client = new Anthropic({
        apiKey,
        baseURL: options?.baseUrl,
      });
    }
  }

  private disableParallelToolUseFlag = true;
  protected includeWebSearch = true;

  private createOAuthFetch() {
    return async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      await this.ensureValidToken();

      const accessToken = await AnthropicAuth.getAccessToken();
      if (!accessToken) {
        throw new Error("Failed to get valid OAuth access token");
      }

      const headers = {
        ...(init?.headers || {}),
        authorization: `Bearer ${accessToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta":
          "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
      };

      // Remove x-api-key header if present
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      delete (headers as any)["x-api-key"];

      return fetch(input, {
        ...init,
        headers,
      });
    };
  }

  private async ensureValidToken(): Promise<void> {
    const isAuthenticated = await AnthropicAuth.isAuthenticated();
    if (!isAuthenticated) {
      await this.triggerOAuthFlow();
    }
  }

  private async triggerOAuthFlow(): Promise<void> {
    try {
      const { url, verifier } = await AnthropicAuth.authorize();

      // Show OAuth flow instructions in a floating window and get the auth code
      const code = await this.requestOAuthCode(url);

      // Exchange code for tokens
      const tokens = await AnthropicAuth.exchange(code, verifier);
      await AnthropicAuth.storeTokens(tokens);

      this.logger.info("OAuth authentication successful");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`OAuth authentication failed: ${message}`);
    }
  }

  private async requestOAuthCode(authUrl: string): Promise<string> {
    try {
      await open(authUrl);
    } catch {
      this.logger.warn(
        "Could not automatically open browser, please open URL manually",
      );
    }

    if (!this.oauthFlowHandler) {
      throw new Error(
        "OAuth authentication required but no OAuth flow handler was provided. " +
          "The control plane must provide a showOAuthFlow callback.",
      );
    }

    return this.oauthFlowHandler(authUrl);
  }

  createStreamParameters({
    model,
    messages,
    tools,
    disableCaching,
    systemPrompt,
    thinking,
  }: {
    model: string;
    messages: ProviderMessage[];
    tools: Array<ProviderToolSpec>;
    disableCaching?: boolean | undefined;
    systemPrompt?: string | undefined;
    thinking?: {
      enabled: boolean;
      budgetTokens?: number;
    };
  }): MessageStreamParams {
    let anthropicMessages = messages.map((m): Anthropic.MessageParam => {
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
                // Collect all contents into one array
                const allContents: Array<
                  | Anthropic.Messages.TextBlockParam
                  | Anthropic.Messages.ImageBlockParam
                > = [];
                let hasDocument = false;

                for (const resultContent of c.result.value) {
                  switch (resultContent.type) {
                    case "text":
                      allContents.push(
                        mapProviderTextToAnthropicText(resultContent),
                      );
                      break;
                    case "image":
                      allContents.push(resultContent);
                      break;
                    case "document":
                      hasDocument = true;
                      // Documents need special handling, so don't add them to the array yet
                      break;
                    default:
                      assertUnreachable(resultContent);
                  }
                }

                // If no documents are included, create a single tool_result block
                if (!hasDocument) {
                  content.push({
                    tool_use_id: c.id,
                    type: "tool_result",
                    content: allContents,
                    is_error: false,
                  });
                } else {
                  // If documents are included, maintain the special processing for them
                  // Documents require special handling
                  for (const resultContent of c.result.value) {
                    if (resultContent.type === "document") {
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
                    }
                  }

                  // If there are text and images, put them in a separate tool_result block
                  if (allContents.length > 0) {
                    content.push({
                      tool_use_id: c.id,
                      type: "tool_result",
                      content: allContents,
                      is_error: false,
                    });
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

            case "thinking":
              content.push({
                type: "thinking",
                thinking: c.thinking,
                signature: c.signature,
              });
              break;

            case "redacted_thinking":
              content.push({
                type: "redacted_thinking",
                data: c.data,
              });
              break;

            case "system_reminder":
              content.push({
                type: "text",
                text: c.text,
              });
              break;

            case "context_update":
              content.push({
                type: "text",
                text: c.text,
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

    if (!disableCaching) {
      anthropicMessages = withCacheControl(anthropicMessages);
    }

    const anthropicTools: Anthropic.Tool[] = tools.map((t): Anthropic.Tool => {
      return {
        ...t,
        input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
      };
    });

    // Build system prompt, prepending Claude Code spoofing for Max auth
    const baseSystemPrompt = systemPrompt
      ? systemPrompt
      : DEFAULT_SYSTEM_PROMPT;

    const systemBlocks: MessageStreamParams["system"] = [
      {
        type: "text" as const,
        text: baseSystemPrompt,
        // the prompt appears in the following order:
        // tools
        // system
        // messages
        // This ensures the tools + system prompt (which is approx 1400 tokens) is cached.
        cache_control: disableCaching ? null : { type: "ephemeral" },
      },
    ];

    if (this.authType === "max") {
      systemBlocks.unshift({
        type: "text" as const,
        text: CLAUDE_CODE_SPOOF_PROMPT,
      });
    }

    const builtInTools: Anthropic.Messages.Tool[] = [];
    if (this.includeWebSearch) {
      builtInTools.push({
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 5,
      } as unknown as Anthropic.Messages.Tool);
    }

    const params: MessageStreamParams = {
      messages: anthropicMessages,
      model: model,
      max_tokens: getMaxTokensForModel(model),
      system: systemBlocks,
      tool_choice: {
        type: "auto",
        disable_parallel_tool_use: this.disableParallelToolUseFlag || undefined,
      },
      tools: [...anthropicTools, ...builtInTools],
    };

    // Add thinking configuration if enabled
    if (thinking?.enabled) {
      params.thinking = {
        type: "enabled",
        budget_tokens: thinking.budgetTokens || 1024,
      };
    }

    return params;
  }

  forceToolUse(options: {
    model: string;
    input: AgentInput[];
    spec: ProviderToolSpec;
    systemPrompt?: string;
    disableCaching?: boolean;
    contextAgent?: Agent;
  }): ProviderToolUseRequest {
    const { model, input, spec, systemPrompt, disableCaching, contextAgent } =
      options;
    let aborted = false;

    // Convert input to native Anthropic content blocks
    const userContent: Anthropic.Messages.ContentBlockParam[] = input.map(
      (c): Anthropic.Messages.ContentBlockParam => {
        switch (c.type) {
          case "text":
            return { type: "text", text: c.text, citations: null };
          case "image":
            return { type: "image", source: c.source };
          case "document":
            return {
              type: "document",
              source: c.source,
              title: c.title || null,
            };
          default:
            assertUnreachable(c);
        }
      },
    );

    // Extract native messages from context agent if provided
    let contextMessages: Anthropic.MessageParam[] = [];
    if (contextAgent && contextAgent instanceof AnthropicAgent) {
      contextMessages = contextAgent.getNativeMessages();
    }

    // Build messages: optional context + new user message
    const messages: Anthropic.MessageParam[] = [
      ...contextMessages,
      { role: "user", content: userContent },
    ];

    // Build system prompt
    const baseSystemPrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
    const systemBlocks: Anthropic.Messages.MessageStreamParams["system"] = [
      {
        type: "text" as const,
        text: baseSystemPrompt,
        cache_control: disableCaching ? null : { type: "ephemeral" },
      },
    ];

    if (this.authType === "max") {
      systemBlocks.unshift({
        type: "text" as const,
        text: CLAUDE_CODE_SPOOF_PROMPT,
      });
    }

    const request = this.client.messages.stream({
      model,
      max_tokens: getMaxTokensForModel(model),
      system: systemBlocks,
      messages: disableCaching ? messages : withCacheControl(messages),
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
        disable_parallel_tool_use: this.disableParallelToolUseFlag,
      },
    });

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
      aborted,
      abort: () => {
        aborted = true;
        request.abort();
      },
    };
  }

  createAgent(options: AgentOptions, dispatch: Dispatch<AgentMsg>): Agent {
    return new AnthropicAgent(options, this.client, dispatch, {
      authType: this.authType,
      includeWebSearch: this.includeWebSearch,
      disableParallelToolUseFlag: this.disableParallelToolUseFlag,
    });
  }
}
