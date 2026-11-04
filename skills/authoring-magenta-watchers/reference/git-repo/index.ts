import { serveWatcher } from "../../../../sdk/watchers/index.ts";
import {
  makeScan,
  poll,
  type RepoSnapshot,
  render,
  summarize,
} from "./git-repo.ts";

/** Scoping knob: only paths under these roots are tracked. */
const ROOTS = ["~/src"];

serveWatcher<RepoSnapshot>({
  manifest: new URL("./manifest.json", import.meta.url).pathname,
  scan: makeScan(ROOTS),
  intervalMs: 10_000,
  poll: (key) => poll(key),
  summarize,
  render,
});
