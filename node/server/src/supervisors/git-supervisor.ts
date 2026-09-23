import type { GitClient, GitState } from "../capabilities/git-client.ts";
import { formatGitHead } from "../capabilities/git-client.ts";
import type { Logger } from "../logger.ts";
import type { NativeMessageIdx } from "../providers/provider-types.ts";

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
  readonly nativeMessageIdx: HistoryIdx;
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
        nativeMessageIdx: PRE_HISTORY,
        state: cloneState(args.initialState),
      },
    ]);
  }

  static clone(args: {
    source: GitTracker;
    nativeMessageIdx: NativeMessageIdx;
    gitClient?: GitClient;
    logger?: Logger;
  }): GitTracker {
    return new GitTracker(
      args.gitClient ?? args.source.gitClient,
      args.logger ?? args.source.logger,
      args.source.history
        .filter((entry) =>
          historyIdxAtOrBefore(entry.nativeMessageIdx, args.nativeMessageIdx),
        )
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
    if (
      previousIdx !== undefined &&
      historyIdxPrecedes(nativeMessageIdx, previousIdx)
    ) {
      throw new Error(
        `Git view history must be monotonic: ${nativeMessageIdx} < ${formatHistoryIdx(previousIdx)}`,
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
  ToolLoopSupervisor,
} from "../thread-supervisor.ts";
import { injectText } from "../thread-supervisor.ts";
import {
  formatHistoryIdx,
  type HistoryIdx,
  historyIdxAtOrBefore,
  historyIdxPrecedes,
  PRE_HISTORY,
} from "./history.ts";

/** Contributes the git status update to the request that is about to go out.
 * `GitTracker.getUpdate` commits the agent view as a side effect, which is
 * correct here: an injection is applied unconditionally. */
export type GitSupervisorCallbacks = {
  /** A git update was just committed into the request going out, into the
   * message at `nativeMessageIdx`. */
  onSent?: (
    update: GitContextUpdate,
    nativeMessageIdx: NativeMessageIdx,
  ) => void;
};

export class GitSupervisor implements ToolLoopSupervisor {
  /** Assigned by the owner once it exists; a retired supervisor drops them. */
  callbacks: GitSupervisorCallbacks = {};

  private constructor(readonly gitTracker: GitTracker) {}

  static create(args: {
    gitClient: GitClient;
    initialGitState: GitState | undefined;
    logger: Logger;
  }): GitSupervisor {
    return new GitSupervisor(
      GitTracker.create({
        gitClient: args.gitClient,
        initialState: args.initialGitState,
        logger: args.logger,
      }),
    );
  }

  static clone(args: {
    source: GitSupervisor;
    nativeMessageIdx: NativeMessageIdx;
    gitClient?: GitClient;
    logger?: Logger;
  }): GitSupervisor {
    return new GitSupervisor(
      GitTracker.clone({
        ...args,
        source: args.source.gitTracker,
        nativeMessageIdx: args.nativeMessageIdx,
      }),
    );
  }

  async onBeforeRequest(context: RequestContext): Promise<SupervisorAction> {
    const update = await this.gitTracker.getUpdate(context.nativeMessageIdx);
    if (!update) return { type: "none" };
    this.callbacks.onSent?.(update, context.nativeMessageIdx);
    return injectText(gitUpdateToText(update));
  }

  async hasPendingContent(): Promise<boolean> {
    return this.gitTracker.hasUpdate();
  }
}
