import { withDriver } from "../test/preamble.ts";
import { describe, it } from "vitest";
import { LOGO } from "./thread.ts";
import type { ToolRequestId, ToolName } from "@magenta/core";
import { pollUntil } from "../utils/async.ts";

describe("node/chat/chat.test.ts", () => {
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

  it("spawns subagent, runs command, yields result to parent", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      const thread1 = driver.getThreadId(0);

      await driver.inputMagentaText(
        "Use spawn_subagent to create a sub-agent that will echo 'Hello from subagent' and then yield that result back to me.",
      );
      await driver.send();

      const request1 =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Use spawn_subagent",
        );
      request1.respond({
        stopReason: "tool_use",
        text: "I'll spawn a sub-agent to handle this task.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-spawn-subagent" as ToolRequestId,
              toolName: "spawn_subagent" as ToolName,
              input: {
                prompt:
                  "Echo the text 'Hello from subagent' using the bash_command tool, then yield that result back to the parent using yield_to_parent.",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("🤖✅ spawn_subagent");
      const thread2 = driver.getThreadId(1);

      const request = await driver.mockAnthropic.awaitPendingStreamWithText(
        `Sub-agent started with threadId: ${thread2}`,
      );

      request.respond({
        stopReason: "tool_use",
        text: "Now I'll wait for the sub-agent to complete.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-wait-for-subagents" as ToolRequestId,
              toolName: "wait_for_subagents" as ToolName,
              input: {
                threadIds: [thread2],
              },
            },
          },
        ],
      });

      // We should stay in the parent thread (thread 1) since switchToThread is now false
      await driver.awaitChatState(
        {
          state: "thread-selected",
          id: thread1,
        },
        `We stay in the parent thread during subagent execution`,
      );

      // Assert we see the waiting state in the parent thread
      await driver.assertDisplayBufferContains("⏳ Waiting for 1 subagent(s):");
      await driver.assertDisplayBufferContains(
        `- Echo the text 'Hello from subagent' using the bash...: ⏳ streaming response`,
      );

      const request3 =
        await driver.mockAnthropic.awaitPendingStreamWithText("Echo the text");
      request3.respond({
        stopReason: "tool_use",
        text: "I'll echo that text for you.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-bash-command" as ToolRequestId,
              toolName: "bash_command" as ToolName,
              input: {
                command: "echo 'Hello from subagent'",
              },
            },
          },
        ],
      });

      const request4 =
        await driver.mockAnthropic.awaitPendingStreamWithText("exit code 0");
      request4.respond({
        stopReason: "tool_use",
        text: "I'll now yield this result back to the parent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-yield-to-parent" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: {
                result: "Successfully echoed: Hello from subagent",
              },
            },
          },
        ],
      });

      await driver.awaitChatState(
        {
          state: "thread-selected",
          id: thread1,
        },
        "We remain in the parent thread and see the subagent result",
      );

      await driver.assertDisplayBufferContains(
        `⏳✅ wait_for_subagents (1 threads)`,
      );
    });
  });

  it("wait_for_subagents view handles missing threads gracefully", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText("Wait for a thread that doesn't exist.");
      await driver.send();

      const request =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Wait for a thread",
        );
      request.respond({
        stopReason: "tool_use",
        text: "I'll wait for a non-existent thread.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "wait-missing" as ToolRequestId,
              toolName: "wait_for_subagents" as ToolName,
              input: {
                threadIds: ["nonexistent-thread-id"], // Non-existent thread ID
              },
            },
          },
        ],
      });

      // Verify we see the missing thread status
      await driver.assertDisplayBufferContains("⏳ Waiting for 1 subagent(s):");
      await driver.assertDisplayBufferContains("- [Untitled]: ❓ not found");
    });
  });

  it("wait_for_subagents view updates as threads progress and yield", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText(
        "Use spawn_subagent to create two sub-agents and wait for both.",
      );
      await driver.send();

      const request1 =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Use spawn_subagent",
        );
      request1.respond({
        stopReason: "tool_use",
        text: "I'll spawn the first sub-agent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-1" as ToolRequestId,
              toolName: "spawn_subagent" as ToolName,
              input: {
                prompt: "Echo 'Hello from subagent 1' and yield the result.",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("🤖✅ spawn_subagent");
      const thread2 = driver.getThreadId(1);

      const request2 = await driver.mockAnthropic.awaitPendingStreamWithText(
        `Sub-agent started with threadId: ${thread2}`,
      );
      request2.respond({
        stopReason: "tool_use",
        text: "Now I'll spawn the second sub-agent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-2" as ToolRequestId,
              toolName: "spawn_subagent" as ToolName,
              input: {
                prompt: "Echo 'Hello from subagent 2' and yield the result.",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("🤖✅ spawn_subagent");
      await driver.awaitThreadCount(3);
      const thread3 = driver.getThreadId(2);

      // Start waiting for both subagents
      const request3 = await driver.mockAnthropic.awaitPendingStreamWithText(
        `Sub-agent started with threadId: ${thread3}`,
      );
      request3.respond({
        stopReason: "tool_use",
        text: "Now I'll wait for both sub-agents to complete.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "wait-both" as ToolRequestId,
              toolName: "wait_for_subagents" as ToolName,
              input: {
                threadIds: [thread2, thread3],
              },
            },
          },
        ],
      });

      // Verify we see both threads in waiting state
      await driver.assertDisplayBufferContains("⏳ Waiting for 2 subagent(s):");
      await driver.assertDisplayBufferContains(
        `- Echo 'Hello from subagent 1' and yield the result.: ⏳ streaming response`,
      );
      await driver.assertDisplayBufferContains(
        `- Echo 'Hello from subagent 2' and yield the result.: ⏳ streaming response`,
      );

      // First subagent yields successfully
      const subagent1Request =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Echo 'Hello from subagent 1'",
        );
      subagent1Request.respond({
        stopReason: "tool_use",
        text: "I'll yield the result back to the parent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-1" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: {
                result: "Hello from subagent 1",
              },
            },
          },
        ],
      });

      // Verify the first thread shows as yielded
      await driver.assertDisplayBufferContains(
        `- Echo 'Hello from subagent 1' and yield the result.: ✅ 1 lines`,
      );
      // Second thread should still be running
      await driver.assertDisplayBufferContains(
        `- Echo 'Hello from subagent 2' and yield the result.: ⏳ streaming response`,
      );

      // Second subagent yields successfully
      const subagent2Request =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Echo 'Hello from subagent 2'",
        );
      subagent2Request.respond({
        stopReason: "tool_use",
        text: "I'll yield the result back to the parent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-2" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: {
                result: "Hello from subagent 2",
              },
            },
          },
        ],
      });

      // Verify both threads have completed and the wait tool shows final results
      await driver.assertDisplayBufferContains(
        `⏳✅ wait_for_subagents (2 threads)`,
      );
    });
  });

  it("wait_for_subagents view shows stopped state", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText(
        "Create two subagents: one will stop normally, one will succeed.",
      );
      await driver.send();

      const request1 = await driver.mockAnthropic.awaitPendingStreamWithText(
        "Create two subagents",
      );
      request1.respond({
        stopReason: "tool_use",
        text: "I'll spawn two sub-agents to demonstrate different outcomes.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-1" as ToolRequestId,
              toolName: "spawn_subagent" as ToolName,
              input: {
                prompt: "Just say something and stop without yielding.",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("🤖✅ spawn_subagent");
      const thread2 = driver.getThreadId(1);

      const request2 = await driver.mockAnthropic.awaitPendingStreamWithText(
        `Sub-agent started with threadId: ${thread2}`,
      );
      request2.respond({
        stopReason: "tool_use",
        text: "Now spawning the second sub-agent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-2" as ToolRequestId,
              toolName: "spawn_subagent" as ToolName,
              input: {
                prompt: "Echo 'Success!' and yield the result.",
              },
            },
          },
        ],
      });

      await driver.awaitThreadCount(3);
      const thread3 = driver.getThreadId(2);

      // Start waiting for both subagents
      const request3 = await driver.mockAnthropic.awaitPendingStreamWithText(
        `Sub-agent started with threadId: ${thread3}`,
      );
      request3.respond({
        stopReason: "tool_use",
        text: "Now I'll wait for both sub-agents to complete.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "wait-both" as ToolRequestId,
              toolName: "wait_for_subagents" as ToolName,
              input: {
                threadIds: [thread2, thread3],
              },
            },
          },
        ],
      });

      // Verify we see both threads in waiting state initially
      await driver.assertDisplayBufferContains("⏳ Waiting for 2 subagent(s):");

      // First subagent stops without yielding
      const subagent1Request =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Just say something and stop",
        );
      subagent1Request.respond({
        stopReason: "end_turn",
        text: "I'll just say hello and stop here without yielding.",
        toolRequests: [],
      });

      // Verify the first thread shows as stopped
      await driver.assertDisplayBufferContains(
        `- Just say something and stop without yielding.: ⏹️ stopped (end_turn)`,
      );

      // Second subagent succeeds and yields
      const subagent2Request =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Echo 'Success!'",
        );
      subagent2Request.respond({
        stopReason: "tool_use",
        text: "I'll echo success and yield the result.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "success-command" as ToolRequestId,
              toolName: "bash_command" as ToolName,
              input: {
                command: "echo 'Success!'",
              },
            },
          },
        ],
      });

      const subagent2Request2 =
        await driver.mockAnthropic.awaitPendingStreamWithText("exit code 0");
      subagent2Request2.respond({
        stopReason: "tool_use",
        text: "I'll yield this successful result.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-success" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: {
                result: "Success!",
              },
            },
          },
        ],
      });

      // Verify the second thread shows as yielded
      await driver.assertDisplayBufferContains(
        `- Echo 'Success!' and yield the result.: ✅ 1 lines`,
      );

      // Verify we can see both final states - one stopped, one yielded
      // The tool is still waiting because thread 2 stopped without yielding
      await driver.assertDisplayBufferContains(
        `- Just say something and stop without yielding.: ⏹️ stopped (end_turn)`,
      );
      await driver.assertDisplayBufferContains(
        `- Echo 'Success!' and yield the result.: ✅ 1 lines`,
      );
    });
  });

  it("wait_for_subagents view allows clicking on thread lines to navigate to them", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      const thread1 = driver.getThreadId(0);

      // Spawn a subagent to have something to wait for
      await driver.inputMagentaText(
        "Use spawn_subagent to create a sub-agent that will yield a result.",
      );
      await driver.send();

      const request1 =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Use spawn_subagent",
        );
      request1.respond({
        stopReason: "tool_use",
        text: "I'll spawn a sub-agent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-test" as ToolRequestId,
              toolName: "spawn_subagent" as ToolName,
              input: {
                prompt: "Echo 'Test message' and yield the result.",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("🤖✅ spawn_subagent");
      const thread2 = driver.getThreadId(1);

      // Start waiting for the subagent
      const request2 = await driver.mockAnthropic.awaitPendingStreamWithText(
        `Sub-agent started with threadId: ${thread2}`,
      );
      request2.respond({
        stopReason: "tool_use",
        text: "Now I'll wait for the sub-agent to complete.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "wait-test" as ToolRequestId,
              toolName: "wait_for_subagents" as ToolName,
              input: {
                threadIds: [thread2],
              },
            },
          },
        ],
      });

      // Verify we see the waiting state with the thread line
      await driver.assertDisplayBufferContains("⏳ Waiting for 1 subagent(s):");
      // We should currently be in thread 1 (the parent)
      await driver.awaitChatState({
        state: "thread-selected",
        id: thread1,
      });

      // Click on the thread line to navigate to thread 2
      await driver.triggerDisplayBufferKeyOnContent(
        `- Echo 'Test message' and yield the result.: ⏳ streaming response`,
        "<CR>",
      );

      // Verify we switched to thread 2
      await driver.awaitChatState({
        state: "thread-selected",
        id: thread2,
      });

      // We should now see the subagent thread content
      await driver.assertDisplayBufferContains(
        `Parent thread: Use spawn_subagent to create a sub-agent that will...`,
      );
      await driver.assertDisplayBufferContains("# [ Untitled ]");

      // Navigate back to thread 1 via the parent thread link
      await driver.triggerDisplayBufferKeyOnContent(
        `Parent thread: Use spawn_subagent to create a sub-agent that will...`,
        "<CR>",
      );

      // Verify we're back in thread 1
      await driver.awaitChatState({
        state: "thread-selected",
        id: thread1,
      });

      // We should see the wait_for_subagents view again
      await driver.assertDisplayBufferContains("⏳ Waiting for 1 subagent(s):");
    });
  });

  it("shows thread hierarchy with parent-child relationships", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Create a parent thread with some content
      await driver.inputMagentaText("This is the parent thread");
      await driver.send();

      const parentRequest =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "This is the parent thread",
        );
      parentRequest.respond({
        stopReason: "tool_use",
        text: "I'll spawn a subagent to help with this task.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-child" as ToolRequestId,
              toolName: "spawn_subagent" as ToolName,
              input: {
                prompt: "This is a child thread task",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("🤖✅ spawn_subagent");

      // Create another parent thread
      await driver.magenta.command("new-thread");
      // Wait for new thread to be created
      await driver.awaitThreadCount(3);

      await driver.inputMagentaText("This is another parent thread");
      await driver.send();

      const parent2Request =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "This is another parent thread",
        );
      parent2Request.respond({
        stopReason: "tool_use",
        text: "I'll also spawn a subagent for this task.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-child2" as ToolRequestId,
              toolName: "spawn_subagent" as ToolName,
              input: {
                prompt: "This is another child thread task",
              },
            },
          },
        ],
      });

      // Wait for the spawn message to appear in the display buffer
      await driver.assertDisplayBufferContains("🤖✅ spawn_subagent");

      // Now view the thread hierarchy
      await driver.magenta.command("threads-overview");
      await driver.awaitChatState({
        state: "thread-overview",
      });

      // Verify hierarchical display with proper indentation
      await driver.assertDisplayBufferContains("# Threads");
      await driver.assertDisplayBufferContains(
        `- This is the parent thread: ⏳ streaming response`,
      );
      await driver.assertDisplayBufferContains(
        `  - This is a child thread task: ⏳ streaming response`,
      );
      await driver.assertDisplayBufferContains(
        `* This is another parent thread: ⏳ streaming response`,
      );
      await driver.assertDisplayBufferContains(
        `  - This is another child thread task: ⏳ streaming response`,
      );
    });
  });

  it("handles thread hierarchy with stopped and yielded children", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Create parent and spawn child that will yield
      await driver.inputMagentaText("Parent with yielding child");
      await driver.send();

      const parentRequest =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Parent with yielding child",
        );
      parentRequest.respond({
        stopReason: "tool_use",
        text: "I'll spawn a subagent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-yielder" as ToolRequestId,
              toolName: "spawn_subagent" as ToolName,
              input: {
                prompt: "Yield a result back to parent",
              },
            },
          },
        ],
      });

      // Wait for subagent to be spawned
      await driver.assertDisplayBufferContains("🤖✅ spawn_subagent");

      // Child thread yields a result
      const childRequest =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Yield a result back to parent",
        );
      childRequest.respond({
        stopReason: "tool_use",
        text: "I'll yield this result.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-result" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: {
                result:
                  "This is a very long result message that should be truncated in the thread overview display",
              },
            },
          },
        ],
      });

      // Create another parent with child that stops
      await driver.magenta.command("new-thread");
      // Wait for new thread to be created
      await driver.awaitThreadCount(3);
      await driver.inputMagentaText("Parent with stopping child");
      await driver.send();

      const parent2Request =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Parent with stopping child",
        );
      parent2Request.respond({
        stopReason: "tool_use",
        text: "I'll spawn another subagent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-stopper" as ToolRequestId,
              toolName: "spawn_subagent" as ToolName,
              input: {
                prompt: "Just stop without yielding",
              },
            },
          },
        ],
      });

      // Wait for subagent to be spawned
      await driver.assertDisplayBufferContains("🤖✅ spawn_subagent");

      // Child thread stops without yielding
      const child2Request =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Just stop without yielding",
        );
      child2Request.respond({
        stopReason: "end_turn",
        text: "I'm stopping here without yielding anything.",
        toolRequests: [],
      });

      // View thread hierarchy
      await driver.magenta.command("threads-overview");

      // Verify hierarchy shows different child states with proper formatting
      await driver.assertDisplayBufferContains(
        `- Parent with yielding child: ⏳ streaming response`,
      );
      await driver.assertDisplayBufferContains(
        `  - Yield a result back to parent: ✅ yielded`,
      );
      await driver.assertDisplayBufferContains(
        `* Parent with stopping child: ⏳ streaming response`,
      );
      await driver.assertDisplayBufferContains(
        `  - Just stop without yielding: ⏹️ stopped (end_turn)`,
      );
    });
  });

  it("allows selecting parent and child threads from hierarchy view", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      const thread1 = driver.getThreadId(0);

      // Create parent thread
      await driver.inputMagentaText("Parent thread message");
      await driver.send();

      const parentRequest =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Parent thread message",
        );
      parentRequest.respond({
        stopReason: "tool_use",
        text: "Spawning a child thread.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-test-child" as ToolRequestId,
              toolName: "spawn_subagent" as ToolName,
              input: {
                prompt: "Child thread task",
              },
            },
          },
        ],
      });

      // Wait for the subagent to be spawned
      await driver.assertDisplayBufferContains("🤖✅ spawn_subagent");
      const thread2 = driver.getThreadId(1);

      await driver.magenta.command("threads-overview");

      await driver.triggerDisplayBufferKeyOnContent(
        `  - Child thread task: ⏳ streaming response`,
        "<CR>",
      );

      await driver.awaitChatState({
        state: "thread-selected",
        id: thread2,
      });
      await driver.assertDisplayBufferContains(
        `Parent thread: Parent thread message`,
      );

      await driver.magenta.command("threads-overview");
      await driver.triggerDisplayBufferKeyOnContent(
        `- Parent thread message: ⏳ streaming response`,
        "<CR>",
      );

      // Verify we switched to the parent thread
      await driver.awaitChatState({
        state: "thread-selected",
        id: thread1,
      });
      await driver.assertDisplayBufferContains("Parent thread message");
    });
  });

  it("formats thread status correctly for different states", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Create a thread and let it complete normally
      await driver.inputMagentaText("Test message");
      await driver.send();

      const request =
        await driver.mockAnthropic.awaitPendingStreamWithText("Test message");
      request.streamText("Assistant response");
      request.finishResponse("end_turn");

      // Create another thread that will spawn a subagent
      await driver.magenta.command("new-thread");
      await driver.assertDisplayBufferContains("# [ Untitled ]");
      await driver.assertDisplayBufferContains(LOGO);
      await driver.inputMagentaText("Spawn a subagent");
      await driver.send();

      const request2 =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Spawn a subagent",
        );
      request2.respond({
        stopReason: "tool_use",
        text: "Spawning subagent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-for-status" as ToolRequestId,
              toolName: "spawn_subagent" as ToolName,
              input: {
                prompt: "Child task",
              },
            },
          },
        ],
      });

      // View threads overview to see different status formats
      await driver.magenta.command("threads-overview");

      // Verify different status displays
      await driver.assertDisplayBufferContains(
        `- Test message: ⏹️ stopped (end_turn)`,
      );
    });
  });

  it("blocking spawn_subagent shows (blocking) suffix and waits for completion", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText(
        "Use spawn_subagent with blocking=true to get a result.",
      );
      await driver.send();

      const request1 =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Use spawn_subagent",
        );
      request1.respond({
        stopReason: "tool_use",
        text: "I'll spawn a blocking sub-agent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-blocking-spawn" as ToolRequestId,
              toolName: "spawn_subagent" as ToolName,
              input: {
                prompt: "Do a task and yield back the result.",
                blocking: true,
              },
            },
          },
        ],
      });

      // Verify the blocking spawn_subagent shows waiting state with (blocking) label
      await driver.assertDisplayBufferContains(
        "🚀⏳ spawn_subagent (blocking)",
      );

      // The subagent should start running
      const subagentRequest =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Do a task and yield back",
        );
      subagentRequest.respond({
        stopReason: "tool_use",
        text: "I completed the task.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-blocking" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: {
                result: "Task completed with blocking mode",
              },
            },
          },
        ],
      });

      // After subagent yields, the blocking spawn should complete with (blocking) suffix
      await driver.assertDisplayBufferContains(
        "🤖✅ spawn_subagent (blocking)",
      );

      // The parent thread should continue with the result
      const parentContinue =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Task completed with blocking mode",
        );
      parentContinue.respond({
        stopReason: "end_turn",
        text: "Great, the blocking subagent returned successfully.",
        toolRequests: [],
      });

      await driver.assertDisplayBufferContains(
        "Great, the blocking subagent returned successfully.",
      );
    });
  });

  it("non-blocking spawn_subagent does not show (blocking) suffix", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText("Use spawn_subagent without blocking.");
      await driver.send();

      const request1 =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Use spawn_subagent",
        );
      request1.respond({
        stopReason: "tool_use",
        text: "I'll spawn a non-blocking sub-agent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-nonblocking-spawn" as ToolRequestId,
              toolName: "spawn_subagent" as ToolName,
              input: {
                prompt: "Do something in the background.",
                // blocking is false by default
              },
            },
          },
        ],
      });

      // Non-blocking spawn should show completed immediately without (blocking) suffix
      await driver.assertDisplayBufferContains("🤖✅ spawn_subagent");
      await driver.assertDisplayBufferDoesNotContain("(blocking)");
    });
  });

  it("navigates to subagent thread when clicking on spawn_subagent completed summary", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      const thread1 = driver.getThreadId(0);

      await driver.inputMagentaText(
        "Use spawn_subagent to create a sub-agent.",
      );
      await driver.send();

      const request1 =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Use spawn_subagent",
        );
      request1.respond({
        stopReason: "tool_use",
        text: "I'll spawn a sub-agent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-nav-spawn" as ToolRequestId,
              toolName: "spawn_subagent" as ToolName,
              input: {
                prompt: "Child thread for navigation test.",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("🤖✅ spawn_subagent");
      const thread2 = driver.getThreadId(1);

      // Verify we're in the parent thread
      await driver.awaitChatState({
        state: "thread-selected",
        id: thread1,
      });

      // Click on the spawn_subagent summary to navigate to the subagent thread
      await driver.triggerDisplayBufferKeyOnContent(
        "🤖✅ spawn_subagent",
        "<CR>",
      );

      // Verify we navigated to the subagent thread
      await pollUntil(
        () => driver.magenta.chat.getActiveThread().id === thread2,
      );

      // We should see the subagent thread content
      await driver.assertDisplayBufferContains(
        "Parent thread: Use spawn_subagent to create a sub-agent.",
      );
    });
  });
});
