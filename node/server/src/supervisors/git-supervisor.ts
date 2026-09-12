import type { GitClient, GitState } from "../capabilities/git-client.ts";
import { formatGitHead } from "../capabilities/git-client.ts";
import type { Logger } from "../logger.ts";
import type { NativeMessageIdx } from "../providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "../providers/provider-types.ts";

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

type GitViewEntry = {
  readonly nativeMessageIdx: NativeMessageIdx;
  state: GitState | undefined;
};

function cloneState(state: GitState | undefined): GitState | undefined {
  return state ? { ...state } : undefined;
}

export class GitTracker {
  private constructor(
    private readonly gitClient: GitClient,
    private readonly logger: Logger,
    private readonly history: GitViewEntry[],
  ) {}

  static create(args: {
    gitClient: GitClient;
    initialState: GitState | undefined;
    logger: Logger;
  }): GitTracker {
    return new GitTracker(args.gitClient, args.logger, [
      {
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        state: cloneState(args.initialState),
      },
    ]);
  }

  static clone(args: {
    source: GitTracker;
    nativeMessageIdx: NativeMessageIdx;
  }): GitTracker {
    return new GitTracker(
      args.source.gitClient,
      args.source.logger,
      args.source.history
        .filter((entry) => entry.nativeMessageIdx <= args.nativeMessageIdx)
        .map((entry) => ({
          nativeMessageIdx: entry.nativeMessageIdx,
          state: cloneState(entry.state),
        })),
    );
  }

  getAgentView(): GitState | undefined {
    return cloneState(this.history.at(-1)?.state);
  }

  /** Whether `getUpdate` would report something right now, without committing
   * the agent view. A probe for a request that may never be issued. */
  async hasUpdate(): Promise<boolean> {
    try {
      return coarseChanged(
        this.getAgentView(),
        await this.gitClient.getState(),
      );
    } catch (error) {
      this.logger.error(
        `GitTracker failed to read git state: ${String(error)}`,
      );
      return false;
    }
  }

  /** Polls current git state and commits the state this request will reveal. */
  async getUpdate(
    nativeMessageIdx: NativeMessageIdx,
  ): Promise<GitContextUpdate | undefined> {
    let current: GitState | undefined;
    try {
      current = await this.gitClient.getState();
    } catch (error) {
      this.logger.error(
        `GitTracker failed to read git state: ${String(error)}`,
      );
      return undefined;
    }

    const previous = this.getAgentView();
    if (!coarseChanged(previous, current)) {
      const latest = this.history.at(-1);
      if (latest) latest.state = cloneState(current);
      return undefined;
    }

    const previousIdx = this.history.at(-1)?.nativeMessageIdx;
    if (previousIdx !== undefined && nativeMessageIdx < previousIdx) {
      throw new Error(
        `Git view history must be monotonic: ${nativeMessageIdx} < ${previousIdx}`,
      );
    }
    this.history.push({ nativeMessageIdx, state: cloneState(current) });
    return { previous, current: cloneState(current) };
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

import type {
  RequestContext,
  SupervisorAction,
  ThreadSupervisor,
} from "../thread-supervisor.ts";
import { injectText } from "../thread-supervisor.ts";

/** Contributes the git status update to the request that is about to go out.
 * `GitTracker.getUpdate` commits the agent view as a side effect, which is
 * correct here: an injection is applied unconditionally. */
export class GitSupervisor implements ThreadSupervisor {
  private constructor(
    readonly gitTracker: GitTracker,
    private readonly onSent: ((update: GitContextUpdate) => void) | undefined,
  ) {}

  static create(args: {
    gitClient: GitClient;
    initialGitState: GitState | undefined;
    logger: Logger;
    onSent?: (update: GitContextUpdate) => void;
  }): GitSupervisor {
    return new GitSupervisor(
      GitTracker.create({
        gitClient: args.gitClient,
        initialState: args.initialGitState,
        logger: args.logger,
      }),
      args.onSent,
    );
  }

  static clone(args: {
    source: GitSupervisor;
    nativeMessageIdx: NativeMessageIdx;
    onSent?: (update: GitContextUpdate) => void;
  }): GitSupervisor {
    return new GitSupervisor(
      GitTracker.clone({
        source: args.source.gitTracker,
        nativeMessageIdx: args.nativeMessageIdx,
      }),
      args.onSent,
    );
  }

  async onBeforeRequest(context: RequestContext): Promise<SupervisorAction> {
    if (context.status === "suspended") return { type: "none" };
    const update = await this.gitTracker.getUpdate(context.nativeMessageIdx);
    if (!update) return { type: "none" };
    this.onSent?.(update);
    return injectText(gitUpdateToText(update));
  }

  async hasPendingContent(): Promise<boolean> {
    return this.gitTracker.hasUpdate();
  }
}
