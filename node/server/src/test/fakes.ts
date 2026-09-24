import type { GitClient, GitState } from "../capabilities/git-client.ts";
import type { OutputLine, Shell, ShellResult } from "../capabilities/shell.ts";
import { Defer } from "../utils/async.ts";

/** A git client whose state the test sets directly, e.g. to simulate a branch
 * switch between turns. */
export class FakeGitClient implements GitClient {
  constructor(private state?: GitState) {}
  set(state: GitState | undefined): void {
    this.state = state;
  }
  getState(): Promise<GitState | undefined> {
    return Promise.resolve(this.state && { ...this.state });
  }
}

export type FakeShellResponse = {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
};
/** Command -> canned response. Unscripted commands stay pending until the test
 * settles them through `FakeShell.pending`. */
export type FakeShellScript = Record<string, FakeShellResponse>;

export function shellResult(response: FakeShellResponse): ShellResult {
  const output: OutputLine[] = [
    ...(response.stdout ?? "")
      .split("\n")
      .filter((text) => text.length)
      .map((text) => ({ stream: "stdout" as const, text })),
    ...(response.stderr ?? "")
      .split("\n")
      .filter((text) => text.length)
      .map((text) => ({ stream: "stderr" as const, text })),
  ];
  return {
    exitCode: response.exitCode ?? 0,
    signal: undefined,
    output,
    logFilePath: undefined,
    durationMs: 0,
  };
}

export class FakeShell implements Shell {
  readonly calls: string[] = [];
  /** Unscripted executions, in order, for the test to resolve. */
  readonly pending: { command: string; result: Defer<ShellResult> }[] = [];
  terminated = 0;

  constructor(private script: FakeShellScript = {}) {}

  execute(
    command: string,
    opts: { onOutput?: (line: OutputLine) => void; onStart?: () => void },
  ): Promise<ShellResult> {
    this.calls.push(command);
    opts.onStart?.();
    const scripted = this.script[command];
    if (scripted) {
      const result = shellResult(scripted);
      for (const line of result.output) opts.onOutput?.(line);
      return Promise.resolve(result);
    }
    const result = new Defer<ShellResult>();
    this.pending.push({ command, result });
    return result.promise;
  }

  terminate(): void {
    this.terminated++;
    for (const { result } of this.pending.splice(0)) {
      result.resolve({ ...shellResult({ exitCode: 143 }), signal: "SIGTERM" });
    }
  }
}
