import { FakeGitHubClient } from "@magenta/server/src/test/fakes.ts";
import { setGitHubClient } from "@magenta/server/src/test-helpers.ts";
import { it } from "vitest";
import { serverSession } from "../test/left-thread.ts";
import { withDriver } from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";

const URL = "https://github.com/o/r/pull/12";
const ok = (body: unknown) => ({
  type: "ok" as const,
  body,
  etag: undefined,
});

it("renders the pull request summary and inline deliveries", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const session = serverSession(driver.magenta.chat);
    const monitor = session.pullRequestMonitor;
    if (!monitor) throw new Error("no monitor");
    const gh = new FakeGitHubClient();
    gh.setResponse(
      "repos/o/r/pulls/12",
      ok({
        title: "Fix",
        state: "open",
        merged: false,
        draft: false,
        head: { sha: "s" },
      }),
    );
    gh.setResponse(
      "repos/o/r/commits/s/check-runs?per_page=100",
      ok({
        total_count: 2,
        check_runs: [
          {
            name: "lint",
            status: "completed",
            conclusion: "failure",
            html_url: "https://ci/lint",
          },
          {
            name: "test",
            status: "in_progress",
            conclusion: null,
            html_url: "https://ci/test",
          },
        ],
      }),
    );
    gh.setResponse("repos/o/r/commits/s/status", ok({ statuses: [] }));
    for (const p of [
      "repos/o/r/issues/12/comments?per_page=100",
      "repos/o/r/pulls/12/comments?per_page=100",
      "repos/o/r/pulls/12/reviews?per_page=100",
    ])
      gh.setResponse(p, ok([]));
    setGitHubClient(monitor, gh);

    await driver.inputMagentaText(`Watch ${URL}`);
    await driver.send();
    (await driver.mockAnthropic.awaitPendingStream()).respond({
      stopReason: "end_turn",
      text: "ok",
      toolRequests: [],
    });
    await pollUntil(() => {
      if (!monitor.getSnapshot(URL)) throw new Error("no snapshot");
    });
    await driver.assertDisplayBufferContains("# pull requests:");
    await driver.assertDisplayBufferContains(
      `- ${URL} (open) checks: 1 pending, 0 passed, 1 failed`,
    );
    await driver.assertDisplayBufferContains(
      "  - failed: lint https://ci/lint",
    );
    await driver.assertDisplayBufferContains("  - [pending update: tracked]");

    await driver.inputMagentaText("status?");
    await driver.send();
    (await driver.mockAnthropic.awaitPendingStream()).respond({
      stopReason: "end_turn",
      text: "done",
      toolRequests: [],
    });
    await driver.assertDisplayBufferContains(
      ` pr: ${URL} tracked (open, 2 checks, 0 comments)`,
    );
  });
});
