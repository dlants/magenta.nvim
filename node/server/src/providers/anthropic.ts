import { execSync } from "node:child_process";
import { userInfo } from "node:os";
import Anthropic from "@anthropic-ai/sdk";
import type { AnthropicAuth } from "../anthropic-auth.ts";
import type { AuthUI } from "../auth-ui.ts";
import type { Logger } from "../logger.ts";
import type {
  ToolRequest,
  ToolRequestId,
  ValidateInput,
} from "../tool-types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { extendError, type Result } from "../utils/result.ts";
import { withCacheControl } from "./anthropic-cache.ts";
import {
  AnthropicInferenceManager,
  isRetryableError,
} from "./anthropic-inference.ts";
import {
  CLAUDE_CODE_SPOOF_PROMPT,
  getMaxTokensForModel,
  resolveOutputConfig,
} from "./anthropic-models.ts";
import { isAuthError, type RefreshAuth } from "./auth-refresh.ts";
import { getRetryDelay, MAX_RETRY_DURATION } from "./inference-shared.ts";
import type {
  AgentInput,
  InferenceOptions,
  NativeInferenceManager,
  Provider,
  ProviderToolSpec,
  ProviderToolUseRequest,
  Usage,
} from "./provider-types.ts";

// Coalesces concurrent interactive OAuth flows across all provider instances
// that share the same auth object (e.g. the agent stream and the thread-title
// forceToolUse request). Without this, each would prompt the user separately.
const pendingOAuthFlows = new WeakMap<AnthropicAuth, Promise<void>>();

export class AnthropicProvider implements Provider {
  protected client: Anthropic;
  private authType: "key" | "max" | "keychain";
  private validateInput: ValidateInput;
  private auth: AnthropicAuth | undefined;
  protected isBedrock: boolean = false;
  protected refreshAuth: RefreshAuth | undefined;

  constructor(
    protected logger: Logger,
    private authUI: AuthUI | undefined,
    _validateInput: ValidateInput,
    anthropicAuth: AnthropicAuth | undefined,
    options?: {
      baseUrl?: string | undefined;
      apiKeyEnvVar?: string | undefined;
      authType?: "key" | "max" | "keychain" | undefined;
      disableParallelToolUseFlag?: boolean;
    },
  ) {
    this.validateInput = _validateInput;
    this.auth = anthropicAuth;
    this.authType = options?.authType || "key";
    this.includeWebSearch = !options?.baseUrl;

    if (this.authType === "max") {
      this.client = new Anthropic({
        apiKey: "dummy-key-for-oauth",
        baseURL: options?.baseUrl,
        fetch: this.createOAuthFetch(),
      });
    } else if (this.authType === "keychain") {
      const apiKey = loadApiKeyFromKeychain(logger);
      this.client = new Anthropic({
        apiKey,
        baseURL: options?.baseUrl,
      });
    } else {
      const apiKey = process.env[options?.apiKeyEnvVar || "ANTHROPIC_API_KEY"];

      this.client = new Anthropic({
        apiKey,
        baseURL: options?.baseUrl,
      });
    }
  }

  private disableParallelToolUseFlag = true;
  // web_search_20250305 is an Anthropic server tool with no input_schema.
  // Third-party Anthropic-compatible APIs (e.g. MiniMax) reject it, so only
  // enable web search when hitting the real Anthropic endpoint (no custom baseUrl).
  protected includeWebSearch: boolean;

  private createOAuthFetch() {
    return async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      await this.ensureValidToken();

      const accessToken = await this.auth!.getAccessToken();
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
      // biome-ignore lint/suspicious/noExplicitAny: necessary to cast headers to any to allow dynamic key deletion
      delete (headers as any)["x-api-key"];

      return fetch(input, {
        ...init,
        headers,
      });
    };
  }

  private async ensureValidToken(): Promise<void> {
    const isAuthenticated = await this.auth!.isAuthenticated();
    if (!isAuthenticated) {
      const auth = this.auth!;
      let pending = pendingOAuthFlows.get(auth);
      if (!pending) {
        pending = this.triggerOAuthFlow().finally(() => {
          pendingOAuthFlows.delete(auth);
        });
        pendingOAuthFlows.set(auth, pending);
      }
      await pending;
    }
  }

  private async triggerOAuthFlow(): Promise<void> {
    if (!this.authUI) {
      throw new Error(
        "OAuth authentication required but no AuthUI provided. Configure authType or provide an AuthUI implementation.",
      );
    }

    try {
      const { url, verifier } = await this.auth!.authorize();

      const code = await this.authUI.showOAuthFlow(url);

      const tokens = await this.auth!.exchange(code, verifier);
      await this.auth!.storeTokens(tokens);

      this.logger.info("OAuth authentication successful");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fullMessage = `OAuth authentication failed: ${message}`;
      this.authUI.showError(fullMessage);
      throw new Error(fullMessage);
    }
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
      effort?: "low" | "medium" | "high" | "xhigh" | "max";
    };
  }): ProviderToolUseRequest {
    const { model, input, spec, systemPrompt, disableCaching, thinking } =
      options;
    let aborted = false;

    // Convert input to native Anthropic content blocks
    // biome-ignore lint/suspicious/useIterableCallbackReturn: exhaustive switch with assertUnreachable handles all cases
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

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: userContent },
    ];

    // Build system prompt
    const baseSystemPrompt =
      systemPrompt || "You are a helpful coding assistant.";
    const systemBlocks: Anthropic.Messages.MessageStreamParams["system"] = [
      {
        type: "text" as const,
        text: baseSystemPrompt,
        cache_control: disableCaching ? null : { type: "ephemeral" },
      },
    ];

    if (this.authType === "max" || this.authType === "keychain") {
      systemBlocks.unshift({
        type: "text" as const,
        text: CLAUDE_CODE_SPOOF_PROMPT,
      });
    }

    let retryAbortController: AbortController | undefined;
    const streamParams: Anthropic.Messages.MessageStreamParams = {
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
        type: "tool" as const,
        name: spec.name,
        disable_parallel_tool_use: this.disableParallelToolUseFlag,
      },
    };

    const outputConfig = resolveOutputConfig(
      model,
      thinking,
      this.logger,
      this.isBedrock,
    );
    if (outputConfig) {
      streamParams.output_config = outputConfig;
    }
    let currentRequest = this.client.messages.stream(streamParams);

    const processResponse = (response: Anthropic.Message) => {
      if (response.stop_reason === "max_tokens") {
        throw new Error("Response exceeded max_tokens limit");
      }

      if (response.content.length !== 1) {
        throw new Error(
          `Expected a single response but got ${response.content.length}`,
        );
      }

      const contentBlock = response.content[0];

      const toolRequest = extendError(
        ((): Result<ToolRequest> => {
          if (contentBlock.type !== "tool_use") {
            throw new Error(
              `Expected a tool_use response but got ${response.type}`,
            );
          }

          if (typeof contentBlock !== "object" || contentBlock == null) {
            return { status: "error", error: "received a non-object" };
          }

          const name = (
            contentBlock as unknown as { [key: string]: unknown } | undefined
          )?.name;

          if (name !== spec.name) {
            return {
              status: "error",
              error: `expected contentBlock.name to be '${spec.name}'`,
            };
          }

          const req2 = contentBlock as unknown as { [key: string]: unknown };

          if (req2.type !== "tool_use") {
            return {
              status: "error",
              error: "expected contentBlock.type to be tool_use",
            };
          }

          if (typeof req2.id !== "string") {
            return {
              status: "error",
              error: "expected contentBlock.id to be a string",
            };
          }

          if (typeof req2.input !== "object" || req2.input == null) {
            return {
              status: "error",
              error: "expected contentBlock.input to be an object",
            };
          }

          const input = this.validateInput(
            spec.name,
            req2.input as { [key: string]: unknown },
          );

          if (input.status === "ok") {
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
      if (response.usage.cache_read_input_tokens != null) {
        usage.cacheHits = response.usage.cache_read_input_tokens;
      }
      if (response.usage.cache_creation_input_tokens != null) {
        usage.cacheMisses = response.usage.cache_creation_input_tokens;
      }

      return {
        toolRequest,
        stopReason: (response.stop_reason ||
          "end_turn") as import("./provider-types.ts").StopReason,
        usage,
      };
    };

    const promise = (async () => {
      const retryStart = Date.now();
      let attempt = 0;
      while (true) {
        try {
          const response: Anthropic.Message =
            await currentRequest.finalMessage();
          return processResponse(response);
        } catch (error) {
          if (aborted || !(error instanceof Error)) {
            throw error;
          }

          // Auth-error path: try to refresh credentials and retry immediately,
          // independent of the 429/529 retry budget. The 30s guard inside
          // refreshAuth prevents tight loops.
          if (this.refreshAuth && isAuthError(error)) {
            try {
              await this.refreshAuth();
              currentRequest = this.client.messages.stream(streamParams);
              continue;
            } catch (refreshErr) {
              const refreshMessage =
                refreshErr instanceof Error
                  ? refreshErr.message
                  : String(refreshErr);
              throw new Error(
                `Auth refresh failed: ${refreshMessage}. Original error: ${error.message}`,
              );
            }
          }

          if (
            !isRetryableError(error) ||
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
          currentRequest = this.client.messages.stream(streamParams);
        }
      }
    })();

    return {
      promise,
      aborted,
      abort: () => {
        aborted = true;
        if (retryAbortController) {
          retryAbortController.abort();
        }
        currentRequest.abort();
      },
    };
  }

  createInferenceManager(options: InferenceOptions): NativeInferenceManager {
    return new AnthropicInferenceManager(options, this.client, {
      authType: this.authType,
      includeWebSearch: this.includeWebSearch,
      disableParallelToolUseFlag: this.disableParallelToolUseFlag,
      logger: this.logger,
      validateInput: this.validateInput,
      bedrock: this.isBedrock,
      refreshAuth: this.refreshAuth,
    });
  }
}

function loadApiKeyFromKeychain(logger: Logger): string | undefined {
  if (process.platform !== "darwin") {
    logger.warn("Keychain auth is only supported on macOS");
    return undefined;
  }

  try {
    const username = userInfo().username;
    const apiKey = execSync(
      `security find-generic-password -s "Claude Code" -a "${username}" -w 2>/dev/null`,
      { encoding: "utf-8" },
    ).trim();

    if (apiKey?.startsWith("sk-ant-")) {
      logger.info("Loaded API key from macOS Keychain (Claude Code)");
      return apiKey;
    }

    logger.warn("Could not find Claude Code API key in macOS Keychain");
    return undefined;
  } catch (e) {
    logger.error(`Error loading from keychain: ${e as Error}`);
    return undefined;
  }
}
