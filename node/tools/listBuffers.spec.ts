import { type ToolRequestId } from "./toolManager.ts";
import { describe, it, expect } from "vitest";
import { withDriver } from "../test/preamble";
import { pollUntil } from "../utils/async.ts";
import type { ToolName } from "./types.ts";
import type { ListBuffersTool } from "./listBuffers.ts";

describe("node/tools/listBuffers.spec.ts", () => {
  it("listBuffers end-to-end", async () => {
    await withDriver({}, async (driver) => {
      await driver.editFile("node/test/fixtures/poem.txt");
      await driver.editFile("node/test/fixtures/poem2.txt");
      await driver.showSidebar();

      await driver.assertWindowCount(3);

      await driver.inputMagentaText(`Try listing some buffers`);
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
              toolName: "list_buffers" as ToolName,
              input: {},
            },
          },
        ],
      });

      const result = await pollUntil(() => {
        const thread = driver.magenta.chat.getActiveThread();
        if (!thread || !thread.state || typeof thread.state !== "object") {
          throw new Error("Thread state is not valid");
        }

        if (!thread.toolManager) {
          throw new Error("Thread state does not have toolManager");
        }

        const tool = thread.toolManager.getTool(toolRequestId);
        if (!(tool && tool.toolName == "list_buffers")) {
          throw new Error(`could not find tool with id ${toolRequestId}`);
        }
        const listBuffersTool = tool as unknown as ListBuffersTool;

        if (listBuffersTool.state.state != "done") {
          throw new Error(`Request not done`);
        }

        return listBuffersTool.state.result;
      });

      expect(result).toEqual({
        id: toolRequestId,
        type: "tool_result",
        result: {
          status: "ok",
          value: [
            {
              type: "text",
              text: `node/test/fixtures/poem.txt\nactive node/test/fixtures/poem2.txt`,
            },
          ],
        },
      });
    });
  });
});
