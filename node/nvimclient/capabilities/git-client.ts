import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import {
  type GitClient,
  type GitCommandRunner,
  type GitState,
  parseGitState,
} from "@magenta/server";

const execFile = promisify(execFileCb);

function runnerResult(
  promise: Promise<{ stdout: string }>,
): Promise<{ stdout: string; exitCode: number }> {
  return promise
    .then((r) => ({ stdout: r.stdout, exitCode: 0 }))
    .catch((error: unknown) => {
      const err = error as { stdout?: string; code?: number | string };
      const exitCode = typeof err.code === "number" ? err.code : 1;
      return { stdout: err.stdout ?? "", exitCode };
    });
}

export class LocalGitClient implements GitClient {
  constructor(private cwd: string) {}

  getState(): Promise<GitState | undefined> {
    const run: GitCommandRunner = (args) =>
      runnerResult(execFile("git", args, { cwd: this.cwd }));
    return parseGitState(run);
  }
}

export class DockerGitClient implements GitClient {
  constructor(
    private container: string,
    private cwd: string,
  ) {}

  getState(): Promise<GitState | undefined> {
    const run: GitCommandRunner = (args) =>
      runnerResult(
        execFile("docker", [
          "exec",
          "-w",
          this.cwd,
          this.container,
          "git",
          ...args,
        ]),
      );
    return parseGitState(run);
  }
}
