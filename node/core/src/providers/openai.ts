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
  type Provider,
  type ProviderToolSpec,
  type ProviderToolUseRequest,
  type ProviderToolUseResponse,
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
// AgentInput -> Responses input items
// ---------------------------------------------------------------------------

/** The one-shot conversion of caller-supplied content into wire items. Used by
 * `appendUserMessage` and `forceToolUse`; nothing converts a `ProviderMessage`
 * back into an item, by design. */
export function convertInputToNativeItems(
  content: ReadonlyArray<AgentInput>,
): OpenAI.Responses.ResponseInputItem[] {
  const parts: OpenAI.Responses.ResponseInputContent[] = [];
  for (const item of content) {
    switch (item.type) {
      case "text":
        if (!item.text.trim()) break;
        parts.push({ type: "input_text", text: item.text });
        break;
      case "image":
        parts.push({
          type: "input_image",
          detail: "auto",
          image_url: `data:${item.source.media_type};base64,${item.source.data}`,
        });
        break;
      case "document":
        parts.push({
          type: "input_file",
          filename: item.title || "untitled.pdf",
          file_data: `data:${item.source.media_type};base64,${item.source.data}`,
        });
        break;
      default:
        assertUnreachable(item);
    }
  }
  return parts.length
    ? [{ type: "message", role: "user", content: parts }]
    : [];
}

export type CreateStreamParametersOptions = {
  model: string;
  input: OpenAI.Responses.ResponseInputItem[];
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
  input,
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
    input,
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

/** The installed SDK (5.23.2) omits `action` from `ResponseFunctionWebSearch`,
 * though the API sends it. This is the only place that payload is narrowed. */
type WebSearchAction =
  | OpenAI.Responses.ResponseFunctionWebSearch.Search
  | OpenAI.Responses.ResponseFunctionWebSearch.OpenPage
  | OpenAI.Responses.ResponseFunctionWebSearch.Find;

export function webSearchQuery(item: {
  type: "web_search_call";
  action?: WebSearchAction | undefined;
}): string | undefined {
  const { action } = item;
  return action?.type === "search" ? action.query : undefined;
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

    const streamParams = createStreamParameters({
      model,
      input: convertInputToNativeItems(input),
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
