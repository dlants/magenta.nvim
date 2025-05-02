import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import type { Nvim } from "nvim-node";
import { AnthropicProvider } from "./anthropic.ts";
import type Anthropic from "@anthropic-ai/sdk";

export class BedrockProvider extends AnthropicProvider {
  constructor(nvim: Nvim, promptCaching: boolean) {
    super(nvim, { promptCaching, awsAPIKey: true });
    this.model = "anthropic.claude-3-5-sonnet-20241022-v2:0";
    this.client = new AnthropicBedrock() as unknown as Anthropic;
  }
}
