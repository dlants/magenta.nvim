import type { ClientOptions } from "@anthropic-ai/bedrock-sdk";
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import type Anthropic from "@anthropic-ai/sdk";
import type { AnthropicAuth } from "../anthropic-auth.ts";
import type { Logger } from "../logger.ts";
import type { ValidateInput } from "../tool-types.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { makeRefreshAuth } from "./auth-refresh.ts";
import { AwsCredentials } from "./aws-credentials.ts";

export type BedrockProviderOptions = {
  env?: Record<string, string> | undefined;
  tokenRefreshCommand?: string | undefined;
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
    const credentials = new AwsCredentials(env);
    const clientOptions: ClientOptions = {
      // The resolver is consulted per request, so rebuilding the chain after a
      // token refresh takes effect without recreating the client.
      providerChainResolver: () => Promise.resolve(credentials.resolve),
    };
    if (env?.AWS_REGION) {
      clientOptions.awsRegion = env.AWS_REGION;
    }
    this.client = new AnthropicBedrock(
      clientOptions as ConstructorParameters<typeof AnthropicBedrock>[0],
    ) as unknown as Anthropic;
    this.includeWebSearch = false;

    if (options.tokenRefreshCommand) {
      const refresh = makeRefreshAuth(options.tokenRefreshCommand, logger);
      this.refreshAuth = async () => {
        await refresh();
        credentials.reset();
      };
    }
  }
}
