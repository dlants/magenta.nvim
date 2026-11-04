import type { WatcherName } from "@magenta/server";
import { FakeWatcherTransport } from "@magenta/server/src/test/fakes.ts";
import { useFakeWatchers } from "@magenta/server/src/test-helpers.ts";
import { it } from "vitest";
import { serverSession } from "../test/left-thread.ts";
import { withDriver } from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";

const KEY = "o/r/pull/12";
it("renders watched resource summary/details, deliveries and untracks", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const session = serverSession(driver.magenta.chat);
    const registry = session.watcherRegistry;
    if (!registry) throw new Error("no registry");
    const transport = new FakeWatcherTransport();
    useFakeWatchers(registry, transport, [
      {
        name: "gh" as WatcherName,
        protocolVersion: 1,
        command: ["true"],
        triggers: [
          { pattern: "https://github\\.com/(\\S+/pull/\\d+)", keyGroup: 1 },
        ],
      },
    ]);
    transport.push("gh", {
      key: KEY,
      status: "active",
      context: "state: open\n",
      summary: "Fix (open) 1 failed",
      details: "failed: lint\npending: test",
    });
    await driver.inputMagentaText(`Watch https://github.com/${KEY}`);
    await driver.send();
    (await driver.mockAnthropic.awaitPendingStream()).respond({
      stopReason: "end_turn",
      text: "ok",
      toolRequests: [],
    });
    await driver.assertDisplayBufferContains("# watched:");
    const line = `- gh [active, pending update]: ${KEY} Fix (open) 1 failed`;
    await driver.triggerDisplayBufferKeyOnContent(line, "=");
    await driver.assertDisplayBufferContains("  failed: lint\n  pending: test");

    await driver.inputMagentaText("status?");
    await driver.send();
    (await driver.mockAnthropic.awaitPendingStream()).respond({
      stopReason: "end_turn",
      text: "done",
      toolRequests: [],
    });
    await driver.assertDisplayBufferContains(`gh: ${KEY} tracked`);

    await driver.triggerDisplayBufferKeyOnContent(
      `- gh [active]: ${KEY}`,
      "dd",
    );
    await pollUntil(() => {
      if (transport.subscriberCount("gh", KEY) !== 0)
        throw new Error("still subscribed");
    });
    await driver.assertDisplayBufferDoesNotContain("# watched:");
  });
});
