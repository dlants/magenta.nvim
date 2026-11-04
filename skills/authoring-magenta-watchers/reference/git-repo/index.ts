import { serveWatcher } from "../../../../sdk/watchers/index.ts";
import { poll, type RepoSnapshot, render, summarize } from "./git-repo.ts";

serveWatcher<RepoSnapshot>({
  manifest: new URL("./manifest.json", import.meta.url).pathname,
  intervalMs: 10_000,
  poll: (key) => poll(key),
  summarize,
  render,
});
