import { describe, expect, it } from "vitest";
import { TMP_DIR, withDriver } from "../test/preamble";
import type { ToolRequestId } from "./toolManager";
import * as path from "path";
import { getCurrentBuffer, getcwd } from "../nvim/nvim";
import * as fs from "node:fs";
import { type Line } from "../nvim/buffer";
import type { UnresolvedFilePath } from "../utils/files";

describe("node/tools/diff.spec.ts", () => {
  it("insert into new file", async () => {
    await withDriver({}, async (driver) => {
      await driver.nvim.call("nvim_set_option_value", [
        "relativenumber",
        true,
        {},
      ]);

      await driver.showSidebar();
      await driver.inputMagentaText(
        `Write me a short poem in the file new.txt`,
      );
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "ok, here is a new poem",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "insert",
              input: {
                filePath: `${TMP_DIR}/new.txt` as UnresolvedFilePath,
                insertAfter: "",
                content: "a poem\nwith some lines",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("✏️ Insert [[ +2 ]]");

      const poemPath = path.join(
        await getcwd(driver.nvim),
        `${TMP_DIR}/new.txt`,
      );
      expect(fs.existsSync(poemPath)).toBe(true);
      const poemContent = fs.readFileSync(poemPath, "utf-8");
      expect(poemContent).toEqual("a poem\nwith some lines");
    });
  });

  it("insert into a large file", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(
        `Add a short poem to the end of toolManager.ts`,
      );
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "ok, here is a poem",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "insert",
              input: {
                filePath: `${TMP_DIR}/toolManager.ts` as UnresolvedFilePath,
                insertAfter: "",
                content: "a poem",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("✏️ Insert [[ +1 ]]");

      const filePath = path.join(
        await getcwd(driver.nvim),
        `${TMP_DIR}/toolManager.ts`,
      );
      const fileContent = fs.readFileSync(filePath, "utf-8");

      // The file content might end with a newline, so check if it contains our poem
      expect(fileContent.includes("a poem")).toBe(true);
    });
  });

  it("replace in existing file", async () => {
    await withDriver({}, async (driver) => {
      await driver.nvim.call("nvim_set_option_value", [
        "relativenumber",
        true,
        {},
      ]);
      await driver.showSidebar();
      await driver.inputMagentaText(
        `Update the poem in the file ${TMP_DIR}/poem.txt`,
      );
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "ok, I will try to rewrite the poem in that file",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "replace",
              input: {
                filePath: `${TMP_DIR}/poem.txt` as UnresolvedFilePath,
                find: `\
shadows dance with ease.
Stars above like diamonds bright,
Paint their `,
                replace: `\
blooms for all to see.
Nature's canvas, bold and bright,
Paints its colors `,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("✏️ Replace [[ -3 / +3 ]]");

      // Verify file was updated
      const filePath = path.join(
        await getcwd(driver.nvim),
        `${TMP_DIR}/poem.txt`,
      );
      const fileContent = fs.readFileSync(filePath, "utf-8");
      expect(fileContent).toEqual(
        `\
Moonlight whispers through the trees,
Silver blooms for all to see.
Nature's canvas, bold and bright,
Paints its colors stories in the night.
`,
      );
    });
  });

  it("multiple messages editing same file", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(
        `Write me a short poem in the file poem.txt`,
      );
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "ok, here is a poem",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "insert",
              input: {
                filePath: `${TMP_DIR}/multiple.txt` as UnresolvedFilePath,
                insertAfter: "",
                content: "a poem",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("Insert [[ +1 ]]");

      // Verify first edit was applied
      const poemPath = path.join(
        await getcwd(driver.nvim),
        `${TMP_DIR}/multiple.txt`,
      );
      expect(fs.existsSync(poemPath)).toBe(true);
      let fileContent = fs.readFileSync(poemPath, "utf-8");
      expect(fileContent).toEqual("a poem");

      await driver.inputMagentaText(`Another one!`);
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "ok, here is another poem",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "insert",
              input: {
                filePath: `${TMP_DIR}/multiple.txt` as UnresolvedFilePath,
                insertAfter: "a poem",
                content: "\nanother poem",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("Insert [[ +2 ]]");
      fileContent = fs.readFileSync(poemPath, "utf-8");
      expect(fileContent).toEqual("a poem\nanother poem");
    });
  });

  it("replace a single line", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`Update line 2 in ${TMP_DIR}/poem.txt`);
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "I'll update that line",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "replace",
              input: {
                filePath: `${TMP_DIR}/poem.txt` as UnresolvedFilePath,
                find: "Silver shadows dance with ease.",
                replace: "Golden moonbeams dance with ease.",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("✏️ Replace [[ -1 / +1 ]]");

      // Verify the line was replaced
      const filePath = path.join(
        await getcwd(driver.nvim),
        `${TMP_DIR}/poem.txt`,
      );
      const fileContent = fs.readFileSync(filePath, "utf-8");
      expect(fileContent).toEqual(
        `Moonlight whispers through the trees,
Golden moonbeams dance with ease.
Stars above like diamonds bright,
Paint their stories in the night.
`,
      );
    });
  });

  it("replace entire file with empty find parameter", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(
        `Replace the entire contents of ${TMP_DIR}/poem.txt with a new poem`,
      );
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "I'll replace the entire file content",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "replace",
              input: {
                filePath: `${TMP_DIR}/poem.txt` as UnresolvedFilePath,
                find: "",
                replace:
                  "A brand new poem\nWritten from scratch\nReplacing all that came before",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("✏️ Replace [[ -1 / +3 ]]");
      await driver.assertDisplayBufferContains("Success");

      // Verify the entire file was replaced
      const filePath = path.join(
        await getcwd(driver.nvim),
        `${TMP_DIR}/poem.txt`,
      );
      const fileContent = fs.readFileSync(filePath, "utf-8");
      expect(fileContent).toEqual(
        "A brand new poem\nWritten from scratch\nReplacing all that came before",
      );
    });
  });

  it("failed edit is not fatal", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(
        `Update the poem in the file ${TMP_DIR}/poem.txt`,
      );
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "ok, I will try to rewrite the poem in that file",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id1" as ToolRequestId,
              toolName: "replace",
              input: {
                filePath: `${TMP_DIR}/poem.txt` as UnresolvedFilePath,
                find: `bogus line...`,
                replace: `Replace text`,
              },
            },
          },
          {
            status: "ok",
            value: {
              id: "id2" as ToolRequestId,
              toolName: "insert",
              input: {
                filePath: `${TMP_DIR}/poem.txt` as UnresolvedFilePath,
                insertAfter: `Paint their stories in the night.`,
                content: `Added text`,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("Replace [[ -1 / +1 ]]");
      await driver.assertDisplayBufferContains("Error");
      await driver.assertDisplayBufferContains("Insert [[ +1 ]]");

      // Verify that the first edit failed but the second succeeded
      const filePath = path.join(
        await getcwd(driver.nvim),
        `${TMP_DIR}/poem.txt`,
      );
      const fileContent = fs.readFileSync(filePath, "utf-8");
      expect(fileContent).toEqual(
        "Moonlight whispers through the trees,\nSilver shadows dance with ease.\nStars above like diamonds bright,\nPaint their stories in the night.Added text\n",
      );

      const detailsPos = await driver.assertDisplayBufferContains("Replace");
      await driver.triggerDisplayBufferKey(detailsPos, "<CR>");

      await driver.assertDisplayBufferContains(
        "I will try to rewrite the poem",
      );
      await driver.assertDisplayBufferContains("Replace [[ -1 / +1 ]]");
      await driver.assertDisplayBufferContains(
        'Unable to find text "bogus line..."',
      );
      await driver.assertDisplayBufferContains("diff snapshot");
    });
  });

  it("file changing under buffer is handled", async () => {
    await withDriver({}, async (driver) => {
      // Create a file and open it in a buffer
      const poemFile = path.join(
        await getcwd(driver.nvim),
        `${TMP_DIR}/poem_to_change.txt`,
      );
      fs.writeFileSync(poemFile, "Original content here", "utf-8");

      // Open the file in a buffer
      await driver.command(`edit ${poemFile}`);
      fs.writeFileSync(poemFile, "changed content", "utf-8");

      // Make the buffer "modified" but don't save
      await driver.command("normal! iSome unsaved changes");

      await driver.showSidebar();
      await driver.inputMagentaText(`Add to the end of poem_to_change.txt`);
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "I'll append to that file",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "insert",
              input: {
                filePath: poemFile as UnresolvedFilePath,
                insertAfter: "Original content here",
                content: "\nAppended content",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("Error");
      await driver.assertDisplayBufferContains(
        "has unsaved changes that could not be written",
      );
    });
  });

  it("handle invalid insertAfter location", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(
        `Add content at a specific spot in the poem file`,
      );
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "I'll try to add content",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "insert",
              input: {
                filePath: `${TMP_DIR}/poem.txt` as UnresolvedFilePath,
                insertAfter: "Text that doesn't exist in the file",
                content: "\nNew content to add",
              },
            },
          },
        ],
      });

      const detailsPos =
        await driver.assertDisplayBufferContains("Insert [[ +2 ]]");

      await driver.assertDisplayBufferContains("Error");
      await driver.assertDisplayBufferContains(
        "Unable to find insert location",
      );
      await driver.assertDisplayBufferContains("diff snapshot");

      await driver.triggerDisplayBufferKey(detailsPos, "<CR>");

      // Check for error message - it appears in a different format
      await driver.assertDisplayBufferContains(
        "Unable to find insert location",
      );
    });
  });

  it("edit a file with open buffer containing pending changes", async () => {
    await withDriver({}, async (driver) => {
      // Create a file and open it in a buffer
      const poemFile = path.join(
        await getcwd(driver.nvim),
        `${TMP_DIR}/buffer_with_changes.txt`,
      ) as UnresolvedFilePath;

      fs.writeFileSync(poemFile, "Original content\nSecond line", "utf-8");

      await driver.command(`edit ${poemFile}`);

      const buffer = await getCurrentBuffer(driver.nvim);
      expect(await buffer.getName()).toContain("buffer_with_changes.txt");
      await buffer.setLines({
        start: -1,
        end: -1,
        lines: ["Unsaved buffer changes"] as Line[],
      });
      const isModified = await buffer.getOption("modified");
      expect(isModified).toBe(true);

      await driver.showSidebar();
      await driver.inputMagentaText(
        `Add text after "Second line" in buffer_with_changes.txt`,
      );
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "I'll add text to that file",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "insert",
              input: {
                filePath: poemFile,
                insertAfter: "Second line",
                content: "\nAdded by Magenta",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("✏️ Insert [[ +2 ]]");
      await driver.assertDisplayBufferContains("Success");

      const bufferLines = await buffer.getLines({
        start: 0,
        end: -1,
      });
      expect(bufferLines).toEqual([
        "Original content",
        "Second line",
        "Added by Magenta",
        "Unsaved buffer changes",
      ]);

      // Verify file was updated on disk
      const fileContent = fs.readFileSync(poemFile, "utf-8");
      expect(fileContent).toEqual(
        "Original content\nSecond line\nAdded by Magenta\nUnsaved buffer changes\n",
      );

      // Buffer should no longer be modified after successful save
      const isStillModified = await buffer.getOption("modified");
      expect(isStillModified).toBe(false);
    });
  });
});
