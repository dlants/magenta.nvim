import type { Nvim } from "../nvim/nvim-node";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { BedrockProvider } from "./bedrock.ts";
import { OpenAIProvider } from "./openai.ts";
import type { Provider } from "./provider-types.ts";
import { type EditPredictionProfile, type Profile } from "../options.ts";
import { OllamaProvider } from "./ollama.ts";
import { CopilotProvider } from "./copilot.ts";

export * from "./provider-types.ts";

const clients: { [key: string]: Provider } = {};

// lazy load so we have a chance to init context before constructing the class
export function getProvider(
  nvim: Nvim,
  profile: Profile | EditPredictionProfile,
): Provider {
  const clientKey = profile.name;

  if (!clients[clientKey]) {
    switch (profile.provider) {
      case "anthropic":
        return new AnthropicProvider(nvim, {
          baseUrl: profile.baseUrl,
          apiKeyEnvVar: profile.apiKeyEnvVar,
          authType: profile.authType,
          promptCaching: true,
        });
      case "openai":
        return new OpenAIProvider(nvim, {
          baseUrl: profile.baseUrl,
          apiKeyEnvVar: profile.apiKeyEnvVar,
        });
      case "bedrock":
        return new BedrockProvider(nvim, !!(profile as Profile).promptCaching);
      case "ollama":
        return new OllamaProvider(nvim);
      case "copilot":
        return new CopilotProvider(nvim);
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
