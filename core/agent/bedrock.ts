import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import type { Logger } from "../logger.ts";
import { AnthropicProvider } from "./anthropic.ts";
import type Anthropic from "@anthropic-ai/sdk";

export type BedrockProviderOptions = {
  env?: Record<string, string> | undefined;
};

export class BedrockProvider extends AnthropicProvider {
  constructor(logger: Logger, options?: BedrockProviderOptions) {
    if (options?.env) {
      for (const [key, value] of Object.entries(options.env)) {
        process.env[key] = value;
      }
    }

    super(logger, {});

    this.client = new AnthropicBedrock() as unknown as Anthropic;
    this.includeWebSearch = false;
  }
}
