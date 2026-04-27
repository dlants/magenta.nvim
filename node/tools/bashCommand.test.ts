import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pollUntil, type ToolName, type ToolRequestId } from "@magenta/core";
import { describe, expect, it } from "vitest";
import { getcwd } from "../nvim/nvim.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import { MockProvider } from "../providers/mock.ts";
import { FULL_CAPABILITIES } from "../test/capabilities.ts";
import { withDriver } from "../test/preamble.ts";

describe("node/tools/bashCommand.test.ts", () => {
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

  it("abbreviates long lines and trims output to token limit", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Generate output with very long lines (5000 chars each)
      // Lines longer than MAX_OUTPUT_TOKENS_FOR_ONE_LINE * 4 (800 chars) will be abbreviated
      const longString = "A".repeat(5000);
      await driver.inputMagentaText(
        `Run this command: yes "${longString}" | head -50`,
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      const toolRequestId = "test-token-limit" as ToolRequestId;

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
                command: `yes "${longString}" | head -50`,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("✅");

      const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
      const toolResultMessage = MockProvider.findLastToolResultMessage(
        toolResultRequest.messages,
      )!;

      const content = extractToolResultText(toolResultMessage);

      // Verify the output is limited by token count (8000 characters max for 2000 tokens)
      expect(content.length).toBeLessThan(9000);

      // Should contain exit code
      expect(content).toContain("exit code 0");

      // Long lines should be abbreviated with "..." in the middle
      // The full 5000-char string should NOT be present
      expect(content).not.toContain(longString);

      // But abbreviated lines should contain the "..." marker
      expect(content).toContain("AAA...AAA");

      // Should contain omission marker due to token trimming (50 lines don't all fit)
      expect(content).toContain("lines omitted");

      // Should have log file reference
      expect(content).toMatch(/Full output \(\d+ lines\):/);
      expect(content).toContain("bashCommand.log");
    });
  });
});

function extractToolResultText(toolResultMessage: {
  role: string;
  content: unknown;
}): string {
  const content = toolResultMessage.content as {
    type: string;
    content?: string | { type: string; text?: string }[];
  }[];
  const toolResult = content[0];
  const toolContent = toolResult.content;
  if (typeof toolContent === "string") {
    return toolContent;
  }
  if (Array.isArray(toolContent)) {
    return toolContent
      .filter(
        (item): item is { type: "text"; text: string } => item.type === "text",
      )
      .map((item) => item.text)
      .join("");
  }
  return "";
}

describe("bash command output logging", () => {
  it("creates log file with command and output", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`Run: echo "line1" && echo "line2"`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      const toolRequestId = "test-log-file" as ToolRequestId;

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
                command: 'echo "line1" && echo "line2"',
              },
            },
          },
        ],
      });

      // Command is auto-approved since both echo commands are allowed
      await driver.assertDisplayBufferContains("✅");

      // Get the tool result - log file path won't be in output since it fits
      const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
      const toolResultMessage = MockProvider.findLastToolResultMessage(
        toolResultRequest.messages,
      )!;

      expect(toolResultMessage.role).toBe("user");
      expect(Array.isArray(toolResultMessage.content)).toBe(true);

      const content = extractToolResultText(toolResultMessage);
      // Short output fits in the token budget so the trailer is omitted
      expect(content).not.toContain("Full output");

      // But we can verify the log file exists by getting the thread id and constructing the path
      const thread = driver.magenta.chat.getActiveThread();
      const logPath = path.join(
        "/tmp/magenta/threads",
        thread.id,
        "tools",
        toolRequestId,
        "bashCommand.log",
      );
      expect(fs.existsSync(logPath)).toBe(true);

      const logContent = fs.readFileSync(logPath, "utf8");
      expect(logContent).toContain('$ echo "line1" && echo "line2"');
      expect(logContent).toContain("stdout:");
      expect(logContent).toContain("line1");
      expect(logContent).toContain("line2");
      expect(logContent).toContain("exit code 0");
    });
  });

  it("abbreviates output when it exceeds token budget", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      // Generate output that exceeds token budget (2000 tokens = 8000 chars)
      // Each line is ~200 chars, 100 lines = 20000 chars (exceeds budget)
      const lineContent = "X".repeat(200);
      await driver.inputMagentaText(
        `Run: bash -c 'for i in $(seq 1 100); do echo "LINE$i:${lineContent}"; done'`,
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      const toolRequestId = "test-abbreviated" as ToolRequestId;

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
                command: `bash -c 'for i in $(seq 1 100); do echo "LINE$i:${lineContent}"; done'`,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("✅");

      const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
      const toolResultMessage = MockProvider.findLastToolResultMessage(
        toolResultRequest.messages,
      )!;

      const content = extractToolResultText(toolResultMessage);

      // Should contain exit code
      expect(content).toContain("exit code 0");

      // Should contain omission marker since output exceeds budget
      expect(content).toContain("lines omitted");

      // Should contain some head lines (early LINE numbers)
      expect(content).toContain("LINE1:");

      // Should contain some tail lines (later LINE numbers)
      expect(content).toContain("LINE100:");

      // Should contain log file reference
      expect(content).toContain("Full output (100 lines):");
      expect(content).toContain("bashCommand.log");
    });
  });

  it("includes full output when 30 lines or fewer", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      // Generate exactly 30 lines
      await driver.inputMagentaText(`Run: seq 1 30`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      const toolRequestId = "test-full-output" as ToolRequestId;

      request.respond({
        stopReason: "tool_use",
        text: "Running seq.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "bash_command" as ToolName,
              input: {
                command: "seq 1 30",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("✅");

      const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
      const toolResultMessage = MockProvider.findLastToolResultMessage(
        toolResultRequest.messages,
      )!;

      const content = extractToolResultText(toolResultMessage);

      // Should contain all lines 1-30
      for (let i = 1; i <= 30; i++) {
        expect(content).toContain(`${i}\n`);
      }

      // Should NOT contain omission marker
      expect(content).not.toContain("lines omitted");

      // Short output fits in the token budget so the trailer is omitted
      expect(content).not.toContain("Full output");
    });
  });

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
      await driver.triggerDisplayBufferKeyOnContent("stdout:", "<CR>");

      // After toggling, should show full detail with command header
      await driver.assertDisplayBufferContains("command:");

      // Toggle back to preview view
      await driver.triggerDisplayBufferKeyOnContent("command:", "<CR>");

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
      await driver.triggerDisplayBufferKeyOnContent(
        "Full output (100 lines):",
        "<CR>",
      );

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

  it("includes duration in the tool result for successful commands", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`Run this command: echo 'test'`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      const toolRequestId = "test-duration" as ToolRequestId;

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
                command: "echo 'test'",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("⚡ `echo 'test'`");

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

          // Verify the result contains duration in milliseconds
          expect(resultText).toMatch(/exit code 0 \(\d+ms\)/);
        }
      }
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

  it.runIf(FULL_CAPABILITIES)("terminates process with SIGTERM", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText("Run a bash command that sleeps");
      await driver.send();

      const request =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Run a bash command",
        );

      // Command that outputs its PID then sleeps
      const command = `echo "pid: $$" && sleep 60`;

      request.respond({
        stopReason: "tool_use",
        text: "I'll run that command for you.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-bash-sigterm" as ToolRequestId,
              toolName: "bash_command" as ToolName,
              input: {
                command,
              },
            },
          },
        ],
      });

      // Wait for PID number to appear in output
      let pid = 0;
      await pollUntil(
        async () => {
          const text = await driver.getDisplayBufferText();
          const match = text.match(/pid: (\d+)/);
          if (match) {
            pid = parseInt(match[1], 10);
            return true;
          }
          throw new Error("PID not found in display buffer");
        },
        { timeout: 5000 },
      );

      // Verify process is running
      const isRunning = (p: number) => {
        const result = spawnSync("kill", ["-0", p.toString()], {
          stdio: "pipe",
        });
        return result.status === 0;
      };
      expect(isRunning(pid)).toBe(true);

      // Get the tool instance and trigger termination
      const thread = driver.magenta.chat.getActiveThread();
      const { mode } = thread.core.state;
      if (mode.type !== "tool_use") {
        throw new Error(`Expected tool_use mode, got ${mode.type}`);
      }
      const entry = mode.activeTools.get("test-bash-sigterm" as ToolRequestId);
      if (!entry) {
        throw new Error("Expected tool entry");
      }

      // Abort the tool execution
      entry.handle.abort();

      // Wait for process to be gone
      await pollUntil(
        () => {
          if (isRunning(pid)) {
            throw new Error(`Process ${pid} still running`);
          }
        },
        { timeout: 3000 },
      );

      // Verify the request was aborted
      await driver.assertDisplayBufferContains(
        "Request was aborted by the user.",
      );
    });
  });

  it.runIf(FULL_CAPABILITIES)(
    "escalates to SIGKILL when process ignores SIGTERM",
    async () => {
      await withDriver({}, async (driver) => {
        await driver.showSidebar();

        await driver.inputMagentaText(
          "Run a bash command that ignores SIGTERM",
        );
        await driver.send();

        const request =
          await driver.mockAnthropic.awaitPendingStreamWithText(
            "Run a bash command",
          );

        // Command that traps SIGTERM and ignores it, only SIGKILL can kill it
        const command = `bash -c 'trap "" TERM; echo "pid: $$"; while true; do sleep 1; done'`;

        request.respond({
          stopReason: "tool_use",
          text: "I'll run that command for you.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "test-bash-sigkill" as ToolRequestId,
                toolName: "bash_command" as ToolName,
                input: {
                  command,
                },
              },
            },
          ],
        });

        // Wait for PID number to appear in output
        let pid = 0;
        await pollUntil(
          async () => {
            const text = await driver.getDisplayBufferText();
            const match = text.match(/pid: (\d+)/);
            if (match) {
              pid = parseInt(match[1], 10);
              return true;
            }
            throw new Error("PID not found in display buffer");
          },
          { timeout: 5000 },
        );

        // Verify process is running
        const isRunning = (p: number) => {
          const result = spawnSync("kill", ["-0", p.toString()], {
            stdio: "pipe",
          });
          return result.status === 0;
        };
        expect(isRunning(pid)).toBe(true);

        // Get the tool instance and trigger termination
        const thread = driver.magenta.chat.getActiveThread();
        const { mode } = thread.core.state;
        if (mode.type !== "tool_use") {
          throw new Error(`Expected tool_use mode, got ${mode.type}`);
        }
        const entry = mode.activeTools.get(
          "test-bash-sigkill" as ToolRequestId,
        );
        if (!entry) {
          throw new Error("Expected tool entry");
        }

        // Abort the invocation
        entry.handle.abort();

        // Process should survive SIGTERM (for ~1 second) then die from SIGKILL
        // Wait a bit and verify process is still running (SIGTERM ignored)
        await new Promise((resolve) => setTimeout(resolve, 500));
        // Process might still be running at this point since it ignores SIGTERM

        // Wait for process to be gone after SIGKILL (after 1s timeout + some buffer)
        await pollUntil(
          () => {
            if (isRunning(pid)) {
              throw new Error(`Process ${pid} still running`);
            }
          },
          { timeout: 5000 },
        );

        // Verify the request was aborted
        await driver.assertDisplayBufferContains(
          "Request was aborted by the user.",
        );
      });
    },
  );

  it.runIf(FULL_CAPABILITIES)(
    "kills entire process tree including child processes",
    async () => {
      await withDriver({}, async (driver) => {
        await driver.showSidebar();

        await driver.inputMagentaText(
          "Run a bash command that spawns child processes",
        );
        await driver.send();

        const request =
          await driver.mockAnthropic.awaitPendingStreamWithText(
            "Run a bash command",
          );

        // Command that spawns child processes that output their PIDs
        // The parent spawns two children, each outputs its PID and sleeps
        const command = `bash -c '
echo "parent: $$"
bash -c "echo child1: \\$\\$; sleep 60" &
bash -c "echo child2: \\$\\$; sleep 60" &
wait
'`;

        request.respond({
          stopReason: "tool_use",
          text: "I'll run that command for you.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "test-bash-tree" as ToolRequestId,
                toolName: "bash_command" as ToolName,
                input: {
                  command,
                },
              },
            },
          ],
        });

        // Wait for all PIDs to appear in output
        let parentPid = 0;
        let child1Pid = 0;
        let child2Pid = 0;
        await pollUntil(
          async () => {
            const text = await driver.getDisplayBufferText();
            const pm = text.match(/parent: (\d+)/);
            const c1 = text.match(/child1: (\d+)/);
            const c2 = text.match(/child2: (\d+)/);
            if (pm && c1 && c2) {
              parentPid = parseInt(pm[1], 10);
              child1Pid = parseInt(c1[1], 10);
              child2Pid = parseInt(c2[1], 10);
              return true;
            }
            throw new Error("PID not found in display buffer");
          },
          { timeout: 5000 },
        );

        // Verify all processes are running (not zombie/dead)
        const isRunning = (p: number) => {
          try {
            const stat = spawnSync("cat", [`/proc/${p}/status`], {
              encoding: "utf-8",
              stdio: "pipe",
            });
            if (stat.status !== 0) return false;
            const stateMatch = stat.stdout.match(/State:\s+(\S)/);
            // Z = zombie, X = dead — these are not truly running
            return stateMatch
              ? stateMatch[1] !== "Z" && stateMatch[1] !== "X"
              : false;
          } catch {
            return false;
          }
        };

        expect(isRunning(parentPid)).toBe(true);
        expect(isRunning(child1Pid)).toBe(true);
        expect(isRunning(child2Pid)).toBe(true);

        // Get the tool instance and trigger termination
        const thread = driver.magenta.chat.getActiveThread();
        const { mode } = thread.core.state;
        if (mode.type !== "tool_use") {
          throw new Error(`Expected tool_use mode, got ${mode.type}`);
        }
        const entry = mode.activeTools.get("test-bash-tree" as ToolRequestId);
        if (!entry) {
          throw new Error("Expected tool entry");
        }

        // Abort the command
        entry.handle.abort();

        // Wait for ALL processes to be gone
        await pollUntil(
          () => {
            const parentRunning = isRunning(parentPid);
            const child1Running = isRunning(child1Pid);
            const child2Running = isRunning(child2Pid);

            if (parentRunning || child1Running || child2Running) {
              throw new Error(
                `Processes still running: parent=${parentRunning}, child1=${child1Running}, child2=${child2Running}`,
              );
            }
          },
          { timeout: 5000 },
        );

        // Verify the request was aborted
        await driver.assertDisplayBufferContains(
          "Request was aborted by the user.",
        );
      });
    },
  );
});
