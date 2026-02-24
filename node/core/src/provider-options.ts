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

export type ProviderProfile = {
  name: string;
  provider: ProviderName;
  model: string;
  fastModel: string;
  baseUrl?: string;
  apiKeyEnvVar?: string;
  authType?: "key" | "max";
  promptCaching?: boolean;
  env?: Record<string, string>;
  thinking?:
    | {
        enabled: boolean;
        budgetTokens?: number;
      }
    | undefined;
  reasoning?:
    | {
        effort?: "low" | "medium" | "high";
        summary?: "auto" | "concise" | "detailed";
      }
    | undefined;
};

export type ProviderOptions = {
  skillsPaths: string[];
};
