import type { GitClient, GitState } from "../capabilities/git-client.ts";
import { formatGitHead } from "../capabilities/git-client.ts";
import type { Logger } from "../logger.ts";

export type GitContextUpdate = {
  previous: GitState | undefined;
  current: GitState | undefined;
};

/** True when the coarse-grained identity of the repo changed: presence,
 * branch, or HEAD commit. File counts deliberately do not trigger an update,
 * since the agent already knows about its own edits. */
function coarseChanged(
  a: GitState | undefined,
  b: GitState | undefined,
): boolean {
  if (!a && !b) return false;
  if (!a || !b) return true;
  return (
    a.branch !== b.branch ||
    a.headSha !== b.headSha ||
    a.headSubject !== b.headSubject
  );
}

export class GitTracker {
  /** What the agent has been told about git state. */
  private agentView: GitState | undefined;

  constructor(
    private gitClient: GitClient,
    initialState: GitState | undefined,
    private logger: Logger,
  ) {
    this.agentView = initialState;
  }

  getAgentView(): GitState | undefined {
    return this.agentView;
  }

  /** Polls current git state and, if the coarse identity changed since the
   * agent last saw it, commits the new state to the agent view and returns the
   * update. Returns undefined when nothing worth reporting changed. */
  /** Whether `getUpdate` would report something right now, without committing
   * the agent view. A probe for a request that may never be issued. */
  async hasUpdate(): Promise<boolean> {
    try {
      return coarseChanged(this.agentView, await this.gitClient.getState());
    } catch (error) {
      this.logger.error(
        `GitTracker failed to read git state: ${String(error)}`,
      );
      return false;
    }
  }

  async getUpdate(): Promise<GitContextUpdate | undefined> {
    let current: GitState | undefined;
    try {
      current = await this.gitClient.getState();
    } catch (error) {
      this.logger.error(
        `GitTracker failed to read git state: ${String(error)}`,
      );
      return undefined;
    }

    if (!coarseChanged(this.agentView, current)) {
      // Keep counts fresh without reporting, so the agent view stays accurate.
      this.agentView = current;
      return undefined;
    }

    const previous = this.agentView;
    this.agentView = current;
    return { previous, current };
  }
}

/** Builds the message text describing a git context update shown to the agent. */
export function gitUpdateToText(update: GitContextUpdate): string {
  const { current } = update;
  if (!current) {
    return "# Git status update\n\nThe working directory is no longer inside a git repository.";
  }

  const lines = [
    "# Git status update",
    "",
    "The git repository state has changed:",
    `- Repository root: ${current.repoRoot}`,
    `- Branch: ${current.branch ?? "(detached HEAD)"}`,
    `- HEAD: ${formatGitHead(current)}`,
    `- Changes: ${current.stagedCount} staged, ${current.unstagedCount} unstaged, ${current.untrackedCount} untracked`,
  ];
  return lines.join("\n");
}
