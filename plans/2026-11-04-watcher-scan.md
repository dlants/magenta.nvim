# Objective and Context

User request (verbatim):

> Okay what I want you to do next is look in ~/src/dotfiles/ and configure it to set up magenta properly to support repo & PR watching for my macos machine. We should track repose and worktrees in ~/src (some of them are nested, make sure you also catch absolute paths).
>
> We should track PRs under https://github.com/dlants
>
> Make sure you test the process starting/stopping behavior and triggers.
>
> Also, set up a wait skill for the PR - I want to be able to wait until a PR has:
>
> - all green tests
> - a new failing test
> - a new comment

> Yeah I think we should rethink the way that the trigger works. Maybe the way that we do it is we send the text to the watcher instead of configuring regexes. We send text to the watcher and then the watcher returns the available keys within that text. If we're using a regular expression we can do that inside the watcher logic or we can look up files or do whatever else we need to.

Problem: the manifest `triggers` regexes (from `plans/2026-11-03-external-watchers.md`) can't know repo boundaries. Repos and worktrees under `~/src` nest (`~/src/gatherus/main`, `~/src/magenta-dev/<wt>`, `~/src/book-review/pkb`), so a trigger must match whole paths, and the matched string becomes the key verbatim. `~/src/a/x.ts` and `~/src/a/y.ts` become two resources (two pollers, two sidebar rows, duplicate context) for one repo. The watcher can't canonicalize either, because `WatchSupervisor.applyState` looks resources up by `state.key`.

Relevant files:

- `sdk/watchers/protocol.ts`: `Trigger`, `Manifest`, parsers (sdk copy).
- `sdk/watchers/server.ts`: `serveWatcher`, `WatcherSpec`, request dispatch in `handle`.
- `sdk/watchers/client.ts`: `WatcherClient`, `connectWatcher`, `waitFor`.
- `node/server/src/watchers/protocol.ts`: magenta-side manifest/state parsers.
- `node/server/src/watchers/watcher-registry.ts`: `WatcherRegistry` (`setManifests` compiles triggers, `triggers()`, `connect`), `WatcherConnection`, `WatcherTriggerMatcher`.
- `node/server/src/watchers/socket-transport.ts`: NDJSON client implementing `WatcherConnection`.
- `node/server/src/watchers/mention-scanner.ts`: incremental per-native-message scan with `SKIPPED_BLOCK_TYPES`; `mentioned` refs.
- `node/server/src/thread-core.ts`: builds `MentionScanner` with `registry.triggers()` and feeds `mentioned` into `watchSupervisor.track`.
- `node/server/src/supervisors/watch-supervisor.ts`: per-core connections per watcher, `track`/`untrack`, dormancy.
- `node/server/src/test/fakes.ts`: `FakeWatcherTransport`.
- `skills/authoring-magenta-watchers/{skill.md,reference/github-pr,reference/git-repo}`.
- `~/src/dotfiles/magenta-watchers/{github-pr,git-repo}`, `magenta-options-darwin.json`, `nix/common.nix` (`~/.magenta/watchers` symlink, `magenta-sdk` links), `nix/magenta-skills.nix`, `magenta-skills/`.

# Design

The watcher owns key extraction. Manifests drop `triggers`; watchers answer a `scan` request with the canonical keys found in some text. Returned keys are exactly what `subscribe` will be called with, so dedupe across mentions is key equality, and the watcher may use any logic (regex, fs, `git rev-parse`). The git-repo watcher resolves any path under `~/src` (file or dir, absolute or `~`) to its worktree root.

Magenta side: `MentionScanner` keeps its per-native-message incremental bookkeeping and block-type exclusions, but instead of regex matching it gathers the strings of each new message and asks the thread's `WatchSupervisor` to scan them with every configured watcher. The supervisor uses its existing per-watcher connection (connect-or-spawn), tracks the returned keys, and, if it then has no subscriptions on that watcher, closes the connection so the watcher can still idle-exit. Scanning stays async and off the request path.

What gets scanned: the string leaves of each new block (not `JSON.stringify` of the message: escaping turns newlines into literal `\n`, which breaks path/URL regexes, and adds ids/signatures/base64), skipping `data` fields and `citations`. Included: user and assistant `text`, `tool_use` inputs (bash commands, file paths), all `tool_result` content (file reads incl. markdown plans, bash output, subagent results). Excluded block types:

- injected context: `system_reminder`, `system_info`, `context_update`, `thread_context`, `fork_notification` (watch updates arrive as `context_update`; excluding these prevents cascades; tracked-file diffs are lost, but paths/URLs in edited or read files still appear in the tool call/result).
- search: `server_tool_use`, `web_search_tool_result`, and `citations` on `text` blocks.
- reasoning: `thinking`, `redacted_thinking`.
- binary: `image`, `document`.

Costs accepted:

- Any thread with new messages starts every configured watcher (previously only on a match). Mitigated by idle exit.
- Non-injected thread text is sent to user-configured watcher processes (user-level options only, same trust as today).
- A scan that fails (unreachable, error, timeout) is logged and not retried; that message's mentions for that watcher are missed.

Then dotfiles: copy the updated references, scope github-pr to `dlants`, git-repo to `~/src`, and add a PR wait script + skill.

## Interfaces

```ts
// sdk/watchers/protocol.ts and node/server/src/watchers/protocol.ts
type Manifest = {
  name: string;
  protocolVersion: 1;
  command: string[];
  socket?: string;
};
type ScanParams = { texts: string[] };
type ScanResult = { keys: string[] };
//   scan(ScanParams) -> ScanResult   (pure: no subscription, no polling)

// sdk/watchers/server.ts
type WatcherSpec<S, F> = {
  // ...existing fields
  scan(texts: string[]): string[] | Promise<string[]>;
};
export function regexScan(
  patterns: Array<{ pattern: RegExp; keyGroup?: number }>,
): (texts: string[]) => string[]; // global matching, deduped

// sdk/watchers/client.ts
class WatcherClient { scan(texts: string[]): Promise<string[]>; }

// node/server/src/watchers/watcher-registry.ts
interface WatcherConnection { /* existing */ scan(texts: string[]): Promise<string[]>; }
class WatcherRegistry { names(): ReadonlyArray<WatcherName>; /* triggers() and WatcherTriggerMatcher removed */ }

// node/server/src/supervisors/watch-supervisor.ts
class WatchSupervisor {
  /** Scans with every configured watcher, tracks returned keys. Never throws. */
  scan(texts: string[]): Promise<void>;
}

// node/server/src/watchers/mention-scanner.ts
new MentionScanner(getMessages, scan: (texts: string[]) => Promise<void>);
```

Scan payload cap: per call at most 256KB total; strings longer than 64KB are truncated. Scan timeout 5s.

PR wait (dotfiles `magenta-watchers/github-pr/wait-pr.ts`, built on `connectWatcher`/`subscribe`/`onState`):

```
node wait-pr.ts <pr-url> --until green|new-failure|new-comment [--timeout S]
```

- `green`: no pending checks and no failing checks (matches immediately if already green).
- `new-failure`: a check failing now that was not failing in the state at wait start.
- `new-comment`: a comment (issue or review) whose id/timestamp line was not in the state at wait start.
- Exit codes as `wait.ts`: 0 matched (prints the matching state), 2 timeout, 1 error/unavailable. Predicates parse the github-pr `context` blob, so its check/comment line formats are the contract; tests pin them.

## Invariants

- Excluded block types (injected context, search, thinking, binary; see Design) are never sent to `scan`, so watcher output can't cascade into more tracking.
- The request path never waits on a scan.
- A key the user untracked (`dd`) is not re-tracked by later scans returning it.
- Scan failures never fail a submission.
- A supervisor holds a watcher connection only while it has subscriptions there or a scan is in flight, so watchers idle-exit when nothing is tracked.
- Keys returned by `scan` are canonical: two mentions of the same repo/PR produce one resource.

# Stages

## Protocol + sdk scan

- Goal: `scan` request in both protocol copies; manifests drop `triggers`; `WatcherSpec.scan`, `regexScan`, `WatcherClient.scan`; counter fixture implements scan.
- Tests (tier B, real socket): scan round trip returns deduped keys; scan on a connection with no subscriptions doesn't start a poller.
- Status: done.
  - sdk: `scan` request + `ScanParams`/`ScanResult`, `triggers` dropped from sdk `Manifest`/parser (extra fields ignored), `WatcherSpec.scan` (server dedupes results), `regexScan`, `WatcherClient.scan`; counter fixture scans `counter:<path>`; test in `sdk/watchers/test/watchers.test.ts`.
  - Deviation: magenta-side `protocol.ts` only gained `ScanParams`/`ScanResult`/`parseScanResult`; its `triggers` field stays until Stage 2 removes `registry.triggers()`, so the tree keeps working between stages (the sdk test manifest still carries `triggers` for that reason; drop it in Stage 2).
  - Reference watchers got placeholder `scan: () => []` (TODO for Stage 3) to typecheck.
  - Review follow-up: added tests for a malformed `scan` request (JSON-RPC error) and a pure `regexScan` unit test (default whole match, pre-existing `g`, empty groups). `parseScanResult` rejection tests are deferred to Stage 2, when it gets a caller.
  - Pre-existing failures unrelated to this stage: 3 snapshot mismatches in `node/nvimclient/chat/thread.test.ts` (fail on the stashed tree too).

## Magenta scanning

- Goal: `WatcherConnection.scan` in socket transport and `FakeWatcherTransport`; `WatchSupervisor.scan` with connection close-after-scan; `MentionScanner` calls it; registry `triggers()` removed.
- Tests (tier A, harness + fake transport):
  - a user message mentioning two files in one repo (fake scan canonicalizes) tracks one resource.
  - text, tool_use input and tool_result strings reach the fake watcher's `scan`; injected context, thinking, web search results and citations do not; newlines arrive as real newlines.
  - scan failure: submission succeeds, nothing tracked, error logged.
  - untracked key returned by a later scan stays untracked.
  - after scanning with no keys, the supervisor's connection to that watcher is closed.
- Status: done.
  - `triggers` removed from magenta `WatcherManifest`/parser and the sdk test manifest; registry gained `names()` and `logError()`.
  - `WatchSupervisor.scan` counts in-flight scans per watcher; `closeIfUnused` runs after each scan and on `untrack`. An unreachable watcher during scan is logged as a scan failure (not shown as an unavailable resource, since nothing is tracked).
  - `MentionScanner` skips fields `type`, `id`, `data`, `citations` (type/id strings are noise), filters empty strings, batches to 256KB, truncates strings to 64KB; scans are fire-and-forget. Unit tests in `mention-scanner.test.ts`; harness tests in `watch-supervisor.test.ts`; `FakeWatcherTransport` gained `scanners`/`scanCalls`.
  - Reference watcher tests that read `triggers` (git-repo, github-pr) now read the raw manifest JSON; Stage 3 replaces them.
  - Scan timeout (5s) not implemented in the socket transport yet; a hung watcher only delays that scan.
  - Review follow-up: tests for scan batching/truncation/empty filtering, overlapping scans keeping the connection open, connection staying open while a scanned key is subscribed and closing after untrack, and `parseScanResult` rejection; `FakeWatcherTransport` scanners/scanCalls keyed by `WatcherName`.

## Reference watchers + skill doc

- Goal: github-pr `scan` via `regexScan`; git-repo `scan` = path candidates (absolute + `~`) under configured roots → expand `~` → strip trailing punctuation → walk up to an existing dir → `git rev-parse --show-toplevel` → dedupe; non-repos dropped. skill.md documents `scan` instead of triggers.
- Tests (tier B, real tmp repos): nested repo inside a repo, linked worktree, file path inside repo, `~` path, trailing `.`/`)`/`:12`, non-repo path → no key.

## Dotfiles config + PR wait skill

- Goal: `~/src/dotfiles/magenta-watchers` updated from references (github-pr scoped to `https://github.com/dlants/`, git-repo root `~/src`), `wait-pr.ts`, `magenta-skills/wait-pr/skill.md` registered in `nix/magenta-skills.nix`; `home-manager switch` applied.
- Tests:
  - `wait-pr.ts` predicates against fixture `context` blobs (green, already green, new failure vs pre-existing failure, new comment vs existing).
  - Manual against real watchers: scan of text mentioning `~/src/magenta.nvim/node/x.ts`, `/Users/denis.lantsman/src/gatherus/main`, a `dlants` PR URL and a non-`dlants` PR URL returns the expected keys; first client spawns the watcher (socket + log appear), a second client reuses it (one process), after last disconnect + idle window the process exits and socket is unlinked; `wait-pr.ts` against a real `dlants` PR.
