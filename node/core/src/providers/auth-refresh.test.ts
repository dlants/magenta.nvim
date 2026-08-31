import { APIError } from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.ts";
import {
  describeError,
  flattenError,
  isAuthError,
  makeRefreshAuth,
  REFRESH_WINDOW_MS,
  type RunCommand,
} from "./auth-refresh.ts";

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("isAuthError", () => {
  it("detects TokenProviderError by name", () => {
    const err = new Error("Token is expired.");
    err.name = "TokenProviderError";
    expect(isAuthError(err)).toBe(true);
  });

  it("detects CredentialsProviderError by name", () => {
    const err = new Error("nope");
    err.name = "CredentialsProviderError";
    expect(isAuthError(err)).toBe(true);
  });

  it("detects 'Token is expired' message", () => {
    expect(isAuthError(new Error("Token is expired. Please refresh."))).toBe(
      true,
    );
  });

  it("detects ExpiredToken / ExpiredTokenException", () => {
    expect(isAuthError(new Error("ExpiredToken: bad creds"))).toBe(true);
    expect(isAuthError(new Error("ExpiredTokenException: nope"))).toBe(true);
  });

  it("detects 'SSO session token ... not found or is invalid'", () => {
    expect(
      isAuthError(
        new Error(
          "The SSO session token associated with profile=dev was not found or is invalid. To refresh this SSO session run 'aws sso login' with the corresponding profile.",
        ),
      ),
    ).toBe(true);
  });

  it("detects 401/403 APIError", () => {
    const err401 = new APIError(
      401,
      { type: "error", message: "unauth" },
      "unauth",
      new Headers(),
    );
    const err403 = new APIError(
      403,
      { type: "error", message: "forbidden" },
      "forbidden",
      new Headers(),
    );
    expect(isAuthError(err401)).toBe(true);
    expect(isAuthError(err403)).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isAuthError(new Error("random thing"))).toBe(false);
    const apiErr = new APIError(
      500,
      { type: "error", message: "boom" },
      "boom",
      new Headers(),
    );
    expect(isAuthError(apiErr)).toBe(false);
    expect(isAuthError("not an error")).toBe(false);
    expect(isAuthError(null)).toBe(false);
  });
});

describe("cause chains", () => {
  function wrapped(): Error {
    const cause = new Error("Token is expired. Run 'aws sso login'.");
    cause.name = "TokenProviderError";
    return new Error("Connection error.", { cause });
  }

  it("detects an auth error wrapped as a cause", () => {
    expect(isAuthError(wrapped())).toBe(true);
  });

  it("describeError appends the wrapped cause", () => {
    expect(describeError(wrapped())).toBe(
      "Connection error. Cause: Token is expired. Run 'aws sso login'.",
    );
  });

  it("flattenError keeps the original as the cause so detection still works", () => {
    const flattened = flattenError(wrapped());
    expect(flattened.message).toContain("Token is expired");
    expect(isAuthError(flattened)).toBe(true);
  });

  it("flattenError returns the error itself when there is nothing to add", () => {
    const plain = new Error("plain");
    expect(flattenError(plain)).toBe(plain);
  });
});

describe("makeRefreshAuth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves when the command succeeds", async () => {
    const runCommand = vi.fn<RunCommand>().mockResolvedValue({
      stdout: "ok",
      stderr: "",
    });
    const refresh = makeRefreshAuth("aws sso login", noopLogger, runCommand);
    await expect(refresh()).resolves.toBeUndefined();
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith("aws sso login");
  });

  it("rejects with stderr text when the command fails", async () => {
    const runCommand = vi
      .fn<RunCommand>()
      .mockRejectedValue(new Error("exit 1\nboom on stderr"));
    const refresh = makeRefreshAuth("bad-cmd", noopLogger, runCommand);
    await expect(refresh()).rejects.toThrow(/boom on stderr/);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("rejects calls within 30s window without re-running command", async () => {
    const runCommand = vi.fn<RunCommand>().mockResolvedValue({
      stdout: "",
      stderr: "",
    });
    const refresh = makeRefreshAuth("aws sso login", noopLogger, runCommand);

    await refresh();
    expect(runCommand).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    await expect(refresh()).rejects.toThrow(/not retrying/);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("allows refresh after the window expires", async () => {
    const runCommand = vi.fn<RunCommand>().mockResolvedValue({
      stdout: "",
      stderr: "",
    });
    const refresh = makeRefreshAuth("aws sso login", noopLogger, runCommand);

    await refresh();
    vi.advanceTimersByTime(REFRESH_WINDOW_MS + 1_000);
    await refresh();

    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent calls into a single command invocation", async () => {
    let resolveCmd: (() => void) | undefined;
    const runCommand = vi.fn<RunCommand>().mockImplementation(
      () =>
        new Promise<{ stdout: string; stderr: string }>((res) => {
          resolveCmd = () => res({ stdout: "", stderr: "" });
        }),
    );
    const refresh = makeRefreshAuth("aws sso login", noopLogger, runCommand);

    const p1 = refresh();
    const p2 = refresh();

    expect(runCommand).toHaveBeenCalledTimes(1);
    resolveCmd!();
    await Promise.all([p1, p2]);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
});
