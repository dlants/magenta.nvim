import { withDriver } from "../test/preamble.ts";
import { describe, it } from "vitest";
import type { ToolRequestId } from "./toolManager.ts";
import type { ToolName } from "./types.ts";

describe("pending approvals surfaced in parent thread", () => {
  it("blocking spawn_subagent surfaces bash_command approval in parent view", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText(
        "Spawn a blocking subagent to run a command.",
      );
      await driver.send();

      const parentStream =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Spawn a blocking subagent",
        );

      parentStream.respond({
        stopReason: "tool_use",
        text: "I'll spawn a blocking subagent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-1" as ToolRequestId,
              toolName: "spawn_subagent" as ToolName,
              input: {
                prompt: "Run mkdir to create a directory",
                blocking: true,
              },
            },
          },
        ],
      });

      // Wait for the subagent stream
      const subagentStream = await driver.mockAnthropic.awaitPendingStream({
        predicate: (stream) => {
          return stream.messages.some((msg) => {
            if (msg.role !== "user") return false;
            const content = msg.content;
            if (typeof content === "string")
              return content.includes("Run mkdir");
            if (Array.isArray(content)) {
              return content.some(
                (block) =>
                  block.type === "text" && block.text.includes("Run mkdir"),
              );
            }
            return false;
          });
        },
        message: "waiting for subagent stream",
      });

      // Subagent responds with a bash_command that requires approval
      // mkdir is not in the auto-approved builtin commands
      subagentStream.respond({
        stopReason: "tool_use",
        text: "I'll run the mkdir command.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "bash-1" as ToolRequestId,
              toolName: "bash_command" as ToolName,
              input: {
                command: "mkdir test-approval-dir",
              },
            },
          },
        ],
      });

      // The parent view should show the approval dialog surfaced from the subagent
      await driver.assertDisplayBufferContains("May I run command");
      await driver.assertDisplayBufferContains("> YES");
      await driver.assertDisplayBufferContains("> NO");
      await driver.assertDisplayBufferContains("waiting for approval");

      // Approve from parent view
      const yesPos = await driver.assertDisplayBufferContains("> YES");
      await driver.triggerDisplayBufferKey(yesPos, "<CR>");

      // After approval, the approval dialog should disappear
      await driver.assertDisplayBufferDoesNotContain("> YES");
    });
  });

  it("wait_for_subagents surfaces pending approvals", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText("Spawn a subagent and then wait for it.");
      await driver.send();

      const stream1 = await driver.mockAnthropic.awaitPendingStreamWithText(
        "Spawn a subagent and then wait",
      );

      // Parent spawns a non-blocking subagent
      stream1.respond({
        stopReason: "tool_use",
        text: "I'll spawn a subagent first.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-1" as ToolRequestId,
              toolName: "spawn_subagent" as ToolName,
              input: {
                prompt: "Run mkdir to create a directory",
              },
            },
          },
        ],
      });

      // Wait for spawn_subagent to complete (non-blocking returns immediately)
      await driver.assertDisplayBufferContains("🤖✅ spawn_subagent");

      const subagentThreadId = driver.getThreadId(1);

      // Parent gets tool result and calls wait_for_subagents
      const stream2 = await driver.mockAnthropic.awaitPendingStreamWithText(
        `threadId: ${subagentThreadId}`,
      );

      stream2.respond({
        stopReason: "tool_use",
        text: "Now I'll wait for it.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "wait-1" as ToolRequestId,
              toolName: "wait_for_subagents" as ToolName,
              input: {
                threadIds: [subagentThreadId],
              },
            },
          },
        ],
      });

      // Wait for the waiting state to appear
      await driver.assertDisplayBufferContains(
        "⏸️⏳ Waiting for 1 subagent(s):",
      );

      // Now the subagent gets its stream
      const subagentStream =
        await driver.mockAnthropic.awaitPendingStreamWithText("Run mkdir");

      // Subagent responds with bash_command requiring approval
      subagentStream.respond({
        stopReason: "tool_use",
        text: "Running mkdir.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "bash-2" as ToolRequestId,
              toolName: "bash_command" as ToolName,
              input: {
                command: "mkdir test-wait-dir",
              },
            },
          },
        ],
      });

      // The parent view should show the approval in the wait_for_subagents section
      await driver.assertDisplayBufferContains("May I run command");
      await driver.assertDisplayBufferContains("> YES");

      // Approve from parent view
      const yesPos = await driver.assertDisplayBufferContains("> YES");
      await driver.triggerDisplayBufferKey(yesPos, "<CR>");

      // After approval, it should disappear
      await driver.assertDisplayBufferDoesNotContain("> YES");
    });
  });

  it("spawn_foreach surfaces pending approvals from element subagents", async () => {
    await withDriver(
      { options: { maxConcurrentSubagents: 1 } },
      async (driver) => {
        await driver.showSidebar();

        await driver.inputMagentaText("Run mkdir in parallel for me.");
        await driver.send();

        const parentStream =
          await driver.mockAnthropic.awaitPendingStreamWithText(
            "Run mkdir in parallel",
          );

        parentStream.respond({
          stopReason: "tool_use",
          text: "I'll use spawn_foreach.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "foreach-1" as ToolRequestId,
                toolName: "spawn_foreach" as ToolName,
                input: {
                  prompt: "Run the mkdir command for the given directory name",
                  elements: ["dir1"],
                },
              },
            },
          ],
        });

        // Wait for the foreach element's subagent stream
        const subagentStream = await driver.mockAnthropic.awaitPendingStream({
          predicate: (stream) => {
            return stream.messages.some((msg) => {
              if (msg.role !== "user") return false;
              const content = msg.content;
              if (typeof content === "string") return content.includes("dir1");
              if (Array.isArray(content)) {
                return content.some(
                  (block) =>
                    block.type === "text" && block.text.includes("dir1"),
                );
              }
              return false;
            });
          },
          message: "waiting for foreach element subagent",
        });

        // Subagent responds with bash_command requiring approval
        subagentStream.respond({
          stopReason: "tool_use",
          text: "Running mkdir.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "bash-3" as ToolRequestId,
                toolName: "bash_command" as ToolName,
                input: {
                  command: "mkdir test-foreach-dir",
                },
              },
            },
          ],
        });

        // The parent view should show the approval in the spawn_foreach section
        await driver.assertDisplayBufferContains("May I run command");
        await driver.assertDisplayBufferContains("> YES");

        // Approve from parent view
        const yesPos = await driver.assertDisplayBufferContains("> YES");
        await driver.triggerDisplayBufferKey(yesPos, "<CR>");

        // After approval, it should disappear
        await driver.assertDisplayBufferDoesNotContain("> YES");
      },
    );
  });
});
