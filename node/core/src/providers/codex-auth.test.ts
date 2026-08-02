import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAuth, type CodexAuthError } from "./codex-auth.ts";

const NOW = 1_800_000_000_000;

/** A JWT with only the `exp` claim — all `needsRefresh` looks at. */
function token(expiresAtMs: number): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(expiresAtMs / 1000) }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

let home: string;

async function writeAuthFile(tokens: Record<string, string>) {
  await fs.writeFile(
    path.join(home, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens }),
    { mode: 0o600 },
  );
}

function refreshResponse(body: Record<string, string>) {
  return vi.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(body),
    } as Response),
  );
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-test-"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("CodexAuth.getCredentials", () => {
  it("returns the stored token without refreshing when it is still valid", async () => {
    await writeAuthFile({
      access_token: token(NOW + 60 * 60 * 1000),
      refresh_token: "refresh-1",
      id_token: "id-1",
      account_id: "acct-1",
    });
    const fetchImpl = vi.fn();
    const auth = new CodexAuth({ home, now: () => NOW, fetchImpl });

    expect(await auth.getCredentials()).toEqual({
      accessToken: token(NOW + 60 * 60 * 1000),
      accountId: "acct-1",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes a token that is within the expiry window and writes it back at 0600", async () => {
    await writeAuthFile({
      access_token: token(NOW + 60 * 1000),
      refresh_token: "refresh-1",
      id_token: "id-1",
      account_id: "acct-1",
    });
    const fetchImpl = refreshResponse({
      access_token: "fresh-access",
      refresh_token: "rotated-refresh",
      id_token: "fresh-id",
    });
    const auth = new CodexAuth({ home, now: () => NOW, fetchImpl });

    expect(await auth.getCredentials()).toEqual({
      accessToken: "fresh-access",
      accountId: "acct-1",
    });

    const authPath = path.join(home, "auth.json");
    const written = JSON.parse(await fs.readFile(authPath, "utf8")) as {
      auth_mode: string;
      tokens: Record<string, string>;
      last_refresh: string;
    };
    // The rotated refresh token must be persisted, or the next refresh presents
    // a spent token.
    expect(written.tokens.refresh_token).toBe("rotated-refresh");
    expect(written.tokens.account_id).toBe("acct-1");
    // Fields we don't own must survive the write.
    expect(written.auth_mode).toBe("chatgpt");
    expect(written.last_refresh).toBe(new Date(NOW).toISOString());

    const mode = (await fs.stat(authPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("coalesces concurrent refreshes into one request", async () => {
    await writeAuthFile({
      access_token: token(NOW - 1000),
      refresh_token: "refresh-1",
      id_token: "id-1",
      account_id: "acct-1",
    });
    const fetchImpl = refreshResponse({ access_token: "fresh-access" });
    const auth = new CodexAuth({ home, now: () => NOW, fetchImpl });

    await Promise.all([auth.getCredentials(), auth.getCredentials()]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces an actionable error when the refresh is rejected", async () => {
    await writeAuthFile({
      access_token: token(NOW - 1000),
      refresh_token: "stale",
      id_token: "id-1",
      account_id: "acct-1",
    });
    const fetchImpl = vi.fn(() =>
      Promise.resolve({ ok: false, status: 400 } as Response),
    );
    const auth = new CodexAuth({ home, now: () => NOW, fetchImpl });

    const err = (await auth
      .getCredentials()
      .catch((e: unknown) => e)) as CodexAuthError;
    expect(err.kind).toBe("refresh-failed");
    expect(err.message).toContain("codex login");
    // One attempt, no retry loop.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports a missing auth.json as not logged in", async () => {
    const auth = new CodexAuth({ home, now: () => NOW });
    const err = (await auth
      .getCredentials()
      .catch((e: unknown) => e)) as CodexAuthError;
    expect(err.kind).toBe("not-logged-in");
    expect(await auth.isAuthenticated()).toBe(false);
  });

  it("distinguishes keyring-backed credentials from never having logged in", async () => {
    await fs.writeFile(
      path.join(home, "config.toml"),
      'cli_auth_credentials_store = "keyring"\n',
    );
    const auth = new CodexAuth({ home, now: () => NOW });

    const err = (await auth
      .getCredentials()
      .catch((e: unknown) => e)) as CodexAuthError;
    expect(err.kind).toBe("credentials-in-keyring");
    expect(err.message).toContain("config.toml");
  });
});

describe("CodexAuth.refreshCredentials", () => {
  it("refreshes even when the token has not expired — the reactive 401 path", async () => {
    await writeAuthFile({
      access_token: token(NOW + 60 * 60 * 1000),
      refresh_token: "refresh-1",
      id_token: "id-1",
      account_id: "acct-1",
    });
    const fetchImpl = refreshResponse({ access_token: "fresh-access" });
    const auth = new CodexAuth({ home, now: () => NOW, fetchImpl });

    expect(await auth.refreshCredentials()).toEqual({
      accessToken: "fresh-access",
      accountId: "acct-1",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("CodexAuth.login", () => {
  it("reports an actionable error when the codex CLI is not installed", async () => {
    const auth = new CodexAuth({ home, now: () => NOW });
    // PATH without codex on it, so spawn fails with ENOENT.
    const originalPath = process.env.PATH;
    process.env.PATH = path.join(home, "empty-bin");
    try {
      const err = (await auth
        .login()
        .catch((e: unknown) => e)) as CodexAuthError;
      expect(err.kind).toBe("codex-not-installed");
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
