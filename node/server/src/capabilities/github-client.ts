import { execFile as execFileCb } from "node:child_process";

export type GitHubResponse =
  | { type: "ok"; body: unknown; etag: string | undefined }
  | { type: "not-modified" }
  | {
      type: "error";
      status: number | undefined;
      message: string;
      retryAfterMs?: number;
    };

export interface GitHubClient {
  get(path: string, etag: string | undefined): Promise<GitHubResponse>;
}

export type ExecFileResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type ExecFileFn = (
  file: string,
  args: string[],
) => Promise<ExecFileResult>;

const MAX_BUFFER = 64 * 1024 * 1024;

const defaultExecFile: ExecFileFn = (file, args) =>
  new Promise((resolve) => {
    execFileCb(
      file,
      args,
      { maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          exitCode: error ? (typeof code === "number" ? code : 1) : 0,
        });
      },
    );
  });

/** Uses the host's `gh` so the user's existing GitHub auth applies. Never throws. */
export class GhCliGitHubClient implements GitHubClient {
  constructor(
    private deps: { execFile?: ExecFileFn; now?: () => number } = {},
  ) {}

  async get(path: string, etag: string | undefined): Promise<GitHubResponse> {
    const args = ["api", "--include"];
    if (etag !== undefined) {
      args.push("-H", `If-None-Match: ${etag}`);
    }
    args.push(path);
    try {
      const result = await (this.deps.execFile ?? defaultExecFile)("gh", args);
      return parseGhApiOutput(result, (this.deps.now ?? Date.now)());
    } catch (e) {
      return {
        type: "error",
        status: undefined,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

export function parseGhApiOutput(
  result: ExecFileResult,
  now: number,
): GitHubResponse {
  const stdout = result.stdout.replace(/^\s+/, "");
  const statusMatch = /^HTTP\/[\d.]+ (\d{3})[^\r\n]*/.exec(stdout);
  if (!statusMatch) {
    return {
      type: "error",
      status: undefined,
      message:
        result.stderr.trim() ||
        `gh exited with code ${result.exitCode} and no response`,
    };
  }
  const status = Number(statusMatch[1]);
  const separator = /\r?\n\r?\n/.exec(stdout);
  const headerText = separator ? stdout.slice(0, separator.index) : stdout;
  const bodyText = separator
    ? stdout.slice(separator.index + separator[0].length)
    : "";
  const headers = new Map<string, string>();
  for (const line of headerText.split(/\r?\n/).slice(1)) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      headers.set(
        line.slice(0, idx).trim().toLowerCase(),
        line.slice(idx + 1).trim(),
      );
    }
  }

  if (status === 304) {
    return { type: "not-modified" };
  }

  if (status >= 200 && status < 300) {
    try {
      return {
        type: "ok",
        body: bodyText.trim() === "" ? undefined : JSON.parse(bodyText),
        etag: headers.get("etag"),
      };
    } catch (e) {
      return {
        type: "error",
        status,
        message: `Failed to parse GitHub response: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  let message = `GitHub API returned ${status}`;
  try {
    const parsed = JSON.parse(bodyText) as { message?: unknown };
    if (typeof parsed.message === "string") {
      message += `: ${parsed.message}`;
    }
  } catch {
    // non-JSON error body; keep the status-only message
  }
  const response: GitHubResponse = { type: "error", status, message };
  const retryAfterMs = rateLimitDelayMs(status, headers, now);
  if (retryAfterMs !== undefined) {
    response.retryAfterMs = retryAfterMs;
  }
  return response;
}

function rateLimitDelayMs(
  status: number,
  headers: Map<string, string>,
  now: number,
): number | undefined {
  if (status !== 403 && status !== 429) return undefined;
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== undefined && /^\d+$/.test(retryAfter)) {
    return Number(retryAfter) * 1000;
  }
  const reset = headers.get("x-ratelimit-reset");
  if (headers.get("x-ratelimit-remaining") === "0" && reset !== undefined) {
    return Math.max(0, Number(reset) * 1000 - now);
  }
  return undefined;
}
