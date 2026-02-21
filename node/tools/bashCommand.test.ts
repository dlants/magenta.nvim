import { withDriver } from "../test/preamble";
import type { ToolRequestId } from "./toolManager";
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getcwd } from "../nvim/nvim";
import type { ToolName } from "./types";
import { MockProvider } from "../providers/mock";
import type { Row0Indexed } from "../nvim/window";
import { pollUntil } from "../utils/async.ts";
import { BashCommandTool } from "./bashCommand.ts";
import { spawnSync } from "child_process";

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
        "⚡✅ `echo 'Hello from Magenta!'`",
      );
      await driver.assertDisplayBufferContains("```");
      await driver.assertDisplayBufferContains("stdout:");
      await driver.assertDisplayBufferContains("Hello from Magenta!");
      await driver.assertDisplayBufferContains("```");
    });
  });

  it("handles command errors gracefully after approval", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
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
      const pos = await driver.assertDisplayBufferContains("> YES");
      await driver.triggerDisplayBufferKey(pos, "<CR>");

      await driver.assertDisplayBufferContains("Exit code: 127");
      await driver.assertDisplayBufferContains(
        "nonexistentcommand: command not found",
      );
    });
  });

  it("requires approval for a command not in the allowlist", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
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

      const pos = await driver.assertDisplayBufferContains("> YES");
      await driver.triggerDisplayBufferKey(pos, "<CR>");

      // Wait for command execution and verify output
      await driver.assertDisplayBufferContains("hello, world");

      // Verify the command format
      await driver.assertDisplayBufferContains(
        '⚡✅ `true && echo "hello, world"`',
      );
      await driver.assertDisplayBufferContains("```");
    });
  });

  it("handles user rejection of command", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
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
      const pos = await driver.assertDisplayBufferContains("> NO");
      await driver.triggerDisplayBufferKey(pos, "<CR>");

      // Verify the rejection message in the result
      await driver.assertDisplayBufferContains("The user did not allow");
    });
  });

  it("displays approval dialog with proper box formatting", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
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
      await driver.assertDisplayBufferContains("> ALWAYS");

      // Test that clicking YES works
      const yesPos = await driver.assertDisplayBufferContains("> YES");
      await driver.triggerDisplayBufferKey(yesPos, "<CR>");

      // Verify command executes (should fail but that's expected)
      await driver.assertDisplayBufferContains("Exit code: 127");
    });
  });

  it("terminates a long-running command with 't' key", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
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
      const approvePos = await driver.assertDisplayBufferContains("> YES");
      await driver.triggerDisplayBufferKey(approvePos, "<CR>");

      const pos = await driver.assertDisplayBufferContains("⚡⚙️ (");

      // Press 't' to terminate the command
      await driver.triggerDisplayBufferKey(pos, "t");

      // Verify that the command was terminated
      await driver.assertDisplayBufferContains("terminated by signal SIGTERM");

      // Ensure the command prompt is updated to show completion
      await driver.assertDisplayBufferContains(
        "⚡❌ `sleep 30` - Terminated by SIGTERM",
      );
      await driver.assertDisplayBufferContains("```");
    });
  });

  it("allows subsequent runs of a command after selecting ALWAYS", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // First run of the command requiring approval
      await driver.inputMagentaText(`Run this command: "true && echo 'tada'`);
      await driver.send();

      const request1 = await driver.mockAnthropic.awaitPendingStream();
      const toolRequestId1 = "test-remembered-command-1" as ToolRequestId;

      request1.respond({
        stopReason: "tool_use",
        text: "I'll run that command for you.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId1,
              toolName: "bash_command" as ToolName,
              input: {
                command: `true && echo 'tada'`,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(
        "⚡ May I run command `true && echo 'tada'`?",
      );

      const alwaysPos = await driver.assertDisplayBufferContains("> ALWAYS");
      await driver.triggerDisplayBufferKey(alwaysPos, "<CR>");

      await driver.inputMagentaText(`Ok, run it again`);
      await driver.send();

      const request2 = await driver.mockAnthropic.awaitPendingStream();
      const toolRequestId2 = "test-remembered-command-2" as ToolRequestId;

      request2.respond({
        stopReason: "tool_use",
        text: "Running that command again.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId2,
              toolName: "bash_command" as ToolName,
              input: {
                command: `true && echo 'tada'`,
              },
            },
          },
        ],
      });

      // Verify content pieces separately to allow for system reminder
      await driver.assertDisplayBufferContains("# user:");
      await driver.assertDisplayBufferContains("Ok, run it again");
      await driver.assertDisplayBufferContains("# assistant:");
      await driver.assertDisplayBufferContains("Running that command again.");
      await driver.assertDisplayBufferContains("⚡✅ `true && echo 'tada'`");
      await driver.assertDisplayBufferContains("stdout:");
      await driver.assertDisplayBufferContains("tada");
    });
  });

  it("ensures a command is executed only once", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

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
      const yesPos = await driver.assertDisplayBufferContains("> YES");
      await driver.triggerDisplayBufferKey(yesPos, "<CR>");

      // Wait for command to complete
      await driver.assertDisplayBufferContains("⚡✅");

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
    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["echo", { type: "restAny" }]],
            pipeCommands: [],
          },
        },
      },
      async (driver) => {
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

        await driver.assertDisplayBufferContains("⚡✅");

        // Verify display shows truncated text
        const truncatedText = "A".repeat(10) + "...";
        await driver.assertDisplayBufferContains(truncatedText);

        // Verify the full output is preserved for the agent
        const toolResultRequest =
          await driver.mockAnthropic.awaitPendingStream();
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
      },
    );
  });

  it("auto-approves commands with redundant cd <cwd> && prefix", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["echo", { type: "restAny" }]],
            pipeCommands: [],
          },
        },
      },
      async (driver) => {
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
        await driver.assertDisplayBufferContains(`⚡✅ \`${commandWithCd}\``);

        // Should NOT show the approval dialog
        await driver.assertDisplayBufferDoesNotContain("> YES");
      },
    );
  });

  it("abbreviates long lines and trims output to token limit", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [
              ["yes", { type: "restAny" }],
              ["head", { type: "restAny" }],
            ],
            pipeCommands: [["head", { type: "restAny" }]],
          },
        },
      },
      async (driver) => {
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

        await driver.assertDisplayBufferContains("⚡✅");

        const toolResultRequest =
          await driver.mockAnthropic.awaitPendingStream();
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
      },
    );
  });
});

describe("commandConfig integration tests", () => {
  it("auto-approves commands with restAny option", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["echo", { type: "restAny" }]],
            pipeCommands: [],
          },
        },
      },
      async (driver) => {
        await driver.showSidebar();
        await driver.inputMagentaText(`Run this command: echo "hello world"`);
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingStream();
        const toolRequestId = "test-restAny" as ToolRequestId;

        request.respond({
          stopReason: "tool_use",
          text: "Running echo command.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: toolRequestId,
                toolName: "bash_command" as ToolName,
                input: {
                  command: 'echo "hello world"',
                },
              },
            },
          ],
        });

        // Should auto-approve and run without showing approval dialog
        await driver.assertDisplayBufferContains('⚡✅ `echo "hello world"`');
        await driver.assertDisplayBufferContains("hello world");
        await driver.assertDisplayBufferDoesNotContain("> YES");
      },
    );
  });

  it("auto-approves commands with exact arg patterns", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["ls", "-la"]],
            pipeCommands: [],
          },
        },
      },
      async (driver) => {
        await driver.showSidebar();
        await driver.inputMagentaText(`Run this command: ls -la`);
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingStream();
        const toolRequestId = "test-subcommand" as ToolRequestId;

        request.respond({
          stopReason: "tool_use",
          text: "Listing files.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: toolRequestId,
                toolName: "bash_command" as ToolName,
                input: {
                  command: "ls -la",
                },
              },
            },
          ],
        });

        // Should auto-approve since args match exactly
        await driver.assertDisplayBufferContains("⚡✅ `ls -la`");
        await driver.assertDisplayBufferDoesNotContain("> YES");
      },
    );
  });

  it("requires approval for commands with non-matching args", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["npx", "tsc", "--noEmit"]],
            pipeCommands: [],
          },
        },
      },
      async (driver) => {
        await driver.showSidebar();
        // --watch is not in the allowed args
        await driver.inputMagentaText(
          `Run this command: npx tsc --watch --noEmit`,
        );
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingStream();
        const toolRequestId = "test-wrong-args" as ToolRequestId;

        request.respond({
          stopReason: "tool_use",
          text: "Running tsc.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: toolRequestId,
                toolName: "bash_command" as ToolName,
                input: {
                  command: "npx tsc --watch --noEmit",
                },
              },
            },
          ],
        });

        // Should require approval since args don't match
        await driver.assertDisplayBufferContains(
          "⚡ May I run command `npx tsc --watch --noEmit`?",
        );
        await driver.assertDisplayBufferContains("> YES");
      },
    );
  });

  it("auto-approves cat with valid file path", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["cat", { type: "file" }]],
            pipeCommands: [],
          },
        },
      },
      async (driver) => {
        await driver.showSidebar();
        const cwd = await getcwd(driver.nvim);

        // Create a test file in the project
        const testFile = path.join(cwd, "test-cat-file.txt");
        fs.writeFileSync(testFile, "test content for cat");

        await driver.inputMagentaText(
          `Run this command: cat test-cat-file.txt`,
        );
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingStream();
        const toolRequestId = "test-cat-file" as ToolRequestId;

        request.respond({
          stopReason: "tool_use",
          text: "Reading file.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: toolRequestId,
                toolName: "bash_command" as ToolName,
                input: {
                  command: "cat test-cat-file.txt",
                },
              },
            },
          ],
        });

        // Should auto-approve since file is in project
        await driver.assertDisplayBufferContains(
          "⚡✅ `cat test-cat-file.txt`",
        );
        await driver.assertDisplayBufferContains("test content for cat");
        await driver.assertDisplayBufferDoesNotContain("> YES");
      },
    );
  });

  it("requires approval for cat with file outside project", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["cat", { type: "file" }]],
            pipeCommands: [],
          },
        },
      },
      async (driver) => {
        await driver.showSidebar();

        await driver.inputMagentaText(`Run this command: cat /etc/passwd`);
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingStream();
        const toolRequestId = "test-cat-outside" as ToolRequestId;

        request.respond({
          stopReason: "tool_use",
          text: "Reading file.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: toolRequestId,
                toolName: "bash_command" as ToolName,
                input: {
                  command: "cat /etc/passwd",
                },
              },
            },
          ],
        });

        // Should require approval since file is outside project
        await driver.assertDisplayBufferContains(
          "⚡ May I run command `cat /etc/passwd`?",
        );
        await driver.assertDisplayBufferContains("> YES");
      },
    );
  });

  it("auto-approves command with restFiles pattern", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["cat", { type: "restFiles" }]],
            pipeCommands: [],
          },
        },
      },
      async (driver) => {
        await driver.showSidebar();
        const cwd = await getcwd(driver.nvim);

        // Create test files in the project
        const testFile1 = path.join(cwd, "testfile1.txt");
        const testFile2 = path.join(cwd, "testfile2.txt");
        fs.writeFileSync(testFile1, "content of file 1");
        fs.writeFileSync(testFile2, "content of file 2");

        await driver.inputMagentaText(
          `Run this command: cat testfile1.txt testfile2.txt`,
        );
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingStream();
        const toolRequestId = "test-restfiles" as ToolRequestId;

        request.respond({
          stopReason: "tool_use",
          text: "Reading files.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: toolRequestId,
                toolName: "bash_command" as ToolName,
                input: {
                  command: "cat testfile1.txt testfile2.txt",
                },
              },
            },
          ],
        });

        // Should auto-approve since all files are in project
        await driver.assertDisplayBufferContains(
          "⚡✅ `cat testfile1.txt testfile2.txt`",
        );
        await driver.assertDisplayBufferContains("content of file 1");
        await driver.assertDisplayBufferContains("content of file 2");
        await driver.assertDisplayBufferDoesNotContain("> YES");
      },
    );
  });

  it("requires approval for restFiles with file outside project", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["cat", { type: "restFiles" }]],
            pipeCommands: [],
          },
        },
      },
      async (driver) => {
        await driver.showSidebar();
        const cwd = await getcwd(driver.nvim);

        // Create a valid test file
        const testFile = path.join(cwd, "valid-file.txt");
        fs.writeFileSync(testFile, "valid content");

        await driver.inputMagentaText(
          `Run this command: cat valid-file.txt /etc/passwd`,
        );
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingStream();
        const toolRequestId = "test-restfiles-outside" as ToolRequestId;

        request.respond({
          stopReason: "tool_use",
          text: "Reading files.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: toolRequestId,
                toolName: "bash_command" as ToolName,
                input: {
                  command: "cat valid-file.txt /etc/passwd",
                },
              },
            },
          ],
        });

        // Should require approval since one file is outside project
        await driver.assertDisplayBufferContains("⚡ May I run command");
        await driver.assertDisplayBufferContains("> YES");
      },
    );
  });

  it("handles chained commands with cd", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["cat", { type: "file" }]],
            pipeCommands: [],
          },
        },
      },
      async (driver) => {
        await driver.showSidebar();
        const cwd = await getcwd(driver.nvim);

        // Create a subdirectory with a file
        const subDir = path.join(cwd, "subdir");
        fs.mkdirSync(subDir, { recursive: true });
        const testFile = path.join(subDir, "nested-file.txt");
        fs.writeFileSync(testFile, "nested content");

        await driver.inputMagentaText(
          `Run this command: cd subdir && cat nested-file.txt`,
        );
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingStream();
        const toolRequestId = "test-cd-chain" as ToolRequestId;

        request.respond({
          stopReason: "tool_use",
          text: "Reading nested file.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: toolRequestId,
                toolName: "bash_command" as ToolName,
                input: {
                  command: "cd subdir && cat nested-file.txt",
                },
              },
            },
          ],
        });

        // Should auto-approve since file resolves to within project
        await driver.assertDisplayBufferContains(
          "⚡✅ `cd subdir && cat nested-file.txt`",
        );
        await driver.assertDisplayBufferContains("nested content");
        await driver.assertDisplayBufferDoesNotContain("> YES");
      },
    );
  });

  it("requires approval when cd navigates outside project", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["cat", { type: "file" }]],
            pipeCommands: [],
          },
        },
      },
      async (driver) => {
        await driver.showSidebar();

        await driver.inputMagentaText(
          `Run this command: cd /tmp && cat somefile.txt`,
        );
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingStream();
        const toolRequestId = "test-cd-outside" as ToolRequestId;

        request.respond({
          stopReason: "tool_use",
          text: "Reading file.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: toolRequestId,
                toolName: "bash_command" as ToolName,
                input: {
                  command: "cd /tmp && cat somefile.txt",
                },
              },
            },
          ],
        });

        // Should require approval since cd navigates outside project
        await driver.assertDisplayBufferContains("⚡ May I run command");
        await driver.assertDisplayBufferContains("> YES");
      },
    );
  });

  it("requires approval for command not in config", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText(`Run this command: rm -rf /tmp/test`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      const toolRequestId = "test-not-in-config" as ToolRequestId;

      request.respond({
        stopReason: "tool_use",
        text: "Removing files.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "bash_command" as ToolName,
              input: {
                command: "rm -rf /tmp/test",
              },
            },
          },
        ],
      });

      // Should require approval since rm is not in builtin config
      await driver.assertDisplayBufferContains(
        "⚡ May I run command `rm -rf /tmp/test`?",
      );
      await driver.assertDisplayBufferContains("> YES");
    });
  });

  it("requires approval for hidden files", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["cat", { type: "file" }]],
            pipeCommands: [],
          },
        },
      },
      async (driver) => {
        await driver.showSidebar();
        const cwd = await getcwd(driver.nvim);

        // Create a hidden file
        const hiddenFile = path.join(cwd, ".hidden-file.txt");
        fs.writeFileSync(hiddenFile, "hidden content");

        await driver.inputMagentaText(`Run this command: cat .hidden-file.txt`);
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingStream();
        const toolRequestId = "test-hidden-file" as ToolRequestId;

        request.respond({
          stopReason: "tool_use",
          text: "Reading hidden file.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: toolRequestId,
                toolName: "bash_command" as ToolName,
                input: {
                  command: "cat .hidden-file.txt",
                },
              },
            },
          ],
        });

        // Should require approval for hidden files
        await driver.assertDisplayBufferContains("⚡ May I run command");
        await driver.assertDisplayBufferContains("> YES");
      },
    );
  });

  it("allows specific subcommand with restAny while restricting other patterns", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [
              ["git", "status", { type: "restAny" }],
              ["git", "log", "--oneline"],
            ],
            pipeCommands: [],
          },
        },
      },
      async (driver) => {
        await driver.showSidebar();

        // git status with any args should be allowed
        await driver.inputMagentaText(
          `Run this command: git status --porcelain`,
        );
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingStream();
        const toolRequestId = "test-git-status" as ToolRequestId;

        request.respond({
          stopReason: "tool_use",
          text: "Checking status.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: toolRequestId,
                toolName: "bash_command" as ToolName,
                input: {
                  command: "git status --porcelain",
                },
              },
            },
          ],
        });

        await driver.assertDisplayBufferContains(
          "⚡✅ `git status --porcelain`",
        );
        await driver.assertDisplayBufferDoesNotContain("> YES");
      },
    );
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
    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["echo", { type: "restAny" }]],
            pipeCommands: [],
          },
        },
      },
      async (driver) => {
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
        await driver.assertDisplayBufferContains("⚡✅");

        // Get the tool result - log file path won't be in output since it fits
        const toolResultRequest =
          await driver.mockAnthropic.awaitPendingStream();
        const toolResultMessage = MockProvider.findLastToolResultMessage(
          toolResultRequest.messages,
        )!;

        expect(toolResultMessage.role).toBe("user");
        expect(Array.isArray(toolResultMessage.content)).toBe(true);

        const content = extractToolResultText(toolResultMessage);
        // Log file path should always be in the result
        expect(content).toContain("Full output");

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
      },
    );
  });

  it("abbreviates output when it exceeds token budget", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["bash", { type: "restAny" }]],
            pipeCommands: [],
          },
        },
      },
      async (driver) => {
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

        await driver.assertDisplayBufferContains("⚡✅");

        const toolResultRequest =
          await driver.mockAnthropic.awaitPendingStream();
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
      },
    );
  });

  it("includes full output when 30 lines or fewer", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["seq", { type: "restAny" }]],
            pipeCommands: [],
          },
        },
      },
      async (driver) => {
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

        await driver.assertDisplayBufferContains("⚡✅");

        const toolResultRequest =
          await driver.mockAnthropic.awaitPendingStream();
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

        // Should always have log file reference
        expect(content).toContain("Full output");
      },
    );
  });

  it("toggles between preview and detail view with Enter key", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["echo", { type: "restAny" }]],
            pipeCommands: [],
          },
        },
      },
      async (driver) => {
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
        await driver.assertDisplayBufferContains('⚡✅ `echo "test output"`');

        // Initially in preview mode - should show output in code block
        await driver.assertDisplayBufferContains("stdout:");
        await driver.assertDisplayBufferContains("test output");

        // Detail view should NOT be shown yet (no command: header)
        await driver.assertDisplayBufferDoesNotContain("command:");

        // Toggle to detail view by pressing Enter on the output preview
        const previewPos = await driver.assertDisplayBufferContains("stdout:");
        await driver.triggerDisplayBufferKey(previewPos, "<CR>");

        // After toggling, should show full detail with command header
        await driver.assertDisplayBufferContains("command:");

        // Toggle back to preview view
        const detailPos = await driver.assertDisplayBufferContains("command:");
        await driver.triggerDisplayBufferKey(detailPos, "<CR>");

        // Should be back in preview mode (no command header)
        await driver.assertDisplayBufferDoesNotContain("command:");
        await driver.assertDisplayBufferContains("stdout:");
      },
    );
  });

  it("opens log file in non-magenta window when clicking Full output link", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["bash", { type: "restAny" }]],
            pipeCommands: [],
          },
        },
      },
      async (driver) => {
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

        await driver.assertDisplayBufferContains("⚡✅");

        // Find and click the "Full output" link
        const fullOutputPos = await driver.assertDisplayBufferContains(
          "Full output (100 lines):",
        );
        await driver.triggerDisplayBufferKey(fullOutputPos, "<CR>");

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
      },
    );
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

      await driver.assertDisplayBufferContains("⚡✅ `echo 'test'`");

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
      const pos = await driver.assertDisplayBufferContains("> YES");
      await driver.triggerDisplayBufferKey(pos, "<CR>");

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

  it("terminates process with SIGTERM", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [
              ["echo", { type: "restAny" }],
              ["sleep", { type: "restAny" }],
            ],
            pipeCommands: [],
          },
        },
      },
      async (driver) => {
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
        const { mode } = thread.state;
        if (mode.type !== "tool_use") {
          throw new Error(`Expected tool_use mode, got ${mode.type}`);
        }
        const tool = mode.activeTools.get(
          "test-bash-sigterm" as ToolRequestId,
        ) as BashCommandTool;
        expect(tool).toBeDefined();

        // Dispatch terminate message
        tool.update({ type: "terminate" });

        // Wait for process to be gone
        await pollUntil(
          () => {
            if (isRunning(pid)) {
              throw new Error(`Process ${pid} still running`);
            }
          },
          { timeout: 3000 },
        );

        // Verify the tool shows SIGTERM message
        await driver.assertDisplayBufferContains("SIGTERM");
      },
    );
  });

  it("escalates to SIGKILL when process ignores SIGTERM", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["bash", { type: "restAny" }]],
            pipeCommands: [],
          },
        },
      },
      async (driver) => {
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
        const { mode } = thread.state;
        if (mode.type !== "tool_use") {
          throw new Error(`Expected tool_use mode, got ${mode.type}`);
        }
        const tool = mode.activeTools.get(
          "test-bash-sigkill" as ToolRequestId,
        ) as BashCommandTool;
        expect(tool).toBeDefined();

        // Dispatch terminate message
        tool.update({ type: "terminate" });

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

        // Verify the tool shows SIGKILL message
        await driver.assertDisplayBufferContains("SIGKILL");
      },
    );
  });

  it("kills entire process tree including child processes", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["bash", { type: "restAny" }]],
            pipeCommands: [],
          },
        },
      },
      async (driver) => {
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

        // Verify all processes are running
        const isRunning = (p: number) => {
          const result = spawnSync("kill", ["-0", p.toString()], {
            stdio: "pipe",
          });
          return result.status === 0;
        };

        expect(isRunning(parentPid)).toBe(true);
        expect(isRunning(child1Pid)).toBe(true);
        expect(isRunning(child2Pid)).toBe(true);

        // Get the tool instance and trigger termination
        const thread = driver.magenta.chat.getActiveThread();
        const { mode } = thread.state;
        if (mode.type !== "tool_use") {
          throw new Error(`Expected tool_use mode, got ${mode.type}`);
        }
        const tool = mode.activeTools.get(
          "test-bash-tree" as ToolRequestId,
        ) as BashCommandTool;
        expect(tool).toBeDefined();

        // Dispatch terminate message
        tool.update({ type: "terminate" });

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

        // Verify the tool shows termination message
        await driver.assertDisplayBufferContains("SIGTERM");
      },
    );
  });
});

describe("bash command filePermissions tests", () => {
  it("auto-approves read command on external directory with read permission", async () => {
    let outsidePath: string;

    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["cat", { type: "readFile" }]],
            pipeCommands: [],
          },
        },
        setupExtraDirs: async (baseDir) => {
          outsidePath = path.join(baseDir, "external-data");
          await fs.promises.mkdir(outsidePath, { recursive: true });
          await fs.promises.writeFile(
            path.join(outsidePath, "allowed.txt"),
            "external content",
          );

          // Write ~/.magenta/options.json with filePermissions
          const homeDir = path.join(baseDir, "home");
          const magentaDir = path.join(homeDir, ".magenta");
          await fs.promises.mkdir(magentaDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(magentaDir, "options.json"),
            JSON.stringify({
              filePermissions: [{ path: outsidePath, read: true }],
            }),
          );
        },
      },
      async (driver) => {
        await driver.showSidebar();
        await driver.inputMagentaText(`cat the external file`);
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingStream();

        request.respond({
          stopReason: "tool_use",
          text: "Reading external file.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "test-external-read" as ToolRequestId,
                toolName: "bash_command" as ToolName,
                input: {
                  command: `cat ${outsidePath!}/allowed.txt`,
                },
              },
            },
          ],
        });

        // Should auto-approve since filePermissions grants read
        await driver.assertDisplayBufferContains(
          `⚡✅ \`cat ${outsidePath!}/allowed.txt\``,
        );
        await driver.assertDisplayBufferContains("external content");
        await driver.assertDisplayBufferDoesNotContain("> YES");
      },
    );
  });

  it("requires approval for read command on external directory without permission", async () => {
    let outsidePath: string;

    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["cat", { type: "readFile" }]],
            pipeCommands: [],
          },
        },
        setupExtraDirs: async (baseDir) => {
          outsidePath = path.join(baseDir, "external-data");
          await fs.promises.mkdir(outsidePath, { recursive: true });
          await fs.promises.writeFile(
            path.join(outsidePath, "secret.txt"),
            "secret content",
          );
          // No filePermissions configured
        },
      },
      async (driver) => {
        await driver.showSidebar();
        await driver.inputMagentaText(`cat the external file`);
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingStream();

        request.respond({
          stopReason: "tool_use",
          text: "Reading external file.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "test-external-no-perm" as ToolRequestId,
                toolName: "bash_command" as ToolName,
                input: {
                  command: `cat ${outsidePath!}/secret.txt`,
                },
              },
            },
          ],
        });

        // Should require approval since no filePermissions for this path
        await driver.assertDisplayBufferContains("⚡ May I run command");
        await driver.assertDisplayBufferContains("> YES");
      },
    );
  });

  it("auto-approves write command on external directory with write permission", async () => {
    let outsidePath: string;

    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["echo", { type: "restAny" }]],
            pipeCommands: [["tee", { type: "writeFile" }]],
          },
        },
        setupExtraDirs: async (baseDir) => {
          outsidePath = path.join(baseDir, "external-data");
          await fs.promises.mkdir(outsidePath, { recursive: true });

          // Write ~/.magenta/options.json with write permission
          const homeDir = path.join(baseDir, "home");
          const magentaDir = path.join(homeDir, ".magenta");
          await fs.promises.mkdir(magentaDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(magentaDir, "options.json"),
            JSON.stringify({
              filePermissions: [{ path: outsidePath, write: true }],
            }),
          );
        },
      },
      async (driver) => {
        await driver.showSidebar();
        await driver.inputMagentaText(`write to external file`);
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingStream();

        request.respond({
          stopReason: "tool_use",
          text: "Writing to external file.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "test-external-write" as ToolRequestId,
                toolName: "bash_command" as ToolName,
                input: {
                  command: `echo "written content" | tee ${outsidePath!}/output.txt`,
                },
              },
            },
          ],
        });

        // Should auto-approve since filePermissions grants write
        await driver.assertDisplayBufferContains(`⚡✅`);
        await driver.assertDisplayBufferDoesNotContain("> YES");
      },
    );
  });

  it("requires approval for write command on external directory with only read permission", async () => {
    let outsidePath: string;

    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["echo", { type: "restAny" }]],
            pipeCommands: [["tee", { type: "writeFile" }]],
          },
        },
        setupExtraDirs: async (baseDir) => {
          outsidePath = path.join(baseDir, "external-data");
          await fs.promises.mkdir(outsidePath, { recursive: true });

          // Write ~/.magenta/options.json with only read permission
          const homeDir = path.join(baseDir, "home");
          const magentaDir = path.join(homeDir, ".magenta");
          await fs.promises.mkdir(magentaDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(magentaDir, "options.json"),
            JSON.stringify({
              filePermissions: [{ path: outsidePath, read: true }],
            }),
          );
        },
      },
      async (driver) => {
        await driver.showSidebar();
        await driver.inputMagentaText(`write to external file`);
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingStream();

        request.respond({
          stopReason: "tool_use",
          text: "Writing to external file.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "test-write-readonly" as ToolRequestId,
                toolName: "bash_command" as ToolName,
                input: {
                  command: `echo "content" | tee ${outsidePath!}/output.txt`,
                },
              },
            },
          ],
        });

        // Should require approval since only read permission, not write
        await driver.assertDisplayBufferContains("⚡ May I run command");
        await driver.assertDisplayBufferContains("> YES");
      },
    );
  });

  it("requires approval for hidden file even in read:true directory", async () => {
    let outsidePath: string;

    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["cat", { type: "readFile" }]],
            pipeCommands: [],
          },
        },
        setupExtraDirs: async (baseDir) => {
          outsidePath = path.join(baseDir, "external-data");
          await fs.promises.mkdir(outsidePath, { recursive: true });
          await fs.promises.writeFile(
            path.join(outsidePath, ".hidden-file"),
            "hidden content",
          );

          // Write ~/.magenta/options.json with read permission (but not readSecret)
          const homeDir = path.join(baseDir, "home");
          const magentaDir = path.join(homeDir, ".magenta");
          await fs.promises.mkdir(magentaDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(magentaDir, "options.json"),
            JSON.stringify({
              filePermissions: [{ path: outsidePath, read: true }],
            }),
          );
        },
      },
      async (driver) => {
        await driver.showSidebar();
        await driver.inputMagentaText(`cat the hidden file`);
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingStream();

        request.respond({
          stopReason: "tool_use",
          text: "Reading hidden file.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "test-hidden-no-secret" as ToolRequestId,
                toolName: "bash_command" as ToolName,
                input: {
                  command: `cat ${outsidePath!}/.hidden-file`,
                },
              },
            },
          ],
        });

        // Should require approval since hidden file needs readSecret
        await driver.assertDisplayBufferContains("⚡ May I run command");
        await driver.assertDisplayBufferContains("> YES");
      },
    );
  });

  it("auto-approves hidden file read with readSecret permission", async () => {
    let outsidePath: string;

    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["cat", { type: "readFile" }]],
            pipeCommands: [],
          },
        },
        setupExtraDirs: async (baseDir) => {
          outsidePath = path.join(baseDir, "external-data");
          await fs.promises.mkdir(outsidePath, { recursive: true });
          await fs.promises.writeFile(
            path.join(outsidePath, ".hidden-file"),
            "hidden content",
          );

          // Write ~/.magenta/options.json with readSecret permission
          const homeDir = path.join(baseDir, "home");
          const magentaDir = path.join(homeDir, ".magenta");
          await fs.promises.mkdir(magentaDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(magentaDir, "options.json"),
            JSON.stringify({
              filePermissions: [
                { path: outsidePath, read: true, readSecret: true },
              ],
            }),
          );
        },
      },
      async (driver) => {
        await driver.showSidebar();
        await driver.inputMagentaText(`cat the hidden file`);
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingStream();

        request.respond({
          stopReason: "tool_use",
          text: "Reading hidden file.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "test-hidden-with-secret" as ToolRequestId,
                toolName: "bash_command" as ToolName,
                input: {
                  command: `cat ${outsidePath!}/.hidden-file`,
                },
              },
            },
          ],
        });

        // Should auto-approve since readSecret grants access to hidden files
        await driver.assertDisplayBufferContains(
          `⚡✅ \`cat ${outsidePath!}/.hidden-file\``,
        );
        await driver.assertDisplayBufferContains("hidden content");
        await driver.assertDisplayBufferDoesNotContain("> YES");
      },
    );
  });

  it("auto-approves hidden file write with writeSecret permission", async () => {
    let outsidePath: string;

    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["echo", { type: "restAny" }]],
            pipeCommands: [["tee", { type: "writeFile" }]],
          },
        },
        setupExtraDirs: async (baseDir) => {
          outsidePath = path.join(baseDir, "external-data");
          await fs.promises.mkdir(outsidePath, { recursive: true });

          // Write ~/.magenta/options.json with writeSecret permission
          const homeDir = path.join(baseDir, "home");
          const magentaDir = path.join(homeDir, ".magenta");
          await fs.promises.mkdir(magentaDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(magentaDir, "options.json"),
            JSON.stringify({
              filePermissions: [
                { path: outsidePath, write: true, writeSecret: true },
              ],
            }),
          );
        },
      },
      async (driver) => {
        await driver.showSidebar();
        await driver.inputMagentaText(`write to hidden file`);
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingStream();

        request.respond({
          stopReason: "tool_use",
          text: "Writing to hidden file.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "test-hidden-write-secret" as ToolRequestId,
                toolName: "bash_command" as ToolName,
                input: {
                  command: `echo "secret content" | tee ${outsidePath!}/.hidden-output`,
                },
              },
            },
          ],
        });

        // Should auto-approve since writeSecret grants access to hidden files
        await driver.assertDisplayBufferContains(`⚡✅`);
        await driver.assertDisplayBufferDoesNotContain("> YES");
      },
    );
  });

  it("requires approval for hidden file write with only write permission", async () => {
    let outsidePath: string;

    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["echo", { type: "restAny" }]],
            pipeCommands: [["tee", { type: "writeFile" }]],
          },
        },
        setupExtraDirs: async (baseDir) => {
          outsidePath = path.join(baseDir, "external-data");
          await fs.promises.mkdir(outsidePath, { recursive: true });

          // Write ~/.magenta/options.json with write permission (but not writeSecret)
          const homeDir = path.join(baseDir, "home");
          const magentaDir = path.join(homeDir, ".magenta");
          await fs.promises.mkdir(magentaDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(magentaDir, "options.json"),
            JSON.stringify({
              filePermissions: [{ path: outsidePath, write: true }],
            }),
          );
        },
      },
      async (driver) => {
        await driver.showSidebar();
        await driver.inputMagentaText(`write to hidden file`);
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingStream();

        request.respond({
          stopReason: "tool_use",
          text: "Writing to hidden file.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "test-hidden-write-no-secret" as ToolRequestId,
                toolName: "bash_command" as ToolName,
                input: {
                  command: `echo "content" | tee ${outsidePath!}/.hidden-output`,
                },
              },
            },
          ],
        });

        // Should require approval since hidden file needs writeSecret
        await driver.assertDisplayBufferContains("⚡ May I run command");
        await driver.assertDisplayBufferContains("> YES");
      },
    );
  });

  it("respects tilde expansion in filePermissions paths", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            commands: [["cat", { type: "readFile" }]],
            pipeCommands: [],
          },
        },
        setupHome: async (homeDir) => {
          // Create ~/Documents directory with a file
          const docsDir = path.join(homeDir, "Documents");
          await fs.promises.mkdir(docsDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(docsDir, "notes.txt"),
            "home document content",
          );

          // Write ~/.magenta/options.json with tilde path
          const magentaDir = path.join(homeDir, ".magenta");
          await fs.promises.mkdir(magentaDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(magentaDir, "options.json"),
            JSON.stringify({
              filePermissions: [{ path: "~/Documents", read: true }],
            }),
          );
        },
      },
      async (driver, dirs) => {
        await driver.showSidebar();
        await driver.inputMagentaText(`cat the home file`);
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingStream();

        request.respond({
          stopReason: "tool_use",
          text: "Reading home file.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "test-tilde-read" as ToolRequestId,
                toolName: "bash_command" as ToolName,
                input: {
                  command: `cat ${dirs.homeDir}/Documents/notes.txt`,
                },
              },
            },
          ],
        });

        // Should auto-approve since ~/Documents is permitted
        await driver.assertDisplayBufferContains(`⚡✅`);
        await driver.assertDisplayBufferContains("home document content");
        await driver.assertDisplayBufferDoesNotContain("> YES");
      },
    );
  });
});
