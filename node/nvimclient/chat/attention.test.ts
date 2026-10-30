import type { SessionThread } from "@magenta/server";
import { expect, it } from "vitest";
import { leftThread, serverSession } from "../test/left-thread.ts";
import { withDriver } from "../test/preamble.ts";
import { delay, pollUntil } from "../utils/async.ts";

it("cursor movement marks the shown thread attended, throttled, only while the sidebar is visible", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const id = leftThread(driver.magenta.chat).id;
    const session = serverSession(driver.magenta.chat);
    const record = session.getThread(id) as SessionThread;
    const marks: unknown[] = [];
    const original = session.markAttended.bind(session);
    session.markAttended = (threadId) => {
      marks.push(threadId);
      original(threadId);
    };
    // Showing the sidebar may already have pinged; start a fresh throttle window.
    (
      driver.magenta.chat as unknown as { lastAttendedAt: Map<unknown, number> }
    ).lastAttendedAt.clear();
    await delay(1100);
    record.lastAttentionTime = 0;
    await driver.nvim.call("nvim_exec_autocmds", ["CursorMoved", {}]);
    await pollUntil(() => {
      if (record.lastAttentionTime === 0) throw new Error("not attended");
    });
    expect(marks).toEqual([id]);

    await delay(1100);
    await driver.nvim.call("nvim_exec_autocmds", ["FocusGained", {}]);
    await delay(200);
    expect(marks).toEqual([id]);

    await driver.magenta.command("toggle");
    await pollUntil(() => {
      if (driver.magenta.sidebar.isVisible()) throw new Error("visible");
    });
    (
      driver.magenta.chat as unknown as { lastAttendedAt: Map<unknown, number> }
    ).lastAttendedAt.clear();
    await delay(1100);
    await driver.nvim.call("nvim_exec_autocmds", ["CursorMoved", {}]);
    await delay(200);
    expect(marks).toEqual([id]);
  });
});
