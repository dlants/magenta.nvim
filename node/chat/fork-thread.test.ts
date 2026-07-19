import * as fs from "node:fs/promises";
import type { NativeMessageIdx, ToolName, ToolRequestId } from "@magenta/core";
import { expect, it, vi } from "vitest";
import { getcwd } from "../nvim/nvim.ts";
import { withDriver } from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";

it("no <context_update> on first turn after fork when files unchanged", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.addContextFiles("poem.txt");

    await driver.inputMagentaText("Read poem.txt");
    await driver.send();

    const r1 = await driver.mockAnthropic.awaitPendingStream();
    r1.respond({
      stopReason: "end_turn",
      text: "I read the poem.",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains("I read the poem.");

    const sourceThreadId = driver.magenta.chat.state.activeThreadId!;
    const sourceThread = driver.magenta.chat.getActiveThread();
    const idx = sourceThread.agent.getNativeMessageIdx();

    await driver.magenta.forkAtMessageAndSwitch(sourceThreadId, idx);

    const forkThread = driver.magenta.chat.getActiveThread();
    expect(forkThread.id).not.toBe(sourceThreadId);

    await driver.inputMagentaText("Continue the conversation");
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStream();
    const messages = stream.getProviderMessages();
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    expect(lastUser).toBeDefined();
    const hasContextUpdate = lastUser!.content.some(
      (c) => c.type === "context_update",
    );
    expect(hasContextUpdate).toBe(false);

    stream.respond({
      stopReason: "end_turn",
      text: "ok",
      toolRequests: [],
    });
  });
});

it("<context_update> IS sent if a tracked file changes after fork", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.addContextFiles("poem.txt");

    await driver.inputMagentaText("Read poem.txt");
    await driver.send();

    const r1 = await driver.mockAnthropic.awaitPendingStream();
    r1.respond({
      stopReason: "end_turn",
      text: "I read the poem.",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains("I read the poem.");

    const sourceThreadId = driver.magenta.chat.state.activeThreadId!;
    const sourceThread = driver.magenta.chat.getActiveThread();
    const idx = sourceThread.agent.getNativeMessageIdx();

    await driver.magenta.forkAtMessageAndSwitch(sourceThreadId, idx);

    const cwd = await getcwd(driver.nvim);
    await fs.writeFile(
      `${cwd}/poem.txt`,
      "completely different\nnew content\nhere\nplus more\n",
    );

    await driver.inputMagentaText("Continue the conversation");
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStream();
    const messages = stream.getProviderMessages();
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    expect(lastUser).toBeDefined();
    const hasContextUpdate = lastUser!.content.some(
      (c) => c.type === "context_update",
    );
    expect(hasContextUpdate).toBe(true);

    stream.respond({
      stopReason: "end_turn",
      text: "ok",
      toolRequests: [],
    });
  });
});

it("tool result map survives the fork", async () => {
  await withDriver({}, async (driver) => {
    driver.mockSandbox.setState({ status: "ready" });
    await driver.showSidebar();

    await driver.inputMagentaText("Read poem.txt");
    await driver.send();

    const r1 = await driver.mockAnthropic.awaitPendingStream();
    r1.respond({
      stopReason: "tool_use",
      text: "Reading poem.txt",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "get-file-1" as ToolRequestId,
            toolName: "get_files" as ToolName,
            input: { files: [{ filePath: "./poem.txt" }] },
          },
        },
      ],
    });

    const r2 = await driver.mockAnthropic.awaitPendingStream();
    r2.respond({
      stopReason: "end_turn",
      text: "Done reading.",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains("Done reading.");

    const sourceThreadId = driver.magenta.chat.state.activeThreadId!;
    const sourceThread = driver.magenta.chat.getActiveThread();
    const idx = sourceThread.agent.getNativeMessageIdx();

    await driver.magenta.forkAtMessageAndSwitch(sourceThreadId, idx);

    await driver.assertDisplayBufferDoesNotContain("tool result not found");
  });
});

it("sandbox bypass is copied as an independent value", async () => {
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

    const sourceThreadId = driver.magenta.chat.state.activeThreadId!;
    const sourceThread = driver.magenta.chat.getActiveThread();
    sourceThread.sandboxBypassed = true;

    const idx = sourceThread.agent.getNativeMessageIdx();
    await driver.magenta.forkAtMessageAndSwitch(sourceThreadId, idx);

    const forkThread = driver.magenta.chat.getActiveThread();
    expect(forkThread.isSandboxBypassed).toBe(true);

    sourceThread.sandboxBypassed = false;

    expect(forkThread.isSandboxBypassed).toBe(true);
    expect(sourceThread.isSandboxBypassed).toBe(false);
  });
});

it("source agent is unaffected by clone", async () => {
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

    await driver.inputMagentaText("again");
    await driver.send();
    const r2 = await driver.mockAnthropic.awaitPendingStream();
    r2.respond({
      stopReason: "end_turn",
      text: "hi again",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains("hi again");

    const sourceThreadId = driver.magenta.chat.state.activeThreadId!;
    const sourceThread = driver.magenta.chat.getActiveThread();
    const messagesBefore = sourceThread.agent.getState().messages.length;
    const statusBefore = sourceThread.agent.getState().status;

    const idx = sourceThread.agent.getNativeMessageIdx();
    await driver.magenta.forkAtMessageAndSwitch(
      sourceThreadId,
      (idx - 1) as NativeMessageIdx,
    );

    const messagesAfter = sourceThread.agent.getState().messages.length;
    const statusAfter = sourceThread.agent.getState().status;

    expect(messagesAfter).toBe(messagesBefore);
    expect(statusAfter.type).toBe(statusBefore.type);
    if (statusAfter.type === "stopped" && statusBefore.type === "stopped") {
      expect(statusAfter.stopReason).toBe(statusBefore.stopReason);
    }
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
    const idx = sourceThread.agent.getNativeMessageIdx();

    await driver.magenta.forkAtMessageAndSwitch(sourceThreadId, idx);

    const forkThread = driver.magenta.chat.getActiveThread();
    const messages = forkThread.getProviderMessages();

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
    const idx = sourceThread.agent.getNativeMessageIdx();

    await driver.magenta.forkAtMessageAndSwitch(sourceThreadId, idx);

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
    const idx = sourceThread.agent.getNativeMessageIdx();

    const childThreadId = await driver.magenta.forkAtMessageAndSwitch(
      sourceThreadId,
      idx,
    );

    const parentHasMarker = sourceThread
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

it("agent clone happens exactly once", async () => {
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

    const sourceThreadId = driver.magenta.chat.state.activeThreadId!;
    const sourceThread = driver.magenta.chat.getActiveThread();
    const cloneSpy = vi.spyOn(sourceThread.agent, "clone");

    const idx = sourceThread.agent.getNativeMessageIdx();
    await driver.magenta.forkAtMessageAndSwitch(sourceThreadId, idx);

    expect(cloneSpy).toHaveBeenCalledTimes(1);

    cloneSpy.mockRestore();
  });
});
