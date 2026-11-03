import { serveWatcher } from "../../../../sdk/watchers/index.ts";
import { GhCliGitHubClient } from "./github.ts";
import {
  isFinished,
  makePoll,
  type PollState,
  render,
  summarize,
} from "./pull-request.ts";

serveWatcher<PollState>({
  manifest: new URL("./manifest.json", import.meta.url).pathname,
  intervalMs: 30_000,
  poll: makePoll(new GhCliGitHubClient()),
  isFinished,
  summarize,
  render,
});
