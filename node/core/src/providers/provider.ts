import type { Logger } from "../logger.ts";
import type { AuthUI } from "../auth-ui.ts";
import type { ProviderProfile } from "../provider-options.ts";
import type { ValidateInput } from "../tool-types.ts";
import type { AnthropicAuth } from "../anthropic-auth.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { BedrockProvider } from "./bedrock.ts";
// import { OpenAIProvider } from "./openai.ts";
import type { Provider } from "./provider-types.ts";

// import { OllamaProvider } from "./ollama.ts";
// import { CopilotProvider } from "./copilot.ts";

export * from "./provider-types.ts";

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
    switch (profile.provider) {
      case "anthropic":
        return new AnthropicProvider(
          logger,
          authUI,
          validateInput,
          anthropicAuth,
          {
            baseUrl: profile.baseUrl,
            apiKeyEnvVar: profile.apiKeyEnvVar,
            authType: profile.authType,
          },
        );
      case "bedrock":
        return new BedrockProvider(logger, validateInput, anthropicAuth, {
          env: profile.env,
        });
      case "openai":
        // return new OpenAIProvider(nvim, {
        //   baseUrl: profile.baseUrl,
        //   apiKeyEnvVar: profile.apiKeyEnvVar,
        // });
        throw new Error("Not implemented");
      case "ollama":
        // return new OllamaProvider(nvim);
        throw new Error("Not implemented");
      case "copilot":
        // return new CopilotProvider(nvim);
        throw new Error("Not implemented");
      case "mock":
        return mockProvider!;
      default:
        assertUnreachable(profile.provider);
    }
  }

  return clients[clientKey];
}

let mockProvider: Provider | undefined;

export function setMockProvider(provider: Provider | undefined) {
  mockProvider = provider;
}
