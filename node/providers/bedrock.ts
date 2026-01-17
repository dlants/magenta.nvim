import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import type { Nvim } from "../nvim/nvim-node";
import { AnthropicProvider } from "./anthropic.ts";
import type Anthropic from "@anthropic-ai/sdk";

export type BedrockProviderOptions = {
  env?: Record<string, string> | undefined;
};

export class BedrockProvider extends AnthropicProvider {
  constructor(nvim: Nvim, options?: BedrockProviderOptions) {
    // Apply environment variables before initializing
    // Supports AWS_PROFILE, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
    if (options?.env) {
      for (const [key, value] of Object.entries(options.env)) {
        process.env[key] = value;
      }
    }

    super(nvim, {});

    this.client = new AnthropicBedrock() as unknown as Anthropic;
    // Bedrock does not support web_search tool
    this.includeWebSearch = false;
  }
}
