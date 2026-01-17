import { describe, expect, it } from "vitest";
import { withDriver } from "../test/preamble";
import type { ToolRequestId } from "./toolManager";
import * as fs from "node:fs";
import * as path from "path";
import { getcwd } from "../nvim/nvim";
import type { UnresolvedFilePath } from "../utils/files";
import type { ToolName } from "./types";
import type { Row0Indexed } from "../nvim/window";

describe("node/tools/display-snapshot-diff.spec.ts", () => {
  it("compare current file with snapshot", async () => {
    await withDriver({}, async (driver) => {
      await driver.nvim.call("nvim_set_option_value", [
        "relativenumber",
        true,
        {},
      ]);
      await driver.showSidebar();
      await driver.inputMagentaText(`Update the poem in the file poem.txt`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "ok, I will try to rewrite the poem in that file",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "replace" as ToolName,
              input: {
                filePath: `poem.txt` as UnresolvedFilePath,
                find: `\
Moonlight whispers through the trees,
Silver shadows dance with ease.
Stars above like diamonds bright,
Paint their stories in the night.`,
                replace: `\
In gardens wild and flowing free,
Magenta blooms for all to see.
Nature's canvas, bold and bright,
Paints its colors in the light.`,
              },
            },
          },
        ],
      });

      // Verify edits were applied immediately
      await driver.assertDisplayBufferContains("✏️✅ Replace [[ -4 / +4 ]]");

      // Verify file was updated with the new content
      const poemPath = path.join(await getcwd(driver.nvim), "poem.txt");
      const fileContent = fs.readFileSync(poemPath, "utf-8");
      expect(fileContent).toContain("In gardens wild and flowing free");
      expect(fileContent).toContain("Magenta blooms for all to see");

      // Now check the snapshot diff functionality
      const diffSnapshotPos =
        await driver.assertDisplayBufferContains("± diff snapshot");

      // Trigger the diff snapshot view
      await driver.triggerDisplayBufferKey(diffSnapshotPos, "<CR>");
      // Should be 4 windows:
      // 1. Magenta display buffer
      // 2. Magenta input buffer
      // 3. Current file buffer
      // 4. Snapshot buffer
      await driver.assertWindowCount(4);

      // Find and check the current file window
      const poemWin = await driver.findWindow(async (w) => {
        const buf = await w.buffer();
        const name = await buf.getName();
        return new RegExp(`poem.txt$`).test(name);
      });

      expect(await poemWin.getOption("diff")).toBe(true);
      expect(await poemWin.getOption("relativenumber")).toBe(true);

      const poemText = (
        await (
          await poemWin.buffer()
        ).getLines({ start: 0 as Row0Indexed, end: -1 as Row0Indexed })
      ).join("\n");
      expect(poemText).toContain("In gardens wild and flowing free");
      expect(poemText).toContain("Magenta blooms for all to see");

      // Find and check the snapshot window
      const diffWin = await driver.findWindow(async (w) => {
        const buf = await w.buffer();
        const name = await buf.getName();
        return /_snapshot$/.test(name);
      });

      expect(await diffWin.getOption("diff")).toBe(true);

      const diffText = (
        await (
          await diffWin.buffer()
        ).getLines({ start: 0 as Row0Indexed, end: -1 as Row0Indexed })
      ).join("\n");
      expect(diffText).toContain("Moonlight whispers through the trees");
      expect(diffText).toContain("Silver shadows dance with ease");
    });
  });
});
