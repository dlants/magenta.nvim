import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expect, it } from "vitest";
import { leftThread, serverThread } from "../test/left-thread.ts";
import { withDriver } from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";

it("sandbox bypass and write approvals use the fork owner", async () => {
  await withDriver({}, async (driver, dirs) => {
    await driver.showSidebar();
    await driver.inputMagentaText("hello");
    await driver.send();

    const r1 = await driver.mockAnthropic.awaitPendingStream();
    r1.respond({
      stopReason: "end_turn",
      text: "hi",
      toolRequests: [],
    });

    const sourceThreadId = driver.magenta.chat.state.left!;
    const sourceThread = leftThread(driver.magenta.chat);

    const idx = serverThread(sourceThread).nativeMessageIdx;
    await driver.magenta.forkAtMessageAndSwitch(sourceThreadId, idx);

    const forkThread = leftThread(driver.magenta.chat);
    expect(forkThread.isSandboxBypassed).toBe(true);

    await driver.magenta.chat.toggleSandboxBypass(sourceThreadId);

    expect(forkThread.isSandboxBypassed).toBe(true);
    expect(sourceThread.isSandboxBypassed).toBe(false);
    const destination = path.join(dirs.baseDir, "fork-write.txt");
    driver.mockSandbox.blockWritesTo(destination);
    // biome-ignore lint/complexity/useLiteralKeys: white-box access to a private field
    const forkIO = serverThread(forkThread)["context"].fileIO;
    expect(forkIO).toBe(forkThread.context.environment.fileIO);
    // biome-ignore lint/complexity/useLiteralKeys: white-box access to a private field
    expect(forkIO).not.toBe(serverThread(sourceThread)["context"].fileIO);
    await forkIO.writeFile(destination, "bypassed fork write");
    expect(
      driver.magenta.chat.session.getPendingApprovals(sourceThread.id).length,
    ).toBe(0);
    expect(
      driver.magenta.chat.session.getPendingApprovals(forkThread.id).length,
    ).toBe(0);
    await driver.magenta.chat.toggleSandboxBypass(forkThread.id);
    await driver.magenta.chat.toggleSandboxBypass(sourceThreadId);
    const writing = forkIO.writeFile(destination, "approved fork write");
    await pollUntil(() => {
      expect(
        driver.magenta.chat.session.getPendingApprovals(forkThread.id).length,
      ).toBe(1);
      return true;
    });
    expect(
      driver.magenta.chat.session.getPendingApprovals(sourceThread.id).length,
    ).toBe(0);
    const position = await driver.assertDisplayBufferContains("> YES");
    await driver.triggerDisplayBufferKey(position, "<CR>");
    await writing;
    expect(await fs.readFile(destination, "utf8")).toBe("approved fork write");
  });
});

it("fork appends an id-free fork_notification and records the fork origin", async () => {
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

    const forkThread = leftThread(driver.magenta.chat);
    const messages = serverThread(forkThread).getProviderMessages();

    const markerIdx = messages.findIndex((m) =>
      m.content.some((c) => c.type === "fork_notification"),
    );
    expect(markerIdx).toBeGreaterThanOrEqual(0);

    const markerContent = messages[markerIdx].content.find(
      (c) => c.type === "fork_notification",
    );
    expect(markerContent).toBeDefined();
    if (markerContent && markerContent.type === "fork_notification") {
      expect(markerContent.text).not.toContain(sourceThreadId);
    }

    expect(driver.magenta.chat.session.getOrigin(forkThread.id)).toEqual({
      type: "fork",
      sourceThreadId,
      nativeMessageIdx: idx,
    });
    expect(
      driver.magenta.chat.session
        .listDerived(sourceThreadId, "fork")
        .map((d) => d.threadId),
    ).toEqual([forkThread.id]);
    // The next user message merges into the seam notice rather than following
    // it as a second consecutive user message, which some providers reject.
    expect(
      messages[markerIdx].content.some(
        (c) => c.type === "text" && c.text.includes("continue"),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m, i) => i > 0 && m.role === "user" && messages[i - 1].role === "user",
      ),
    ).toBe(false);
  });
});

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
