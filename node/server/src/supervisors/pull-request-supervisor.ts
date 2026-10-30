import type { NativeMessageIdx } from "../providers/provider-types.ts";
import type { PullRequestMonitor } from "../pull-requests/monitor.ts";
import type {
  CheckStatus,
  PullRequestCheck,
  PullRequestComment,
  PullRequestRef,
  PullRequestSnapshot,
} from "../pull-requests/types.ts";
import type {
  RequestContext,
  SupervisorAction,
  ToolLoopSupervisor,
} from "../thread-supervisor.ts";
import { injectText } from "../thread-supervisor.ts";

export type PullRequestUpdate =
  | { type: "tracked"; snapshot: PullRequestSnapshot }
  | {
      type: "changed";
      ref: PullRequestRef;
      title: string;
      stateChange?: {
        from: PullRequestSnapshot["state"];
        to: PullRequestSnapshot["state"];
      };
      headChange?: { from: string; to: string };
      checks: Array<{
        check: PullRequestCheck;
        previous: CheckStatus | undefined;
      }>;
      comments: Array<{ comment: PullRequestComment; edited: boolean }>;
    };
export type PullRequestContextUpdate = { pullRequests: PullRequestUpdate[] };

export function diffSnapshots(
  seen: PullRequestSnapshot,
  latest: PullRequestSnapshot,
): PullRequestUpdate | undefined {
  const headChanged = seen.headSha !== latest.headSha;
  const seenChecks = new Map(seen.checks.map((c) => [c.name, c.status]));
  const checks = latest.checks
    .filter(
      (check) => headChanged || seenChecks.get(check.name) !== check.status,
    )
    .map((check) => ({
      check,
      previous: headChanged ? undefined : seenChecks.get(check.name),
    }));
  const seenComments = new Map(seen.comments.map((c) => [c.id, c.updatedAt]));
  const comments = latest.comments.flatMap((comment) => {
    const updatedAt = seenComments.get(comment.id);
    if (updatedAt === undefined) return [{ comment, edited: false }];
    return updatedAt !== comment.updatedAt ? [{ comment, edited: true }] : [];
  });
  const stateChanged = seen.state !== latest.state;
  if (!stateChanged && !headChanged && !checks.length && !comments.length) {
    return undefined;
  }
  return {
    type: "changed",
    ref: latest.ref,
    title: latest.title,
    ...(stateChanged
      ? { stateChange: { from: seen.state, to: latest.state } }
      : {}),
    ...(headChanged
      ? { headChange: { from: seen.headSha, to: latest.headSha } }
      : {}),
    checks,
    comments,
  };
}

function checkLine(check: PullRequestCheck, previous?: CheckStatus): string {
  const change = previous ? ` (was ${previous})` : "";
  const url = check.url ? ` ${check.url}` : "";
  return `- ${check.name}: ${check.status}${change}${url}`;
}

function commentText(comment: PullRequestComment, edited: boolean): string {
  const where =
    comment.kind === "review_comment" && comment.path
      ? ` on ${comment.path}${comment.line !== undefined ? `:${comment.line}` : ""}`
      : "";
  const review =
    comment.kind === "review" && comment.reviewState
      ? ` (${comment.reviewState})`
      : "";
  const kind = comment.kind.replace("_", " ");
  return `### ${edited ? "Edited " : ""}${kind} by ${comment.author}${where}${review}\n${comment.url}\n\n${comment.body}`;
}

function updateToText(update: PullRequestUpdate): string {
  if (update.type === "tracked") {
    const s = update.snapshot;
    return [
      `## ${s.ref.url}`,
      "",
      "Now tracking this pull request:",
      `- Title: ${s.title}`,
      `- State: ${s.state}${s.draft ? " (draft)" : ""}`,
      `- Head: ${s.headSha}`,
      ...(s.truncated
        ? ["- Some lists were truncated to the first 100 entries."]
        : []),
      "",
      "Checks:",
      ...(s.checks.length ? s.checks.map((c) => checkLine(c)) : ["(none)"]),
      "",
      "Comments:",
      ...(s.comments.length
        ? s.comments.map((c) => commentText(c, false))
        : ["(none)"]),
    ].join("\n");
  }
  const lines = [
    `## ${update.ref.url}`,
    "",
    `Pull request "${update.title}" changed:`,
  ];
  if (update.stateChange) {
    lines.push(
      `- State: ${update.stateChange.from} -> ${update.stateChange.to}`,
    );
  }
  if (update.headChange) {
    lines.push(`- Head: ${update.headChange.from} -> ${update.headChange.to}`);
  }
  if (update.checks.length) {
    lines.push(
      "",
      "Checks:",
      ...update.checks.map((c) => checkLine(c.check, c.previous)),
    );
  }
  if (update.comments.length) {
    lines.push(
      "",
      "Comments:",
      ...update.comments.map((c) => commentText(c.comment, c.edited)),
    );
  }
  return lines.join("\n");
}

export function pullRequestUpdateToText(
  update: PullRequestContextUpdate,
): string {
  return [
    "# Pull request update",
    ...update.pullRequests.map(updateToText),
  ].join("\n\n");
}

type ViewEntry = {
  readonly nativeMessageIdx: NativeMessageIdx;
  readonly snapshot: PullRequestSnapshot;
};

export type PullRequestSupervisorCallbacks = {
  onSent?: (
    update: PullRequestContextUpdate,
    nativeMessageIdx: NativeMessageIdx,
  ) => void;
  /** A tracked PR's snapshot or poll status changed. */
  onChanged?: () => void;
};

/** Per-core agent view of the pull requests mentioned in the thread. Reads
 * only the monitor's cached snapshots, so the request path never waits on
 * GitHub. Mirrors `GitTracker`: per-PR history keyed by native message idx. */
export class PullRequestSupervisor implements ToolLoopSupervisor {
  /** Assigned by the owner once it exists; a retired supervisor drops them. */
  callbacks: PullRequestSupervisorCallbacks = {};
  private readonly subscriptions = new Map<string, () => void>();
  private disposed = false;

  private constructor(
    private readonly monitor: PullRequestMonitor,
    private readonly getLastAttention: () => number,
    private readonly histories: Map<string, ViewEntry[]>,
  ) {
    for (const url of histories.keys()) this.track(url);
  }

  static create(args: {
    monitor: PullRequestMonitor;
    getLastAttention?: () => number;
    track?: ReadonlyArray<string>;
  }): PullRequestSupervisor {
    const supervisor = new PullRequestSupervisor(
      args.monitor,
      args.getLastAttention ?? Date.now,
      new Map(),
    );
    for (const url of args.track ?? []) supervisor.track(url);
    return supervisor;
  }

  /** Keeps the agent view as of `nativeMessageIdx`; a PR first shown after it
   * is dropped until the fork's scanner finds its mention again. */
  static clone(args: {
    source: PullRequestSupervisor;
    nativeMessageIdx: NativeMessageIdx;
    monitor?: PullRequestMonitor;
  }): PullRequestSupervisor {
    const histories = new Map<string, ViewEntry[]>();
    for (const [url, history] of args.source.histories) {
      const kept = history.filter(
        (entry) => entry.nativeMessageIdx <= args.nativeMessageIdx,
      );
      if (kept.length) histories.set(url, kept);
    }
    return new PullRequestSupervisor(
      args.monitor ?? args.source.monitor,
      args.source.getLastAttention,
      histories,
    );
  }

  track(url: string): void {
    if (this.disposed || this.subscriptions.has(url)) return;
    this.subscriptions.set(
      url,
      this.monitor.subscribe(url, {
        onChange: () => this.callbacks.onChanged?.(),
        getLastAttention: this.getLastAttention,
      }),
    );
  }

  get trackedPullRequests(): ReadonlyArray<string> {
    return [...this.subscriptions.keys()];
  }

  /** The snapshot the agent last saw for `url`. */
  getAgentView(url: string): PullRequestSnapshot | undefined {
    return this.histories.get(url)?.at(-1)?.snapshot;
  }

  /** What the next request would deliver for `url`. */
  getPending(url: string): PullRequestUpdate | undefined {
    const latest = this.monitor.getSnapshot(url);
    if (!latest) return undefined;
    const seen = this.getAgentView(url);
    return seen
      ? diffSnapshots(seen, latest)
      : { type: "tracked", snapshot: latest };
  }

  private pendingUpdates(): Array<{
    url: string;
    snapshot: PullRequestSnapshot;
    update: PullRequestUpdate;
  }> {
    return this.trackedPullRequests.flatMap((url) => {
      const update = this.getPending(url);
      const snapshot = this.monitor.getSnapshot(url);
      return update && snapshot ? [{ url, snapshot, update }] : [];
    });
  }

  onBeforeRequest(context: RequestContext): Promise<SupervisorAction> {
    const pending = this.pendingUpdates();
    if (!pending.length) return Promise.resolve({ type: "none" });
    for (const { url, snapshot } of pending) {
      const history = this.histories.get(url) ?? [];
      const last = history.at(-1);
      if (last && context.nativeMessageIdx < last.nativeMessageIdx) {
        throw new Error(
          `Pull request view history must be monotonic: ${context.nativeMessageIdx} < ${last.nativeMessageIdx}`,
        );
      }
      history.push({ nativeMessageIdx: context.nativeMessageIdx, snapshot });
      this.histories.set(url, history);
    }
    const update = { pullRequests: pending.map((p) => p.update) };
    this.callbacks.onSent?.(update, context.nativeMessageIdx);
    return Promise.resolve(injectText(pullRequestUpdateToText(update)));
  }

  hasPendingContent(): Promise<boolean> {
    return Promise.resolve(this.pendingUpdates().length > 0);
  }

  dispose(): void {
    this.disposed = true;
    this.callbacks = {};
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
  }
}
