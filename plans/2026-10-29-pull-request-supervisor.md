# Objective and Context

User request (verbatim):

> Let's actually change the pull request into a supervisor as well. For any pull request that's mentioned I want to spin up a loop that periodically pulls from the GitHub API to verify or track the status of the pull request and notify the agent of any changes. The things that I want to pay attention to are our test statuses: any check updates relative to when the pull request was mentioned, and also comments. [...] do we want to initialize it by just pasting all the check statuses and comments that are present at the moment that it's mentioned? I guess we should. Whenever it's mentioned we should initialize the thing and pull it. The same thing as with the git status is that whenever we get a chance we enqueue updates about the thing. When we display the PR status we should show a summary of what is happening with the checks: which checks are pending or how many checks are pending, succeeded, or errored. If there are errored checks we should show, ideally, the name of the check and the URL where you can see the status of the check. Show this always at the bottom and if we have any pending updates we should show that in terms of a context update thing, the same way that we do for files.

Follow-ups: don't skip any comments (including the user's own and bots'). No push API is available to a local client (webhooks need a public endpoint), so poll at a constant 30s with ETag conditional requests. Be careful not to abuse GitHub's API, and be resilient to failed polls.

Dormancy follow-up: "we should extend it if the thread is dormant. If the thread hasn't had any user activity in a while, we should fall back to maybe polling every 5 minutes gradually and then reset it whenever we see user activity." Agreed rule: attention = thread running, a user submission, or a throttled `thread.markAttended` ping from the client while the thread is the active one in a visible sidebar and nvim sees CursorMoved/FocusGained/BufEnter.

Key entities:

- `PullRequestMentionScanner` (`node/server/src/pull-request-mentions.ts`): finds PR URLs in provider messages off the hot path. Stays the mention detector and feeds the new supervisor.
- `GitSupervisor`/`GitTracker` (`node/server/src/supervisors/git-supervisor.ts`): the pattern to copy. Per-key history of agent-seen states keyed by `nativeMessageIdx`, `getUpdate(idx)` commits, `hasUpdate()` probes, `clone` filters history at the fork point, `onSent` callback records a `ContextDelivery`.
- `ToolLoopSupervisor`/`injectText` (`node/server/src/thread-supervisor.ts`): `onBeforeRequest` + `hasPendingContent`.
- `ThreadCore` (`node/server/src/thread-core.ts`): owns supervisors, `ContextDelivery`, `recordDelivery`, `ThreadCoreContext`.
- `Thread.contextSupervisors` (`node/server/src/thread.ts`): request-time ordering.
- `ServerSessionHost` (`node/server/src/server-session-host.ts`): builds `ThreadCoreContext` (~L434).
- `Session` (`node/server/src/session.ts`): session-lifetime owner; disposes resources.
- Protocol thread state (`node/server/src/protocol/state.ts`): currently exposes `mentionedPullRequests`.
- Client view (`node/nvimclient/chat/thread-view.ts`, `node/nvimclient/context/context-manager.ts`): renders deliveries (`renderGitUpdate`) and the bottom-of-thread sections.
- Test fakes (`node/server/src/test/fakes.ts`), harness (`node/server/src/test/harness.ts`).

# Design

Three layers:

1. `GitHubClient` capability: one conditional GET. Implemented with the host's `gh api` (reuses the user's gh auth; works for docker threads too since PR status does not depend on the container). Faked in tests.
2. `PullRequestMonitor`: session-owned, one poller per PR URL shared by every thread (and fork) that tracks it, refcounted. Keeps the latest `PullRequestSnapshot`, polls every 30s with per-endpoint ETags, backs off on failures, stops when the PR is finished. Never touches thread state; notifies subscribers when the snapshot changes.
3. `PullRequestSupervisor`: per-ThreadCore, mirrors `GitTracker`. The mention scanner calls `track(url)`, which subscribes to the monitor. Per PR it keeps the history of snapshots the agent has seen. `onBeforeRequest` diffs each latest snapshot against the agent's view and commits synchronously from cache, so the request path never waits on the network. First delivery of a PR is the full snapshot; later ones are diffs.

Why session-level sharing: a parent, its forks, subagents and compaction replacements commonly mention the same PR; per-thread pollers would multiply requests. Sharing also means a compaction replacement core re-subscribes to a warm snapshot.

Polling per PR, each request with `If-None-Match` (304s don't count against the rate limit):

- `GET repos/{o}/{r}/pulls/{n}` → state, merged, draft, title, head sha
- `GET repos/{o}/{r}/commits/{sha}/check-runs?per_page=100`
- `GET repos/{o}/{r}/commits/{sha}/status` (legacy statuses)
- `GET repos/{o}/{r}/issues/{n}/comments?per_page=100`
- `GET repos/{o}/{r}/pulls/{n}/comments?per_page=100` (review comments)
- `GET repos/{o}/{r}/pulls/{n}/reviews?per_page=100`

Requests within a poll run sequentially. A poll's results are applied atomically: if any request fails, the snapshot is left unchanged (no half-updated snapshot). Pagination beyond the first 100 is out of scope for v1 (noted on the snapshot as `truncated`).

Failure handling:

- Any failure (non-zero gh exit, parse error, 5xx) increments `consecutiveFailures` and records `lastError`; the next poll is delayed `min(30s * 2^failures, 10min)`. Success resets.
- 403/429 with `retry-after` or `x-ratelimit-remaining: 0`: wait until `retry-after`/`x-ratelimit-reset`, at minimum the backoff.
- 404 (deleted PR / no access): mark `unavailable`, stop polling.
- Failures never reach the agent as updates; they're shown in the bottom view only.
- Polling stops when the PR is closed/merged and no check is pending; it resumes never (a reopened PR would be re-detected only on the next mention; acceptable for v1).

Dormancy (separate from failure backoff; the effective delay is the max of the two):

- Each subscription supplies `getLastAttention(): number` (ms epoch; `Infinity`/now while the thread is running). The poller uses the max across its subscribers.
- `idle = now - lastAttention`. If `idle < 5min` the interval is 30s. Otherwise it doubles per poll from 60s (60, 120, 240) capped at 5min.
- `PullRequestMonitor.noteAttention()` (called by Session whenever attention is recorded for any thread) resets dormant pollers: the interval returns to 30s, and if the last poll is more than 30s old the poller polls immediately (rescheduling its timer; never overlapping an in-flight poll).
- Attention is tracked on the Session record as `lastAttentionTime`, distinct from `lastActivityTime` (which is bumped by agent updates). Set on: `thread.markAttended` op, user submissions through Session/protocol. A running thread counts as attended now.

The monitor is driven by `setTimeout` per PR, cleared on last unsubscribe and on session dispose (cancellation rules in `node/server/src/context.md`: the timer loop is a leaf; `dispose` clears the handle and an in-flight poll's result is dropped).

## Interfaces

```ts
// node/server/src/capabilities/github-client.ts
export type GitHubResponse =
  | { type: "ok"; body: unknown; etag: string | undefined }
  | { type: "not-modified" }
  | { type: "error"; status: number | undefined; message: string;
      retryAfterMs: number | undefined };
export interface GitHubClient {
  get(path: string, etag: string | undefined): Promise<GitHubResponse>;
}
export class GhCliGitHubClient implements GitHubClient {} // execFile("gh", ["api", "--include", "-H", `If-None-Match: ${etag}`, path]); parses status line + headers + JSON body; never throws.

// node/server/src/pull-requests/types.ts
export type PullRequestRef = { url: string; owner: string; repo: string; number: number };
export type CheckStatus = "pending" | "success" | "failure" | "neutral" | "skipped";
export type PullRequestCheck = { name: string; status: CheckStatus; url: string | undefined };
export type PullRequestComment = {
  id: string; // "issue:123" | "review_comment:456" | "review:789"
  kind: "issue" | "review_comment" | "review";
  author: string; body: string; url: string; updatedAt: string;
  path?: string; line?: number; reviewState?: string;
};
export type PullRequestSnapshot = {
  ref: PullRequestRef;
  title: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  headSha: string;
  checks: PullRequestCheck[];
  comments: PullRequestComment[];
  truncated: boolean;
};
export type PullRequestUpdate =
  | { type: "tracked"; snapshot: PullRequestSnapshot }
  | { type: "changed"; ref: PullRequestRef; title: string;
      stateChange?: { from: PullRequestSnapshot["state"]; to: PullRequestSnapshot["state"] };
      headChange?: { from: string; to: string };
      checks: Array<{ check: PullRequestCheck; previous: CheckStatus | undefined }>;
      comments: Array<{ comment: PullRequestComment; edited: boolean }> };
export type PullRequestContextUpdate = { pullRequests: PullRequestUpdate[] };

// node/server/src/pull-requests/monitor.ts (session-owned)
export type PullRequestPollStatus =
  | { type: "loading" }
  | { type: "ok"; lastPolledAt: number; nextPollAt: number }
  | { type: "failing"; consecutiveFailures: number; lastError: string; nextPollAt: number }
  | { type: "unavailable"; message: string }
  | { type: "finished" };
export class PullRequestMonitor {
  constructor(deps: { client: GitHubClient; logger: Logger; intervalMs?: number; now?: () => number });
  subscribe(url: string, sub: { onChange: () => void; getLastAttention: () => number }): () => void; // returns unsubscribe; first subscriber starts polling immediately
  noteAttention(): void;
  getSnapshot(url: string): PullRequestSnapshot | undefined;
  getStatus(url: string): PullRequestPollStatus;
  dispose(): void;
}

// node/server/src/supervisors/pull-request-supervisor.ts (per ThreadCore)
export class PullRequestSupervisor implements ToolLoopSupervisor {
  callbacks: { onSent?: (u: PullRequestContextUpdate, idx: NativeMessageIdx) => void; onChanged?: () => void };
  static create(args: { monitor: PullRequestMonitor }): PullRequestSupervisor;
  static clone(args: { source: PullRequestSupervisor; nativeMessageIdx: NativeMessageIdx; monitor?: PullRequestMonitor }): PullRequestSupervisor;
  track(url: string): void;               // idempotent; called by the mention scanner
  get trackedPullRequests(): ReadonlyArray<string>;
  /** Latest snapshot + whether it differs from the agent's view + poll status. */
  getViewState(): PullRequestViewState[];
  onBeforeRequest(ctx: RequestContext): Promise<SupervisorAction>;
  hasPendingContent(): Promise<boolean>;
  dispose(): void;                          // unsubscribes everything
}

// ThreadCoreContext gains: pullRequestMonitor: PullRequestMonitor; getLastAttention: () => number
// protocol/operations.ts gains: { type: "thread.markAttended"; threadId: ThreadId } → Ok
// Session gains: markAttended(id), record.lastAttentionTime; calls monitor.noteAttention()
// ContextDelivery gains: pullRequests?: PullRequestContextUpdate

// protocol/state.ts: replaces mentionedPullRequests
export type PullRequestViewState = {
  url: string;
  snapshot: PullRequestSnapshot | undefined;
  status: PullRequestPollStatus;
  pending: PullRequestUpdate | undefined; // what the next request would deliver
};
pullRequests: ReadonlyArray<PullRequestViewState>;
```

Diff rules (`diffSnapshots(seen, latest)`):

- state changes and head sha changes are reported. On a head change, every check of the new head is reported (previous undefined) since the check set is reset.
- a check is reported if it is new or its status changed; keyed by name.
- a comment is reported if its id is new (`edited: false`) or its `updatedAt` changed (`edited: true`). Deleted comments are not reported.
- no change → no update.

Agent text: a `# Pull request update` section per PR with title/state/head, checks as `- name: status (url)`, and comments with author, kind, file:line for review comments, url, and the body.

Bottom-of-thread view (always shown when any PR is tracked, replacing the current `# mentioned pull requests:`):

```
# pull requests:
- https://github.com/o/r/pull/12 (open) checks: 2 pending, 5 passed, 1 failed (polled 40s ago)
  - failed: lint https://github.com/o/r/actions/runs/...
  - [pending update: 1 check, 2 comments]
  - poll failing (3x): <message>
```

## Invariants

- The request path never awaits GitHub: `onBeforeRequest`/`hasPendingContent` read cached snapshots only.
- One poller per URL per session regardless of how many threads/forks/cores track it; the last unsubscribe stops it. No timer outlives `Session` disposal.
- A poll never applies a partial snapshot; failures leave the previous snapshot in place.
- Polls never overlap for the same URL; the next one is scheduled only after the previous settles.
- Agent-view history is monotonic in `nativeMessageIdx` and fork-filtered exactly like `GitTracker` (a PR first shown after the fork point is untracked in the fork; the fork re-tracks it if the scanner finds the mention in its retained messages).
- Before the first successful poll a tracked PR has no snapshot and produces no update; the first delivery after that is `tracked` with everything.
- Poll failures are never delivered to the agent.
- Compaction replacement disposes the old core's supervisor (unsubscribe) before or after the new one subscribes; sharing keeps the snapshot warm either way.

# Stages

## GitHub client

Status: DONE. `node/server/src/capabilities/github-client.ts` (`GhCliGitHubClient`, exported `parseGhApiOutput`, injectable `execFile`/`now`), `FakeGitHubClient` in `test/fakes.ts` (`setResponse(path, response | () => Promise)`, `calls`; unscripted paths return a 404 error), tests in `github-client.test.ts`. Decisions: output is parsed from stdout regardless of exit code (gh exits 1 on 304/4xx but still prints the response with `--include`); `retryAfterMs` is a required `number | undefined` field (also changed in the interface above), only defined for 403/429 rate limits, from `retry-after` seconds or `x-ratelimit-reset` when `x-ratelimit-remaining: 0`.

- Goal: `GitHubClient` interface, `GhCliGitHubClient` parsing of `gh api --include` output (status, `etag`, `retry-after`, `x-ratelimit-*`, body), and a `FakeGitHubClient` in `test/fakes.ts` (scripted responses per path, records calls with etags, can be made to fail).
- Tests:
  - parsing of captured `gh api --include` outputs for 200, 304, 403 rate-limited, 404 and a non-zero exit with no output.
  - `If-None-Match` header is passed when an etag is supplied (assert on the args given to an injected execFile).

## Monitor

Status: DONE. `node/server/src/pull-requests/types.ts` (snapshot types + `parsePullRequestUrl`), `pull-requests/monitor.ts` (`PullRequestMonitor`, exported `normalizeSnapshot`/`checkRunStatus`), tests in `monitor.test.ts`. Decisions: `Session` takes `new Session(host, { pullRequestMonitor })` (optional, exposed as `session.pullRequestMonitor`, disposed first in `Session.dispose`); the composition root passes a `GhCliGitHubClient` monitor, the harness passes one over `TestSessionHost.github` (a `FakeGitHubClient`). Each poll caches `{etag, body}` per path and commits the cache only when the whole poll succeeds, so a 304 reuses the stored body. A poll stops between requests once the poller is stopped. Subscribers are notified when the snapshot changes or the status changes (first success, failing, unavailable, finished); 304-only polls don't notify. Check-run conclusions: success→success, neutral→neutral, skipped/stale→skipped, everything else (failure, timed_out, cancelled, action_required, ...)→failure; non-completed→pending. Legacy statuses: error/failure→failure. `truncated` is set when `check_runs.total_count` exceeds the page or a comment list hits 100. Failure delay = `max(min(30s*2^failures, 10min), retryAfterMs)`. `noteAttention` reschedules dormant pollers to `lastSettledAt + max(30s, failureDelay)` (immediate if overdue). Non-PR URLs are `unavailable` without polling. Review follow-up: `Poller` lifecycle is one `phase` union (`idle{timer} | inFlight | stopped`); terminal statuses set `stopped` via `finish`. Invalid URLs never create a poller (`subscribe` returns a no-op unsubscribe; `getStatus` reports `unavailable` for them). `getStatus` returns `undefined` for unsubscribed valid URLs. A stopped poll yields a distinct `{type:"stopped"}` result. `PullRequestComment` is a union on `kind` with template-literal ids (`path`/`line` on review_comment, `reviewState: ReviewState` literal union on review). Session-level dispose is covered only by the monitor dispose test. Pre-existing nvim-tier flakes (spawn-subagents, script-manager) fail on the baseline too.

- Goal: `PullRequestMonitor` polls, normalizes into `PullRequestSnapshot`, shares per URL, backs off, stops, disposes. Owned by `Session`, created in the composition root with `GhCliGitHubClient`, `TestSessionHost` uses the fake.
- Tests (vitest fake timers + `FakeGitHubClient`):
  - two subscribers to one URL produce one poll per interval; last unsubscribe stops polling; dispose stops polling with a poll in flight and drops its result.
  - second poll sends stored etags; 304 on everything keeps the snapshot and does not notify.
  - check-runs and statuses are merged into one check list with the right status mapping (queued/in_progress → pending, conclusion mapping, legacy `error`/`failure` → failure).
  - one failing endpoint in a poll leaves the previous snapshot unchanged, sets `failing`, and the next poll is delayed by the backoff; success resets.
  - rate-limit response delays until reset; 404 → `unavailable`, no further polls.
  - merged PR with no pending checks → `finished`, no further polls.
  - dormancy: with attention 10 minutes old, successive polls are 60s, 120s, 240s, 300s, 300s apart; `noteAttention` after the 300s gap polls immediately and returns to 30s; a subscriber reporting a running thread keeps a shared poller at 30s while another subscriber is dormant.
  - failure backoff and dormancy combine as max.

## Supervisor and core wiring

- Goal: `PullRequestSupervisor` replaces direct use of `mentionedPullRequests`; scanner feeds `track`; registered in `Thread.contextSupervisors` after git; deliveries recorded as `ContextDelivery.pullRequests`; clone on fork; dispose on core disposal.
- Tests (tier A harness, mock provider, fake GitHub client):
  - a user message mentioning a PR → after the monitor's first poll, the next request contains the full snapshot (all checks and comments); a delivery record exists at that native idx.
  - a check flips to failure and a comment is added between requests → the next request contains only those; no change → nothing injected.
  - an idle thread does not start a request when the PR changes, but `hasPendingContent` is true and the next user submission carries the update.
  - forking before the PR's first delivery leaves the fork without that history (fork re-delivers in full); forking after keeps the agent view.
  - compaction replacement keeps the poller alive (no extra polls) and the new core's view.
  - edited comment reported with `edited: true`; head change reports the full new check set.

## Attention signal

- Goal: Session `lastAttentionTime` + `markAttended` + `thread.markAttended` op; user submissions and running state count; client sends `thread.markAttended` (throttled to once per minute per thread) when the thread is active in a visible sidebar and nvim fires CursorMoved/FocusGained/BufEnter. Wire `getLastAttention` into `ThreadCoreContext` and `noteAttention` into the monitor.
- Tests:
  - tier A: `thread.markAttended` updates attention and wakes a dormant poller (fake timers); agent updates do not change `lastAttentionTime`.
  - tier C: moving the cursor in nvim while the thread is shown sends one `thread.markAttended` within the throttle window; with the sidebar hidden none is sent.

## Protocol and view

- Goal: `pullRequests: PullRequestViewState[]` in thread protocol state; bottom section with check counts, failed check names + URLs, pending-update marker, poll status; inline rendering of delivered PR updates (like `renderGitUpdate`).
- Tests:
  - tier A: protocol thread state reflects snapshot, pending update and status transitions.
  - tier C (one test): rendered thread shows the summary line, failed check line with URL, and pending marker, and the inline delivery after a request.
