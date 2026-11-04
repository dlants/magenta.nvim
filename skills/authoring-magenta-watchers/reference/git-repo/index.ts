import { serveWatcher } from "../../../../sdk/watchers/index.ts";
import { poll, type RepoSnapshot, render, summarize } from "./git-repo.ts";

serveWatcher<RepoSnapshot>({
  manifest: new URL("./manifest.json", import.meta.url).pathname,
  // TODO(watcher-scan stage 3): real scan.
  scan: () => [],
  intervalMs: 10_000,
  poll: (key) => poll(key),
  summarize,
  render,
});
