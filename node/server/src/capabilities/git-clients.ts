import { execFile as execFileCb } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { AbsFilePath } from "../utils/files.ts";
import {
  type GitClient,
  type GitCommandRunner,
  type GitState,
  parseGitState,
} from "./git-client.ts";

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

/** Shared repo-root lookup over a runner that takes `git -C <dir>` args.
 * `path` may be a file, so a failed lookup falls back to its parent dir. */
abstract class DirectorylessGitClient implements GitClient {
  private rootCache = new Map<string, AbsFilePath>();

  protected abstract runIn(dir: string): GitCommandRunner;

  /** Only found roots are cached, so a directory that later becomes a repo is
   * still discovered. */
  async findRepoRoot(p: AbsFilePath): Promise<AbsFilePath | undefined> {
    const cached = this.rootCache.get(p);
    if (cached) return cached;
    const root = await this.lookupRoot(p);
    if (root) this.rootCache.set(p, root);
    return root;
  }

  private async lookupRoot(p: AbsFilePath): Promise<AbsFilePath | undefined> {
    for (const dir of [p, path.dirname(p)]) {
      const result = await this.runIn(dir)(["rev-parse", "--show-toplevel"]);
      if (result.exitCode === 0) {
        return result.stdout.trim() as AbsFilePath;
      }
    }
    return undefined;
  }

  getState(repoRoot: AbsFilePath): Promise<GitState | undefined> {
    return parseGitState(this.runIn(repoRoot));
  }
}

export class LocalGitClient extends DirectorylessGitClient {
  protected runIn(dir: string): GitCommandRunner {
    return (args) => runnerResult(execFile("git", ["-C", dir, ...args]));
  }
}

export class DockerGitClient extends DirectorylessGitClient {
  constructor(private container: string) {
    super();
  }

  protected runIn(dir: string): GitCommandRunner {
    return (args) =>
      runnerResult(
        execFile("docker", ["exec", this.container, "git", "-C", dir, ...args]),
      );
  }
}
