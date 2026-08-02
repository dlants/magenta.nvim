/**
 * Minimal provider-facing interfaces for options.
 * The root project's Profile and MagentaOptions satisfy these interfaces,
 * so they can be passed to providers without casting.
 */

export type ProviderName =
  | "anthropic"
  | "openai"
  | "bedrock"
  | "ollama"
  | "copilot"
  | "mock";

export type ThinkingEffort = "low" | "medium" | "high" | "xhigh" | "max";
/** The reasoning-effort levels the OpenAI Responses API accepts; "max" is
 * thinking-only and has no reasoning analogue. */
export type ReasoningEffort = Exclude<ThinkingEffort, "max">;
export type ReasoningSummary = "auto" | "concise" | "detailed";

export type ProviderProfile = {
  name: string;
  provider: ProviderName;
  model: string;
  fastModel: string;
  thinkingModel: string;
  baseUrl?: string;
  apiKeyEnvVar?: string;
  authType?: "key" | "max" | "keychain";
  promptCaching?: boolean;
  env?: Record<string, string>;
  tokenRefreshCommand?: string;
  thinking?:
    | {
        enabled: boolean;
        budgetTokens?: number;
        displayThinking?: boolean;
        effort?: "low" | "medium" | "high" | "xhigh" | "max";
      }
    | undefined;
  reasoning?:
    | {
        effort?: "low" | "medium" | "high" | "xhigh";
        summary?: "auto" | "concise" | "detailed";
      }
    | undefined;
};

export type ProviderOptions = {
  skillsPaths: string[];
  agentsPaths: string[];
  suppressProjectSkills?: string[];
};
