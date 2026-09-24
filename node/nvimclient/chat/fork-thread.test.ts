import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expect, it } from "vitest";
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

    const sourceThreadId = driver.magenta.chat.state.activeThreadId!;
    const sourceThread = driver.magenta.chat.getActiveThread();
    driver.magenta.chat.host.setSandboxBypassed(sourceThreadId, true);

    const idx = sourceThread.thread.nativeMessageIdx;
    await driver.magenta.forkAtMessageAndSwitch(sourceThreadId, idx);

    const forkThread = driver.magenta.chat.getActiveThread();
    expect(forkThread.isSandboxBypassed).toBe(true);

    driver.magenta.chat.host.setSandboxBypassed(sourceThreadId, false);

    expect(forkThread.isSandboxBypassed).toBe(true);
    expect(sourceThread.isSandboxBypassed).toBe(false);
    const destination = path.join(dirs.baseDir, "fork-write.txt");
    driver.mockSandbox.blockWritesTo(destination);
    const forkIO = forkThread.thread["context"].fileIO;
    expect(forkIO).toBe(forkThread.context.environment.fileIO);
    expect(forkIO).not.toBe(sourceThread.thread["context"].fileIO);
    await forkIO.writeFile(destination, "bypassed fork write");
    expect(
      sourceThread.sandboxViolationHandler!.getPendingViolations().size,
    ).toBe(0);
    expect(
      forkThread.sandboxViolationHandler!.getPendingViolations().size,
    ).toBe(0);
    driver.magenta.chat.host.setSandboxBypassed(forkThread.id, false);
    driver.magenta.chat.host.setSandboxBypassed(sourceThreadId, true);
    const writing = forkIO.writeFile(destination, "approved fork write");
    await pollUntil(() => {
      expect(
        forkThread.sandboxViolationHandler!.getPendingViolations().size,
      ).toBe(1);
      return true;
    });
    expect(
      sourceThread.sandboxViolationHandler!.getPendingViolations().size,
    ).toBe(0);
    const position = await driver.assertDisplayBufferContains("> YES");
    await driver.triggerDisplayBufferKey(position, "<CR>");
    await writing;
    expect(await fs.readFile(destination, "utf8")).toBe("approved fork write");
  });
});

it("fork appends an id-free fork_notification and records forkedFrom", async () => {
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

    const sourceThreadId = driver.magenta.chat.state.activeThreadId!;
    const sourceThread = driver.magenta.chat.getActiveThread();
    const idx = sourceThread.thread.nativeMessageIdx;

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

    const forkThread = driver.magenta.chat.getActiveThread();
    const messages = forkThread.thread.getProviderMessages();

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

    expect(forkThread.state.messageViewState[markerIdx]?.forkedFrom).toBe(
      sourceThreadId,
    );
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

    const sourceThreadId = driver.magenta.chat.state.activeThreadId!;
    const sourceThread = driver.magenta.chat.getActiveThread();
    const idx = sourceThread.thread.nativeMessageIdx;

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
      if (driver.magenta.chat.state.activeThreadId !== sourceThreadId) {
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

    const sourceThreadId = driver.magenta.chat.state.activeThreadId!;
    const sourceThread = driver.magenta.chat.getActiveThread();
    const idx = sourceThread.thread.nativeMessageIdx;

    const childThreadId = await driver.magenta.forkAtMessageAndSwitch(
      sourceThreadId,
      idx,
    );

    const parentHasMarker = sourceThread.thread
      .getProviderMessages()
      .some((m) => m.content.some((c) => c.type === "fork_notification"));
    expect(parentHasMarker).toBe(false);

    driver.magenta.dispatch({
      type: "select-thread-effect",
      id: sourceThreadId,
    });

    await driver.assertDisplayBufferContains("forked to thread");

    await driver.pressOnDisplayMessage("forked to thread", "<CR>");

    await pollUntil(() => {
      if (driver.magenta.chat.state.activeThreadId !== childThreadId) {
        throw new Error("active thread did not switch to child");
      }
    });
  });
});
