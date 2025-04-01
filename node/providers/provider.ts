import type { Nvim } from "nvim-node";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { BedrockProvider } from "./bedrock.ts";
import { OpenAIProvider } from "./openai.ts";
import type {
  Provider,
  ProviderName,
  ProviderSetting,
} from "./provider-types.ts";

export * from "./provider-types.ts";

const clients: Partial<{ [providerName in ProviderName]: Provider }> = {};

// lazy load so we have a chance to init context before constructing the class
export function getProvider(
  nvim: Nvim,
  providerSetting: ProviderSetting,
): Provider {
  if (!clients[providerSetting.provider]) {
    switch (providerSetting.provider) {
      case "anthropic":
        clients[providerSetting.provider] = new AnthropicProvider(nvim);
        break;
      case "openai":
        clients[providerSetting.provider] = new OpenAIProvider(nvim, {
          model: providerSetting.model,
          omitParallelToolCalls: providerSetting.omitParallelToolCalls ?? false,
        });
        break;
      case "bedrock":
        clients[providerSetting.provider] = new BedrockProvider(
          nvim,
          providerSetting.promptCaching,
        );
        break;
      default:
        assertUnreachable(providerSetting);
    }
  }

  const provider = clients[providerSetting.provider]!;
  provider.setModel(providerSetting.model);

  if (
    providerSetting.provider === "openai" &&
    "setOmitParallelToolCalls" in provider
  ) {
    provider.setOmitParallelToolCalls(
      providerSetting.omitParallelToolCalls ?? false,
    );
  }

  return provider;
}

export function setClient(providerName: ProviderName, c: Provider | undefined) {
  if (c) {
    clients[providerName] = c;
  } else {
    delete clients[providerName];
  }
}
