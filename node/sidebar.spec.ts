import { describe, expect, it } from "vitest";
import { withDriver } from "./test/preamble";

describe("node/sidebar.spec.ts", () => {
  it("send command should scroll to last user message", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`\n`.repeat(100));
      await driver.send();
      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "sup?",
        toolRequests: [],
      });
      await driver.inputMagentaText(`sup!`);
      await driver.send();

      const displayWindow = driver.getVisibleState().displayWindow;
      const buffer = await displayWindow.buffer();
      const lines = await buffer.getLines({ start: 0, end: -1 });
      const line = lines.findLastIndex((l) => l == "# user:");
      expect(await displayWindow.topLine()).toEqual(line + 1);
    });
  });
});
