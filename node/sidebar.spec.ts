import { describe, it, expect } from "vitest";
import { withDriver } from "./test/preamble";
import { pollUntil } from "./utils/async";

describe("node/sidebar.spec.ts", () => {
  it("send command should scroll to last user message", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`\n`.repeat(100));
      await driver.send();
      const request = await driver.mockAnthropic.awaitPendingRequest();
      request.respond({
        stopReason: "end_turn",
        text: "sup?",
        toolRequests: [],
      });
      await driver.inputMagentaText(`sup!`);
      await driver.send();

      const displayWindow = driver.getVisibleState().displayWindow;
      await pollUntil(async () => {
        const current = await displayWindow.topLine();
        const expected = 110;
        if (current != expected) {
          throw new Error(
            `Expected to scroll to line ${expected} but we were at ${current}`,
          );
        }
      });
    });
  });

  describe("sidebar position options", () => {
    it("should position sidebar on the left", async () => {
      await withDriver(
        {
          options: {
            sidebarPosition: "left",
          },
        },
        async (driver) => {
          // Open a file first to have something to compare position against
          await driver.editFile("poem.txt");
          await driver.showSidebar();
          const { displayWindow, inputWindow } = driver.getVisibleState();

          // Find the file window
          const fileWindow = await driver.findWindow(async (w) => {
            const buf = await w.buffer();
            const name = await buf.getName();
            return name.includes("poem.txt");
          });
          expect(fileWindow).toBeDefined();

          // Verify sidebar windows are positioned to the left of the file window
          const displayWinPos = await displayWindow.getPosition();
          const inputWinPos = await inputWindow.getPosition();
          const fileWinPos = await fileWindow.getPosition();

          // Left sidebar should have lower column index than file window
          expect(displayWinPos[1]).toBeLessThan(fileWinPos[1]);
          expect(inputWinPos[1]).toBeLessThan(fileWinPos[1]);

          // Display and input windows should have same column position
          expect(displayWinPos[1]).toBe(inputWinPos[1]);
        },
      );
    });

    it("should position sidebar on the right", async () => {
      await withDriver(
        {
          options: {
            sidebarPosition: "right",
          },
        },
        async (driver) => {
          // Open a file first to have something to compare position against
          await driver.editFile("poem.txt");
          await driver.showSidebar();
          const { displayWindow, inputWindow } = driver.getVisibleState();

          // Find the file window
          const fileWindow = await driver.findWindow(async (w) => {
            const buf = await w.buffer();
            const name = await buf.getName();
            return name.includes("poem.txt");
          });
          expect(fileWindow).toBeDefined();

          // Verify sidebar windows are positioned to the right of the file window
          const displayWinPos = await displayWindow.getPosition();
          const inputWinPos = await inputWindow.getPosition();
          const fileWinPos = await fileWindow.getPosition();

          // Right sidebar should have higher column index than file window
          expect(displayWinPos[1]).toBeGreaterThan(fileWinPos[1]);
          expect(inputWinPos[1]).toBeGreaterThan(fileWinPos[1]);

          // Display and input windows should have same column position
          expect(displayWinPos[1]).toBe(inputWinPos[1]);
        },
      );
    });

    it("should position sidebar above", async () => {
      await withDriver(
        {
          options: {
            sidebarPosition: "above",
          },
        },
        async (driver) => {
          // Open a file first to have something to compare position against
          await driver.editFile("poem.txt");
          await driver.showSidebar();
          const { displayWindow, inputWindow } = driver.getVisibleState();

          // Find the file window
          const fileWindow = await driver.findWindow(async (w) => {
            const buf = await w.buffer();
            const name = await buf.getName();
            return name.includes("poem.txt");
          });
          expect(fileWindow).toBeDefined();

          // Verify sidebar windows are positioned above the file window
          const displayWinPos = await displayWindow.getPosition();
          const inputWinPos = await inputWindow.getPosition();
          const fileWinPos = await fileWindow.getPosition();

          // Above sidebar should have lower row index than file window
          expect(displayWinPos[0]).toBeLessThan(fileWinPos[0]);
          expect(inputWinPos[0]).toBeLessThan(fileWinPos[0]);

          // Display window should be above input window
          expect(displayWinPos[0]).toBeLessThan(inputWinPos[0]);
        },
      );
    });

    it("should position sidebar below", async () => {
      await withDriver(
        {
          options: {
            sidebarPosition: "below",
          },
        },
        async (driver) => {
          // Open a file first to have something to compare position against
          await driver.editFile("poem.txt");
          await driver.showSidebar();
          const { displayWindow, inputWindow } = driver.getVisibleState();

          // Find the file window
          const fileWindow = await driver.findWindow(async (w) => {
            const buf = await w.buffer();
            const name = await buf.getName();
            return name.includes("poem.txt");
          });
          expect(fileWindow).toBeDefined();

          // Verify sidebar windows are positioned below the file window
          const displayWinPos = await displayWindow.getPosition();
          const inputWinPos = await inputWindow.getPosition();
          const fileWinPos = await fileWindow.getPosition();

          // Below sidebar should have higher row index than file window
          expect(displayWinPos[0]).toBeGreaterThan(fileWinPos[0]);
          expect(inputWinPos[0]).toBeGreaterThan(fileWinPos[0]);

          // Display window should be above input window
          expect(displayWinPos[0]).toBeLessThan(inputWinPos[0]);
        },
      );
    });

    it("should position sidebar in a new tab", async () => {
      await withDriver(
        {
          options: {
            sidebarPosition: "tab",
          },
        },
        async (driver) => {
          // Open a file first
          await driver.editFile("poem.txt");

          // Get initial tab count
          const initialTabCount = (await driver.nvim.call(
            "nvim_call_function",
            ["tabpagenr", ["$"]],
          )) as number;

          await driver.showSidebar();
          const { displayWindow, inputWindow } = driver.getVisibleState();

          // Should have created a new tab
          const finalTabCount = await driver.nvim.call("nvim_call_function", [
            "tabpagenr",
            ["$"],
          ]);
          expect(finalTabCount).toBeGreaterThan(initialTabCount);

          // Verify we're in the new tab by checking current tab
          const currentTab = await driver.nvim.call("nvim_call_function", [
            "tabpagenr",
            [],
          ]);
          expect(currentTab).toBeGreaterThan(1);

          // Display window should be above input window in the same tab
          const displayWinPos = await displayWindow.getPosition();
          const inputWinPos = await inputWindow.getPosition();
          expect(displayWinPos[0]).toBeLessThan(inputWinPos[0]);
        },
      );
    });
  });

  it("should display and update token count in input window title", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      const { inputWindow } = driver.getVisibleState();
      const initialWinbar = await inputWindow.getOption("winbar");
      expect(initialWinbar).toContain("Magenta Input (claude-sonnet-3.7) [~");

      // Generate a large message that will definitely increase the token count
      const largeMessage = "Hello, this is a test message. ".repeat(500);
      await driver.inputMagentaText(largeMessage);
      await driver.send();
      const request1 = await driver.mockAnthropic.awaitPendingRequest();
      request1.respond({
        stopReason: "tool_use",
        text: "ok, here goes",
        toolRequests: [],
        usage: {
          inputTokens: 1000,
          outputTokens: 2000,
        },
      });

      // Wait for token count to update after the large message
      await pollUntil(async () => {
        const updatedWinbar = await inputWindow.getOption("winbar");
        const updatedCount = extractTokenCount(updatedWinbar as string);
        // Token count should be noticeably higher
        if (updatedCount <= 2000) {
          throw new Error(
            `Token count did not increase: 2K -> ${updatedCount}`,
          );
        }
      });
    });
  });
});

// Helper function to extract token count from winbar title
function extractTokenCount(winbar: string): number {
  const match = winbar.match(/\[~?(\d+)K?\s+tokens\]/);
  if (!match) return 0;

  if (match[1] && match[0].includes("K")) {
    return parseInt(match[1]) * 1000;
  }
  return parseInt(match[1]);
}
