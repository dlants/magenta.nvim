# Objective and Context

User request (verbatim):

> We have this thing for watching Git repos that are locally checked out. I built a thing to watch pull request statuses for remotes. I'm finding that the way that I want to watch them is a little different depending on context. There may be checks that aren't really relevant or that important, and comments from specific automatic generated messages that I want to suppress, things like that. Also in the future, I might want to monitor more things like Kite builds or Terraform applies, things like that.
>
> So it kind of feels like this shouldn't be something that's built into Magenta but is rather something that the person can configure about their particular installation (in a similar way as scripts are).
>
> And another thing that I don't love right now is that we have both this "subscribe to updates of a thing" functionality and then we also want the agent to be able to wait for things via bash. There's not really a way to reuse those I guess. The polling that we're doing for pull requests isn't really observable from bash currently so the agent kind of has to implement it separately and implement its own polling loop if it wants to wait on a pull request update.
>
> I'm thinking about how we can set this up. I could see us setting up an independent process, which is like the pull request puller with an API. That would give us both the ability to customize how we want to pull for things, the ability to filter and do all of that sort of stuff. Also we would have a single pulling loop which we could access both by subscribing to it and by waiting for the update because then it would just be like a bash command that used the API.
>
> On the magenta side, the "waiting for something to happen" thing, I think we already have a solution that is a skill plus an API method that can be exercised by bash. That's pretty straightforward.
>
> I think the notification piece currently is built into Magenta and I guess I'm trying to think about how to pull that out. There are two pieces:
> 1. We currently automatically trigger subscriptions from the core. There needs to be a mechanism to signal or to automatically attach a subscription to a thread based on some combination or based on some triggers.
> 2. We need to be able to configure and define what should happen on that. This will be a separate process, a GitHub provider that is running. We need to specify commands. What is the communication between the thread and this GitHub process? Is it a polling loop? Is it a WebSocket connection?
>
> A design goal is that we should be able to subscribe and wait for arbitrary things: GitHub pull requests, repo updates, files, processes, Buildkite runs. It shouldn't really matter if it's remote or local. We should be able to vibe code. These sorts of watchers are like independent processes and Magenta should be configurable in such a way that it can kind of plug and play with them.

Current state:

- `PullRequestMonitor` (`node/server/src/pull-requests/monitor.ts`): session-owned, one refcounted poller per PR URL, ETags, backoff, dormancy via `noteAttention()`, `finished` terminal status.
- `PullRequestSupervisor` (`node/server/src/supervisors/pull-request-supervisor.ts`): per-ThreadCore `ToolLoopSupervisor`; per-URL history keyed by `nativeMessageIdx`; `diffSnapshots` + `pullRequestUpdateToText` produce injected text; `clone` filters at fork point; `untrack`.
- `PullRequestMentionScanner` (`node/server/src/pull-request-mentions.ts`): the trigger. Regex over `log.messages` (skipping injected blocks); `thread-core.ts` gates via `pullRequestTracking.isRepoAllowed` (`options.pullRequestRepos`, user-level only).
- `GitSupervisor`/`GitTracker` (`node/server/src/supervisors/git-supervisor.ts`): local, file-registration driven. Out of scope to externalize here (it is tightly coupled to FileSupervisor and must be synchronous with file edits), but the external model must be able to express a similar watcher later.
- `ScriptManager` (`node/server/src/scripts/script-manager.ts`) + `sdk/`: the precedent for user-installed TS extensions (`scriptsPaths`, `<dir>/<name>/index.ts`, spawned with `node --experimental-transform-types`).
- `ToolLoopSupervisor` (`node/server/src/thread-supervisor.ts`): `onBeforeRequest`/`hasPendingContent`/`injectText`.
- Protocol thread state (`node/server/src/protocol/state.ts`) and client PR rendering (`node/nvimclient/chat/thread-view.ts`, `node/nvimclient/chat/pull-requests.test.ts`).
- Options: `node/server/src/config/options.ts` (`pullRequestRepos`, `scriptsPaths`).

Note: the "bash-callable wait API + skill" the request refers to does not exist in the repo today. Under this design it falls out of the watcher API for free (the watcher is the thing you wait on), so magenta does not need its own.

# Design

A **watcher** is an independent, long-running process that owns polling for one domain (GitHub PRs, Buildkite, terraform, ...). It speaks newline-delimited JSON-RPC 2.0 on a unix socket. Two kinds of clients consume the same API:

- magenta (subscribe: a streaming connection per resource, injected into threads by a generic supervisor),
- the agent via bash, through whatever wait script/skill the user writes against the documented protocol (magenta ships none), which subscribes to the same resource and evaluates its own condition.

Because there is one poller per resource in the watcher, magenta subscriptions, bash waits, and multiple nvim instances all share it.

Why NDJSON JSON-RPC on a unix socket rather than HTTP, stdio or websockets:

- Must be reachable from bash without magenta in the loop → stdio is out. Bash access goes through user-written scripts (`nc -U`/`socat` or a few lines of node/python), so raw-`curl` reachability, HTTP's main advantage, is not required.
- One persistent connection carries both requests and server-pushed notifications, so subscriptions need no separate SSE channel; connection close is the natural lease boundary.
- Trivial to implement in any language (read lines, parse JSON), matches the shape of MCP/LSP and the existing script IPC.
- A unix socket in `~/.magenta/watchers/<name>.sock` gives free discovery and filesystem-permission auth. Docker threads can get the socket bind-mounted later.

Lifecycle: watchers are started lazily by whichever client needs them first (magenta, a wait script, another watcher) and exit when no clients remain. Every client runs the same connect-or-spawn: connect to the socket; if refused/missing, spawn the watcher command detached (`detached: true`, stdio to a log file, `unref()`, `MAGENTA_WATCHER_SOCKET` in env) so it never dies with the client that spawned it; retry connecting with backoff. Every client gets the command and socket from the watcher's `manifest.json` (magenta via the `watchers` option; a wait script or skill author passes the manifest path they know). This lives once in `sdk/watchers/client.ts` (`connectWatcher(manifestPath)`), used by `wait.ts`, user scripts and magenta's `WatcherTransport`. Idle exit uses a grace period (default ~30–60s with zero connections) so back-to-back bash waits reuse the warm poller/ETag cache; on idle exit the watcher closes the listener and unlinks the socket before exiting, so a client racing the shutdown gets a refused connection and takes the spawn path. This makes "is it remote or local" irrelevant: a watcher that proxies a remote service is just another process.

Multiple consumers: the watcher is a unix-socket server, so every consumer process (each magenta instance, each user wait script) is just another connection.

- Each ThreadCore opens its own connection per watcher it tracks something from (lazily, on first `track`), and closes it on dispose. No multiplexing or subscription ids: a connection's subscriptions are just a set of keys. Dozens of connections is trivial for the OS. Compaction replacement and forks open fresh connections and immediately get the cached state. Waiters likewise open their own short-lived connection.
- The watcher keeps `key -> set of (connection, filter)`. A poller exists while that set is non-empty. On each poll it renders once per distinct filter and pushes `state` to each subscription whose rendered state changed. A new subscription to an already-polled key gets the cached state immediately.
- A closed connection drops all its subscriptions, so crashes on the consumer side never leak pollers.
- Startup race (two consumers find no watcher and both spawn): the socket bind is the lock. On `EADDRINUSE` the new watcher tries to connect to the existing socket. If that succeeds it exits; if it is refused, the socket is stale, so it unlinks it and binds. Consumers retry connecting with backoff after spawning.
- Idle exit: the watcher exits only after N seconds with zero connections. A consumer that hits the shutdown window sees a refused connection and goes through the spawn path again.

Resource model (watcher-agnostic, so magenta never understands PRs):

- A resource is identified by `(watcher, key)`, where `key` is an opaque string chosen by the watcher (for GitHub: the PR URL).
- The watcher is stateless with respect to consumers: on any change it pushes the resource's full current state. No cursors, no history, no diffs in the protocol.
- A state has two parts:
  - `context`: a string blob, the agent-facing rendering of the resource (for GitHub: PR state, check results, comments). This is what ends up in context updates.
  - `summary`/`details`: the sidebar rendering.
- Because filtering/rendering live in the watcher, "suppress this bot's comments" or "ignore check X" is a change in the user's watcher code, not in magenta. A change that is filtered out does not alter the blob, so the watcher does not push it (watchers push only when the rendered state changes).
- Diffing lives entirely in magenta and is an optimization over context updates. Per resource, `WatchSupervisor` keeps the history of blobs the agent has seen, keyed by `nativeMessageIdx` (same as `GitTracker`/`PullRequestSupervisor` today). On `onBeforeRequest`, if the latest blob differs from the last-seen one it injects either the whole blob (first delivery) or a generic line diff against the last-seen blob. Fork/rewind/compaction need nothing from the watcher: the supervisor's own history already says what the thread has seen at any idx.
- Different contexts wanting different filters: a subscription may carry an opaque `filter` (watcher-defined JSON) and the watcher renders per `(key, filter)`. Where filters come from (options default, profiles by project dir) is open; v1 can ship without filters and rely on editing the watcher.

Triggers (how a resource gets attached to a thread):

- The watcher's manifest declares `triggers`: regexes matched against thread text. Capture group / whole match → `key`. The generic `MentionScanner` (generalized `PullRequestMentionScanner`) runs every enabled watcher's triggers over the same non-injected text.
- Scoping (which repos/owners to track) is encoded in the watcher itself, via its trigger regexes or by rejecting keys at `subscribe` (status `unavailable`). Magenta has no allowlist.
- Explicit attach: the agent can attach by mentioning the key (the mention is the trigger) — no new tool needed in v1. A `watch` tool is a possible follow-up.
- Detach: existing `untrack` UI generalizes to `(watcher, key)`.

Delivery into the thread: `WatchSupervisor` (generalized `PullRequestSupervisor`) on `onBeforeRequest` compares each tracked resource's latest pushed blob (cached by the supervisor from the last push on its connection, so the request path never waits on the socket) with the agent-seen blob, records history, injects full text or a diff.

Dormancy: not in the protocol. Watchers poll at one fixed interval while a key has any subscriber. Magenta handles dormancy by subscribing only while a thread is attended (running, just submitted, or recently active in a visible sidebar — the existing attention rule) and unsubscribing its keys after the dormancy timeout. On re-attention it resubscribes, immediately receives the current full state, and the supervisor diffs it against the agent-seen blob as usual, so nothing is lost. While dormant, the sidebar shows the last cached summary marked as paused. Bash waiters keep a key polled for as long as they are connected.

Bash wait: not part of magenta or the protocol. Every wait condition is a predicate over a pushed full state, so a wait is just a short-lived connection that subscribes and tests each state as it arrives. Users write this as their own script plus a skill that tells the agent to use it instead of sleep loops. Watcher authors make a condition waitable by exposing it in a blob (e.g. a `checks: 3 pending, 1 failed` line in `context`). Magenta's deliverable here is the protocol doc (`doc/watchers.md`), precise enough that a watcher or a wait script can be written from it alone.

Built-in skill: `skills/authoring-magenta-watchers/` teaches the agent to vibe code watchers and waiters. It is the protocol's documentation (there is no separate doc), and ships a reference implementation the agent copies and adapts:

- `skill.md`: when to use (user asks to watch/monitor/wait on something: PRs, CI, terraform, files, processes); the protocol (socket path, NDJSON JSON-RPC framing, methods, `state` notification, `ResourceState` fields and what each blob is for, trigger manifest); lifecycle rules a watcher must follow (bind-as-lock, idle exit, connection-scoped subscriptions, push only on rendered-state change, `unavailable` for rejected keys); how to register it in `~/.magenta/options.json`; how to write a wait script (subscribe + predicate over a blob) and a companion skill so agents use it instead of sleep loops; a short "adapting the GitHub reference" checklist (filters, triggers, rejecting repos).
- Shared library: `sdk/watchers/`, consumed exactly like the script SDK (the package dir symlinks `magenta-sdk -> <plugin>/sdk`, imports `./magenta-sdk/watchers/index.ts`). Separate entry from `sdk/index.ts` so watchers/waiters don't trigger the script IPC `activate()` side effect. Node built-ins only.
  - `protocol.ts`: `Manifest`, `ResourceState`, `ResourceStatus`, JSON-RPC message types, and `readManifest(path)`.
  - `server.ts`: `serveWatcher` — socket bind/stale-socket handling, per-key pollers refcounted by connections, render-and-compare, per-connection push, backoff, idle-exit grace period (default 60s, overridable), unlink-before-exit.
  - `client.ts`: `connectWatcher(manifestPath)` connect-or-spawn (detached spawn, retry with backoff), `subscribe`/`onState`, and `waitFor(manifestPath, key, predicate, { timeoutMs })`.
  - `wait.ts`: CLI over `waitFor` (`node wait.ts <key> --manifest <path> --field context --match <regex> [--timeout S]`), usable directly from bash.
- `reference/github-pr/{manifest.json,index.ts}`: the GitHub PR watcher on top of `sdk/watchers`, ported from `node/server/src/pull-requests/` (`gh api` with ETags, snapshot, `context`/`summary`/`details` rendering, trigger = PR URL regex). Users copy it to `~/.magenta/watchers/github-pr/` and edit it.
- `reference/git-repo/{manifest.json,index.ts}`: local repo/worktree watcher. Key = absolute worktree root (normalized via `git rev-parse --show-toplevel`; non-repos → `unavailable`). Polls `git status --porcelain=v2 --branch`, `git rev-parse HEAD`, ahead/behind vs upstream, and `git worktree list --porcelain`. `context` renders branch, HEAD subject, upstream ahead/behind, dirty/staged/untracked files, in-progress rebase/merge; `summary` is e.g. `main ↑2 ↓0, 3 dirty`. Trigger = absolute paths under user-chosen roots (default `~/src/<name>` style regex in the manifest, which is also the scoping knob). Shows that a local, non-HTTP watcher fits the same model. Complements, does not replace, the built-in `GitSupervisor` (which stays synchronous with file edits).

## Interfaces

Options (`~/.magenta/options.json` only — project options cannot add watchers, same rationale as `pullRequestRepos`):

```json
"watchers": {
  "github": {
"watchers": ["~/.magenta/watchers/github/manifest.json"]
```

Each entry points at a manifest file owned by the watcher (lives next to its code):

```json
{
  "name": "github",
  "protocolVersion": 1,
  "command": ["node", "--experimental-transform-types", "./index.ts"],
  "socket": "~/.magenta/watchers/github.sock",
  "triggers": [{ "pattern": "https://github\\.com/([^/\\s]+/[^/\\s]+/pull/\\d+)", "keyGroup": 0 }]
}
```

- Magenta reads manifests from disk, so triggers are known without spawning anything; a watcher starts only when a thread first tracks one of its keys.
- `command` is resolved and run with cwd = the manifest's directory, so relative paths work and the watcher dir is self-contained/movable.
- `socket` defaults to `~/.magenta/watchers/<name>.sock`.
- The watcher reads the same file (e.g. `serveWatcher({ manifest: "./manifest.json", ... })`) for its name/socket default, so the two never drift. Triggers live only in the manifest.
- Manifests are re-read when options reload; an unreadable/invalid manifest disables that watcher with an error in the log.

```ts
// node/server/src/config/options.ts
// ServerOptions.watchers: string[]  (manifest paths)

// Manifest file + JSON-RPC API. Canonical types in sdk/watchers/protocol.ts; node/server/src/watchers/protocol.ts mirrors them with runtime parsers (same split as the script SDK protocol).
type Manifest = {
  name: string;
  protocolVersion: 1;
  command: string[];   // run with cwd = manifest dir
  socket?: string;     // default ~/.magenta/watchers/<name>.sock
  triggers: { pattern: string; flags?: string; keyGroup?: number }[];
};
type ResourceStatus = "loading" | "active" | "failing" | "unavailable" | "finished";
type ResourceState = {
  key: string;
  status: ResourceStatus;
  context: string;           // agent-facing blob; magenta diffs successive blobs
  summary: string;           // one line for sidebar
  details?: string;          // multi-line for expanded sidebar view
  error?: string;

};
type Filter = unknown;       // watcher-defined JSON

// One JSON-RPC 2.0 message per line. Requests (client -> watcher):
//   hello()                                            -> { name: string; protocolVersion: 1 }  (sanity check on connect; manifest is read from disk, not RPC)
//   subscribe({ key: string; filter?: Filter })       -> ResourceState  (scoped to this connection; one filter per key per connection)
//   unsubscribe({ key: string })                      -> null
//   get({ key, filter? })                              -> ResourceState
//   list()                                             -> ResourceState[]

// Notifications:
//   watcher -> client: state(ResourceState)  (full state, whenever the rendered state for a key this connection subscribed changes)

```

Subscriptions belong to the connection and are released when it closes (magenta crash ≠ leaked pollers). A user's wait script is just a short-lived subscribing connection.

```ts
// sdk/watchers/server.ts
export function serveWatcher<S, F = unknown>(spec: {
  manifest: string; // path to manifest.json; supplies name and socket default
  poll(key: string, ctx: { previous: S | undefined; signal: AbortSignal }): Promise<
    { kind: "ok"; snapshot: S } | { kind: "unavailable" } | { kind: "error"; error: string }
  >;
  isFinished?(s: S): boolean;
  summarize(s: S): { summary: string; details?: string };
  render(s: S, filter: F | undefined): string; // the context blob; push happens only when render/summarize output changes
  intervalMs?: number;
}): void; // listens on MAGENTA_WATCHER_SOCKET; handles subscriptions, change detection, backoff, idle exit

// node/server/src/watchers/watcher-registry.ts — session-owned, replaces PullRequestMonitor. Loads manifest files, owns spawning; no subscriptions.
class WatcherRegistry {
  constructor(opts: { getConfig(): ServerOptions["watchers"]; fileIO: FileIO; transport: WatcherTransport; logger: Logger });
  triggers(): { watcher: string; regex: RegExp; keyGroup: number }[]; // from manifests on disk, no spawn
  connect(watcher: string): Promise<WatcherConnection>; // connects, spawning the watcher if needed
}
interface WatcherConnection {
  subscribe(key: string, filter?: Filter): Promise<ResourceState>;
  unsubscribe(key: string): void;
  onState(cb: (s: ResourceState) => void): void;
  onClose(cb: () => void): void; // supervisor reconnects and resubscribes its keys
  close(): void;
}
// WatcherTransport = the NDJSON JSON-RPC unix-socket client + spawn; faked in tests.

// node/server/src/supervisors/watch-supervisor.ts — replaces PullRequestSupervisor
type ResourceRef = { watcher: string; key: string };
class WatchSupervisor implements ToolLoopSupervisor { track(r): void; untrack(r): void; tracked(): ResourceRef[]; clone(idx): WatchSupervisor; }
```

Protocol thread state: replace `mentionedPullRequests`/PR fields with `watchedResources: (ResourceRef & ResourceState & { pendingUpdate: boolean })[]`. The bottom-of-thread watched-resources section renders each resource's `summary` line verbatim (prefixed by watcher name and status), and `details` verbatim when expanded. Magenta does not parse either blob.

## Invariants

- The request path never blocks on a watcher: `onBeforeRequest` only uses the hub cache; a change whose update text has not been fetched yet is delivered on the next request.
- Agent-seen history is keyed by `nativeMessageIdx` and fork/rewind/compaction behave exactly as with `PullRequestSupervisor` (fork filters history; compaction replacement re-subscribes and gets a warm cache).
- One poller per `(watcher, key)` across all threads, forks, nvim instances and bash waits — owned by the watcher process.
- A dead/unreachable watcher degrades to `status: "unavailable"` with an error in the sidebar; it never fails a submission.
- Watchers can only be configured at user level; a project's `.magenta/options.json` cannot add commands.
- The protocol carries only full states; any diffing is magenta-internal, so a watcher author never reasons about consumers, cursors, forks or rewinds.
- Leases are tied to a live connection; a crashed magenta does not leave a watcher polling forever.
- Injected/context text is never scanned for triggers (preserve current scanner exclusions), so watcher output mentioning other PRs cannot cascade.

# Stages

## Watcher skill: protocol, server boilerplate, wait script

Status: DONE.

- [x] `node/server/src/watchers/protocol.ts`: `WatcherManifest`, `ResourceState`, `parseWatcherManifest`, `parseResourceState`, `parseJsonRpcLine`; exported from the server barrel.
- [x] `sdk/watchers/{protocol,server,client,wait,index}.ts`; toy counter watcher at `sdk/watchers/test/fixtures/counter-watcher.ts`; tests in `sdk/watchers/test/watchers.test.ts` (9, real sockets under `/tmp`).
- [x] `skills/authoring-magenta-watchers/skill.md` (reference watchers are added in later stages).
- Decisions: relative `socket` in a manifest resolves against the manifest dir; `MAGENTA_WATCHER_SOCKET` / `MAGENTA_WATCHER_IDLE_MS` env override; `unavailable` and `finished` stop polling; errors back off `interval * 2^failures` capped by `maxBackoffMs`; `subscribe` waits for the first poll and pushes nothing for that subscription until the response is sent; `get` on an unpolled key does a one-off poll; spawned watcher logs to `<socket>.log`; `wait.ts` exits 0 on match, 2 on timeout, 1 on error/unavailable, and defaults to waiting for `finished` without `--match`.
- Note: 3 failures in `node/nvimclient/chat/thread.test.ts` are pre-existing on HEAD (unrelated).
- Review follow-up: `ResourceState` (and the sdk poller's `phase`) is a status-discriminated union, `error` required on `failing`/`unavailable` and absent elsewhere; `PollResult` `unavailable` requires `error`. The sdk now carries the same validating parsers (`parseManifestObject`, `parseResourceState`, `parseJsonRpcLine`) as `node/server/src/watchers/protocol.ts` (duplicated to keep the sdk self-contained); `readManifest`, the client and the server validate all input through them. A wire `id: null` parses to `id: undefined`. Handlers return `undefined`, mapped to `null` only at serialization; `WatcherClient.unsubscribe` returns `Promise<void>`; client results are validated. `filter` stays an opaque cast to `F` (watcher-defined). Parser reject branches tested in `node/server/src/watchers/protocol.test.ts`.

- Goal: `node/server/src/watchers/protocol.ts` (types + parsers); `skills/authoring-magenta-watchers/skill.md`; `sdk/watchers/{protocol,server,client,wait}.ts`, exercised with a toy counter watcher.
- Tests (tier B, real socket in tmp dir, run under the server vitest project so the reference code is type-checked and tested in CI):
  - subscribe → poll runs; second subscriber does not start a second poller; last unsubscribe stops polling.
  - a poll whose rendered state is unchanged (including changes hidden by `render`) pushes nothing; a changed one pushes the full state to every subscriber.
  - a second connection subscribing to an already-polled key gets the current state immediately and shares the poller.
  - connection close releases its subscriptions; idle exit after no connections; a second instance started against a live socket exits, against a stale socket takes over.
  - errors back off and surface `failing`; `unavailable` is terminal.
  - `wait.ts` returns as soon as a pushed state matches (including the initial one) and exits non-zero on timeout.
  - magenta's `protocol.ts` parsers accept everything `sdk/watchers/server.ts` emits (shared fixture).

## Reference GitHub watcher

Status: DONE.

- [x] `skills/authoring-magenta-watchers/reference/github-pr/{manifest.json,index.ts,github.ts,pull-request.ts,github-pr.test.ts}`; skill.md section on adapting it.
- [x] `tsconfig.json` includes `skills/**/*.ts`; the server vitest project includes `skills/**/*.test.ts`.
- Decisions: code is copied (not moved) from `node/server/src/pull-requests/` and `capabilities/github-client.ts`, since the built-in path stays in use until stage 6 deletes it. The ETag cache lives in the poll snapshot (`PollState = { pr, cache }`) so it is per key and dropped with the poller; `render` ignores it. `render` emits the full snapshot (one fact per line, comments carry `updated <ts>` so edits change the blob); the old `diffSnapshots`/update text is not ported because diffing moves into magenta. 404 → `unavailable`; other errors → `error` (sdk backoff; `Retry-After` and the old 3-failure stop / dormancy are not ported). Finished = not open and no pending checks. The reference imports the sdk relatively (`../../../../sdk/watchers/index.ts`); users switch to the `magenta-sdk` symlink when copying. Monitor tests ported: normalization, ETag/304 reuse, failure not committing the cache, head change, 404, finished; poller-sharing/backoff/dormancy tests belong to the sdk (stage 1) or magenta (stage 4).
- Review follow-up: static imports in `github-pr.test.ts`; table-driven tests for `parseGhApiOutput` (no status line, 304, empty/bad-JSON 2xx, JSON error message, CRLF) and `rateLimitDelayMs` (now exported). `EtagCache` entries require `etag: string`; responses without an ETag are not cached.

- Goal: `reference/github-pr/` on `sdk/watchers`, moving `GitHubClient`, snapshot fetch with ETags, and text rendering out of `node/server/src/pull-requests/`. Trigger regex is today's PR URL regex.
- Tests: port existing monitor/diff unit tests to the watcher's `poll`/`render`/`summarize` with a fake `gh`; `context` output covers the same information as today's full-snapshot text.

## Reference git repo watcher

Status: DONE.

- [x] `skills/authoring-magenta-watchers/reference/git-repo/{manifest.json,index.ts,git-repo.ts,git-repo.test.ts}`; skill.md section.
- Decisions: keys normalize inside `poll` (the sdk keys pollers by the raw key, so `/repo` and `/repo/sub` are separate pollers with identical rendering; triggers capture the repo-level dir so this rarely matters). A nonexistent path walks up to the nearest existing dir before `rev-parse`. In-progress operations are detected via git-dir markers (rebase-merge/apply, MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, BISECT_LOG). Interval 10s. Default trigger `/Users/[^/\s]+/src/<name>`. Tests exercise `poll`/`render` on real tmp repos (socket push semantics are covered by stage 1 sdk tests).

- Review follow-up: snapshot types tightened: `head: HeadState` (`branch` with optional oid for unborn | `detached` with oid), `upstream: { name, ahead, behind } | undefined`, `FileChange.state: ChangeState` literal union, `operation: RepoOperation`. Added tests: pure `parseStatus` fixture (rename w/ origPath, `u` conflict, spaces, `(initial)`/`(detached)`, `branch.ab`), merge conflict in a linked worktree (per-worktree git-dir markers), nonexistent/relative keys, upstream ahead/behind via bare clone, detached HEAD summary.

- Goal: `reference/git-repo/` on `sdk/watchers` as described above.
- Tests (tier B, real tmp git repos + a linked worktree):
  - subscribing by a subdirectory path normalizes to the worktree root; a non-repo path is `unavailable`.
  - committing, staging, dirtying a file, and checking out a branch each push a changed state; a poll with no git changes pushes nothing.
  - linked worktree and main worktree are separate keys with independent state.
  - trigger regex matches absolute paths under the configured root and not elsewhere.

## Magenta WatcherRegistry + WatchSupervisor

Status: DONE.

- [x] `watchers: string[]` in `ServerOptions` (parsed by `parseOptions` only, so project options can't add watchers); added to `SERVER_OPTION_KEYS`.
- [x] `node/server/src/watchers/watcher-registry.ts` (`WatcherRegistry`, `WatcherTransport`, `WatcherConnection`, `LoadedWatcherManifest`, `ResourceRef`), `socket-transport.ts` (`SocketWatcherTransport`, NDJSON client + detached connect-or-spawn, server-side copy of the sdk client), `mention-scanner.ts` (generic `MentionScanner` over registry triggers).
- [x] `node/server/src/supervisors/watch-supervisor.ts` (`WatchSupervisor`, `diffBlobs`, `watchUpdateToText`); wired in `thread-core.ts` (`watchTracking` context, `watched` seed, `ContextDelivery.watched`), `thread.ts` (`watchedResources`, `untrackWatchedResource`, `noteAttention`, compaction seeds), `session.ts` (`watcherRegistry`, `markAttended` → `thread.noteAttention()`), both hosts, `in-process-server.ts`.
- [x] `FakeWatcherTransport` in `test/fakes.ts`; harness `watchers` option; `supervisors/watch-supervisor.test.ts` (9 tests).
- Deviations/decisions:
  - `WatchSupervisor` runs alongside `PullRequestSupervisor` instead of replacing it, so the existing PR view/protocol keep working until stages 5/6; the PR path is only active via `pullRequestRepos`.
  - Diff text is changed lines only (`- old` / `+ new`, via the `diff` package), under `## <watcher>: <key> (changed lines)`; first delivery is `## <watcher>: <key>` + full blob. An empty `context` with nothing seen injects nothing (so `unavailable` with no blob is silent).
  - Compaction replacement seeds the new core with each resource's agent-seen blob (`WatchSeed.seen`, history entry at idx 0), so it is not re-delivered (the old PR path re-delivered the full snapshot).
  - Dormancy: supervisor checks `now - getLastAttention() >= 5min` every 30s, on `onBeforeRequest`, and on `Session.markAttended`; dormant → unsubscribe all keys, keep the last state, `paused: true` in the view.
  - Connection drop → reconnect after 1s and resubscribe; connect failure → resources become `unavailable` ("watcher unreachable: ...") with `subscribed=false` (no automatic retry until re-tracked/re-attended).
  - Registry `load()` is async (fs read); `in-process-server.ts` fires it at startup. Manifests are not re-read on options reload yet. Tests use `setManifests`.
- Review follow-up: `WatcherName` brand (`protocol.ts`) on `ResourceRef.watcher`, manifest `name`, trigger matchers and `connect`. `WatchSeed` is `{ seen: "never" } | { seen: "blob"; context }`; seeded blobs are kept as per-resource baselines (superseded by history) instead of fake idx-0 history entries. Every `ProviderMessageContent` variant has `nativeMessageIdx`, so both mention scanners read it without a cast. Added tests: reconnect after drop (fake timers) + no resubscribe after dispose, rejected resubscribe keeps prior context/summary, stale subscribe result after dormancy (`FakeWatcherTransport` gained `dropConnections`, `rejectSubscribe`, `holdSubscribes`); `watchers/mention-scanner.test.ts` (multi-key global regex, injected blocks skipped, incremental append); `watchers/socket-transport.test.ts` (tier B real socket: split-line framing, push, close; connect timeout).

- Goal: `watchers` option parsed (user-level only); `WatcherRegistry` loads manifests and auto-spawns; each `WatchSupervisor` owns one connection per watcher it uses (reconnecting and resubscribing on drop) and caches the latest pushed state; `MentionScanner` uses manifest triggers; `WatchSupervisor` replaces `PullRequestSupervisor` in `thread-core.ts`/`thread.ts`; supervisors unsubscribe after the dormancy timeout and resubscribe on attention. Old PR path still present but unused behind no config.
- Tests (tier A, fake `WatcherTransport` in `test/fakes.ts`, harness):
  - mentioning a matching key in a user message subscribes once; a key the watcher rejects shows as `unavailable`.
  - first delivery injects the full blob; a later push injects a diff against the agent-seen blob; an identical push injects nothing and `hasPendingContent` is false; delivery is recorded as a context delivery.
  - fork at an earlier idx diffs against the blob seen at the fork point; compaction replacement does not re-deliver an already-seen blob.
  - a thread going dormant unsubscribes its keys (the fake watcher sees no subscribers); on attention it resubscribes and a change that happened meanwhile is injected as one diff.
  - unreachable watcher → `unavailable` state, submission still succeeds.
  - project options cannot add a watcher.

## Protocol + client view

- Goal: `watchedResources` in thread protocol state; sidebar renders summaries/details and untrack for any watcher; remove PR-specific protocol fields and views.
- Tests: tier A on protocol state shape; port `node/nvimclient/chat/pull-requests.test.ts` to tier C rendering of generic resources (one test for render + untrack keymap).

## Remove built-in PR tracking

- Goal: delete `PullRequestMonitor`, `PullRequestSupervisor`, `pullRequestRepos` (parse error message pointing to the `watchers` option), and their wiring in `in-process-server.ts`/`session.ts`/`server-session-host.ts`. Update dotfiles options to the `watchers` shape and copy both reference watchers there.
- Tests: full `npx vitest run`, `npx tsc -b`, `npx biome check .`.

# Open questions

- Explicit `watch`/`unwatch` agent tool vs. mention-only triggers.
- Can `GitSupervisor` eventually become a watcher? Probably not (needs synchronous consistency with edits), so keep it built in.
- Docker threads: bind-mount watcher sockets so bash `wait` works inside containers?
