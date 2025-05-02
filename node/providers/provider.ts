import type { Nvim } from "nvim-node";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { BedrockProvider } from "./bedrock.ts";
import { OpenAIProvider } from "./openai.ts";
import type { Provider, ProviderName } from "./provider-types.ts";
import { type Profile } from "../options.ts";

export * from "./provider-types.ts";

const clients: Partial<{ [providerName in ProviderName]: Provider }> = {};

// lazy load so we have a chance to init context before constructing the class
export function getProvider(nvim: Nvim, profile: Profile): Provider {
  // Create a client key based on provider name and custom settings
  const providerName = profile.provider;

  if (!clients[providerName]) {
    switch (profile.provider) {
      case "anthropic":
        clients[providerName] = new AnthropicProvider(nvim, {
          baseUrl: profile.baseUrl,
          apiKeyEnvVar: profile.apiKeyEnvVar,
          promptCaching: true,
        });
        break;
      case "openai":
        clients[providerName] = new OpenAIProvider(nvim, {
          baseUrl: profile.baseUrl,
          apiKeyEnvVar: profile.apiKeyEnvVar,
        });
        break;
      case "bedrock":
        clients[providerName] = new BedrockProvider(
          nvim,
          !!profile.promptCaching,
        );
        break;
      default:
        assertUnreachable(profile.provider);
    }
  }

  const provider = clients[providerName];
  provider.setModel(profile.model);

  return provider;
}

export function setClient(providerName: ProviderName, c: Provider | undefined) {
  if (c) {
    clients[providerName] = c;
  } else {
    delete clients[providerName];
  }
}
