import fs from "node:fs";
import * as os from "node:os";
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
import { leftThread, serverThread } from "../test/left-thread.ts";
import { withDriver } from "../test/preamble.ts";

it("returns diff when disk changes even if buffer has unsaved changes", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    const fileSupervisor = getFileSupervisor(
      serverThread(leftThread(driver.magenta.chat)),
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
