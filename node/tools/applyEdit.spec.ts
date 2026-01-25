import { describe, expect, it, vi } from "vitest";
import { withDriver } from "../test/preamble";
import type { ToolRequestId } from "./toolManager";
import type { ToolName } from "./types";
import * as path from "path";
import { getCurrentBuffer, getcwd } from "../nvim/nvim";
import * as fs from "node:fs";
import { type Line } from "../nvim/buffer";
import type { AbsFilePath, UnresolvedFilePath } from "../utils/files";
import { applyEdit } from "./applyEdit";
import type { Row0Indexed } from "../nvim/window";

describe("node/tools/applyEdit.spec.ts", () => {
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

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "ok, here is a new poem",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "insert" as ToolName,
              input: {
                filePath: "new.txt" as UnresolvedFilePath,
                insertAfter: "",
                content: "a poem\nwith some lines",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("✏️✅ Insert [[ +2 ]]");

      const poemPath = path.join(await getcwd(driver.nvim), "new.txt");
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

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "ok, here is a poem",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "insert" as ToolName,
              input: {
                filePath: "toolManager.ts" as UnresolvedFilePath,
                insertAfter: "",
                content: "a poem",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("✏️✅ Insert [[ +1 ]]");

      const filePath = path.join(await getcwd(driver.nvim), "toolManager.ts");
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
                filePath: "poem.txt" as UnresolvedFilePath,
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

      await driver.assertDisplayBufferContains("✏️✅ Replace [[ -3 / +3 ]]");

      // Verify file was updated
      const filePath = path.join(await getcwd(driver.nvim), "poem.txt");
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

      const request1 = await driver.mockAnthropic.awaitPendingStream();
      request1.respond({
        stopReason: "tool_use",
        text: "ok, here is a poem",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id1" as ToolRequestId,
              toolName: "insert" as ToolName,
              input: {
                filePath: "multiple.txt" as UnresolvedFilePath,
                insertAfter: "",
                content: "a poem",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("Insert [[ +1 ]]");

      // Verify first edit was applied
      const poemPath = path.join(await getcwd(driver.nvim), "multiple.txt");
      expect(fs.existsSync(poemPath)).toBe(true);
      let fileContent = fs.readFileSync(poemPath, "utf-8");
      expect(fileContent).toEqual("a poem");

      await driver.inputMagentaText(`Another one!`);
      await driver.send();

      const request2 = await driver.mockAnthropic.awaitPendingStream();
      request2.respond({
        stopReason: "tool_use",
        text: "ok, here is another poem",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id2" as ToolRequestId,
              toolName: "insert" as ToolName,
              input: {
                filePath: "multiple.txt" as UnresolvedFilePath,
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
      await driver.inputMagentaText(`Update line 2 in poem.txt`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "I'll update that line",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "replace" as ToolName,
              input: {
                filePath: "poem.txt" as UnresolvedFilePath,
                find: "Silver shadows dance with ease.",
                replace: "Golden moonbeams dance with ease.",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("✏️✅ Replace [[ -1 / +1 ]]");

      // Verify the line was replaced
      const filePath = path.join(await getcwd(driver.nvim), "poem.txt");
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
        `Replace the entire contents of poem.txt with a new poem`,
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "I'll replace the entire file content",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "replace" as ToolName,
              input: {
                filePath: "poem.txt" as UnresolvedFilePath,
                find: "",
                replace:
                  "A brand new poem\nWritten from scratch\nReplacing all that came before",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("✏️✅ Replace [[ -1 / +3 ]]");

      // Verify the entire file was replaced
      const filePath = path.join(await getcwd(driver.nvim), "poem.txt");
      const fileContent = fs.readFileSync(filePath, "utf-8");
      expect(fileContent).toEqual(
        "A brand new poem\nWritten from scratch\nReplacing all that came before",
      );
    });
  });

  it("failed edit is not fatal", async () => {
    await withDriver({}, async (driver) => {
      // First open the poem file in a buffer
      const poemFile = path.join(await getcwd(driver.nvim), "poem.txt");
      await driver.command(`edit ${poemFile}`);

      // Verify the buffer is open
      const buffer = await getCurrentBuffer(driver.nvim);
      expect(await buffer.getName()).toContain("poem.txt");

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
              id: "id1" as ToolRequestId,
              toolName: "replace" as ToolName,
              input: {
                filePath: "poem.txt" as UnresolvedFilePath,
                find: `bogus 1 / bogus 2...`,
                replace: `Replace text`,
              },
            },
          },
          {
            status: "ok",
            value: {
              id: "id2" as ToolRequestId,
              toolName: "insert" as ToolName,
              input: {
                filePath: "poem.txt" as UnresolvedFilePath,
                insertAfter: `Paint their stories in the night.\n`, // note newline at the end of file does not match
                content: `\nGentle breezes softly sway,\nIn the quiet, dreams convey.\nMoonlit paths of silver glow,\nLead to places hearts may go.\n`,
              },
            },
          },
          {
            status: "ok",
            value: {
              id: "id3" as ToolRequestId,
              toolName: "replace" as ToolName,
              input: {
                filePath: "poem.txt" as UnresolvedFilePath,
                find: `Moonlight whispers through the trees,`,
                replace: `Starlight whispers through the trees,`,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(
        "✏️❌ Replace [[ -1 / +1 ]] in `poem.txt` - Unable to find text in content. Try to re-read the file and make sure you match the latest content updates exactly. in file `poem.txt`",
      );
      await driver.assertDisplayBufferContains(
        '✏️❌ Insert [[ +6 ]] in `poem.txt` - Unable to find insert location "Paint their stories in the night.\n" in file `poem.txt`',
      );
      await driver.assertDisplayBufferContains(
        "✏️✅ Replace [[ -1 / +1 ]] in `poem.txt`",
      );

      // Verify that the first edit failed but the third succeeded
      const bufferLines = await buffer.getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });
      expect(bufferLines).toEqual([
        "Starlight whispers through the trees,",
        "Silver shadows dance with ease.",
        "Stars above like diamonds bright,",
        "Paint their stories in the night.",
      ]);

      // Also verify the file was updated on disk
      const fileContent = fs.readFileSync(poemFile, "utf-8");
      expect(fileContent).toEqual(
        "Starlight whispers through the trees,\nSilver shadows dance with ease.\nStars above like diamonds bright,\nPaint their stories in the night.\n",
      );

      // Check buffer modified state - should not be modified as changes were saved
      const isModified = await buffer.getOption("modified");
      expect(isModified).toBe(false);

      const detailsPos = await driver.assertDisplayBufferContains("Replace");
      await driver.triggerDisplayBufferKey(detailsPos, "<CR>");

      await driver.assertDisplayBufferContains("✅ Replace [[ -1 / +1 ]]");
      await driver.assertDisplayBufferContains("diff snapshot");
    });
  });

  it("file changing under buffer is handled", async () => {
    await withDriver({}, async (driver) => {
      // Create a file and open it in a buffer
      const poemFile = path.join(
        await getcwd(driver.nvim),
        "poem_to_change.txt",
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

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "I'll append to that file",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "insert" as ToolName,
              input: {
                filePath: poemFile as UnresolvedFilePath,
                insertAfter: "Original content here",
                content: "\nAppended content",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("✏️❌ Insert [[ +2 ]]");
    });
  });

  it("applyEdit immediately updates buffer tracker on insert", async () => {
    await withDriver({}, async (driver) => {
      // Create a file and open it in a buffer
      const cwd = await getcwd(driver.nvim);
      const poemFile = path.join(cwd, "poem.txt");

      await driver.command(`edit ${poemFile}`);
      await driver.showSidebar();

      const prevSyncInfo = driver.magenta.bufferTracker.getSyncInfo(
        poemFile as AbsFilePath,
      );
      expect(prevSyncInfo?.mtime).toBeDefined();

      const myDispatch = vi.fn();
      const dispatch = vi.fn();
      await driver.wait(100);
      const threadId = driver.magenta.chat.getActiveThread().id;
      await applyEdit(
        {
          id: "id" as ToolRequestId,
          toolName: "insert",
          input: {
            filePath: poemFile as UnresolvedFilePath,
            insertAfter: "",
            content: "\nAppended content",
          },
        },
        threadId,
        {
          cwd,
          nvim: driver.nvim,
          bufferTracker: driver.magenta.bufferTracker,
          myDispatch,
          dispatch,
        },
      );

      expect(dispatch, "dispatch").toBeCalledTimes(2);
      expect(dispatch).toHaveBeenLastCalledWith({
        id: threadId,
        msg: {
          msg: {
            absFilePath: poemFile,
            tool: {
              content: "\nAppended content",
              insertAfter: "",
              type: "insert",
            },
            type: "tool-applied",
            fileTypeInfo: {
              category: "text",
              mimeType: "text/plain",
              extension: "",
            },
          },
          type: "context-manager-msg",
        },
        type: "thread-msg",
      });
      expect(myDispatch, "myDispatch").toBeCalledTimes(1);
      expect(myDispatch).toHaveBeenLastCalledWith({
        result: {
          status: "ok",
          value: [
            {
              type: "text",
              text: "Successfully applied edits.",
            },
          ],
        },
        type: "finish",
      });

      const currSyncInfo = driver.magenta.bufferTracker.getSyncInfo(
        poemFile as AbsFilePath,
      );

      expect(
        currSyncInfo?.mtime,
        "bufferTracker updated before applyEdit halts",
      ).toBeGreaterThan(prevSyncInfo!.mtime);
    });
  });

  it("applyEdit immediately updates buffer tracker on replace", async () => {
    await withDriver({}, async (driver) => {
      const cwd = await getcwd(driver.nvim);
      // Create a file and open it in a buffer
      const poemFile = path.join(cwd, "poem.txt");

      await driver.command(`edit ${poemFile}`);
      await driver.showSidebar();

      const prevSyncInfo = driver.magenta.bufferTracker.getSyncInfo(
        poemFile as AbsFilePath,
      );
      expect(prevSyncInfo?.mtime).toBeDefined();

      const myDispatch = vi.fn();
      const dispatch = vi.fn();
      await driver.wait(100);
      await applyEdit(
        {
          id: "id" as ToolRequestId,
          toolName: "replace",
          input: {
            filePath: poemFile as UnresolvedFilePath,
            find: "",
            replace: "Replace content",
          },
        },
        driver.magenta.chat.getActiveThread().id,
        {
          nvim: driver.nvim,
          cwd,
          bufferTracker: driver.magenta.bufferTracker,
          myDispatch,
          dispatch,
        },
      );

      expect(myDispatch, "myDispatch").toBeCalledTimes(1);
      expect(myDispatch).toHaveBeenLastCalledWith({
        result: {
          status: "ok",
          value: [
            {
              type: "text",
              text: "Successfully applied edits.",
            },
          ],
        },
        type: "finish",
      });

      const currSyncInfo = driver.magenta.bufferTracker.getSyncInfo(
        poemFile as AbsFilePath,
      );

      expect(
        currSyncInfo?.mtime,
        "bufferTracker updated before applyEdit halts",
      ).toBeGreaterThan(prevSyncInfo!.mtime);
    });
  });

  it("handle invalid insertAfter location", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(
        `Add content at a specific spot in the poem file`,
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "I'll try to add content",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "insert" as ToolName,
              input: {
                filePath: "poem.txt" as UnresolvedFilePath,
                insertAfter: "Text that doesn't exist in the file",
                content: "\nNew content to add",
              },
            },
          },
        ],
      });

      const detailsPos = await driver.assertDisplayBufferContains(
        "✏️❌ Insert [[ +2 ]]",
      );

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
        "buffer_with_changes.txt",
      ) as UnresolvedFilePath;

      fs.writeFileSync(poemFile, "Original content\nSecond line", "utf-8");

      await driver.command(`edit ${poemFile}`);

      const buffer = await getCurrentBuffer(driver.nvim);
      expect(await buffer.getName()).toContain("buffer_with_changes.txt");
      await buffer.setLines({
        start: -1 as Row0Indexed,
        end: -1 as Row0Indexed,
        lines: ["Unsaved buffer changes"] as Line[],
      });
      const isModified = await buffer.getOption("modified");
      expect(isModified).toBe(true);

      await driver.showSidebar();
      await driver.inputMagentaText(
        `Add text after "Second line" in buffer_with_changes.txt`,
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "I'll add text to that file",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "insert" as ToolName,
              input: {
                filePath: poemFile,
                insertAfter: "Second line",
                content: "\nAdded by Magenta",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("✏️✅ Insert [[ +2 ]]");

      const bufferLines = await buffer.getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
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
