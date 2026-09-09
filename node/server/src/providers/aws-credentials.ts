import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type {
  AwsCredentialIdentity,
  AwsCredentialIdentityProvider,
} from "@smithy/types";

/** The AWS-related subset of a profile's `env` block. */
export type AwsEnv = Record<string, string> | undefined;

export function resolveAwsRegion(env: AwsEnv, fallback: string): string {
  return env?.AWS_REGION || fallback;
}

function buildProvider(env: AwsEnv): AwsCredentialIdentityProvider {
  const accessKeyId = env?.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env?.AWS_SECRET_ACCESS_KEY;
  if (accessKeyId && secretAccessKey) {
    const credentials: AwsCredentialIdentity = {
      accessKeyId,
      secretAccessKey,
      sessionToken: env?.AWS_SESSION_TOKEN,
    };
    return () => Promise.resolve(credentials);
  }
  if (accessKeyId || secretAccessKey) {
    throw new Error(
      "Both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together",
    );
  }
  return fromNodeProviderChain(
    env?.AWS_PROFILE ? { profile: env.AWS_PROFILE } : {},
  );
}

/** Credential resolution shared by the two Bedrock-backed providers: the
 *  anthropic SDK (via its `providerChainResolver` hook) and the SigV4-signed
 *  fetch the OpenAI mantle endpoint needs.
 *
 *  The provider is rebuildable because the SDK chain memoizes both resolved
 *  credentials and the SSO cache it read them from; after an external
 *  `aws sso login` repopulates that cache, only a fresh chain picks it up. */
export class AwsCredentials {
  private provider: AwsCredentialIdentityProvider;

  /** `build` is injectable for tests; production always uses the SDK chain. */
  constructor(
    private readonly env: AwsEnv,
    private readonly build: (
      env: AwsEnv,
    ) => AwsCredentialIdentityProvider = buildProvider,
  ) {
    this.provider = build(env);
  }

  resolve: AwsCredentialIdentityProvider = () => this.provider();

  reset(): void {
    this.provider = this.build(this.env);
  }
}
