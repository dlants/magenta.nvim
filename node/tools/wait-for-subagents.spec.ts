import { withDriver } from "../test/preamble.ts";
import { it, expect } from "vitest";
import type { ToolRequestId } from "./toolManager.ts";
import type { ToolName } from "./types.ts";
import { pollUntil } from "../utils/async.ts";
import type { ThreadId } from "../chat/types.ts";

it("navigates to subagent thread when pressing Enter on completed summary thread link", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText(
      "Spawn a subagent and then wait for it to complete.",
    );
    await driver.send();

    const stream1 =
      await driver.mockAnthropic.awaitPendingStreamWithText("Spawn a subagent");

    // Get the parent thread id
    const parentThread = driver.magenta.chat.getActiveThread();
    const parentThreadId = parentThread.id;

    stream1.respond({
      stopReason: "tool_use",
      text: "I'll spawn a subagent first.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "spawn-subagent-1" as ToolRequestId,
            toolName: "spawn_subagent" as ToolName,
            input: {
              prompt: "Do a task and yield the result",
            },
          },
        },
      ],
    });

    // Wait for spawn_subagent to complete and get the thread id
    await driver.assertDisplayBufferContains("🤖✅ spawn_subagent");

    // Get the spawned thread id from the display
    const displayContent = await driver.getDisplayBufferText();
    const threadIdMatch = displayContent.match(
      /🤖✅ spawn_subagent ([a-f0-9-]+)/,
    );
    expect(threadIdMatch).toBeTruthy();
    const subagentThreadId = threadIdMatch![1] as ThreadId;

    // Now the parent continues and waits for the subagent
    const stream2 = await driver.mockAnthropic.awaitPendingStreamWithText(
      `threadId: ${subagentThreadId}`,
    );

    stream2.respond({
      stopReason: "tool_use",
      text: "Now I'll wait for the subagent to complete.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "wait-subagents-1" as ToolRequestId,
            toolName: "wait_for_subagents" as ToolName,
            input: {
              threadIds: [subagentThreadId],
            },
          },
        },
      ],
    });

    // Wait for the waiting state to appear
    await driver.assertDisplayBufferContains("⏸️⏳ Waiting for 1 subagent(s):");

    // Now complete the subagent
    const subagentStream =
      await driver.mockAnthropic.awaitPendingStreamWithText(
        "Do a task and yield",
      );
    subagentStream.respond({
      stopReason: "tool_use",
      text: "I completed the task.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "yield-result" as ToolRequestId,
            toolName: "yield_to_parent" as ToolName,
            input: {
              result: "Task completed successfully",
            },
          },
        },
      ],
    });

    // Wait for the completed summary to appear
    await driver.assertDisplayBufferContains("⏳✅ wait_for_subagents");

    // Find the thread link in the completed summary and press Enter
    const threadLinkPos =
      await driver.assertDisplayBufferContains(subagentThreadId);
    await driver.triggerDisplayBufferKey(threadLinkPos, "<CR>");

    // Verify we navigated to a subagent thread
    await pollUntil(
      () => driver.magenta.chat.getActiveThread().id !== parentThreadId,
    );
  });
});
