import { expect, it } from "vitest";
import { withDriver } from "./test/preamble";
import { pollUntil } from "./utils/async";
import type { Position0Indexed } from "./nvim/window";
import { LOGO } from "./chat/thread";
import type { ToolRequestId } from "./tools/toolManager";
import type { UnresolvedFilePath } from "./utils/files";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ToolName } from "./tools/types";

it("clear command should work", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(`hello`);
    await driver.send();
    const request1 = await driver.mockAnthropic.awaitPendingRequest();
    request1.respond({
      stopReason: "end_turn",
      text: "sup?",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains(`# user:
hello

# assistant:
sup?

Stopped (end_turn) [input: 0, output: 0]`);

    await driver.clear();
    await driver.assertDisplayBufferContains(LOGO);
    await driver.inputMagentaText(`hello again`);
    await driver.send();
    const request2 = await driver.mockAnthropic.awaitPendingRequest();
    request2.respond({
      stopReason: "end_turn",
      text: "huh?",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains(`# user:
hello again

# assistant:
huh?

Stopped (end_turn) [input: 0, output: 0]`);
  });
});

it("abort command should work when waiting for response", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(`hello`);
    await driver.send();
    await driver.assertDisplayBufferContains(`\
# user:
hello

Streaming response ⠁`);

    await pollUntil(() => {
      if (driver.mockAnthropic.requests.length != 1) {
        throw new Error(`Expected a message to be pending.`);
      }
    });
    const request =
      driver.mockAnthropic.requests[driver.mockAnthropic.requests.length - 1];
    expect(request.defer.resolved).toBe(false);

    await driver.abort();
    expect(request.defer.resolved).toBe(true);
  });
});

it("abort command should work when response is in progress", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(`hello`);
    await driver.send();

    // Wait for the pending request to be registered
    await pollUntil(() => {
      if (driver.mockAnthropic.requests.length != 1) {
        throw new Error(`Expected a message to be pending.`);
      }
    });

    // Get the latest request and start streaming a response but don't complete it
    const request = await driver.mockAnthropic.awaitPendingRequest();
    request.streamText("I'm starting to respond");

    // Verify that response has started appearing
    await driver.assertDisplayBufferContains(`\
# user:
hello

# assistant:
I'm starting to respond`);

    expect(request.defer.resolved).toBe(false);

    await driver.abort();
    expect(request.defer.resolved).toBe(true);

    // Verify the final state shows the aborted message
    await driver.assertDisplayBufferContains(`Stopped (aborted)`);
  });
});

it("abort command should stop pending tool use", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(`hello`);
    await driver.send();

    // Wait for the pending request to be registered
    await pollUntil(() => {
      if (driver.mockAnthropic.requests.length != 1) {
        throw new Error(`Expected a message to be pending.`);
      }
    });

    const request3 = await driver.mockAnthropic.awaitPendingRequest();
    request3.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "request_id" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: {
              // secret file should trigger user permission check
              filePath: ".secret" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    // Verify that response has started appearing
    await driver.assertDisplayBufferContains(`\
# user:
hello

# assistant:
ok, here goes
⏳ May I read file \`.secret\`? **[ NO ]** **[ OK ]**

Stopped (tool_use) [input: 0, output: 0]
`);

    await driver.abort();

    await driver.assertDisplayBufferContains(`The user aborted this request`);
  });
});

it("can switch profiles", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    {
      const thread = driver.magenta.chat.getActiveThread();
      expect(thread.state.profile).toEqual({
        name: "claude-sonnet-3.7",
        provider: "anthropic",
        model: "claude-3-7-sonnet-latest",
        apiKeyEnvVar: "ANTHROPIC_API_KEY",
      });
    }
    const displayState = driver.getVisibleState();
    {
      const winbar = await displayState.inputWindow.getOption("winbar");
      expect(winbar).toContain(`Magenta Input (claude-sonnet-3.7)`);
    }
    await driver.nvim.call("nvim_command", ["Magenta profile gpt-4o"]);
    {
      const thread = driver.magenta.chat.getActiveThread();
      expect(thread.state.profile).toEqual({
        name: "gpt-4o",
        provider: "openai",
        model: "gpt-4o",
        apiKeyEnvVar: "OPENAI_API_KEY",
      });
      const winbar = await displayState.inputWindow.getOption("winbar");
      expect(winbar).toContain(`Magenta Input (gpt-4o)`);
    }
  });
});

it("paste-selection command", async () => {
  await withDriver({}, async (driver) => {
    await driver.editFile("node/test/fixtures/poem.txt");
    await driver.selectRange(
      { row: 0, col: 5 } as Position0Indexed,
      { row: 2, col: 11 } as Position0Indexed,
    );

    await driver.pasteSelection();
    await driver.assertInputBufferContains(`
Here is a snippet from the file \`node/test/fixtures/poem.txt\`
\`\`\`txt
ight whispers through the trees,
Silver shadows dance with ease.
Stars above
\`\`\`
`);
  });
});

it("should use project settings to allow bash commands without permission", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir: string) => {
        // Create .magenta directory
        const magentaDir = path.join(tmpDir, ".magenta");
        await mkdir(magentaDir, { recursive: true });

        // Create project settings file that allows bash commands
        const projectSettings = {
          commandAllowlist: ["bash_command"],
        };

        await writeFile(
          path.join(magentaDir, "options.json"),
          JSON.stringify(projectSettings, null, 2),
        );
      },
    },
    async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`run echo "hello world"`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();
      request.respond({
        stopReason: "tool_use",
        text: "I'll run that command for you.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "bash_cmd_1" as ToolRequestId,
              toolName: "bash_command" as ToolName,
              input: {
                command: "echo 'hello world'",
              },
            },
          },
        ],
      });

      // The bash command should execute without requiring user permission
      // because it's in the project's commandAllowlist

      // First verify the command output appears (meaning it executed)
      await driver.assertDisplayBufferContains(`⚡ \`echo 'hello world'\``);
      await driver.assertDisplayBufferContains(`stdout:
hello world`);
      await driver.assertDisplayBufferContains(`Exit code: 0`);

      // Most importantly, verify there's no permission request
      const displayText = await driver.getDisplayBufferText();
      expect(displayText).not.toContain("May I run");
      expect(displayText).not.toContain("[ NO ]");
      expect(displayText).not.toContain("[ OK ]");
    },
  );
});
