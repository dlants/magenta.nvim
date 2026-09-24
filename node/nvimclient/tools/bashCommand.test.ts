import fs from "node:fs";
import type { ToolName, ToolRequestId } from "@magenta/server";
import { describe, expect, it } from "vitest";
import { getcwd } from "../nvim/nvim.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import { withDriver } from "../test/preamble.ts";

describe("node/nvimclient/tools/bashCommand.test.ts", () => {
  it("executes a simple echo command without requiring approval (allowlisted)", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(
        `Run this command: echo 'Hello from Magenta!'`,
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      const toolRequestId = "test-echo-command" as ToolRequestId;

      request.respond({
        stopReason: "tool_use",
        text: "I'll run that command for you.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "bash_command" as ToolName,
              input: {
                command: "echo 'Hello from Magenta!'",
              },
            },
          },
        ],
      });

      // Since echo commands are in the allowlist, it should run automatically without requiring approval
      // Wait for command execution and UI update with the command output
      await driver.assertDisplayBufferContains("Hello from Magenta!");

      // Verify the command output is displayed
      await driver.assertDisplayBufferContains(
        "⚡ `echo 'Hello from Magenta!'`",
      );
      await driver.assertDisplayBufferContains("stdout:");
      await driver.assertDisplayBufferContains("Hello from Magenta!");
    });
  });

  it("handles command errors gracefully after approval", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      driver.mockSandbox.setState({
        status: "unsupported",
        reason: "disabled",
      });
      await driver.inputMagentaText(`Run this command: nonexistentcommand`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      const toolRequestId = "test-error-command" as ToolRequestId;

      request.respond({
        stopReason: "tool_use",
        text: "I'll run that command for you.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "bash_command" as ToolName,
              input: {
                command: "nonexistentcommand",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(
        "⚡ May I run command `nonexistentcommand`?",
      );
      await driver.triggerDisplayBufferKeyOnContent("> YES", "<CR>");

      await driver.assertDisplayBufferContains("Exit code: 127");
      await driver.assertDisplayBufferContains(
        "nonexistentcommand: command not found",
      );
    });
  });

  it("requires approval for a command not in the allowlist", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      driver.mockSandbox.setState({
        status: "unsupported",
        reason: "disabled",
      });
      await driver.inputMagentaText(
        `Run this command: true && echo "hello, world"`,
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      const toolRequestId = "test-curl-command" as ToolRequestId;

      request.respond({
        stopReason: "tool_use",
        text: "I'll run that curl command for you.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "bash_command" as ToolName,
              input: {
                command: 'true && echo "hello, world"',
              },
            },
          },
        ],
      });

      // Since this command is not in the allowlist, it should require approval
      await driver.assertDisplayBufferContains(
        '⚡ May I run command `true && echo "hello, world"`?',
      );

      // Verify approval UI is fully displayed
      await driver.assertDisplayBufferContains('true && echo "hello, world"');
      await driver.assertDisplayBufferContains("> NO");

      await driver.triggerDisplayBufferKeyOnContent("> YES", "<CR>");

      // Wait for command execution and verify output
      await driver.assertDisplayBufferContains("hello, world");

      // Verify the command format
      await driver.assertDisplayBufferContains(
        '⚡ `true && echo "hello, world"`',
      );
    });
  });

  it("handles user rejection of command", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      driver.mockSandbox.setState({
        status: "unsupported",
        reason: "disabled",
      });
      await driver.inputMagentaText(`Run this command: true && ls -la`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      const toolRequestId = "test-rejected-command" as ToolRequestId;

      request.respond({
        stopReason: "tool_use",
        text: "I'll run that command for you.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "bash_command" as ToolName,
              input: {
                command: "true && ls -la",
              },
            },
          },
        ],
      });

      // Wait for the user approval prompt
      await driver.assertDisplayBufferContains(
        "⚡ May I run command `true && ls -la`?",
      );

      // Find approval text position and trigger key on NO button
      await driver.triggerDisplayBufferKeyOnContent("> NO", "<CR>");

      // Verify the rejection message in the result
      await driver.assertDisplayBufferContains("The user did not allow");
    });
  });

  it("displays approval dialog with proper box formatting", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      driver.mockSandbox.setState({
        status: "unsupported",
        reason: "disabled",
      });
      await driver.inputMagentaText(`Run this command: dangerous-command`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      const toolRequestId = "test-box-formatting" as ToolRequestId;

      request.respond({
        stopReason: "tool_use",
        text: "I'll run that command for you.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "bash_command" as ToolName,
              input: {
                command: "dangerous-command",
              },
            },
          },
        ],
      });

      // Wait for the user approval prompt
      await driver.assertDisplayBufferContains(
        "⚡ May I run command `dangerous-command`?",
      );

      // Verify the vertical button layout is displayed correctly
      await driver.assertDisplayBufferContains("> NO");
      await driver.assertDisplayBufferContains("> YES");

      // Test that clicking YES works
      await driver.triggerDisplayBufferKeyOnContent("> YES", "<CR>");

      // Verify command executes (should fail but that's expected)
      await driver.assertDisplayBufferContains("Exit code: 127");
    });
  });

  it("terminates a long-running command with 't' key", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      driver.mockSandbox.setState({
        status: "unsupported",
        reason: "disabled",
      });
      // Use a command that will run until terminated
      await driver.inputMagentaText(`Run this command: sleep 30`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      const toolRequestId = "test-terminate-command" as ToolRequestId;

      request.respond({
        stopReason: "tool_use",
        text: "I'll run that command for you.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "bash_command" as ToolName,
              input: {
                command: "sleep 30",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(
        "⚡ May I run command `sleep 30`?",
      );
      await driver.triggerDisplayBufferKeyOnContent("> YES", "<CR>");

      // Press 't' to abort the command
      await driver.triggerDisplayBufferKeyOnContent("⚡ `sleep 30`", "t");

      // Verify that the command was aborted
      await driver.assertDisplayBufferContains(
        "❌ Request was aborted by the user.",
      );
    });
  });

  it("shows the timer in both collapsed and expanded progress views", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      driver.mockSandbox.setState({
        status: "unsupported",
        reason: "disabled",
      });
      await driver.inputMagentaText(`Run this command: sleep 30`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      const toolRequestId = "test-progress-timer" as ToolRequestId;

      request.respond({
        stopReason: "tool_use",
        text: "I'll run that command for you.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "bash_command" as ToolName,
              input: {
                command: "sleep 30",
              },
            },
          },
        ],
      });

      await driver.triggerDisplayBufferKeyOnContent("> YES", "<CR>");

      // Collapsed progress view shows the timer
      await driver.assertDisplayBufferContains("s / 300s)");

      // Expand the progress view and verify the timer is still shown
      await driver.triggerDisplayBufferKeyOnContent("s / 300s)", "=");
      await driver.assertDisplayBufferContains("s / 300s)");

      // Abort the command to clean up
      await driver.triggerDisplayBufferKeyOnContent("⚡ `sleep 30`", "t");
      await driver.assertDisplayBufferContains(
        "❌ Request was aborted by the user.",
      );
    });
  });

  it("ensures a command is executed only once", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      driver.mockSandbox.setState({
        status: "unsupported",
        reason: "disabled",
      });

      // Create a unique filename for this test
      const cwd = await getcwd(driver.nvim);
      const uniqueFile = `${cwd}/command-execution-count-${Date.now()}.txt`;
      const appendCmd = `echo "executed" >> ${uniqueFile}`;

      // First, make sure the file doesn't exist
      if (fs.existsSync(uniqueFile)) {
        fs.unlinkSync(uniqueFile);
      }

      // Run the command through magenta
      await driver.inputMagentaText(`Run this command: ${appendCmd}`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      const toolRequestId = "test-single-execution" as ToolRequestId;

      request.respond({
        stopReason: "tool_use",
        text: "I'll run the append command for you.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "bash_command" as ToolName,
              input: {
                command: appendCmd,
              },
            },
          },
        ],
      });

      // Wait for the approval prompt
      await driver.assertDisplayBufferContains("⚡ May I run command");

      // Click the YES button to approve the command
      await driver.triggerDisplayBufferKeyOnContent("> YES", "<CR>");

      // Wait for command to complete
      await driver.assertDisplayBufferContains("✅");

      // Directly check the file content using fs module
      expect(fs.existsSync(uniqueFile)).toBe(true);

      // Read file contents
      const fileContents = fs.readFileSync(uniqueFile, "utf8");

      // Split by newlines and count
      const lines = fileContents
        .split("\n")
        .filter((line) => line.trim() !== "");
      expect(lines.length).toBe(1);
      expect(lines[0].trim()).toBe("executed");
    });
  });

  it("truncates display preview but preserves full output for agent", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      const longText = "A".repeat(200); // 200 characters, much longer than WIDTH-5 (95)
      await driver.inputMagentaText(`Run this command: echo "${longText}"`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      const toolRequestId = "test-truncation" as ToolRequestId;

      request.respond({
        stopReason: "tool_use",
        text: "I'll run that command for you.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "bash_command" as ToolName,
              input: {
                command: `echo "${longText}"`,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("✅");

      // Verify display shows truncated text
      const truncatedText = `${"A".repeat(10)}...`;
      await driver.assertDisplayBufferContains(truncatedText);

      // Verify the full output is preserved for the agent
      const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
      const toolResultMessage =
        toolResultRequest.messages[toolResultRequest.messages.length - 1];

      if (
        toolResultMessage.role === "user" &&
        Array.isArray(toolResultMessage.content)
      ) {
        const toolResult = toolResultMessage.content[0];
        if (toolResult.type === "tool_result") {
          expect(toolResult.is_error).toBeFalsy();
          const content = toolResult.content;
          const resultText =
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content
                    .filter(
                      (item): item is { type: "text"; text: string } =>
                        item.type === "text",
                    )
                    .map((item) => item.text)
                    .join("")
                : "";

          // Verify the full 200-character string is preserved for the agent
          expect(resultText).toContain(longText);
          expect(resultText).toContain("exit code 0");
        }
      }
    });
  });

  it("auto-approves commands with redundant cd <cwd> && prefix", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      const cwd = await getcwd(driver.nvim);
      const commandWithCd = `cd ${cwd} && echo "Hello from cwd"`;

      await driver.inputMagentaText(`Run this command: ${commandWithCd}`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      const toolRequestId = "test-cd-prefix" as ToolRequestId;

      request.respond({
        stopReason: "tool_use",
        text: "I'll run that command for you.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "bash_command" as ToolName,
              input: {
                command: commandWithCd,
              },
            },
          },
        ],
      });

      // Should auto-approve since the stripped command "echo "Hello from cwd"" is in the allowlist
      await driver.assertDisplayBufferContains("Hello from cwd");
      await driver.assertDisplayBufferContains(`⚡ \`${commandWithCd}\``);

      // Should NOT show the approval dialog
      await driver.assertDisplayBufferDoesNotContain("> YES");
    });
  });
});

describe("bash command output logging", () => {
  it("toggles between preview and detail view with Enter key", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`Run: echo "test output"`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      const toolRequestId = "test-toggle-detail" as ToolRequestId;

      request.respond({
        stopReason: "tool_use",
        text: "Running echo.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "bash_command" as ToolName,
              input: {
                command: 'echo "test output"',
              },
            },
          },
        ],
      });

      // Wait for command to complete
      await driver.assertDisplayBufferContains('⚡ `echo "test output"`');

      // Initially in preview mode - should show output in code block
      await driver.assertDisplayBufferContains("stdout:");
      await driver.assertDisplayBufferContains("test output");

      // Detail view should NOT be shown yet (no command: header)
      await driver.assertDisplayBufferDoesNotContain("command:");

      // Toggle to detail view by pressing Enter on the output preview
      await driver.triggerDisplayBufferKeyOnContent("stdout:", "=");

      // After toggling, should show full detail with command header
      await driver.assertDisplayBufferContains("command:");

      // Toggle back to preview view
      await driver.triggerDisplayBufferKeyOnContent("command:", "=");

      // Should be back in preview mode (no command header)
      await driver.assertDisplayBufferDoesNotContain("command:");
      await driver.assertDisplayBufferContains("stdout:");
    });
  });

  it("opens log file in non-magenta window when clicking Full output link", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      // Generate output that exceeds token budget to show log file link
      // Each line is ~200 chars, 100 lines = 20000 chars (exceeds 8000 char budget)
      const lineContent = "X".repeat(200);
      const command = `bash -c 'for i in $(seq 1 100); do echo "LINE$i:${lineContent}"; done'`;
      await driver.inputMagentaText(`Run: ${command}`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      const toolRequestId = "test-open-log" as ToolRequestId;

      request.respond({
        stopReason: "tool_use",
        text: "Running command.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "bash_command" as ToolName,
              input: {
                command,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("✅");

      // Find and click the "Full output" link
      // Find and click the "Full output" link
      await driver.triggerDisplayBufferKeyOnContent("Full output (", "<CR>");

      // Verify a new window was opened with the log file
      const logWindow = await driver.findWindow(async (w) => {
        const buf = await w.buffer();
        const name = await buf.getName();
        return name.includes("bashCommand.log");
      });

      expect(logWindow).toBeDefined();

      // Verify the window is not a magenta window
      const isMagenta = await logWindow.getVar("magenta");
      expect(isMagenta).toBeFalsy();

      // Verify the log file contains the expected content
      const logBuffer = await logWindow.buffer();
      const lines = await logBuffer.getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });
      const content = lines.join("\n");
      expect(content).toContain("$ bash -c");
      expect(content).toContain("stdout:");
      expect(content).toContain("LINE1:");
      expect(content).toContain("LINE100:");
    });
  });

  it("includes duration in the tool result for failed commands", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      driver.mockSandbox.setState({
        status: "unsupported",
        reason: "disabled",
      });
      await driver.inputMagentaText(`Run this command: exit 1`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      const toolRequestId = "test-duration-error" as ToolRequestId;

      request.respond({
        stopReason: "tool_use",
        text: "I'll run that command for you.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "bash_command" as ToolName,
              input: {
                command: "exit 1",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(
        "⚡ May I run command `exit 1`?",
      );
      await driver.triggerDisplayBufferKeyOnContent("> YES", "<CR>");

      await driver.assertDisplayBufferContains("Exit code: 1");

      const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
      const toolResultMessage =
        toolResultRequest.messages[toolResultRequest.messages.length - 1];

      if (
        toolResultMessage.role === "user" &&
        Array.isArray(toolResultMessage.content)
      ) {
        const toolResult = toolResultMessage.content[0];
        if (toolResult.type === "tool_result") {
          const content = toolResult.content;
          const resultText =
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content
                    .filter(
                      (item): item is { type: "text"; text: string } =>
                        item.type === "text",
                    )
                    .map((item) => item.text)
                    .join("")
                : "";

          // Verify the result contains duration in milliseconds
          expect(resultText).toMatch(/exit code 1 \(\d+ms\)/);
        }
      }
    });
  });
});
