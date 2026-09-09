import {
  pollUntil,
  type ToolName,
  type ToolRequestId,
  type UnresolvedFilePath,
} from "@magenta/server";
import { describe, expect, it } from "vitest";
import { findToolResult } from "../chat/thread-view.ts";
import { normalizePaths, withDriver } from "../test/preamble.ts";

describe("node/nvimclient/tools/findReferences.test.ts", () => {
  it("findReferences end-to-end", async () => {
    await withDriver({}, async (driver, dirs) => {
      await driver.editFile("test.ts");
      await driver.showSidebar();

      await driver.inputMagentaText(`Try finding references for a symbol`);
      await driver.send();

      const toolRequestId = "id" as ToolRequestId;
      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "ok, here goes",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "find_references" as ToolName,
              input: {
                filePath: "test.ts" as UnresolvedFilePath,
                symbol: "val.a.b.c",
              },
            },
          },
        ],
      });

      const result = await pollUntil(
        () => {
          const thread = driver.magenta.chat.getActiveThread();
          if (!thread || !thread.state || typeof thread.state !== "object") {
            throw new Error("Thread state is not valid");
          }

          const result = findToolResult(thread, toolRequestId);
          if (!result) {
            throw new Error(`no result for ${toolRequestId} found.`);
          }

          return result;
        },
        { timeout: 3000 },
      );

      expect(normalizePaths(result, dirs.tmpDir)).toMatchObject({
        type: "tool_result",
        id: toolRequestId,
        result: {
          status: "ok",
          value: [
            {
              type: "text",
              text: `<tmpDir>/test.ts:4:6\n<tmpDir>/test.ts:12:6\n<tmpDir>/test.ts:17:20\n`,
            },
          ],
        },
      });
    });
  });
});
