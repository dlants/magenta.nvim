import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";
import type { AwsCredentials } from "./aws-credentials.ts";

export const DEFAULT_BEDROCK_MANTLE_REGION = "us-west-2";

/** OpenAI frontier models live under the `openai/v1` prefix, which is distinct
 * from the `v1` prefix the other mantle-hosted models use. */
export function bedrockMantleBaseUrl(region: string): string {
  return `https://bedrock-mantle.${region}.api.aws/openai/v1`;
}

/** Signs each request with SigV4 so that the standard AWS credential chain
 * (including the SSO cache populated by `aws sso login`) can be used instead
 * of a static Bedrock API key.
 *
 * Credential resolution happens per request, inside `fetch`, so an expired SSO
 * token surfaces as a throw from `fetch` rather than an HTTP error — the OpenAI
 * SDK then reports it as `APIConnectionError("Connection error.")` with the
 * real error as `cause` (see `isAuthError`). */
export function createSigV4Fetch(
  region: string,
  credentials: AwsCredentials,
): typeof fetch {
  const signer = new SignatureV4({
    service: "bedrock",
    region,
    credentials: credentials.resolve,
    sha256: Sha256,
  });

  return async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    // The SDK always serializes bodies to strings, and SigV4 needs the exact
    // bytes it will send in order to compute the payload hash.
    const body = typeof init?.body === "string" ? init.body : undefined;
    const signed = await signer.sign({
      method: init?.method ?? "GET",
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: {
        ...Object.fromEntries(new Headers(init?.headers).entries()),
        host: url.hostname,
      },
      body,
    });
    return fetch(url, { ...init, headers: signed.headers });
  };
}
