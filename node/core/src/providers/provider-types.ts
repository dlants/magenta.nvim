import type Anthropic from "@anthropic-ai/sdk";
import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import type * as ToolManager from "../tool-types.ts";
import type { ToolName, ToolRequest } from "../tool-types.ts";
import type { Result } from "../utils/result.ts";

export const PROVIDER_NAMES = [
  "anthropic",
  "openai",
  "bedrock",
  "ollama",
  "copilot",
  "mock",
] as const;
export type { ProviderName } from "../provider-options.ts";

import type {
  ProviderName,
  ReasoningEffort,
  ReasoningSummary,
} from "../provider-options.ts";

export type ProviderSetting = {
  provider: ProviderName;
  model: string;
  baseUrl?: string;
  apiKeyEnvVar?: string;
  promptCaching?: boolean;
};

/** What the provider said when it ended a response. `tool_use` is deliberately
 * absent: it is consumed by the agent's turn loop and never surfaces as a turn
 * outcome. So is `aborted`, which was never the provider's word to begin with —
 * see `TurnResult`. */
export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "pause_turn"
  | "content"
  | "refusal"
  | "model_context_window_exceeded"
  | "stop_sequence";

/** What a single provider stream can terminate with. Internal to the agent's
 * loop, plus the per-message record in `ProviderMessage.stopReason`. */
export type StreamStopReason = StopReason | "tool_use";

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheHits?: number;
  cacheMisses?: number;
};

export type ProviderMessage = {
  role: "user" | "assistant";
  content: Array<ProviderMessageContent>;
  /** Absent when the message was never finished — an aborted assistant turn
   * has no provider-reported stop reason. */
  stopReason?: StreamStopReason;
  usage?: Usage;
};

export type ProviderWebSearchCitation = {
  cited_text: string;
  encrypted_index: string;
  title: string;
  type: "web_search_citation";
  url: string;
};

export type ProviderTextContent = {
  type: "text";
  text: string;
  citations?: ProviderWebSearchCitation[] | undefined;
  providerMetadata?: ProviderMetadata | undefined;
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderThinkingContent = {
  type: "thinking";
  thinking: string;
  /** Anthropic's thinking signature, or OpenAI's `encrypted_content`. Absent
   * when the provider did not supply one. */
  signature?: string | undefined;
  providerMetadata?: ProviderMetadata | undefined;
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderRedactedThinkingContent = {
  type: "redacted_thinking";
  data: string;
  providerMetadata?: ProviderMetadata | undefined;
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderSystemReminderContent = {
  type: "system_reminder";
  text: string;
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderSystemInfoContent = {
  type: "system_info";
  text: string;
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderContextUpdateContent = {
  type: "context_update";
  text: string;
  nativeMessageIdx: NativeMessageIdx;
};

/** Like `context_update`, this is only ever *constructed* by
 * `classifyTextContent`: the block leaves as plain text (the wire format has
 * nothing else), and is re-tagged on the way back into `ProviderMessage[]` so
 * the view can suppress it rather than render it verbatim. */
export type ProviderCommentUpdateContent = {
  type: "comment_update";
  text: string;
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderForkNotificationContent = {
  type: "fork_notification";
  text: string;
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderImageContent = {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    data: string;
  };
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderDocumentContent = {
  type: "document";
  source: {
    type: "base64";
    media_type: "application/pdf";
    data: string;
  };
  title?: string | null;
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderToolUseContent = {
  type: "tool_use";
  id: ToolManager.ToolRequestId;
  name: ToolName;
  request: Result<ToolRequest, { rawRequest: unknown }>;
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderServerToolUseContent = {
  type: "server_tool_use";
  id: string;
  name: "web_search";
  input: {
    query: string;
  };
  providerMetadata?: ProviderMetadata | undefined;
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderWebSearchToolResult = {
  type: "web_search_tool_result";
  tool_use_id: string;
  content: Anthropic.WebSearchToolResultBlockContent;
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderToolResultContent =
  | ProviderTextContent
  | ProviderImageContent
  | ProviderDocumentContent;

export type ProviderToolResult = {
  type: "tool_result";
  id: ToolManager.ToolRequestId;
  result:
    | {
        status: "ok";
        value: ProviderToolResultContent[];
        structuredResult: ToolManager.ToolStructuredResult;
      }
    | { status: "error"; error: string };
  nativeMessageIdx: NativeMessageIdx;
};

export type ProviderToolSpec = {
  name: ToolName;
  description: string;
  input_schema: JSONSchemaType;
};

export type ProviderMessageContent =
  | ProviderTextContent
  | ProviderImageContent
  | ProviderDocumentContent
  | ProviderToolUseContent
  | ProviderServerToolUseContent
  | ProviderWebSearchToolResult
  | ProviderToolResult
  | ProviderThinkingContent
  | ProviderRedactedThinkingContent
  | ProviderSystemReminderContent
  | ProviderSystemInfoContent
  | ProviderContextUpdateContent
  | ProviderCommentUpdateContent
  | ProviderForkNotificationContent;

export interface Provider {
  forceToolUse(options: {
    model: string;
    input: AgentInput[];
    spec: ProviderToolSpec;
    systemPrompt?: string;
    disableCaching?: boolean;
    contextAgent?: Runner;
    thinking?: {
      enabled: boolean;
      budgetTokens?: number;
      displayThinking?: boolean;
      effort?: "low" | "medium" | "high" | "xhigh" | "max";
    };
  }): ProviderToolUseRequest;

  createAgent(options: AgentOptions): Runner;
}

/** Presence of this value implies a usable provider-native item id; there is
 * no encoding for "present but empty". */
export type ProviderMetadata = { provider: "openai"; itemId: string };

/** OpenAI's function calls carry no Anthropic `caller`, so they cannot be
 * expressed as `Anthropic.ToolUseBlock`. The start event's block is therefore
 * a provider-agnostic union rather than the Anthropic one alone. */
export type ProviderToolUseBlockStart = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};
export type ProviderServerToolUseBlockStart = {
  type: "server_tool_use";
  id: string;
  name: "web_search";
  input: unknown;
};
export type ProviderContentBlockStart =
  | Anthropic.RawContentBlockStartEvent["content_block"]
  | ProviderToolUseBlockStart
  | ProviderServerToolUseBlockStart;
export type ProviderBlockStartEvent = {
  type: "content_block_start";
  index: number;
  content_block: ProviderContentBlockStart;
  providerMetadata?: ProviderMetadata;
};

export type ProviderBlockDeltaEvent = Anthropic.RawContentBlockDeltaEvent;

export type ProviderBlockStopEvent = Anthropic.RawContentBlockStopEvent;

export type ProviderStreamEvent =
  | ProviderBlockStartEvent
  | ProviderBlockDeltaEvent
  | ProviderBlockStopEvent;

export interface ProviderStreamRequest {
  abort(): void;
  aborted: boolean;
  promise: Promise<{
    stopReason: StreamStopReason;
    usage: Usage;
  }>;
}

export type ProviderToolUseResponse = {
  toolRequest: Result<ToolRequest, { rawRequest: unknown }>;
  stopReason: StreamStopReason;
  usage: Usage;
};

export interface ProviderToolUseRequest {
  abort(): void;
  aborted: boolean;
  promise: Promise<ProviderToolUseResponse>;
}

// ============================================================================
// Runner - Stateful conversation agent interface
// ============================================================================

export type RetryStatus = {
  attempt: number;
  nextRetryAt: Date;
  error: Error;
};

/** Branded type for native message index within an Runner.
 * This is opaque to external code - only the Runner knows how to use it.
 */
export type NativeMessageIdx = number & { __nativeMessageIdx: true };

/** Placeholder used when constructing content blocks before they are attached
 * to a native message array (e.g. tool results, AgentInput). The actual
 * `nativeMessageIdx` is stamped by `convertAnthropicMessagesToProvider` on the
 * agent's `cachedProviderMessages`, so the input value is discarded. */
export const PLACEHOLDER_NATIVE_MESSAGE_IDX = -1 as NativeMessageIdx;

export type StreamingBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | {
      type: "tool_use";
      id: ToolManager.ToolRequestId;
      name: ToolName;
      inputJson: string;
    };

export type AgentInput =
  | ProviderTextContent
  | ProviderImageContent
  | ProviderDocumentContent;

export type RequestedTool = {
  id: ToolManager.ToolRequestId;
  /** err when the model emitted unparseable input for this call */
  request: Result<ToolRequest, { rawRequest: unknown }>;
};

/** The states a turn passes through. Progress, not outcome: how a turn ended
 * is delivered exactly once, by the promise `runTurn` returns. */
export type AgentPhase =
  | { type: "idle" }
  | {
      type: "streaming";
      startedAt: Date;
      /** Timestamp of the most recent sign of life from the server during the
       * current turn: set when each attempt's request is sent, and advanced on
       * every received stream event. Used to show a "waiting" timer during dead
       * air (no events for >3s). */
      lastEventTime: Date;
      block: StreamingBlock | undefined;
      retry: RetryStatus | undefined;
    }
  | {
      type: "running_tools";
      requested: ReadonlyArray<RequestedTool>;
      /** the turn was cut short by the output token limit mid-tool-use */
      truncated: boolean;
    }
  | { type: "aborting" };

/** How a turn ended. Delivered once, by the promise. */
export type TurnResult =
  | { type: "stopped"; stopReason: StopReason }
  /** the executor returned suspend; history is coherent and resumable */
  | { type: "suspended" }
  | { type: "aborted" }
  | { type: "failed"; error: Error; retryable: boolean };

export type ToolResults = ReadonlyMap<
  ToolManager.ToolRequestId,
  ProviderToolResult["result"]
>;

export type ToolOutcome =
  | { type: "continue"; results: ToolResults }
  /** record the results, then park the agent */
  | { type: "suspend"; results: ToolResults }
  /** the caller aborted its tool handles; unwind the turn */
  | { type: "aborted"; results: ToolResults };

/** "Please run these for me." Must settle; a rejection is converted into
 * error results for every requested id. No abort signal is passed in: the
 * caller owns the tool invocations, so on abort it cancels them itself and
 * settles with `{type: "aborted"}` carrying whatever results it has. */
export type ToolExecutor = (
  requests: ReadonlyArray<RequestedTool>,
) => Promise<ToolOutcome>;

/** Append-only render view of the conversation. Distinct from `phase`, which
 * is the machine. */
export type AgentLog = {
  readonly messages: ReadonlyArray<ProviderMessage>;
  readonly latestUsage: Usage | undefined;
  readonly inputTokenCount: number | undefined;
};

export interface Runner {
  readonly phase: AgentPhase;
  readonly log: AgentLog;

  /** Run until stop. Resolves once, with why it stopped. Does not reject for
   * provider errors — those are `failed` results. Rejects only on misuse: a
   * turn is already in flight. */
  runTurn(input: AgentInput[]): Promise<TurnResult>;

  /** Append content to the message log as user input, without issuing a
   * request. With `coalesce`, folds into a trailing user message rather than
   * pushing a new one — how supervisor injections land next to the content
   * that follows them. */
  appendUserMessage(content: AgentInput[], opts?: { coalesce: boolean }): void;

  /** Cancels the in-flight inference request (and any retry backoff) and
   * unwinds the loop: fills results for any unanswered tool_use and appends
   * the abort marker. The in-flight `runTurn` resolves with
   * `{type: "aborted"}` — that promise is the join point, so this returns void
   * rather than offering a second one to await. A no-op when idle, and also
   * when in `running_tools`: there the caller aborts its own tool handles and
   * the executor reports it via `{type: "aborted"}`. */
  abort(): void;

  /** Get the current native message index. Use this to capture a position
   * that can later be passed to truncateMessages.
   */
  getNativeMessageIdx(): NativeMessageIdx;

  /** Truncate messages to keep only messages 0..messageIdx (inclusive). */
  truncateMessages(messageIdx: NativeMessageIdx): void;

  /** Create a deep copy of this agent. Can be called in any phase; the clone
   * is `idle`, with incomplete blocks and unanswered tool_use cleaned up.
   * The new owner supplies its own hooks; none of the source's collaborators
   * cross over.
   */
  clone(hooks: RunnerHooks): Runner;
}

/** Optional interception point, supplied by whoever owns the runner. Called
 * before the continuation request that carries tool results; the returned
 * content is appended to that request. Purely additive, and not re-fired when
 * that request is retried. */
export type OnBeforeToolResponse = (args: {
  stopReason: StreamStopReason;
  results: ToolResults;
}) => Promise<AgentInput[]>;

/** The collaborators a runner is bound to. Supplied wherever the runner is
 * created — construction or `clone` — and never afterwards, so there is no
 * moment at which a runner exists pointing at the wrong owner. */
export type RunnerHooks = {
  executeTools: ToolExecutor;
  onUpdate: () => void;
  onBeforeToolResponse?: OnBeforeToolResponse | undefined;
};

export interface AgentOptions {
  model: string;
  systemPrompt: string;
  tools: ProviderToolSpec[];
  executeTools: ToolExecutor;
  /** "Something visible moved, re-render." No payload: read `phase` / `log`.
   * Called at streaming rates; the owner is responsible for throttling. */
  onBeforeToolResponse?: OnBeforeToolResponse | undefined;
  onUpdate: () => void;
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
    displayThinking?: boolean;
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
  };
  reasoning?: {
    effort?: ReasoningEffort;
    summary?: ReasoningSummary;
  };
  skipPostFlightTokenCount?: boolean;
}
