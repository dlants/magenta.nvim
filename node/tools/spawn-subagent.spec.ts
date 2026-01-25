import { withDriver } from "../test/preamble.ts";
import { it } from "vitest";
import type { ToolRequestId } from "./toolManager.ts";
import type { ToolName } from "./types.ts";
import { pollUntil } from "../utils/async.ts";

it("navigates to spawned subagent thread when pressing Enter on completed summary", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText("Use spawn_subagent to do a task.");
    await driver.send();

    const stream1 =
      await driver.mockAnthropic.awaitPendingStreamWithText("spawn_subagent");

    // Get the active thread before navigation
    const parentThread = driver.magenta.chat.getActiveThread();
    const parentThreadId = parentThread.id;

    stream1.respond({
      stopReason: "tool_use",
      text: "I'll spawn a subagent to handle this task.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "test-subagent" as ToolRequestId,
            toolName: "spawn_subagent" as ToolName,
            input: {
              prompt: "Do the task and yield the result",
            },
          },
        },
      ],
    });

    // Wait for the completed summary to appear
    const summaryPos =
      await driver.assertDisplayBufferContains("🤖✅ spawn_subagent");

    // Press Enter on the completed summary to navigate to the subagent thread
    await driver.triggerDisplayBufferKey(summaryPos, "<CR>");

    // Verify we navigated to a different thread (the subagent)
    await pollUntil(
      () => driver.magenta.chat.getActiveThread().id !== parentThreadId,
    );
  });
});
