import fs from "node:fs";
import * as os from "node:os";
import type { ProviderMessage, ProviderMessageContent } from "@magenta/server";
import {
  type HomeDir,
  PRE_HISTORY,
  pollUntil,
  resolveFilePath,
  type UnresolvedFilePath,
} from "@magenta/server";
import { getFileSupervisor } from "@magenta/server/src/test-helpers.ts";
import { describe, expect, it } from "vitest";
import { getAllWindows, getcwd } from "../nvim/nvim.ts";
import { withDriver } from "../test/preamble.ts";
import { sanitizeMessagesForSnapshot } from "../test/sanitize-snapshot.ts";

it("returns diff when disk changes even if buffer has unsaved changes", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    const fileSupervisor = getFileSupervisor(
      driver.magenta.chat.getActiveThread().thread,
    );

    const cwd = await getcwd(driver.nvim);
    const absFilePath = resolveFilePath(
      cwd,
      "poem.txt" as UnresolvedFilePath,
      os.homedir() as HomeDir,
    );

    await driver.addContextFiles("poem.txt");
    await driver.editFile("poem.txt");

    // Initial read to establish agentView
    await fileSupervisor.getContextUpdate(PRE_HISTORY);

    // Modify the file on disk directly (agent reads from disk)
    const filePath = `${cwd}/poem.txt`;
    fs.writeFileSync(filePath, "Disk edit\n");

    // Context update should return a diff (disk-first reads from disk)
    const updates = await fileSupervisor.getContextUpdate(PRE_HISTORY);
    const update = updates[absFilePath];
    expect(update).toBeDefined();
    expect(update.update.status).toBe("ok");
    if (update.update.status === "ok") {
      expect(update.update.value.type).toBe("diff");
    }
  });
});

describe("key bindings", () => {
  it("'dd' key correctly removes the middle file when three files are in context", async () => {
    await withDriver({}, async (driver) => {
      // Open context sidebar
      await driver.showSidebar();

      await driver.addContextFiles("poem 3.txt", "poem2.txt", "poem.txt");

      // Press dd on the middle file to remove it
      await driver.triggerDisplayBufferKeyOnContent(`- \`poem2.txt\``, "dd");

      // Wait for the file to be removed from context
      await pollUntil(async () => {
        const content = await driver.getDisplayBufferText();
        if (content.includes(`- \`poem2.txt\``)) {
          throw new Error("Context file not yet removed");
        }
        if (
          !content.includes(`- \`poem 3.txt\``) ||
          !content.includes(`- \`poem.txt\``)
        ) {
          throw new Error("Other context files should still be present");
        }
      });
    });
  });

  it("'Enter' key opens file in existing non-magenta window", async () => {
    await withDriver({}, async (driver) => {
      const normalWindow = await driver.findWindow(async (w) => {
        const buf = await w.buffer();
        const name = await buf.getName();
        return name === "";
      });

      // Open context sidebar
      await driver.showSidebar();

      // Add file to context using the helper method
      await driver.addContextFiles("poem.txt");

      await driver.triggerDisplayBufferKeyOnContent(`\`poem.txt\``, "<CR>");

      await driver.assertWindowCount(
        3,
        "3 windows - display, input and non-magenta window with the buffer open",
      );

      // Verify file is opened in the non-magenta window
      await pollUntil(async () => {
        const winBuffer = await normalWindow.buffer();
        const bufferName = await winBuffer.getName();
        if (!bufferName.includes("poem.txt")) {
          throw new Error(
            `Expected buffer name to contain poem.txt, got ${bufferName}`,
          );
        }
      });
    });
  });

  it("'Enter' key opens file with multiple non-magenta windows", async () => {
    await withDriver({}, async (driver) => {
      await driver.nvim.call("nvim_command", ["new second_window"]);

      await driver.showSidebar();

      // Add file to context using the helper method
      await driver.addContextFiles("poem.txt");

      await driver.triggerDisplayBufferKeyOnContent(`\`poem.txt\``, "<CR>");
      await driver.assertWindowCount(4);

      const poemWindow = await driver.findWindow(async (w) => {
        const buffer = await w.buffer();
        const name = await buffer.getName();
        return name.indexOf("poem.txt") > -1;
      });

      const isMagenta = await poemWindow.getVar("magenta");
      expect(isMagenta, "we opened in a non-magenta window").toBeFalsy();
    });
  });

  it("'Enter' key opens file when sidebar is on the left", async () => {
    await withDriver(
      { options: { sidebarPosition: "left" } },
      async (driver) => {
        const initialWindow = (await getAllWindows(driver.nvim))[0];
        await driver.showSidebar();
        await driver.nvim.call("nvim_win_close", [initialWindow.id, true]);
        expect(
          (await getAllWindows(driver.nvim)).length,
          "now only magenta windows open",
        ).toBe(2);

        await driver.addContextFiles("poem.txt");

        const displayWindow = driver.getVisibleState().displayWindow;

        // Get position of the file line to click on
        await driver.triggerDisplayBufferKeyOnContent(`\`poem.txt\``, "<CR>");

        await driver.assertWindowCount(3, "Enter should open a new window");

        const fileWindow = await driver.findWindow(async (w) => {
          const buf = await w.buffer();
          const name = await buf.getName();
          return name.includes("poem.txt");
        });
        expect(fileWindow).toBeDefined();

        // Verify window position is on the right (col index 1 is higher for windows on the right)
        const fileWinPos = await fileWindow.getPosition();
        const displayWinPos = await displayWindow.getPosition();
        expect(fileWinPos[1]).toBeGreaterThan(displayWinPos[1]);
      },
    );
  });

  it("'Enter' key opens file when sidebar is on the right", async () => {
    await withDriver(
      { options: { sidebarPosition: "right" } },
      async (driver) => {
        const initialWindow = (await getAllWindows(driver.nvim))[0];
        await driver.showSidebar();
        await driver.nvim.call("nvim_win_close", [initialWindow.id, true]);
        expect(
          (await getAllWindows(driver.nvim)).length,
          "now only magenta windows open",
        ).toBe(2);

        await driver.addContextFiles("poem.txt");

        const displayWindow = driver.getVisibleState().displayWindow;

        // Get position of the file line to click on
        await driver.triggerDisplayBufferKeyOnContent(`\`poem.txt\``, "<CR>");

        await driver.assertWindowCount(3, "Enter should open a new window");

        const fileWindow = await driver.findWindow(async (w) => {
          const buf = await w.buffer();
          const name = await buf.getName();
          return name.includes("poem.txt");
        });
        expect(fileWindow).toBeDefined();

        // Verify window position is on the left (col index 1 is lower for windows on the left)
        const fileWinPos = await fileWindow.getPosition();
        const displayWinPos = await displayWindow.getPosition();
        expect(fileWinPos[1]).toBeLessThan(displayWinPos[1]);
      },
    );
  });
});

it("context-files end-to-end", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.addContextFiles("poem.txt");

    await driver.assertDisplayBufferContains(`- \`poem.txt\``);

    await driver.inputMagentaText("check out this file");
    await driver.send();
    const request = await driver.mockAnthropic.awaitPendingUserRequest();
    expect(sanitizeMessagesForSnapshot(request.messages)).toMatchSnapshot();
  });
});

it("autoContext loads on startup and after new-thread", async () => {
  const testOptions = {
    autoContext: [`test-auto-context.md`],
  };

  await withDriver({ options: testOptions }, async (driver) => {
    // Show sidebar and verify autoContext is loaded
    await driver.showSidebar();
    await driver.assertDisplayBufferContains(`- \`test-auto-context.md\``);

    // Create new thread and verify autoContext is loaded
    await driver.magenta.command("new-thread");
    await driver.assertDisplayBufferContains(`- \`test-auto-context.md\``);

    // Check that the content is included in messages when sending
    await driver.inputMagentaText("hello");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    expect(request.messages).toContainEqual(
      expect.objectContaining<ProviderMessage>({
        role: "user",

        content: expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("test-auto-context.md"),
          }),
        ]) as ProviderMessageContent[],
      }),
    );
  });
});

it("large context files are summarized and rendered with a (summary) badge", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        const path = await import("node:path");
        const fsPromises = await import("node:fs/promises");
        const lines: string[] = [];
        for (let i = 0; i < 4000; i++) {
          lines.push(`line ${i}: ${"x".repeat(40)}`);
        }
        await fsPromises.writeFile(
          path.join(tmpDir, "huge.txt"),
          lines.join("\n"),
        );
      },
    },
    async (driver) => {
      await driver.showSidebar();
      await driver.addContextFiles("huge.txt");

      await driver.assertDisplayBufferContains("- `huge.txt` [ summary ]");

      await driver.inputMagentaText("describe this file");
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();

      request.respond({
        stopReason: "end_turn",
        text: "ok",
        toolRequests: [],
      });

      const fileSupervisor =
        driver.magenta.chat.getActiveThread().thread.contextFiles;
      const cwd = await getcwd(driver.nvim);
      const absHuge = resolveFilePath(
        cwd,
        "huge.txt" as UnresolvedFilePath,
        os.homedir() as HomeDir,
      );
      await pollUntil(() => {
        if (fileSupervisor.files[absHuge]?.agentView?.type !== "summary") {
          throw new Error("agentView not yet set to summary");
        }
      });

      await driver.triggerDisplayBufferKeyOnContent("1 file in context", "=");

      await driver.assertDisplayBufferContains("- `huge.txt` (summary)");

      let userMessageContent: ProviderMessageContent[] | undefined;
      for (const msg of request.messages) {
        if (
          msg.role === "user" &&
          Array.isArray(msg.content) &&
          (msg.content as ProviderMessageContent[]).some(
            (c) => c.type === "text" && c.text.includes("<context_update>"),
          )
        ) {
          userMessageContent = msg.content as ProviderMessageContent[];
          break;
        }
      }

      expect(userMessageContent).toBeDefined();
      const textBlock = userMessageContent!.find(
        (c) => c.type === "text" && c.text.includes("<context_update>"),
      ) as Extract<ProviderMessageContent, { type: "text" }>;
      expect(textBlock.text).toContain("[File too large for full context");
      expect(textBlock.text).toContain("[File summary:");
    },
  );
});

it("out-of-process file change surfaces in the pending-context view", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const fileSupervisor = getFileSupervisor(
      driver.magenta.chat.getActiveThread().thread,
    );

    const cwd = await getcwd(driver.nvim);
    const absFilePath = resolveFilePath(
      cwd,
      "poem.txt" as UnresolvedFilePath,
      os.homedir() as HomeDir,
    );

    await driver.addContextFiles("poem.txt");
    await fileSupervisor.getContextUpdate(PRE_HISTORY);

    await fs.promises.writeFile(
      absFilePath,
      "completely different content\nwith several new lines\nadded here\n",
    );

    await pollUntil(
      async () => {
        const content = await driver.getDisplayBufferText();
        if (!content.match(/- `poem\.txt` \[ \+\d+ \/ -\d+ \]/)) {
          throw new Error("pending diff entry for poem.txt not yet shown");
        }
      },
      { timeout: 5000 },
    );
  });
});
