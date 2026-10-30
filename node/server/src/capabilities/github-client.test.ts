import { describe, expect, it } from "vitest";
import {
  type ExecFileFn,
  GhCliGitHubClient,
  parseGhApiOutput,
} from "./github-client.ts";

const NOW = 1_700_000_000_000;

describe("parseGhApiOutput", () => {
  it("parses a 200 with etag and body", () => {
    const stdout =
      'HTTP/2.0 200 OK\r\nContent-Type: application/json\r\nEtag: W/"abc"\r\n\r\n{"number":12}';
    expect(parseGhApiOutput({ stdout, stderr: "", exitCode: 0 }, NOW)).toEqual({
      type: "ok",
      body: { number: 12 },
      etag: 'W/"abc"',
    });
  });

  it("parses a 304", () => {
    const stdout = 'HTTP/2.0 304 Not Modified\r\nEtag: W/"abc"\r\n\r\n';
    expect(
      parseGhApiOutput({ stdout, stderr: "gh: HTTP 304", exitCode: 1 }, NOW),
    ).toEqual({ type: "not-modified" });
  });

  it("parses a rate-limited 403", () => {
    const reset = NOW / 1000 + 120;
    const stdout = `HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: ${reset}\r\n\r\n{"message":"API rate limit exceeded"}`;
    expect(parseGhApiOutput({ stdout, stderr: "", exitCode: 1 }, NOW)).toEqual({
      type: "error",
      status: 403,
      message: "GitHub API returned 403: API rate limit exceeded",
      retryAfterMs: 120_000,
    });
  });

  it("uses retry-after when present", () => {
    const stdout =
      "HTTP/2.0 429 Too Many Requests\r\nRetry-After: 60\r\n\r\n{}";
    expect(
      parseGhApiOutput({ stdout, stderr: "", exitCode: 1 }, NOW),
    ).toMatchObject({ status: 429, retryAfterMs: 60_000 });
  });

  it("parses a 404", () => {
    const stdout = 'HTTP/2.0 404 Not Found\r\n\r\n{"message":"Not Found"}';
    expect(parseGhApiOutput({ stdout, stderr: "", exitCode: 1 }, NOW)).toEqual({
      type: "error",
      status: 404,
      message: "GitHub API returned 404: Not Found",
      retryAfterMs: undefined,
    });
  });

  it("reports invalid JSON in a 2xx as an error keeping the status", () => {
    const stdout = "HTTP/2.0 200 OK\r\n\r\n{not json";
    expect(
      parseGhApiOutput({ stdout, stderr: "", exitCode: 0 }, NOW),
    ).toMatchObject({ type: "error", status: 200 });
  });
  it("returns an undefined body for an empty 2xx", () => {
    const stdout = "HTTP/2.0 204 No Content\r\n\r\n";
    expect(parseGhApiOutput({ stdout, stderr: "", exitCode: 0 }, NOW)).toEqual({
      type: "ok",
      body: undefined,
      etag: undefined,
    });
  });
  it("does not retry a 403 that is not a rate limit", () => {
    const stdout = `HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 10\r\nX-Ratelimit-Reset: ${NOW / 1000 + 60}\r\n\r\n{"message":"Resource not accessible"}`;
    expect(
      parseGhApiOutput({ stdout, stderr: "", exitCode: 1 }, NOW),
    ).toMatchObject({ status: 403, retryAfterMs: undefined });
  });
  it("clamps a past rate-limit reset to 0", () => {
    const stdout = `HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: ${NOW / 1000 - 60}\r\n\r\n{}`;
    expect(
      parseGhApiOutput({ stdout, stderr: "", exitCode: 1 }, NOW),
    ).toMatchObject({ status: 403, retryAfterMs: 0 });
  });
  it("falls back to a status-only message for a non-JSON error body", () => {
    const stdout = "HTTP/2.0 502 Bad Gateway\r\n\r\n<html>bad</html>";
    expect(parseGhApiOutput({ stdout, stderr: "", exitCode: 1 }, NOW)).toEqual({
      type: "error",
      status: 502,
      message: "GitHub API returned 502",
      retryAfterMs: undefined,
    });
  });
  it("reports a non-zero exit with no output", () => {
    expect(
      parseGhApiOutput(
        { stdout: "", stderr: "gh: not logged in\n", exitCode: 4 },
        NOW,
      ),
    ).toEqual({
      type: "error",
      status: undefined,
      message: "gh: not logged in",
    });
  });
});

describe("GhCliGitHubClient", () => {
  it("passes If-None-Match only when an etag is given", async () => {
    const calls: string[][] = [];
    const execFile: ExecFileFn = async (_file, args) => {
      calls.push(args);
      return {
        stdout: "HTTP/2.0 304 Not Modified\r\n\r\n",
        stderr: "",
        exitCode: 1,
      };
    };
    const client = new GhCliGitHubClient({ execFile });
    await client.get("repos/o/r/pulls/1", 'W/"x"');
    await client.get("repos/o/r/pulls/1", undefined);
    expect(calls).toEqual([
      ["api", "--include", "-H", 'If-None-Match: W/"x"', "repos/o/r/pulls/1"],
      ["api", "--include", "repos/o/r/pulls/1"],
    ]);
  });

  it("never throws when execFile rejects", async () => {
    const client = new GhCliGitHubClient({
      execFile: async () => {
        throw new Error("spawn gh ENOENT");
      },
    });
    expect(await client.get("x", undefined)).toEqual({
      type: "error",
      status: undefined,
      message: "spawn gh ENOENT",
    });
  });
});
