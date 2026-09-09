import { exec } from "node:child_process";
import { APIError } from "@anthropic-ai/sdk";
import type { Logger } from "../logger.ts";

export type RefreshAuth = () => Promise<void>;

export type RunCommandResult = { stdout: string; stderr: string };
export type RunCommand = (command: string) => Promise<RunCommandResult>;

/** Window during which a successful or attempted refresh blocks further
 *  refresh attempts. Prevents tight refresh loops when the command succeeds
 *  but the next request still fails with an auth error. */
export const REFRESH_WINDOW_MS = 30_000;

const DEFAULT_TIMEOUT_MS = 60_000;

/** Walks the `cause` chain, which is where the real failure lives when an SDK
 *  wraps it: the OpenAI SDK turns any throw from its `fetch` (including AWS
 *  credential resolution) into `APIConnectionError("Connection error.")` with
 *  the original error as `cause`. */
function causeChain(error: unknown): Error[] {
  const chain: Error[] = [];
  let current: unknown = error;
  while (current instanceof Error && chain.length < 5) {
    chain.push(current);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return chain;
}

/** The message a user should see: the outermost message plus any wrapped cause
 *  messages, since the outermost one is often a useless "Connection error.". */
export function describeError(error: Error): string {
  const messages = causeChain(error)
    .map((err) => err.message)
    .filter((message, idx, all) => message && all.indexOf(message) === idx);
  const [outer, ...causes] = messages;
  return causes.length ? `${outer} Cause: ${causes.join(" Cause: ")}` : outer;
}

/** Replaces an SDK wrapper error with one whose message includes the wrapped
 *  cause, so the user sees the real failure rather than "Connection error.".
 *  The original is kept as `cause`, so error classification still works. */
export function flattenError(error: Error): Error {
  const message = describeError(error);
  if (message === error.message) return error;
  const flattened = new Error(message, { cause: error });
  flattened.name = error.name;
  return flattened;
}

/** Detects auth/credentials errors from the AWS SDK provider chain or the
 *  Anthropic SDK, including errors wrapped as a `cause`. */
export function isAuthError(error: unknown): boolean {
  return causeChain(error).some(isAuthErrorShallow);
}

function isAuthErrorShallow(error: Error): boolean {
  if (error instanceof APIError) {
    if (error.status === 401 || error.status === 403) return true;
  }

  if (
    error.name === "TokenProviderError" ||
    error.name === "CredentialsProviderError"
  ) {
    return true;
  }

  const message = error.message.toLowerCase();
  const patterns = [
    "token is expired",
    "expiredtoken",
    "expiredtokenexception",
    "invalidsignatureexception",
    "unrecognizedclientexception",
    "could not load credentials",
    "failed to resolve aws credentials",
    "sso session token",
    "was not found or is invalid",
  ];
  return patterns.some((p) => message.includes(p));
}

function defaultRunCommand(command: string): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    exec(
      command,
      { timeout: DEFAULT_TIMEOUT_MS, env: process.env },
      (err, stdout, stderr) => {
        if (err) {
          const wrapped = new Error(
            `${(err as Error).message}${stderr ? `\n${stderr}` : ""}`,
          );
          (wrapped as Error & { stdout?: string; stderr?: string }).stdout =
            stdout;
          (wrapped as Error & { stdout?: string; stderr?: string }).stderr =
            stderr;
          reject(wrapped);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/** Build a refresh closure that runs `command` to refresh auth credentials.
 *
 *  - Coalesces concurrent calls into a single in-flight refresh.
 *  - Rejects calls made within REFRESH_WINDOW_MS of a previous attempt to
 *    prevent tight refresh loops.
 *  - The optional `runCommand` parameter is for testing; defaults to
 *    `child_process.exec` with the current process env. */
export function makeRefreshAuth(
  command: string,
  logger: Logger,
  runCommand: RunCommand = defaultRunCommand,
): RefreshAuth {
  let inProgress: Promise<void> | undefined;
  let lastAttempt: number | undefined;

  return async function refreshAuth(): Promise<void> {
    if (inProgress) {
      return inProgress;
    }

    if (lastAttempt !== undefined) {
      const elapsed = Date.now() - lastAttempt;
      if (elapsed < REFRESH_WINDOW_MS) {
        const seconds = Math.round(elapsed / 1000);
        throw new Error(
          `Token refresh was attempted ${seconds}s ago; not retrying`,
        );
      }
    }

    lastAttempt = Date.now();
    logger.info(`Running token refresh command: ${command}`);

    inProgress = (async () => {
      try {
        const { stdout, stderr } = await runCommand(command);
        if (stdout) logger.info(`Token refresh stdout: ${stdout.trim()}`);
        if (stderr) logger.info(`Token refresh stderr: ${stderr.trim()}`);
        logger.info("Token refresh succeeded");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Token refresh failed: ${message}`);
        throw new Error(
          `Token refresh command failed (\`${command}\`): ${message}`,
        );
      }
    })();

    try {
      await inProgress;
    } finally {
      inProgress = undefined;
    }
  };
}
