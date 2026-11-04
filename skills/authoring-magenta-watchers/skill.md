---
name: authoring-magenta-watchers
description: How to write magenta watchers (independent processes that poll something — PRs, CI, terraform, files, processes — and push state to magenta threads) and bash wait scripts on top of them. Use when the user asks to watch, monitor, or wait on something.
---

# Watchers

A watcher is a long-running process owning polling for one domain. It serves newline-delimited JSON-RPC 2.0 on a unix socket. Magenta subscribes to resources and injects their state into threads; bash wait scripts subscribe to the same resources, so there is one poller per resource for everyone. Never write ad-hoc `sleep` polling loops when a watcher can do it.

## Layout

A watcher lives in its own directory, e.g. `~/.magenta/watchers/<name>/`:

- `manifest.json`
- `index.ts` (calls `serveWatcher`)
- `magenta-sdk` → symlink to `<magenta plugin>/sdk` (import `./magenta-sdk/watchers/index.ts`; do not import `sdk/index.ts`, which activates script IPC)

Register it in `~/.magenta/options.json` (user level only; project options cannot add watchers):

```json
{ "watchers": ["~/.magenta/watchers/<name>/manifest.json"] }
```

## Manifest

```json
{
  "name": "github",
  "protocolVersion": 1,
  "command": ["node", "--experimental-transform-types", "./index.ts"],
  "socket": "~/.magenta/watchers/github.sock",
  "triggers": [{ "pattern": "https://github\\.com/[^/\\s]+/[^/\\s]+/pull/\\d+", "keyGroup": 0 }]
}
```

- `command` runs with cwd = the manifest's directory.
- `socket` defaults to `~/.magenta/watchers/<name>.sock`; relative paths resolve against the manifest dir. The spawner also passes it as `MAGENTA_WATCHER_SOCKET`.
- `triggers`: regexes (optional `flags`, `keyGroup` default 0) matched against thread text (never against injected watcher output). The match/group is the resource key. Scope what gets tracked (repos, owners, roots) here, or reject keys by returning `unavailable` from `poll`.

## Protocol

One JSON object per line, JSON-RPC 2.0. Requests (client → watcher):

- `hello()` → `{ name, protocolVersion: 1 }`
- `subscribe({ key, filter? })` → `ResourceState` (current state; waits for the first poll). Subscriptions belong to the connection; one filter per key per connection.
- `unsubscribe({ key })` → `null`
- `get({ key, filter? })` → `ResourceState` (one-off; does not keep polling)
- `list()` → `ResourceState[]` of currently polled keys

Notification (watcher → client): `{"jsonrpc":"2.0","method":"state","params":ResourceState}` — the full state, sent only when the rendered state of a key this connection subscribed to changes.

```ts
type ResourceState = {
  key: string;
  status: "loading" | "active" | "failing" | "unavailable" | "finished";
  context: string;   // agent-facing text injected into threads; magenta diffs successive blobs
  summary: string;   // one sidebar line
  details?: string;  // expanded sidebar text
  error?: string;
};
```

`filter` is watcher-defined JSON passed to `render`.

## Lifecycle rules (handled by `serveWatcher`)

- Bind is the lock: on `EADDRINUSE` connect to the socket; if it answers, exit; if refused, unlink the stale socket and bind.
- One poller per key while any connection subscribes; connection close drops its subscriptions.
- Push only when `render`/`summarize` output changes — filtered-out changes push nothing.
- `unavailable` and `finished` stop polling; errors become `failing` with exponential backoff.
- Idle exit: after `idleExitMs` (default 60s) with zero connections, close, unlink the socket, exit.
- Clients connect-or-spawn: on a refused/missing socket they spawn `command` detached (log at `<socket>.log`) and retry.

## Writing a watcher

```ts
import { serveWatcher } from "./magenta-sdk/watchers/index.ts";

type Snapshot = { state: string; failing: string[] };

serveWatcher<Snapshot, { ignoreChecks?: string[] }>({
  manifest: "./manifest.json",
  intervalMs: 30_000,
  async poll(key, { previous, signal }) {
    // fetch; return { kind: "ok", snapshot } | { kind: "unavailable", error? } | { kind: "error", error }
  },
  isFinished: (s) => s.state === "merged",
  summarize: (s) => ({ summary: `${s.state}, ${s.failing.length} failing` }),
  render: (s, filter) => `state: ${s.state}\nfailing: ${s.failing.filter((c) => !filter?.ignoreChecks?.includes(c)).join(", ")}`,
});
```

Guidance:

- Put suppression (noisy bots, irrelevant checks) in `render`, so it never reaches the agent and never triggers a push.
- Make wait conditions greppable: render stable lines such as `checks: 3 pending, 1 failed` or `status: merged`.
- Keep `context` deterministic (stable ordering, no timestamps that change every poll), or every poll pushes.
- Test with `node --experimental-transform-types index.ts` and the wait CLI below. Logs go to `<socket>.log`.

## Reference: GitHub PR watcher

`reference/github-pr/` (next to this file) is a complete watcher: `manifest.json` (trigger = PR URL), `github.ts` (`gh api --include` client with ETags), `pull-request.ts` (snapshot fetch, normalization, `render`/`summarize`/`isFinished`), `index.ts` (wiring), and tests with a fake `gh`. To adapt it:

- Copy the dir to `~/.magenta/watchers/github-pr/`, symlink `magenta-sdk -> <plugin>/sdk` there and change the `../../../../sdk/watchers/index.ts` imports to `./magenta-sdk/watchers/index.ts`.
- Filter checks/bot comments in `render` (and `summarize`); filtered-out changes then push nothing.
- Scope repos by narrowing the trigger pattern, or by returning `unavailable` from `poll` for rejected keys.
- Rate-limit `Retry-After` is reported as an error and falls back to the sdk's exponential backoff.

## Reference: git repo watcher

`reference/git-repo/` watches local repos/worktrees, showing that a non-HTTP watcher fits the same model. Key = any absolute path inside a worktree, normalized to the worktree root (non-repos are `unavailable`). `git-repo.ts` polls `git status --porcelain=v2 --branch`, the HEAD subject, in-progress rebase/merge markers and `git worktree list`; `render` lists branch, HEAD, upstream ahead/behind, conflicted/staged/unstaged/untracked files and other worktrees; `summary` is e.g. `main ↑2 ↓0, 3 dirty`. The manifest trigger (`/Users/<user>/src/<name>`) is the scoping knob: edit it to match your checkout roots. Note distinct paths into the same worktree are distinct keys that share nothing but the rendering.

## Waiting from bash

The sdk ships a CLI over `waitFor`:

```bash
node --experimental-transform-types <plugin>/sdk/watchers/wait.ts <key> \
  --manifest ~/.magenta/watchers/github/manifest.json \
  --match '^checks: 0 pending' [--field context|summary|details|status] [--timeout 1800]
```

It matches against the current state first, then each pushed state; prints the field and exits 0; exits 2 on timeout, 1 on error (including `unavailable`). Without `--match` it waits for `status: finished`.

For richer conditions write a script with `waitFor(manifestPath, key, predicate, { timeoutMs })` or `connectWatcher(manifestPath)` (`subscribe`, `onState`, `get`, `list`).

Pair a wait script with a small skill telling agents to use it instead of sleep loops, e.g. "To wait for CI on a PR, run `wait-pr-checks <url>`".
