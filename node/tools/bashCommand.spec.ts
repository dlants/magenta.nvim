import { withDriver } from "../test/preamble";
import type { ToolRequestId } from "./toolManager";
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getcwd } from "../nvim/nvim";
import type { ToolName } from "./types";

describe("node/tools/bashCommand.spec.ts", () => {
  it("executes a simple echo command without requiring approval (allowlisted)", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(
        `Run this command: echo 'Hello from Magenta!'`,
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();
      const toolRequestId = "test-echo-command" as ToolRequestId;

      request.respond({
        stopReason: "end_turn",
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

      const request = await driver.mockAnthropic.awaitPendingRequest();
      const toolRequestId = "test-error-command" as ToolRequestId;

      request.respond({
        stopReason: "end_turn",
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
        "⚡⏳ May I run command `nonexistentcommand`?",
      );
      const pos = await driver.assertDisplayBufferContains("[ YES ]");
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

      const request = await driver.mockAnthropic.awaitPendingRequest();
      const toolRequestId = "test-curl-command" as ToolRequestId;

      request.respond({
        stopReason: "end_turn",
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
        '⚡⏳ May I run command `true && echo "hello, world"`?',
      );

      // Verify approval UI is fully displayed
      await driver.assertDisplayBufferContains('true && echo "hello, world"');
      await driver.assertDisplayBufferContains("[ NO ]");

      const pos = await driver.assertDisplayBufferContains("[ YES ]");
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

      const request = await driver.mockAnthropic.awaitPendingRequest();
      const toolRequestId = "test-rejected-command" as ToolRequestId;

      request.respond({
        stopReason: "end_turn",
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
        "⚡⏳ May I run command `true && ls -la`?",
      );

      // Find approval text position and trigger key on NO button
      const pos = await driver.assertDisplayBufferContains("[ NO ]");
      await driver.triggerDisplayBufferKey(pos, "<CR>");

      // Verify the rejection message in the result
      await driver.assertDisplayBufferContains("Exit code: 1");
    });
  });

  it("displays approval dialog with proper box formatting", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`Run this command: dangerous-command`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();
      const toolRequestId = "test-box-formatting" as ToolRequestId;

      request.respond({
        stopReason: "end_turn",
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
        "⚡⏳ May I run command `dangerous-command`?",
      );

      // Verify the box formatting is displayed correctly
      await driver.assertDisplayBufferContains(`\
┌───────────────────────────┐
│ [ NO ] [ YES ] [ ALWAYS ] │
└───────────────────────────┘`);

      // Test that clicking YES works
      const yesPos = await driver.assertDisplayBufferContains("[ YES ]");
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

      const request = await driver.mockAnthropic.awaitPendingRequest();
      const toolRequestId = "test-terminate-command" as ToolRequestId;

      request.respond({
        stopReason: "end_turn",
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
        "⚡⏳ May I run command `sleep 30`?",
      );
      const approvePos = await driver.assertDisplayBufferContains("[ YES ]");
      await driver.triggerDisplayBufferKey(approvePos, "<CR>");

      const pos = await driver.assertDisplayBufferContains("⚡⚙️ (");

      // Press 't' to terminate the command
      await driver.triggerDisplayBufferKey(pos, "t");

      // Verify that the command was terminated
      await driver.assertDisplayBufferContains(
        "Process terminated by user with SIGTERM",
      );

      // Ensure the command prompt is updated to show completion
      await driver.assertDisplayBufferContains("⚡❌ `sleep 30`");
      await driver.assertDisplayBufferContains("```");
    });
  });

  it("allows subsequent runs of a command after selecting ALWAYS", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // First run of the command requiring approval
      await driver.inputMagentaText(`Run this command: "true && echo 'tada'`);
      await driver.send();

      const request1 = await driver.mockAnthropic.awaitPendingRequest();
      const toolRequestId1 = "test-remembered-command-1" as ToolRequestId;

      request1.respond({
        stopReason: "end_turn",
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
        "⚡⏳ May I run command `true && echo 'tada'`?",
      );

      const alwaysPos = await driver.assertDisplayBufferContains("[ ALWAYS ]");
      await driver.triggerDisplayBufferKey(alwaysPos, "<CR>");

      await driver.inputMagentaText(`Ok, run it again`);
      await driver.send();

      const request2 = await driver.mockAnthropic.awaitPendingRequest();
      const toolRequestId2 = "test-remembered-command-2" as ToolRequestId;

      request2.respond({
        stopReason: "end_turn",
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

      const request = await driver.mockAnthropic.awaitPendingRequest();
      const toolRequestId = "test-single-execution" as ToolRequestId;

      request.respond({
        stopReason: "end_turn",
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
      await driver.assertDisplayBufferContains("⚡⏳ May I run command");

      // Click the YES button to approve the command
      const yesPos = await driver.assertDisplayBufferContains("[ YES ]");
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
            echo: { allowAll: true },
          },
        },
      },
      async (driver) => {
        await driver.showSidebar();

        const longText = "A".repeat(200); // 200 characters, much longer than WIDTH-5 (95)
        await driver.inputMagentaText(`Run this command: echo "${longText}"`);
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingRequest();
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
          await driver.mockAnthropic.awaitPendingRequest();
        const toolResultMessage =
          toolResultRequest.messages[toolResultRequest.messages.length - 1];

        if (
          toolResultMessage.role === "user" &&
          Array.isArray(toolResultMessage.content)
        ) {
          const toolResult = toolResultMessage.content[0];
          if (toolResult.type === "tool_result") {
            expect(toolResult.result.status).toBe("ok");
            if (toolResult.result.status === "ok") {
              const resultItem = toolResult.result.value[0];
              if (resultItem.type !== "text") {
                throw new Error("Expected text result from bash command");
              }
              const resultText = resultItem.text;

              // Verify the full 200-character string is preserved for the agent
              expect(resultText).toContain(longText);
              expect(resultText).toContain("exit code 0");
            }
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
            echo: { allowAll: true },
          },
        },
      },
      async (driver) => {
        await driver.showSidebar();

        const cwd = await getcwd(driver.nvim);
        const commandWithCd = `cd ${cwd} && echo "Hello from cwd"`;

        await driver.inputMagentaText(`Run this command: ${commandWithCd}`);
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingRequest();
        const toolRequestId = "test-cd-prefix" as ToolRequestId;

        request.respond({
          stopReason: "end_turn",
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
        await driver.assertDisplayBufferDoesNotContain("[ YES ]");
      },
    );
  });

  it("trims output to token limit for agent", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            yes: { allowAll: true },
            head: { allowAll: true },
          },
        },
      },
      async (driver) => {
        await driver.showSidebar();

        // Generate output that will exceed the 10,000 token limit (40,000 characters)
        // Use 'yes' command with a long string to create repetitive output
        const longString = "A".repeat(100); // 100 characters per line
        await driver.inputMagentaText(
          `Run this command: yes "${longString}" | head -500`,
        );
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingRequest();
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
                  command: `yes "${longString}" | head -500`,
                },
              },
            },
          ],
        });

        await driver.assertDisplayBufferContains("⚡✅");

        const toolResultRequest =
          await driver.mockAnthropic.awaitPendingRequest();
        const toolResultMessage =
          toolResultRequest.messages[toolResultRequest.messages.length - 1];

        if (
          toolResultMessage.role === "user" &&
          Array.isArray(toolResultMessage.content)
        ) {
          const toolResult = toolResultMessage.content[0];
          if (toolResult.type === "tool_result") {
            expect(toolResult.result.status).toBe("ok");
            if (toolResult.result.status === "ok") {
              const resultItem = toolResult.result.value[0];
              if (resultItem.type !== "text") {
                throw new Error("Expected text result from bash command");
              }
              const resultText = resultItem.text;

              // Verify the output is limited by token count (40,000 characters max)
              // Account for "stdout:\n" and "exit code 0\n" overhead
              expect(resultText.length).toBeLessThan(40100); // Small buffer for overhead

              // Should contain the exit code at the end
              expect(resultText).toContain("exit code 0");

              // Should contain the repeated string pattern
              expect(resultText).toContain(longString);

              // Should not contain the very beginning of the output since we're trimming from the start
              // The output starts with many repetitions, so early lines should be trimmed
              const lines = resultText
                .split("\n")
                .filter((line) => line.trim() !== "");
              const contentLines = lines.filter(
                (line) =>
                  !line.startsWith("stdout:") && !line.startsWith("exit code"),
              );

              // With 100 chars per line + newline, we should have roughly 40,000 / 101 ≈ 396 lines max
              // But the actual limit depends on the overhead from "stdout:" markers
              expect(contentLines.length).toBeLessThan(500); // Should be less than the full 500 lines
              expect(contentLines.length).toBeGreaterThan(300); // Should have a substantial portion
            }
          }
        }
      },
    );
  });
});

describe("commandConfig integration tests", () => {
  it("auto-approves commands with allowAll option", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            echo: { allowAll: true },
          },
        },
      },
      async (driver) => {
        await driver.showSidebar();
        await driver.inputMagentaText(`Run this command: echo "hello world"`);
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingRequest();
        const toolRequestId = "test-allowAll" as ToolRequestId;

        request.respond({
          stopReason: "end_turn",
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
        await driver.assertDisplayBufferDoesNotContain("[ YES ]");
      },
    );
  });

  it("auto-approves commands with exact arg patterns", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            npx: {
              subCommands: {
                tsc: {
                  args: [["--version"]],
                },
              },
            },
          },
        },
      },
      async (driver) => {
        await driver.showSidebar();
        await driver.inputMagentaText(`Run this command: npx tsc --version`);
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingRequest();
        const toolRequestId = "test-subcommand" as ToolRequestId;

        request.respond({
          stopReason: "end_turn",
          text: "Running tsc.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: toolRequestId,
                toolName: "bash_command" as ToolName,
                input: {
                  command: "npx tsc --version",
                },
              },
            },
          ],
        });

        // Should auto-approve since args match exactly
        await driver.assertDisplayBufferContains("⚡✅ `npx tsc --version`");
        await driver.assertDisplayBufferDoesNotContain("[ YES ]");
      },
    );
  });

  it("requires approval for commands with non-matching args", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            npx: {
              subCommands: {
                tsc: {
                  args: [["--noEmit"]],
                },
              },
            },
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

        const request = await driver.mockAnthropic.awaitPendingRequest();
        const toolRequestId = "test-wrong-args" as ToolRequestId;

        request.respond({
          stopReason: "end_turn",
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
          "⚡⏳ May I run command `npx tsc --watch --noEmit`?",
        );
        await driver.assertDisplayBufferContains("[ YES ]");
      },
    );
  });

  it("auto-approves cat with valid file path", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            cat: {
              args: [[{ file: true }]],
            },
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

        const request = await driver.mockAnthropic.awaitPendingRequest();
        const toolRequestId = "test-cat-file" as ToolRequestId;

        request.respond({
          stopReason: "end_turn",
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
        await driver.assertDisplayBufferDoesNotContain("[ YES ]");
      },
    );
  });

  it("requires approval for cat with file outside project", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            cat: {
              args: [[{ file: true }]],
            },
          },
        },
      },
      async (driver) => {
        await driver.showSidebar();

        await driver.inputMagentaText(`Run this command: cat /etc/passwd`);
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingRequest();
        const toolRequestId = "test-cat-outside" as ToolRequestId;

        request.respond({
          stopReason: "end_turn",
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
          "⚡⏳ May I run command `cat /etc/passwd`?",
        );
        await driver.assertDisplayBufferContains("[ YES ]");
      },
    );
  });

  it("auto-approves command with restFiles pattern", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            cat: {
              args: [[{ restFiles: true }]],
            },
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

        const request = await driver.mockAnthropic.awaitPendingRequest();
        const toolRequestId = "test-restfiles" as ToolRequestId;

        request.respond({
          stopReason: "end_turn",
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
        await driver.assertDisplayBufferDoesNotContain("[ YES ]");
      },
    );
  });

  it("requires approval for restFiles with file outside project", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            cat: {
              args: [[{ restFiles: true }]],
            },
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

        const request = await driver.mockAnthropic.awaitPendingRequest();
        const toolRequestId = "test-restfiles-outside" as ToolRequestId;

        request.respond({
          stopReason: "end_turn",
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
        await driver.assertDisplayBufferContains("⚡⏳ May I run command");
        await driver.assertDisplayBufferContains("[ YES ]");
      },
    );
  });

  it("handles chained commands with cd", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            cat: {
              args: [[{ file: true }]],
            },
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

        const request = await driver.mockAnthropic.awaitPendingRequest();
        const toolRequestId = "test-cd-chain" as ToolRequestId;

        request.respond({
          stopReason: "end_turn",
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
        await driver.assertDisplayBufferDoesNotContain("[ YES ]");
      },
    );
  });

  it("requires approval when cd navigates outside project", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            cat: {
              args: [[{ file: true }]],
            },
          },
        },
      },
      async (driver) => {
        await driver.showSidebar();

        await driver.inputMagentaText(
          `Run this command: cd /tmp && cat somefile.txt`,
        );
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingRequest();
        const toolRequestId = "test-cd-outside" as ToolRequestId;

        request.respond({
          stopReason: "end_turn",
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
        await driver.assertDisplayBufferContains("⚡⏳ May I run command");
        await driver.assertDisplayBufferContains("[ YES ]");
      },
    );
  });

  it("requires approval for command not in config", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            echo: { allowAll: true },
          },
        },
      },
      async (driver) => {
        await driver.showSidebar();

        await driver.inputMagentaText(`Run this command: ls -la`);
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingRequest();
        const toolRequestId = "test-not-in-config" as ToolRequestId;

        request.respond({
          stopReason: "end_turn",
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

        // Should require approval since ls is not in config
        await driver.assertDisplayBufferContains(
          "⚡⏳ May I run command `ls -la`?",
        );
        await driver.assertDisplayBufferContains("[ YES ]");
      },
    );
  });

  it("requires approval for hidden files", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            cat: {
              args: [[{ file: true }]],
            },
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

        const request = await driver.mockAnthropic.awaitPendingRequest();
        const toolRequestId = "test-hidden-file" as ToolRequestId;

        request.respond({
          stopReason: "end_turn",
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
        await driver.assertDisplayBufferContains("⚡⏳ May I run command");
        await driver.assertDisplayBufferContains("[ YES ]");
      },
    );
  });

  it("allows specific subcommand with allowAll while restricting parent", async () => {
    await withDriver(
      {
        options: {
          commandConfig: {
            git: {
              subCommands: {
                status: { allowAll: true },
                log: { args: [["--oneline"]] },
              },
            },
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

        const request = await driver.mockAnthropic.awaitPendingRequest();
        const toolRequestId = "test-git-status" as ToolRequestId;

        request.respond({
          stopReason: "end_turn",
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
        await driver.assertDisplayBufferDoesNotContain("[ YES ]");
      },
    );
  });
});
