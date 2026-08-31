import { afterEach, describe, expect, it } from "vitest";
import { isAuthError } from "./auth-refresh.ts";
import { AwsCredentials, resolveAwsRegion } from "./aws-credentials.ts";
import { useExpiredSsoEnv } from "./fake-sso-cache.ts";

const savedEnv = { ...process.env };

describe("AwsCredentials", () => {
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("uses static credentials from the profile env", async () => {
    const credentials = new AwsCredentials({
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "session",
    });
    await expect(credentials.resolve()).resolves.toMatchObject({
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
      sessionToken: "session",
    });
  });

  it("rejects a half-configured static key pair", () => {
    expect(() => new AwsCredentials({ AWS_ACCESS_KEY_ID: "AKIA" })).toThrow(
      "must be set together",
    );
  });

  it("resolve() fails with a recognizable auth error when the SSO token is expired", async () => {
    useExpiredSsoEnv();
    const credentials = new AwsCredentials({ AWS_PROFILE: "fake" });

    const error = await credentials.resolve().then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(Error);
    expect(isAuthError(error)).toBe(true);
    expect((error as Error).message).toContain("aws sso login");
  });

  it("reset() rebuilds the provider, since the SDK chain memoizes what it resolved", async () => {
    let builds = 0;
    const credentials = new AwsCredentials(undefined, () => {
      builds++;
      return () =>
        Promise.resolve({ accessKeyId: `key-${builds}`, secretAccessKey: "s" });
    });

    await expect(credentials.resolve()).resolves.toMatchObject({
      accessKeyId: "key-1",
    });
    await expect(credentials.resolve()).resolves.toMatchObject({
      accessKeyId: "key-1",
    });

    credentials.reset();
    await expect(credentials.resolve()).resolves.toMatchObject({
      accessKeyId: "key-2",
    });
    expect(builds).toBe(2);
  });
});

describe("resolveAwsRegion", () => {
  it("prefers the profile env over the fallback", () => {
    expect(resolveAwsRegion({ AWS_REGION: "eu-west-1" }, "us-west-2")).toBe(
      "eu-west-1",
    );
    expect(resolveAwsRegion(undefined, "us-west-2")).toBe("us-west-2");
  });
});
