import { withDriver } from "../test/preamble.ts";
import { describe, it } from "vitest";
import { LOGO, type ThreadId } from "./thread.ts";
import type { ToolRequestId } from "../tools/toolManager.ts";
import type { ToolName } from "../tools/types.ts";

describe("node/chat/chat.spec.ts", () => {
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

      const request = await driver.mockAnthropic.awaitPendingRequest();
      request.streamText("I'm the assistant's response to the first thread");
      request.finishResponse("end_turn");

      await driver.assertDisplayBufferContains(
        "I'm the assistant's response to the first thread",
      );

      await driver.magenta.command("new-thread");
      await driver.assertDisplayBufferContent("# [ Untitled ]\n" + LOGO + "\n");
    });
  });

  it("shows thread overview and allows selecting a thread", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      await driver.magenta.command("new-thread");
      await driver.awaitChatState({
        state: "thread-selected",
        id: 2 as ThreadId,
      });

      await driver.magenta.command("threads-overview");

      await driver.assertDisplayBufferContains(`\
# Threads

- 1 [Untitled]: ⏹️ stopped (end_turn)
* 2 [Untitled]: ⏹️ stopped (end_turn)`);

      const threadPos = await driver.assertDisplayBufferContains(
        "- 1 [Untitled]: ⏹️ stopped (end_turn)",
      );
      await driver.triggerDisplayBufferKey(threadPos, "<CR>");
      await driver.awaitChatState({
        state: "thread-selected",
        id: 1 as ThreadId,
      });
    });
  });

  it("spawns subagent, runs command, yields result to parent", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText(
        "Use spawn_subagent to create a sub-agent that will echo 'Hello from subagent' and then yield that result back to me.",
      );
      await driver.send();

      const request1 =
        await driver.mockAnthropic.awaitPendingRequestWithText(
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

      await driver.assertDisplayBufferContains(
        "🤖✅ Sub-agent started with threadId: 2",
      );

      const request = await driver.mockAnthropic.awaitPendingRequestWithText(
        "Sub-agent started with threadId: 2",
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
                threadIds: [2 as ThreadId],
              },
            },
          },
        ],
      });

      // We should stay in the parent thread (thread 1) since switchToThread is now false
      await driver.awaitChatState(
        {
          state: "thread-selected",
          id: 1 as ThreadId,
        },
        `We stay in the parent thread during subagent execution`,
      );

      // Assert we see the waiting state in the parent thread
      await driver.assertDisplayBufferContains(
        "⏸️⏳ Waiting for 1 subagent(s):",
      );
      await driver.assertDisplayBufferContains(
        "- 2 [Untitled]: ⏳ streaming response",
      );

      const request3 =
        await driver.mockAnthropic.awaitPendingRequestWithText("Echo the text");
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
        await driver.mockAnthropic.awaitPendingRequestWithText("exit code 0");
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
          id: 1 as ThreadId,
        },
        "We remain in the parent thread and see the subagent result",
      );

      await driver.assertDisplayBufferContains(
        `\
⏸️✅ All subagents completed.`,
      );
    });
  });

  it("wait_for_subagents view handles missing threads gracefully", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText("Wait for a thread that doesn't exist.");
      await driver.send();

      const request =
        await driver.mockAnthropic.awaitPendingRequestWithText(
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
                threadIds: [999 as ThreadId], // Non-existent thread ID
              },
            },
          },
        ],
      });

      // Verify we see the missing thread status
      await driver.assertDisplayBufferContains(
        "⏸️⏳ Waiting for 1 subagent(s):",
      );
      await driver.assertDisplayBufferContains(
        "- 999 [Untitled]: ❓ not found",
      );
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
        await driver.mockAnthropic.awaitPendingRequestWithText(
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

      await driver.assertDisplayBufferContains(
        "🤖✅ Sub-agent started with threadId: 2",
      );

      const request2 = await driver.mockAnthropic.awaitPendingRequestWithText(
        "Sub-agent started with threadId: 2",
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

      await driver.assertDisplayBufferContains(
        "🤖✅ Sub-agent started with threadId: 3",
      );

      // Start waiting for both subagents
      const request3 = await driver.mockAnthropic.awaitPendingRequestWithText(
        "Sub-agent started with threadId: 3",
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
                threadIds: [2 as ThreadId, 3 as ThreadId],
              },
            },
          },
        ],
      });

      // Verify we see both threads in waiting state
      await driver.assertDisplayBufferContains(
        "⏸️⏳ Waiting for 2 subagent(s):",
      );
      await driver.assertDisplayBufferContains(
        "- 2 [Untitled]: ⏳ streaming response",
      );
      await driver.assertDisplayBufferContains(
        "- 3 [Untitled]: ⏳ streaming response",
      );

      // First subagent yields successfully
      const subagent1Request =
        await driver.mockAnthropic.awaitPendingRequestWithText(
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
        "- 2 [Untitled]: ✅ yielded: Hello from subagent 1",
      );
      // Second thread should still be running
      await driver.assertDisplayBufferContains(
        "- 3 [Untitled]: ⏳ streaming response",
      );

      // Second subagent yields successfully
      const subagent2Request =
        await driver.mockAnthropic.awaitPendingRequestWithText(
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
      await driver.assertDisplayBufferContains(`⏸️✅ All subagents completed.`);
    });
  });

  it("wait_for_subagents view shows stopped state", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText(
        "Create two subagents: one will stop normally, one will succeed.",
      );
      await driver.send();

      const request1 = await driver.mockAnthropic.awaitPendingRequestWithText(
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

      await driver.assertDisplayBufferContains(
        "🤖✅ Sub-agent started with threadId: 2",
      );

      const request2 = await driver.mockAnthropic.awaitPendingRequestWithText(
        "Sub-agent started with threadId: 2",
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

      await driver.assertDisplayBufferContains(
        "🤖✅ Sub-agent started with threadId: 3",
      );

      // Start waiting for both subagents
      const request3 = await driver.mockAnthropic.awaitPendingRequestWithText(
        "Sub-agent started with threadId: 3",
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
                threadIds: [2 as ThreadId, 3 as ThreadId],
              },
            },
          },
        ],
      });

      // Verify we see both threads in waiting state initially
      await driver.assertDisplayBufferContains(
        "⏸️⏳ Waiting for 2 subagent(s):",
      );

      // First subagent stops without yielding
      const subagent1Request =
        await driver.mockAnthropic.awaitPendingRequestWithText(
          "Just say something and stop",
        );
      subagent1Request.respond({
        stopReason: "end_turn",
        text: "I'll just say hello and stop here without yielding.",
        toolRequests: [],
      });

      // Verify the first thread shows as stopped
      await driver.assertDisplayBufferContains(
        "- 2 [Untitled]: ⏹️ stopped (end_turn)",
      );

      // Second subagent succeeds and yields
      const subagent2Request =
        await driver.mockAnthropic.awaitPendingRequestWithText(
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
        await driver.mockAnthropic.awaitPendingRequestWithText("exit code 0");
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
        "- 3 [Untitled]: ✅ yielded: Success!",
      );

      // Verify we can see both final states - one stopped, one yielded
      // The tool is still waiting because thread 2 stopped without yielding
      await driver.assertDisplayBufferContains(
        "- 2 [Untitled]: ⏹️ stopped (end_turn)",
      );
      await driver.assertDisplayBufferContains(
        "- 3 [Untitled]: ✅ yielded: Success!",
      );
    });
  });
  it("wait_for_subagents view allows clicking on thread lines to navigate to them", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Spawn a subagent to have something to wait for
      await driver.inputMagentaText(
        "Use spawn_subagent to create a sub-agent that will yield a result.",
      );
      await driver.send();

      const request1 =
        await driver.mockAnthropic.awaitPendingRequestWithText(
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

      await driver.assertDisplayBufferContains(
        "🤖✅ Sub-agent started with threadId: 2",
      );

      // Start waiting for the subagent
      const request2 = await driver.mockAnthropic.awaitPendingRequestWithText(
        "Sub-agent started with threadId: 2",
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
                threadIds: [2 as ThreadId],
              },
            },
          },
        ],
      });

      // Verify we see the waiting state with the thread line
      await driver.assertDisplayBufferContains(
        "⏸️⏳ Waiting for 1 subagent(s):",
      );
      const threadLinePos = await driver.assertDisplayBufferContains(
        "- 2 [Untitled]: ⏳ streaming response",
      );

      // We should currently be in thread 1 (the parent)
      await driver.awaitChatState({
        state: "thread-selected",
        id: 1 as ThreadId,
      });

      // Click on the thread line to navigate to thread 2
      await driver.triggerDisplayBufferKey(threadLinePos, "<CR>");

      // Verify we switched to thread 2
      await driver.awaitChatState({
        state: "thread-selected",
        id: 2 as ThreadId,
      });

      // We should now see the subagent thread content
      await driver.assertDisplayBufferContains("Parent thread: 1");
      await driver.assertDisplayBufferContains("# [ Untitled ]");

      // Navigate back to thread 1 via the parent thread link
      const parentLinkPos =
        await driver.assertDisplayBufferContains("Parent thread: 1");
      await driver.triggerDisplayBufferKey(parentLinkPos, "<CR>");

      // Verify we're back in thread 1
      await driver.awaitChatState({
        state: "thread-selected",
        id: 1 as ThreadId,
      });

      // We should see the wait_for_subagents view again
      await driver.assertDisplayBufferContains(
        "⏸️⏳ Waiting for 1 subagent(s):",
      );
    });
  });

  it("shows thread hierarchy with parent-child relationships", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Create a parent thread with some content
      await driver.inputMagentaText("This is the parent thread");
      await driver.send();

      const parentRequest =
        await driver.mockAnthropic.awaitPendingRequestWithText(
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

      await driver.assertDisplayBufferContains(
        "🤖✅ Sub-agent started with threadId: 2",
      );

      // Create another parent thread
      await driver.magenta.command("new-thread");
      await driver.awaitChatState({
        state: "thread-selected",
        id: 3 as ThreadId,
      });

      await driver.inputMagentaText("This is another parent thread");
      await driver.send();

      const parent2Request =
        await driver.mockAnthropic.awaitPendingRequestWithText(
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
      await driver.assertDisplayBufferContains(
        "🤖✅ Sub-agent started with threadId: 4",
      );

      // Now view the thread hierarchy
      await driver.magenta.command("threads-overview");
      await driver.awaitChatState({
        state: "thread-overview",
      });

      // Verify hierarchical display with proper indentation
      await driver.assertDisplayBufferContains(`\
# Threads

- 1 [Untitled]: ⏳ streaming response
  - 2 [Untitled]: ⏳ streaming response
* 3 [Untitled]: ⏳ streaming response
  - 4 [Untitled]: ⏳ streaming response`);
    });
  });

  it("handles thread hierarchy with stopped and yielded children", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Create parent and spawn child that will yield
      await driver.inputMagentaText("Parent with yielding child");
      await driver.send();

      const parentRequest =
        await driver.mockAnthropic.awaitPendingRequestWithText(
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

      // Child thread yields a result
      const childRequest =
        await driver.mockAnthropic.awaitPendingRequestWithText(
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
      await driver.inputMagentaText("Parent with stopping child");
      await driver.send();

      const parent2Request =
        await driver.mockAnthropic.awaitPendingRequestWithText(
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

      // Child thread stops without yielding
      const child2Request =
        await driver.mockAnthropic.awaitPendingRequestWithText(
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
        "- 1 [Untitled]: ⏳ streaming response",
      );
      await driver.assertDisplayBufferContains(
        "  - 2 [Untitled]: ✅ yielded: This is a very long result message that should ...",
      );
      await driver.assertDisplayBufferContains(
        "* 3 [Untitled]: ⏳ streaming response",
      );
      await driver.assertDisplayBufferContains(
        "  - 4 [Untitled]: ⏹️ stopped (end_turn)",
      );
    });
  });

  it("allows selecting parent and child threads from hierarchy view", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Create parent thread
      await driver.inputMagentaText("Parent thread message");
      await driver.send();

      const parentRequest =
        await driver.mockAnthropic.awaitPendingRequestWithText(
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
      await driver.assertDisplayBufferContains(
        "🤖✅ Sub-agent started with threadId: 2",
      );

      await driver.magenta.command("threads-overview");

      const childThreadPos = await driver.assertDisplayBufferContains(
        "  - 2 [Untitled]: ⏳ streaming response",
      );
      await driver.triggerDisplayBufferKey(childThreadPos, "<CR>");

      await driver.awaitChatState({
        state: "thread-selected",
        id: 2 as ThreadId,
      });
      await driver.assertDisplayBufferContains("Parent thread: 1");

      await driver.magenta.command("threads-overview");
      const parentThreadPos = await driver.assertDisplayBufferContains(
        "- 1 [Untitled]: ⏳ streaming response",
      );
      await driver.triggerDisplayBufferKey(parentThreadPos, "<CR>");

      // Verify we switched to the parent thread
      await driver.awaitChatState({
        state: "thread-selected",
        id: 1 as ThreadId,
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
        await driver.mockAnthropic.awaitPendingRequestWithText("Test message");
      request.streamText("Assistant response");
      request.finishResponse("end_turn");

      // Create another thread that will spawn a subagent
      await driver.magenta.command("new-thread");
      await driver.inputMagentaText("Spawn a subagent");
      await driver.send();

      const request2 =
        await driver.mockAnthropic.awaitPendingRequestWithText(
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
        "- 1 [Untitled]: ⏹️ stopped (end_turn)",
      );
      await driver.assertDisplayBufferContains(
        "* 2 [Untitled]: ⏳ streaming response",
      );
      await driver.assertDisplayBufferContains(
        "  - 3 [Untitled]: ⏳ streaming response",
      );
    });
  });
});
