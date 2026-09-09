import type { ToolName, ToolRequestId } from "@magenta/server";
import { describe, expect, it } from "vitest";
import { withDriver } from "../test/preamble.ts";
import { LOGO } from "./thread-view.ts";

describe("node/nvimclient/chat/chat.test.ts", () => {
  it("resets view when switching to a new thread", async () => {
    await withDriver({}, async (driver) => {
      // 1. Open the sidebar
      await driver.showSidebar();

      // 2. Send a message in the first thread
      await driver.inputMagentaText(
        "Hello, this is a test message in thread 1",
      );
      await driver.send();

      // Verify the message is in the display buffer
      await driver.assertDisplayBufferContains(
        "Hello, this is a test message in thread 1",
      );

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.streamText("I'm the assistant's response to the first thread");
      request.finishResponse("end_turn");

      await driver.assertDisplayBufferContains(
        "I'm the assistant's response to the first thread",
      );

      await driver.magenta.command("new-thread");
      await driver.assertDisplayBufferContains("# [ Untitled ]");
      await driver.assertDisplayBufferContains(LOGO);
    });
  });

  it("summarizes a submission that never issued a request as empty", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      const thread = driver.magenta.chat.getActiveThread();
      expect(await thread.core.send([])).toEqual({ type: "empty" });
      expect(driver.magenta.chat.getThreadSummary(thread.id).status).toEqual({
        type: "stopped",
        reason: "empty",
      });
    });
  });

  it("shows thread overview and allows selecting a thread", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      const thread1 = driver.getThreadId(0);

      // Send a message in thread 1
      await driver.inputMagentaText("First thread message");
      await driver.send();

      // Handle the main response and thread title request
      const response1 = await driver.mockAnthropic.awaitPendingStreamWithText(
        "First thread message",
      );
      response1.respond({
        stopReason: "end_turn",
        text: "Response to first thread",
        toolRequests: [],
      });

      // Respond to thread title request for thread 1
      await driver.mockAnthropic.respondToForceToolUse({
        toolRequest: {
          status: "ok",
          value: {
            id: "title-1" as ToolRequestId,
            toolName: "thread_title" as ToolName,
            input: { title: "First Thread" },
          },
        },
        stopReason: "tool_use",
      });

      // Create second thread
      await driver.magenta.command("new-thread");
      await driver.awaitThreadCount(2);
      const thread2 = driver.getThreadId(1);
      await driver.awaitChatState({
        state: "thread-selected",
        id: thread2,
      });

      // Send a message in thread 2
      await driver.inputMagentaText("Second thread message");
      await driver.send();

      const response2 = await driver.mockAnthropic.awaitPendingStreamWithText(
        "Second thread message",
      );
      response2.respond({
        stopReason: "end_turn",
        text: "Response to second thread",
        toolRequests: [],
      });

      // Respond to thread title request for thread 2
      await driver.mockAnthropic.respondToForceToolUse({
        toolRequest: {
          status: "ok",
          value: {
            id: "title-2" as ToolRequestId,
            toolName: "thread_title" as ToolName,
            input: { title: "Second Thread" },
          },
        },
        stopReason: "tool_use",
      });

      // Ensure thread 2's turn has been fully processed before navigating away,
      // so it isn't flagged with an unviewed-activity bell.
      await driver.assertDisplayBufferContains("Response to second thread");

      await driver.magenta.command("threads-overview");

      await driver.assertDisplayBufferContains("# Threads");
      await driver.assertDisplayBufferContains(
        `- First Thread: ⏹️ stopped (end_turn)`,
      );
      await driver.assertDisplayBufferContains(
        `* Second Thread: ⏹️ stopped (end_turn)`,
      );

      await driver.triggerDisplayBufferKeyOnContent(
        `- First Thread: ⏹️ stopped (end_turn)`,
        "<CR>",
      );
      await driver.awaitChatState({
        state: "thread-selected",
        id: thread1,
      });
    });
  });

  it("does not show a bell on the thread you were just viewing", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Send a message in the active thread and let a turn complete, which
      // updates the thread's lastActivityTime.
      await driver.inputMagentaText("Message in viewed thread");
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStreamWithText(
        "Message in viewed thread",
      );
      request.respond({
        stopReason: "end_turn",
        text: "Response in viewed thread",
        toolRequests: [],
      });

      await driver.mockAnthropic.respondToForceToolUse({
        toolRequest: {
          status: "ok",
          value: {
            id: "title-bell" as ToolRequestId,
            toolName: "thread_title" as ToolName,
            input: { title: "Viewed Thread" },
          },
        },
        stopReason: "tool_use",
      });

      // Ensure the turn (and its lastActivityTime update) has been processed
      // while we're still viewing the thread.
      await driver.assertDisplayBufferContains("Response in viewed thread");

      // Navigate away to the overview. Because we were viewing this thread the
      // whole time, it should not show an unviewed-activity bell.
      await driver.magenta.command("threads-overview");
      await driver.awaitChatState({ state: "thread-overview" });

      await driver.assertDisplayBufferContains("Viewed Thread:");
      await driver.assertDisplayBufferDoesNotContain("🔔");
    });
  });

  it("deletes entire thread subtree when pressing dd on root thread", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Create first parent thread with a child
      await driver.inputMagentaText("Thread to delete");
      await driver.send();

      const parentRequest =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Thread to delete",
        );
      parentRequest.respond({
        stopReason: "tool_use",
        text: "Spawning a child.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-del" as ToolRequestId,
              toolName: "spawn_subagents" as ToolName,
              input: { agents: [{ prompt: "Child of thread to delete" }] },
            },
          },
        ],
      });

      await driver.awaitThreadCount(2);

      // Create a second root thread
      await driver.magenta.command("new-thread");
      await driver.awaitThreadCount(3);
      await driver.inputMagentaText("Thread to keep");
      await driver.send();

      const keepRequest =
        await driver.mockAnthropic.awaitPendingStreamWithText("Thread to keep");
      keepRequest.respond({
        stopReason: "end_turn",
        text: "Done.",
        toolRequests: [],
      });

      // Go to thread overview
      await driver.magenta.command("threads-overview");
      await driver.awaitChatState({ state: "thread-overview" });

      // Both root threads should be visible
      await driver.assertDisplayBufferContains(
        `▶ Thread to delete: ⏳ executing tools (1 subthreads)`,
      );
      await driver.assertDisplayBufferContains(`Thread to keep:`);

      // Press dd on the first root thread to delete it and its subtree
      await driver.triggerDisplayBufferKeyOnContent(
        `▶ Thread to delete: ⏳ executing tools (1 subthreads)`,
        "dd",
      );

      // The deleted thread and its child should be gone
      await driver.assertDisplayBufferDoesNotContain("Thread to delete");
      await driver.assertDisplayBufferDoesNotContain(
        "Child of thread to delete",
      );

      // The other thread should still be there
      await driver.assertDisplayBufferContains(`Thread to keep:`);
    });
  });

  it("deletes entire subtree when pressing dd on a child thread", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText("Root thread for dd child test");
      await driver.send();

      const parentRequest =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Root thread for dd child test",
        );
      parentRequest.respond({
        stopReason: "tool_use",
        text: "Spawning.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-c" as ToolRequestId,
              toolName: "spawn_subagents" as ToolName,
              input: { agents: [{ prompt: "Child thread for dd test" }] },
            },
          },
        ],
      });

      await driver.awaitThreadCount(2);

      // Go to overview, expand the root, then dd the child
      await driver.magenta.command("threads-overview");
      await driver.awaitChatState({ state: "thread-overview" });

      await driver.triggerDisplayBufferKeyOnContent(
        `▶ Root thread for dd child test: ⏳ executing tools (1 subthreads)`,
        "=",
      );

      await driver.assertDisplayBufferContains(
        `  - Child thread for dd test: ⏳ streaming response`,
      );

      // Press dd on the child - should delete the entire root subtree
      await driver.triggerDisplayBufferKeyOnContent(
        `  - Child thread for dd test: ⏳ streaming response`,
        "dd",
      );

      // Everything should be gone
      await driver.assertDisplayBufferContains("No threads yet");
    });
  });
});
