export type GitState = {
  repoRoot: string;
  /** undefined when HEAD is detached. */
  branch: string | undefined;
  /** Full HEAD sha. Empty string when the repo has no commits yet. */
  headSha: string;
  /** Subject line of the HEAD commit. Empty when the repo has no commits. */
  headSubject: string;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
};

export interface GitClient {
  /** Returns undefined when the working directory is not inside a git repository. */
  getState(): Promise<GitState | undefined>;
}

/** Runs a git subcommand with the given args and reports its stdout and exit code.
 * Implementations should not throw on a non-zero exit code. */
export type GitCommandRunner = (
  args: string[],
) => Promise<{ stdout: string; exitCode: number }>;

export async function parseGitState(
  run: GitCommandRunner,
): Promise<GitState | undefined> {
  const root = await run(["rev-parse", "--show-toplevel"]);
  if (root.exitCode !== 0) {
    return undefined;
  }
  const repoRoot = root.stdout.trim();

  const [branchResult, headResult, statusResult] = await Promise.all([
    run(["symbolic-ref", "--short", "-q", "HEAD"]),
    run(["log", "-1", "--format=%H%x00%s"]),
    run(["status", "--porcelain"]),
  ]);

  const branchName =
    branchResult.exitCode === 0 ? branchResult.stdout.trim() : "";
  const branch = branchName.length > 0 ? branchName : undefined;

  let headSha = "";
  let headSubject = "";
  if (headResult.exitCode === 0) {
    const trimmed = headResult.stdout.replace(/\n$/, "");
    if (trimmed.length > 0) {
      const sepIdx = trimmed.indexOf("\0");
      if (sepIdx === -1) {
        headSha = trimmed;
      } else {
        headSha = trimmed.slice(0, sepIdx);
        headSubject = trimmed.slice(sepIdx + 1);
      }
    }
  }

  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;
  for (const line of statusResult.stdout.split("\n")) {
    if (line.length < 2) continue;
    if (line.startsWith("??")) {
      untrackedCount++;
      continue;
    }
    const indexStatus = line[0];
    const worktreeStatus = line[1];
    if (indexStatus !== " ") stagedCount++;
    if (worktreeStatus !== " ") unstagedCount++;
  }

  return {
    repoRoot,
    branch,
    headSha,
    headSubject,
    stagedCount,
    unstagedCount,
    untrackedCount,
  };
}

function formatHead(state: GitState): string {
  if (state.headSha.length === 0) {
    return "(no commits yet)";
  }
  const shortSha = state.headSha.slice(0, 7);
  return state.headSubject.length > 0
    ? `${shortSha} ${state.headSubject}`
    : shortSha;
}

/** Markdown lines describing git state for the system information block. */
export function formatGitInfo(state: GitState | undefined): string {
  if (!state) {
    return "- Git: not a git repository";
  }
  return [
    `- Git repository root: ${state.repoRoot}`,
    `- Git branch: ${state.branch ?? "(detached HEAD)"}`,
    `- Git HEAD: ${formatHead(state)}`,
    `- Git changes: ${state.stagedCount} staged, ${state.unstagedCount} unstaged, ${state.untrackedCount} untracked`,
  ].join("\n");
}

export { formatHead as formatGitHead };
