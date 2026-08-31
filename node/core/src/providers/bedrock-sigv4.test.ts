import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";
import { describeError, isAuthError } from "./auth-refresh.ts";
import { AwsCredentials } from "./aws-credentials.ts";
import { bedrockMantleBaseUrl, createSigV4Fetch } from "./bedrock-sigv4.ts";
import { useExpiredSsoEnv } from "./fake-sso-cache.ts";

const savedEnv = { ...process.env };

describe("bedrock mantle SigV4 auth", () => {
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("reports an expired SSO session as an auth error rather than a bare connection error", async () => {
    useExpiredSsoEnv();
    const client = new OpenAI({
      apiKey: "dummy-key-for-bedrock-auth",
      baseURL: bedrockMantleBaseUrl("us-west-2"),
      fetch: createSigV4Fetch(
        "us-west-2",
        new AwsCredentials({ AWS_PROFILE: "fake" }),
      ),
      maxRetries: 0,
    });

    // Signing fails before any request is made, so this never touches network.
    const error = await client.responses
      .create({ model: "gpt-5.4", input: "hi" })
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    expect(error).toBeInstanceOf(Error);
    // The SDK collapses fetch-layer failures into "Connection error.", so the
    // real cause has to be recovered from the cause chain.
    expect((error as Error).message).toBe("Connection error.");
    expect(isAuthError(error)).toBe(true);
    expect(describeError(error as Error)).toContain("aws sso login");
  });
});
