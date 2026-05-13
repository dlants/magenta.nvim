import type { ClientOptions } from "@anthropic-ai/bedrock-sdk";
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import type Anthropic from "@anthropic-ai/sdk";
import type { DefaultProviderInit } from "@aws-sdk/credential-provider-node";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type { AnthropicAuth } from "../anthropic-auth.ts";
import type { Logger } from "../logger.ts";
import type { ValidateInput } from "../tool-types.ts";
import { AnthropicProvider } from "./anthropic.ts";

export type BedrockProviderOptions = {
  env?: Record<string, string> | undefined;
};

export class BedrockProvider extends AnthropicProvider {
  constructor(
    logger: Logger,
    validateInput: ValidateInput,
    anthropicAuth: AnthropicAuth | undefined,
    options: BedrockProviderOptions,
  ) {
    super(logger, undefined, validateInput, anthropicAuth, {});
    this.isBedrock = true;

    const env = options.env;
    const clientOptions: ClientOptions = {};

    if (env) {
      if (env.AWS_REGION) {
        clientOptions.awsRegion = env.AWS_REGION;
      }
      if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
        clientOptions.awsAccessKey = env.AWS_ACCESS_KEY_ID;
        clientOptions.awsSecretKey = env.AWS_SECRET_ACCESS_KEY;
      } else if (env.AWS_ACCESS_KEY_ID || env.AWS_SECRET_ACCESS_KEY) {
        throw new Error(
          "Both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together",
        );
      }
      if (env.AWS_SESSION_TOKEN) {
        clientOptions.awsSessionToken = env.AWS_SESSION_TOKEN;
      }

      // AWS_PROFILE must go through the credential provider chain since
      // AnthropicBedrock has no direct constructor option for it.
      if (env.AWS_PROFILE) {
        const providerInit: DefaultProviderInit = { profile: env.AWS_PROFILE };
        clientOptions.providerChainResolver = async () =>
          fromNodeProviderChain(providerInit);
      }
    }

    this.client = new AnthropicBedrock(
      clientOptions as ConstructorParameters<typeof AnthropicBedrock>[0],
    ) as unknown as Anthropic;
    this.includeWebSearch = false;
  }
}
