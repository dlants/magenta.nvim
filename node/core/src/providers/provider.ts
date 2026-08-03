import type { AnthropicAuth } from "../anthropic-auth.ts";
import type { AuthUI } from "../auth-ui.ts";
import type { Logger } from "../logger.ts";
import type { ProviderProfile } from "../provider-options.ts";
import type { ValidateInput } from "../tool-types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { BedrockProvider } from "./bedrock.ts";
import { CodexAuth } from "./codex-auth.ts";
import { OpenAIProvider } from "./openai.ts";
import type { Provider } from "./provider-types.ts";

// import { OllamaProvider } from "./ollama.ts";
// import { CopilotProvider } from "./copilot.ts";

export * from "./provider-types.ts";

/** `Profile.authType` is a flat union across providers, so the anthropic-only
 * values have to be separated from the openai-only ones here. */
export function anthropicAuthType(
  authType: ProviderProfile["authType"],
): "key" | "max" | "keychain" | undefined {
  return authType === "chatgpt" ? undefined : authType;
}

const clients: { [key: string]: Provider } = {};

// lazy load so we have a chance to init context before constructing the class
export function getProvider(
  logger: Logger,
  authUI: AuthUI | undefined,
  validateInput: ValidateInput,
  anthropicAuth: AnthropicAuth | undefined,
  profile: ProviderProfile,
): Provider {
  const clientKey = profile.name;

  if (!clients[clientKey]) {
    let provider: Provider;
    switch (profile.provider) {
      case "anthropic":
        provider = new AnthropicProvider(
          logger,
          authUI,
          validateInput,
          anthropicAuth,
          {
            baseUrl: profile.baseUrl,
            apiKeyEnvVar: profile.apiKeyEnvVar,
            authType: anthropicAuthType(profile.authType),
          },
        );
        break;
      case "bedrock":
        provider = new BedrockProvider(logger, validateInput, anthropicAuth, {
          env: profile.env,
          tokenRefreshCommand: profile.tokenRefreshCommand,
        });
        break;
      case "openai": {
        // ChatGPT-subscription auth is opt-in and unofficial; the default
        // remains a platform API key.
        provider = new OpenAIProvider(
          logger,
          validateInput,
          profile.authType === "chatgpt"
            ? {
                baseUrl: profile.baseUrl,
                authType: "chatgpt",
                auth: new CodexAuth(),
                authUI,
              }
            : {
                baseUrl: profile.baseUrl,
                apiKeyEnvVar: profile.apiKeyEnvVar,
              },
        );
        break;
      }
      case "ollama":
        throw new Error("Not implemented");
      case "copilot":
        throw new Error("Not implemented");
      case "mock":
        return mockProvider!;
      default:
        assertUnreachable(profile.provider);
    }
    clients[clientKey] = provider;
  }

  return clients[clientKey];
}

let mockProvider: Provider | undefined;

export function setMockProvider(provider: Provider | undefined) {
  mockProvider = provider;
}
