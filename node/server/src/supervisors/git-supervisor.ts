import type { GitClient, GitState } from "../capabilities/git-client.ts";
import { formatGitHead } from "../capabilities/git-client.ts";
import type { Logger } from "../logger.ts";
import type { NativeMessageIdx } from "../providers/provider-types.ts";
import type { AbsFilePath } from "../utils/files.ts";

export type GitRepoUpdate =
  | { type: "registered"; repoRoot: AbsFilePath; current: GitState }
  | {
      type: "changed";
      repoRoot: AbsFilePath;
      previous: GitState | undefined;
      current: GitState;
    }
  | { type: "gone"; repoRoot: AbsFilePath; previous: GitState };
export type GitContextUpdate = { repos: GitRepoUpdate[] };

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

/** Per-repo agent views. A repo's first history entry is the point it was
 * first shown to the agent, which is what forks filter on. */
type RepoHistories = Map<AbsFilePath, GitViewEntry[]>;
type RepoRead =
  | { kind: "new"; root: AbsFilePath; state: GitState | undefined }
  | { kind: "tracked"; root: AbsFilePath; state: GitState | undefined };

export class GitTracker {
  /** Registered roots not yet shown to the agent. */
  private readonly pending = new Set<AbsFilePath>();
  private readonly registrations = new Set<Promise<void>>();

  private constructor(
    private readonly gitClient: GitClient,
    private readonly logger: Logger,
    private readonly repos: RepoHistories,
  ) {}

  static create(args: {
    gitClient: GitClient;
    initialState: GitState | undefined;
    logger: Logger;
  }): GitTracker {
    const repos: RepoHistories = new Map();
    if (args.initialState) {
      repos.set(args.initialState.repoRoot, [
        { nativeMessageIdx: PRE_HISTORY, state: cloneState(args.initialState) },
      ]);
    }
    return new GitTracker(args.gitClient, args.logger, repos);
  }

  static clone(args: {
    source: GitTracker;
    nativeMessageIdx: NativeMessageIdx;
    gitClient?: GitClient;
    logger?: Logger;
  }): GitTracker {
    const repos: RepoHistories = new Map();
    for (const [root, history] of args.source.repos) {
      const kept = history
        .filter((entry) =>
          historyIdxAtOrBefore(entry.nativeMessageIdx, args.nativeMessageIdx),
        )
        .map((entry) => ({
          nativeMessageIdx: entry.nativeMessageIdx,
          state: cloneState(entry.state),
        }));
      if (kept.length) repos.set(root, kept);
    }
    return new GitTracker(
      args.gitClient ?? args.source.gitClient,
      args.logger ?? args.source.logger,
      repos,
    );
  }

  get trackedRepoRoots(): ReadonlyArray<AbsFilePath> {
    return [...this.repos.keys()];
  }
  /** The state the agent last saw, per tracked repo root. */
  getAgentView(): Map<AbsFilePath, GitState | undefined> {
    return new Map(
      [...this.repos].map(([root, history]) => [
        root,
        cloneState(history.at(-1)?.state),
      ]),
    );
  }

  /** Starts tracking the repository containing `path`, if any. Its state is
   * reported in full with the next update. */
  registerPath(path: AbsFilePath): Promise<void> {
    const registration = this.gitClient
      .findRepoRoot(path)
      .then((root) => {
        if (root && !this.repos.has(root)) this.pending.add(root);
      })
      .catch((error: unknown) => {
        this.logger.error(
          `GitTracker failed to find repo for ${path}: ${String(error)}`,
        );
      })
      .finally(() => this.registrations.delete(registration));
    this.registrations.add(registration);
    return registration;
  }

  private async readAll(): Promise<RepoRead[]> {
    await Promise.all(this.registrations);
    const roots = [
      ...[...this.repos.keys()].map((root) => ({
        root,
        kind: "tracked" as const,
      })),
      ...[...this.pending].map((root) => ({ root, kind: "new" as const })),
    ];
    const results = await Promise.all(
      roots.map(async ({ root, kind }): Promise<RepoRead | undefined> => {
        try {
          const state = await this.gitClient.getState(root);
          return { root, kind, state };
        } catch (error) {
          this.logger.error(
            `GitTracker failed to read git state for ${root}: ${String(error)}`,
          );
          return undefined;
        }
      }),
    );
    return results.filter((r) => r !== undefined);
  }

  /** Whether `getUpdate` would report something right now, without committing
   * the agent view. A probe for a request that may never be issued. */
  async hasUpdate(): Promise<boolean> {
    const views = this.getAgentView();
    return (await this.readAll()).some(({ root, kind, state }) =>
      kind === "new"
        ? state !== undefined
        : coarseChanged(views.get(root), state),
    );
  }

  /** Polls every tracked repo and commits the states this request will reveal. */
  async getUpdate(
    nativeMessageIdx: NativeMessageIdx,
  ): Promise<GitContextUpdate | undefined> {
    const reads = await this.readAll();
    const repos: GitRepoUpdate[] = [];
    for (const { root, kind, state } of reads) {
      if (kind === "new") {
        this.pending.delete(root);
        if (!state) continue;
        this.repos.set(root, [{ nativeMessageIdx, state: cloneState(state) }]);
        repos.push({
          type: "registered",
          repoRoot: root,
          current: { ...state },
        });
        continue;
      }
      const history = this.repos.get(root);
      if (!history) continue;
      const latest = history.at(-1);
      const previous = cloneState(latest?.state);
      if (!coarseChanged(previous, state)) {
        if (latest) latest.state = cloneState(state);
        continue;
      }
      if (
        latest &&
        historyIdxPrecedes(nativeMessageIdx, latest.nativeMessageIdx)
      ) {
        throw new Error(
          `Git view history must be monotonic: ${nativeMessageIdx} < ${formatHistoryIdx(latest.nativeMessageIdx)}`,
        );
      }
      history.push({ nativeMessageIdx, state: cloneState(state) });
      if (state) {
        repos.push({
          type: "changed",
          repoRoot: root,
          previous,
          current: { ...state },
        });
      } else if (previous) {
        repos.push({ type: "gone", repoRoot: root, previous });
      }
    }
    return repos.length ? { repos } : undefined;
  }
}

function repoUpdateToText(update: GitRepoUpdate): string {
  if (update.type === "gone") {
    return `## ${update.repoRoot}\n\nNo longer a git repository.`;
  }
  const { current } = update;
  return [
    `## ${current.repoRoot}`,
    "",
    update.type === "changed"
      ? "The git repository state has changed:"
      : "Now tracking this git repository:",
    `- Repository root: ${current.repoRoot}`,
    `- Branch: ${current.branch ?? "(detached HEAD)"}`,
    `- HEAD: ${formatGitHead(current)}`,
    `- Changes: ${current.stagedCount} staged, ${current.unstagedCount} unstaged, ${current.untrackedCount} untracked`,
  ].join("\n");
}

/** Builds the message text describing a git context update shown to the agent. */
export function gitUpdateToText(update: GitContextUpdate): string {
  return ["# Git status update", ...update.repos.map(repoUpdateToText)].join(
    "\n\n",
  );
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

  registerPath(path: AbsFilePath): Promise<void> {
    return this.gitTracker.registerPath(path);
  }

  async hasPendingContent(): Promise<boolean> {
    return this.gitTracker.hasUpdate();
  }
}
