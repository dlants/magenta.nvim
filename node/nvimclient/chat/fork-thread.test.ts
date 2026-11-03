import { expect, it } from "vitest";
import { leftThread, serverThread } from "../test/left-thread.ts";
import { withDriver } from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";

it("child shows 'forked from' and <CR> navigates to parent", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText("hello");
    await driver.send();
    const r1 = await driver.mockAnthropic.awaitPendingStream();
    r1.respond({
      stopReason: "end_turn",
      text: "hi",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains("hi");

    const sourceThreadId = driver.magenta.chat.state.left!;
    const sourceThread = leftThread(driver.magenta.chat);
    const idx = serverThread(sourceThread).nativeMessageIdx;

    await driver.magenta.forkAtMessageAndSwitch(sourceThreadId, idx);
    // The fork notification rides along with the fork's first turn.
    await driver.inputMagentaText("continue");
    await driver.send();
    (await driver.mockAnthropic.awaitPendingStream()).respond({
      stopReason: "end_turn",
      text: "sure",
      toolRequests: [],
    });
    await driver.assertDisplayBufferContains("sure");

    await driver.assertDisplayBufferContains("forked from");

    await driver.pressOnDisplayMessage("forked from", "<CR>");

    await pollUntil(() => {
      if (driver.magenta.chat.state.left !== sourceThreadId) {
        throw new Error("active thread did not switch to parent");
      }
    });
  });
});

it("parent shows 'forked to' (not in agent messages) and <CR> navigates to child", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText("hello");
    await driver.send();
    const r1 = await driver.mockAnthropic.awaitPendingStream();
    r1.respond({
      stopReason: "end_turn",
      text: "hi",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains("hi");

    const sourceThreadId = driver.magenta.chat.state.left!;
    const sourceThread = leftThread(driver.magenta.chat);
    const idx = serverThread(sourceThread).nativeMessageIdx;

    const childThreadId = await driver.magenta.forkAtMessageAndSwitch(
      sourceThreadId,
      idx,
    );

    const parentHasMarker = serverThread(sourceThread)
      .getProviderMessages()
      .some((m) => m.content.some((c) => c.type === "fork_notification"));
    expect(parentHasMarker).toBe(false);

    driver.magenta.dispatch({
      type: "select-thread-effect",
      id: sourceThreadId,
    });

    await driver.assertDisplayBufferContains("forked to thread");
    const text = await driver.getDisplayBufferText();
    const forkPos = text.indexOf("forked to thread");
    // The fork was taken after the assistant reply, so its indicator must
    // follow both messages rather than attach to an earlier one.
    expect(text.indexOf("hello")).toBeLessThan(forkPos);
    expect(text.lastIndexOf("hi")).toBeLessThan(forkPos);

    await driver.pressOnDisplayMessage("forked to thread", "<CR>");

    await pollUntil(() => {
      if (driver.magenta.chat.state.left !== childThreadId) {
        throw new Error("active thread did not switch to child");
      }
    });
  });
});
