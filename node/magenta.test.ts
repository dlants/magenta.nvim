import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolName, ToolRequestId } from "@magenta/core";
import { expect, it } from "vitest";
import { LOGO } from "./chat/thread-view.ts";
import type { Position0Indexed } from "./nvim/window.ts";
import { withDriver } from "./test/preamble.ts";
import { pollUntil } from "./utils/async.ts";

it("new-thread command should work", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(`hello`);
    await driver.send();
    const request1 = await driver.mockAnthropic.awaitPendingStream();
    request1.respond({
      stopReason: "end_turn",
      text: "sup?",
      toolRequests: [],
    });

    // Check for content pieces separately to allow for system reminder in between
    await driver.assertDisplayBufferContains("# user:");
    await driver.assertDisplayBufferContains("hello");
    await driver.assertDisplayBufferContains("# assistant:");
    await driver.assertDisplayBufferContains("sup?");
    await driver.assertDisplayBufferContains("Stopped (end_turn)");

    // Create a new thread
    await driver.magenta.command("new-thread");
    await driver.assertDisplayBufferContains(LOGO);
    await driver.inputMagentaText(`hello again`);
    await driver.send();
    const request2 = await driver.mockAnthropic.awaitPendingStream();
    request2.respond({
      stopReason: "end_turn",
      text: "huh?",
      toolRequests: [],
    });

    // Check for content pieces separately to allow for system reminder in between
    await driver.assertDisplayBufferContains("# user:");
    await driver.assertDisplayBufferContains("hello again");
    await driver.assertDisplayBufferContains("# assistant:");
    await driver.assertDisplayBufferContains("huh?");
    await driver.assertDisplayBufferContains("Stopped (end_turn)");
  });
});

it("abort command should work when waiting for response", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(`hello`);
    await driver.send();
    // Check for content pieces separately to allow for system reminder in between
    await driver.assertDisplayBufferContains("# user:");
    await driver.assertDisplayBufferContains("hello");
    await driver.assertDisplayBufferContains("Streaming response ⠁");

    const request = await driver.mockAnthropic.awaitPendingStream();
    expect(request.resolved).toBe(false);

    await driver.abort();
    expect(request.resolved).toBe(true);
  });
});

it("abort command should work when response is in progress", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(`hello`);
    await driver.send();

    // Get the latest request and start streaming a response but don't complete it
    const request = await driver.mockAnthropic.awaitPendingStream();
    request.streamText("I'm starting to respond");

    // Verify that response has started appearing - check pieces separately
    await driver.assertDisplayBufferContains("# user:");
    await driver.assertDisplayBufferContains("hello");
    await driver.assertDisplayBufferContains("# assistant:");
    await driver.assertDisplayBufferContains("I'm starting to respond");

    expect(request.resolved).toBe(false);

    await driver.abort();
    expect(request.resolved).toBe(true);

    // Verify the final state shows the aborted message
    await driver.assertDisplayBufferContains(`[ABORTED]`);
  });
});

it("abort command should stop pending tool use", async () => {
  await withDriver({}, async (driver) => {
    driver.mockSandbox.setState({ status: "unsupported", reason: "disabled" });
    await driver.showSidebar();
    await driver.inputMagentaText(`hello`);
    await driver.send();

    const request3 = await driver.mockAnthropic.awaitPendingStream();
    request3.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "request_id" as ToolRequestId,
            toolName: "bash_command" as ToolName,
            input: {
              command: "cat .secret",
            },
          },
        },
      ],
    });

    // Verify that response has started appearing - check pieces separately
    await driver.assertDisplayBufferContains("# user:");
    await driver.assertDisplayBufferContains("hello");
    await driver.assertDisplayBufferContains("# assistant:");
    await driver.assertDisplayBufferContains("ok, here goes");
    await driver.assertDisplayBufferContains("May I run command");

    await driver.abort();

    await driver.assertDisplayBufferContains(`❌ Request was aborted`);
  });
});

it("can switch profiles", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    {
      const thread = driver.magenta.chat.getActiveThread();
      expect(thread.context.profile).toEqual({
        name: "mock",
        provider: "mock",
        model: "mock",
        fastModel: "mock-fast",
        thinkingModel: "mock",
      });
    }
    const displayState = driver.getVisibleState();
    {
      const winbar = await displayState.inputWindow.getOption("winbar");
      expect(winbar).toContain(`Magenta Input (mock)`);
    }
    await driver.nvim.call("nvim_command", ["Magenta profile mock2"]);
    {
      // Profile change only affects future threads, not the current one
      const thread = driver.magenta.chat.getActiveThread();
      expect(thread.context.profile.name).toEqual("mock");
      expect(driver.magenta.options.activeProfile).toEqual("mock2");
      // Winbar still shows old profile since the active thread hasn't changed
      const winbar = await displayState.inputWindow.getOption("winbar");
      expect(winbar).toContain(`Magenta Input (mock)`);
    }
    // Create a new thread to verify the new profile applies
    await driver.nvim.call("nvim_command", ["Magenta new-thread"]);
    await pollUntil(() => {
      const thread = driver.magenta.chat.getActiveThread();
      if (thread.context.profile.name !== "mock2") {
        throw new Error("Waiting for new thread with mock2 profile");
      }
    });
    {
      const thread = driver.magenta.chat.getActiveThread();
      expect(thread.context.profile).toEqual({
        name: "mock2",
        provider: "mock",
        model: "mock",
        fastModel: "mock-fast",
        thinkingModel: "mock",
      });
    }
  });
});

it("paste-selection command", async () => {
  await withDriver({}, async (driver) => {
    await driver.editFile("poem.txt");
    await driver.selectRange(
      { row: 0, col: 5 } as Position0Indexed,
      { row: 2, col: 11 } as Position0Indexed,
    );

    await driver.pasteSelection();
    // Use cwd which has the resolved real path (handles /tmp -> /private/tmp symlink on macOS)
    await driver.assertInputBufferContains(`
Here is a snippet from the file \`${driver.magenta.cwd}/poem.txt\`, lines 1-3:
\`\`\`txt
ight whispers through the trees,
Silver shadows dance with ease.
Stars above
\`\`\`
`);
  });
});

it("paste-selection from the display buffer quotes the selection", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(`hello`);
    await driver.send();
    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "end_turn",
      text: "alpha beta\ngamma delta",
      toolRequests: [],
    });

    const startPos = await driver.assertDisplayBufferContains("alpha beta");

    // Focus the display window so selectRange operates on the display buffer.
    const { displayWindow } = driver.getVisibleState();
    await driver.nvim.call("nvim_set_current_win", [displayWindow.id]);

    await driver.selectRange(startPos, {
      row: startPos.row + 1,
      col: "gamma delta".length,
    } as Position0Indexed);

    await driver.pasteSelection();

    await driver.assertInputBufferContains(`> alpha beta
> gamma delta`);
  });
});

it("clipboard text paste opens the sidebar and appends to the active input buffer", async () => {
  await withDriver({}, async (driver) => {
    await driver.editFile("poem.txt");

    // Sanity: sidebar isn't visible and we're sitting in a non-magenta buffer.
    expect(driver.magenta.sidebar.state.state).not.toBe("visible");

    // Simulate the RPC the lua <leader>mp keymap fires after finding text in
    // the clipboard. Node should toggle the sidebar and route the text into
    // the active thread's input buffer.
    await driver.magenta.onClipboardTextPaste("hello from clipboard");

    await pollUntil(() => {
      if (driver.magenta.sidebar.state.state !== "visible") {
        throw new Error("sidebar did not become visible");
      }
    });

    await driver.assertInputBufferContains("hello from clipboard");
  });
});

it("should use project settings to allow bash commands without permission", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir: string) => {
        // Create .magenta directory
        const magentaDir = path.join(tmpDir, ".magenta");
        await mkdir(magentaDir, { recursive: true });

        // Create project settings file that allows echo commands
        const projectSettings = {
          commandConfig: {
            commands: [["echo", { type: "restAny" }]],
            pipeCommands: [],
          },
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

      const request = await driver.mockAnthropic.awaitPendingStream();
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
      // because echo is in the project's commandConfig with restAny

      // First verify the command output appears (meaning it executed)
      await driver.assertDisplayBufferContains(`⚡ \`echo 'hello world'\``);
      await driver.assertDisplayBufferContains(`stdout:
hello world`);

      // Most importantly, verify there's no permission request
      const displayText = await driver.getDisplayBufferText();
      expect(displayText).not.toContain("May I run");
      expect(displayText).not.toContain("[ NO ]");
      expect(displayText).not.toContain("[ OK ]");
    },
  );
});
