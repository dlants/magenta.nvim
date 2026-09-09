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

  it("toggling sandbox off auto-approves pending approvals in the subtree", async () => {
    await withDriver({}, async (driver) => {
      driver.mockSandbox.setState({
        status: "unsupported",
        reason: "disabled",
      });
      await driver.showSidebar();

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

      const subagentStream = await driver.mockAnthropic.awaitPendingStream({
        predicate: (stream) =>
          stream.messages.some((msg) => {
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
          }),
        message: "waiting for subagent stream",
      });

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
                command: "mkdir test-auto-approve-dir",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("May I run command");
      await driver.assertDisplayBufferContains("> YES");

      // Toggle the sandbox off (bypass) on the active thread tree; pending
      // approvals in the subtree should auto-approve.
      await driver.magenta.command("sandbox-bypass");

      await driver.assertDisplayBufferDoesNotContain("> YES");

      // The auto-approved command should run and produce a tool_result.
      await driver.mockAnthropic.awaitPendingStream({
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
    });
  });

  it("spawn_subagents with multiple agents surfaces pending approvals", async () => {
    await withDriver(
      { options: { maxConcurrentSubagents: 1 } },
      async (driver) => {
        driver.mockSandbox.setState({
          status: "unsupported",
          reason: "disabled",
        });
        await driver.showSidebar();

        await driver.inputMagentaText("Run mkdir in parallel for me.");
        await driver.send();

        const parentStream =
          await driver.mockAnthropic.awaitPendingStreamWithText(
            "Run mkdir in parallel",
          );

        parentStream.respond({
          stopReason: "tool_use",
          text: "I'll use spawn_subagents.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "subagents-1" as ToolRequestId,
                toolName: "spawn_subagents" as ToolName,
                input: {
                  agents: [{ prompt: "Run the mkdir command for dir1" }],
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
          message: "waiting for subagent",
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
                  command: "mkdir test-subagents-dir",
                },
              },
            },
          ],
        });

        // The parent view should show the approval
        await driver.assertDisplayBufferContains("May I run command");
        await driver.assertDisplayBufferContains("> YES");

        // Approve from parent view
        await driver.triggerDisplayBufferKeyOnContent("> YES", "<CR>");

        // After approval, it should disappear
        await driver.assertDisplayBufferDoesNotContain("> YES");

        // After approval, the command runs. The subagent gets a new stream.
        const subagentStream2 = await driver.mockAnthropic.awaitPendingStream({
          predicate: (stream) =>
            stream.messages.some(
              (m) =>
                m.role === "user" &&
                Array.isArray(m.content) &&
                m.content.some(
                  (b) => b.type === "tool_result" && b.tool_use_id === "bash-3",
                ),
            ),
          message: "waiting for subagent stream with bash-3 tool_result",
        });

        // Subagent yields its result to parent
        subagentStream2.respond({
          stopReason: "tool_use",
          text: "Directory created.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "yield-1" as ToolRequestId,
                toolName: "yield_to_parent" as ToolName,
                input: {
                  result: "Created test-subagents-dir",
                },
              },
            },
          ],
        });

        // spawn_subagents completes and parent continues
        const parentStream2 =
          await driver.mockAnthropic.awaitPendingStreamWithText(
            "Created test-subagents-dir",
          );

        await driver.assertDisplayBufferContains("✅ ");

        parentStream2.respond({
          stopReason: "end_turn",
          text: "All directories created.",
          toolRequests: [],
        });
      },
    );
  });
});
