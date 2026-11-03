import type { ToolName, ToolRequestId } from "@magenta/server";
import { describe, it } from "vitest";
import { withDriver } from "../test/preamble.ts";

describe("pending approvals surfaced in parent thread", () => {
  it("spawn_subagents surfaces bash_command approval in parent view", async () => {
    await withDriver({}, async (driver) => {
      driver.mockSandbox.setState({
        status: "unsupported",
        reason: "disabled",
      });
      await driver.showSidebar();
      await driver.magenta.command("sandbox-bypass");

      await driver.inputMagentaText("Spawn a subagent to run a command.");
      await driver.send();

      const parentStream =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Spawn a subagent",
        );

      parentStream.respond({
        stopReason: "tool_use",
        text: "I'll spawn a subagent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-1" as ToolRequestId,
              toolName: "spawn_subagents" as ToolName,
              input: {
                agents: [{ prompt: "Run mkdir to create a directory" }],
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
                description: "test",
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
      await driver.triggerDisplayBufferKeyOnContent("> YES", "<CR>");

      // After approval, the approval dialog should disappear
      await driver.assertDisplayBufferDoesNotContain("> YES");

      // After approval, the command should run and complete.
      const subagentStream2 = await driver.mockAnthropic.awaitPendingStream({
        predicate: (stream) =>
          stream.messages.some(
            (m) =>
              m.role === "user" &&
              Array.isArray(m.content) &&
              m.content.some(
                (b) => b.type === "tool_result" && b.tool_use_id === "bash-1",
              ),
          ),
        message: "waiting for subagent stream with bash-1 tool_result",
      });

      // Subagent yields its result to the parent
      subagentStream2.respond({
        stopReason: "tool_use",
        text: "Directory created successfully.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-1" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: {
                result: "Created test-approval-dir",
              },
            },
          },
        ],
      });

      // The spawn_subagents completing should trigger the parent to continue
      const parentStream2 =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Created test-approval-dir",
        );

      // Verify the parent view shows the completed subagent
      await driver.assertDisplayBufferContains("✅ ");

      parentStream2.respond({
        stopReason: "end_turn",
        text: "The subagent finished creating the directory.",
        toolRequests: [],
      });
    });
  });
});
