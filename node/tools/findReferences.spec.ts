import { type ToolRequestId } from "./toolManager.ts";
import { describe, it, expect } from "vitest";
import { withDriver } from "../test/preamble";
import { pollUntil } from "../utils/async.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { FindReferencesTool } from "./findReferences.ts";
import type { ToolName } from "./types.ts";

describe("node/tools/findReferences.spec.ts", () => {
  it("findReferences end-to-end", async () => {
    await withDriver({}, async (driver) => {
      await driver.editFile("node/test/fixtures/test.ts");
      await driver.showSidebar();

      await driver.inputMagentaText(`Try finding references for a symbol`);
      await driver.send();

      const toolRequestId = "id" as ToolRequestId;
      const request = await driver.mockAnthropic.awaitPendingRequest();
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
                filePath: "node/test/fixtures/test.ts" as UnresolvedFilePath,
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

          const tool = thread.toolManager.getTool(toolRequestId);
          if (!(tool && tool.toolName == "find_references")) {
            throw new Error(`could not find tool with id ${toolRequestId}`);
          }

          const findReferencesTool = tool as unknown as FindReferencesTool;
          if (findReferencesTool.state.state != "done") {
            throw new Error(`Request not done`);
          }

          return findReferencesTool.state.result;
        },
        { timeout: 3000 },
      );

      expect(result).toEqual({
        type: "tool_result",
        id: toolRequestId,
        result: {
          status: "ok",
          value: [
            {
              type: "text",
              text: `node/test/fixtures/test.ts:4:6\nnode/test/fixtures/test.ts:12:6\nnode/test/fixtures/test.ts:17:20\n`,
            },
          ],
        },
      });
    });
  });
});
