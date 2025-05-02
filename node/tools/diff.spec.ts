import { describe, expect, it } from "vitest";
import { withDriver } from "../test/preamble";
import type { ToolRequestId } from "./toolManager";
import * as path from "path";
import type { Line } from "../nvim/buffer";

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
                filePath: "poem.txt",
                insertAfter: "",
                content: "a poem\nwith some lines",
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

      const poemWin = await driver.findWindow(async (w) => {
        const buf = await w.buffer();
        const name = await buf.getName();
        return path.basename(name) == "poem.txt";
      });

      expect(await poemWin.getOption("diff")).toBe(true);
      expect(await poemWin.getOption("relativenumber")).toBe(true);

      const poemText = (
        await (await poemWin.buffer()).getLines({ start: 0, end: -1 })
      ).join("\n");
      expect(poemText).toEqual("");

      const diffWin = await driver.findWindow(async (w) => {
        const buf = await w.buffer();
        const name = await buf.getName();
        return /poem.txt_message_2_diff$/.test(name);
      });

      expect(await diffWin.getOption("diff")).toBe(true);

      const diffText = (
        await (await diffWin.buffer()).getLines({ start: 0, end: -1 })
      ).join("\n");
      expect(diffText).toEqual("a poem\nwith some lines");
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
                filePath: "node/test/fixtures/toolManager.ts",
                insertAfter: "",
                content: "a poem\n",
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
        return /toolManager.ts_message_2_diff$/.test(name);
      });

      expect(await diffWin.getOption("diff")).toBe(true);

      const diffText = await (
        await diffWin.buffer()
      ).getLines({ start: 0, end: -1 });
      expect(diffText[0]).toEqual("a poem" as Line);
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
        `Update the poem in the file node/test/fixtures/poem.txt`,
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
                filePath: "node/test/fixtures/poem.txt",
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
      expect(await poemWin.getOption("relativenumber")).toBe(true);

      const poemText = (
        await (await poemWin.buffer()).getLines({ start: 0, end: -1 })
      ).join("\n");
      expect(poemText).toEqual(
        "Moonlight whispers through the trees,\nSilver shadows dance with ease.\nStars above like diamonds bright,\nPaint their stories in the night.",
      );

      const diffWin = await driver.findWindow(async (w) => {
        const buf = await w.buffer();
        const name = await buf.getName();
        return /node\/test\/fixtures\/poem.txt_message_2_diff$/.test(name);
      });

      expect(await diffWin.getOption("diff")).toBe(true);

      const diffText = (
        await (await diffWin.buffer()).getLines({ start: 0, end: -1 })
      ).join("\n");
      expect(diffText).toEqual(
        "In gardens wild and flowing free,\nMagenta blooms for all to see.\nNature's canvas, bold and bright,\nPaints its colors in the light.",
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
                filePath: "poem.txt",
                insertAfter: "",
                content: "a poem",
              },
            },
          },
        ],
      });

      let reviewPos;
      {
        reviewPos = await driver.assertDisplayBufferContains("review edits");

        await driver.triggerDisplayBufferKey(reviewPos, "<CR>");
        await driver.assertWindowCount(4);

        const diffWin = await driver.findWindow(async (w) => {
          const buf = await w.buffer();
          const name = await buf.getName();
          return /poem.txt_message_2_diff$/.test(name);
        });
        await diffWin.close();
      }

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
                filePath: "poem.txt",
                insertAfter: "",
                content: "another poem",
              },
            },
          },
        ],
      });

      {
        const nextReviewPos = await driver.assertDisplayBufferContains(
          "review edits",
          reviewPos.row + 1,
        );

        await driver.triggerDisplayBufferKey(nextReviewPos, "<CR>");
        await driver.assertWindowCount(4);

        const diffWin = await driver.findWindow(async (w) => {
          const buf = await w.buffer();
          const name = await buf.getName();
          return /poem.txt_message_4_diff$/.test(name);
        });

        const diffText = (
          await (await diffWin.buffer()).getLines({ start: 0, end: -1 })
        ).join("\n");
        expect(diffText).toEqual("another poem");
      }
    });
  });

  it("replace a single line", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(
        `Update line 2 in node/test/fixtures/poem.txt`,
      );
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
                filePath: "node/test/fixtures/poem.txt",
                find: "Silver shadows dance with ease.",
                replace: "Golden moonbeams dance with ease.",
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
      expect(diffText).toEqual(
        "Moonlight whispers through the trees,\nGolden moonbeams dance with ease.\nStars above like diamonds bright,\nPaint their stories in the night.",
      );
    });
  });

  it("failed edit is not fatal", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(
        `Update the poem in the file node/test/fixtures/poem.txt`,
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
                filePath: "node/test/fixtures/poem.txt",
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
                filePath: "node/test/fixtures/poem.txt",
                insertAfter: `Paint their stories in the night.`,
                content: `Added text`,
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

      const poemText = (
        await (await poemWin.buffer()).getLines({ start: 0, end: -1 })
      ).join("\n");
      expect(poemText).toEqual(
        "Moonlight whispers through the trees,\nSilver shadows dance with ease.\nStars above like diamonds bright,\nPaint their stories in the night.",
      );

      const diffWin = await driver.findWindow(async (w) => {
        const buf = await w.buffer();
        const name = await buf.getName();
        return /node\/test\/fixtures\/poem.txt_message_2_diff$/.test(name);
      });

      expect(await diffWin.getOption("diff")).toBe(true);

      const diffText = (
        await (await diffWin.buffer()).getLines({ start: 0, end: -1 })
      ).join("\n");
      expect(diffText).toEqual(
        "Moonlight whispers through the trees,\nSilver shadows dance with ease.\nStars above like diamonds bright,\nPaint their stories in the night.Added text",
      );

      const detailsPos = await driver.assertDisplayBufferContains("Replace");
      await driver.triggerDisplayBufferKey(detailsPos, "<CR>");

      await driver.assertDisplayBufferContains(`\
# assistant:
ok, I will try to rewrite the poem in that file
Replace [[ -1 / +1 ]] in \`node/test/fixtures/poem.txt\` ⚠️ Error: "Unable to find text \\"bogus line...\\" in file \`node/test/fixtures/poem.txt\`"
id: id1
replace: {
    filePath: node/test/fixtures/poem.txt
    match:
\`\`\`
bogus line...
\`\`\`
    replace:
\`\`\`
Replace text
\`\`\`
}
Error: Unable to find text "bogus line..." in file \`node/test/fixtures/poem.txt\`
Insert [[ +1 ]] in \`node/test/fixtures/poem.txt\` Awaiting user review.
Stopped (end_turn) [input: 0, output: 0]

Edits:
  node/test/fixtures/poem.txt (2 edits). **[👀 review edits ]**`);
      await driver.triggerDisplayBufferKey(detailsPos, "<CR>");
      await driver.assertDisplayBufferContains(`\
# assistant:
ok, I will try to rewrite the poem in that file
Replace [[ -1 / +1 ]] in \`node/test/fixtures/poem.txt\` ⚠️ Error: "Unable to find text \\"bogus line...\\" in file \`node/test/fixtures/poem.txt\`"
Insert [[ +1 ]] in \`node/test/fixtures/poem.txt\` Awaiting user review.
Stopped (end_turn) [input: 0, output: 0]

Edits:
  node/test/fixtures/poem.txt (2 edits). **[👀 review edits ]**`);
    });
  });
});
