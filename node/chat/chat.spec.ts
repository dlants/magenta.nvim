import { withDriver } from "../test/preamble.ts";
import { describe, it } from "vitest";
import { LOGO, type ThreadId } from "./thread.ts";
import type { ToolRequestId } from "../tools/toolManager.ts";

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

      await driver.mockAnthropic.streamText(
        "I'm the assistant's response to the first thread",
      );

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

- 1 [Untitled]
* 2 [Untitled]`);

      const threadPos =
        await driver.assertDisplayBufferContains("1 [Untitled]");
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

      await driver.mockAnthropic.awaitPendingRequest();
      await driver.mockAnthropic.respond({
        stopReason: "tool_use",
        text: "I'll spawn a sub-agent to handle this task.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-spawn-subagent" as ToolRequestId,
              toolName: "spawn_subagent",
              input: {
                prompt:
                  "Echo the text 'Hello from subagent' using the bash_command tool, then yield that result back to the parent using yield_to_parent.",
                allowedTools: ["bash_command"],
              },
            },
          },
        ],
      });

      await driver.awaitChatState(
        {
          state: "thread-selected",
          id: 2 as ThreadId,
        },
        `After the initial spawn_subagent command, we show the subthread`,
      );

      await driver.assertDisplayBufferContains(
        "Echo the text 'Hello from subagent'",
      );

      await driver.mockAnthropic.awaitPendingRequest();
      await driver.mockAnthropic.respond({
        stopReason: "tool_use",
        text: "I'll echo that text for you.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-bash-command" as ToolRequestId,
              toolName: "bash_command",
              input: {
                command: "echo 'Hello from subagent'",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("Hello from subagent");
      await driver.assertDisplayBufferContains("Exit code: 0");

      await driver.mockAnthropic.awaitPendingRequest();
      await driver.mockAnthropic.respond({
        stopReason: "tool_use",
        text: "I'll now yield this result back to the parent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-yield-to-parent" as ToolRequestId,
              toolName: "yield_to_parent",
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
        "After the subagent yields, we switch back to the parent",
      );

      await driver.assertDisplayBufferContains(
        "🤖✅ Sub-agent completed with result: Successfully echoed: Hello from subagent",
      );
    });
  });
});
