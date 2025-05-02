import type { ToolRequestId } from "./toolManager.ts";
import { describe, it } from "vitest";
import { withDriver } from "../test/preamble.ts";

describe("tea/getFile.spec.ts", () => {
  it("render the getFile tool.", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(
        `Try reading the file ./node/test/fixtures/poem.txt/`,
      );
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "ok, here goes",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "request_id" as ToolRequestId,
              toolName: "get_file",
              input: {
                filePath: "./node/test/fixtures/poem.txt",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(
        `✅ Finished reading file \`./node/test/fixtures/poem.txt\``,
      );
    });
  });

  it("getFile rejection", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(
        `Try reading the file node/test/fixtures/.secret`,
      );
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "ok, here goes",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "get_file",
              input: {
                filePath: "node/test/fixtures/.secret",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`\
May I read file \`node/test/fixtures/.secret\`? **[ NO ]** **[ OK ]**`);
      const noPos = await driver.assertDisplayBufferContains("**[ NO ]**");

      await driver.triggerDisplayBufferKey(noPos, "<CR>");
      await driver.assertDisplayBufferContains(`\
Error reading file \`node/test/fixtures/.secret\`: The user did not allow the reading of this file.`);
    });
  });

  it("getFile approval", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(
        `Try reading the file node/test/fixtures/.secret`,
      );
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "ok, here goes",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "get_file",
              input: {
                filePath: "node/test/fixtures/.secret",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`\
May I read file \`node/test/fixtures/.secret\`? **[ NO ]** **[ OK ]**`);
      const okPos = await driver.assertDisplayBufferContains("**[ OK ]**");

      await driver.triggerDisplayBufferKey(okPos, "<CR>");
      await driver.assertDisplayBufferContains(`\
Finished reading file \`node/test/fixtures/.secret\``);
    });
  });

  it("getFile requests approval for gitignored file", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`Try reading the file node_modules/test`);
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "ok, here goes",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "get_file",
              input: {
                filePath: "node_modules/test",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`\
May I read file \`node_modules/test\`? **[ NO ]** **[ OK ]**`);
    });
  });

  it("getFile requests approval for file outside cwd", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`Try reading the file /tmp/file`);
      await driver.send();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "ok, here goes",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "get_file",
              input: {
                filePath: "/tmp/file",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`\
May I read file \`/tmp/file\`? **[ NO ]** **[ OK ]**`);
    });
  });
});
