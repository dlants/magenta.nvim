import { describe, expect, it } from "vitest";
import { withDriver } from "../test/preamble";
import type { ToolRequestId } from "./toolManager";
import * as path from "path";
import * as Insert from "./insert";

describe("node/tools/insert.spec.ts", () => {
  it("insert into new file", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`Write a test note in a new file`);
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "Creating a test note file",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "insert",
              input: {
                filePath: "test_note.txt",
                insertAfter: "",
                content: "This is a test note\nWith multiple lines",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("Insert [[ +2 ]]");

      const reviewPos =
        await driver.assertDisplayBufferContains("review edits");

      await driver.triggerDisplayBufferKey(reviewPos, "<CR>");
      await driver.assertWindowCount(4);

      const noteWin = await driver.findWindow(async (w) => {
        const buf = await w.buffer();
        const name = await buf.getName();
        return path.basename(name) == "test_note.txt";
      });

      expect(await noteWin.getOption("diff")).toBe(true);

      const noteText = (
        await (await noteWin.buffer()).getLines({ start: 0, end: -1 })
      ).join("\n");
      expect(noteText).toEqual("");

      const diffWin = await driver.findWindow(async (w) => {
        const buf = await w.buffer();
        const name = await buf.getName();
        return /test_note.txt_message_2_diff$/.test(name);
      });

      expect(await diffWin.getOption("diff")).toBe(true);

      const diffText = (
        await (await diffWin.buffer()).getLines({ start: 0, end: -1 })
      ).join("\n");
      expect(diffText).toEqual("This is a test note\nWith multiple lines");
    });
  });

  it("insert into existing file", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`Add content to the poem file`);
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "I'll add to the poem file",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "insert",
              input: {
                filePath: "node/test/fixtures/poem.txt",
                insertAfter: "Paint their stories in the night.",
                content:
                  "\nWhile magic fills the midnight air,\nWith wonders that are oh so rare.",
              },
            },
          },
        ],
      });

      const reviewPos =
        await driver.assertDisplayBufferContains("review edits");

      await driver.triggerDisplayBufferKey(reviewPos, "<CR>");
      await driver.assertWindowCount(4);

      const poemWin = await driver.findWindow(async (w) => {
        const buf = await w.buffer();
        const name = await buf.getName();
        return /node\/test\/fixtures\/poem.txt$/.test(name);
      });

      expect(await poemWin.getOption("diff")).toBe(true);

      const diffWin = await driver.findWindow(async (w) => {
        const buf = await w.buffer();
        const name = await buf.getName();
        return /poem.txt_message_2_diff$/.test(name);
      });

      expect(await diffWin.getOption("diff")).toBe(true);

      const diffText = (
        await (await diffWin.buffer()).getLines({ start: 0, end: -1 })
      ).join("\n");
      expect(diffText).toContain("While magic fills the midnight air,");
      expect(diffText).toContain("With wonders that are oh so rare.");
    });
  });

  it("insert at beginning of file", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`Add a header to the poem file`);
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "I'll add a header to the poem file",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "insert",
              input: {
                filePath: "node/test/fixtures/poem.txt",
                insertAfter: "",
                content: "NIGHT POETRY\n\n",
              },
            },
          },
        ],
      });

      const reviewPos =
        await driver.assertDisplayBufferContains("review edits");

      await driver.triggerDisplayBufferKey(reviewPos, "<CR>");
      await driver.assertWindowCount(4);

      const diffWin = await driver.findWindow(async (w) => {
        const buf = await w.buffer();
        const name = await buf.getName();
        return /poem.txt_message_2_diff$/.test(name);
      });

      expect(await diffWin.getOption("diff")).toBe(true);

      const diffText = (
        await (await diffWin.buffer()).getLines({ start: 0, end: -1 })
      ).join("\n");

      // Verify content is prepended at the beginning
      expect(diffText.startsWith("NIGHT POETRY\n\n")).toBe(true);
      expect(diffText).toContain("Moonlight whispers through the trees,");
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
                filePath: "node/test/fixtures/poem.txt",
                insertAfter: "Text that doesn't exist in the file",
                content: "\nNew content to add",
              },
            },
          },
        ],
      });

      const reviewPos =
        await driver.assertDisplayBufferContains("review edits");

      await driver.triggerDisplayBufferKey(reviewPos, "<CR>");

      // Check for error message - it appears in a different format
      await driver.assertDisplayBufferContains(
        '⚠️ Error: "Unable to find insert location',
      );
    });
  });

  it("validate input", () => {
    const validInput = {
      filePath: "test.txt",
      insertAfter: "existing text",
      content: "new content",
    };

    const result = Insert.validateInput(validInput);
    expect(result.status).toEqual("ok");
    if (result.status === "ok") {
      expect(result.value.filePath).toEqual("test.txt");
      expect(result.value.insertAfter).toEqual("existing text");
      expect(result.value.content).toEqual("new content");
    }

    // Test with missing filePath
    const invalidInput1 = {
      insertAfter: "existing text",
      content: "new content",
    };
    const result1 = Insert.validateInput(invalidInput1);
    expect(result1.status).toEqual("error");

    // Test with wrong type
    const invalidInput2 = {
      filePath: 123,
      insertAfter: "existing text",
      content: "new content",
    };
    const result2 = Insert.validateInput(invalidInput2);
    expect(result2.status).toEqual("error");
  });
});
