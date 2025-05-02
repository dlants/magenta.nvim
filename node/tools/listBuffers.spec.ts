import { type ToolRequestId } from "./toolManager.ts";
import { describe, it, expect } from "vitest";
import { withDriver } from "../test/preamble";
import { pollUntil } from "../utils/async.ts";

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
      await driver.mockAnthropic.respond({
        stopReason: "tool_use",
        text: "ok, here goes",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "list_buffers",
              input: {},
            },
          },
        ],
      });

      const result = await pollUntil(() => {
        const state = driver.magenta.chat.state;
        if (state.state != "initialized") {
          throw new Error(`app not initialized`);
        }

        const thread = state.thread;
        if (!thread || !thread.state || typeof thread.state !== "object") {
          throw new Error("Thread state is not valid");
        }

        if (!thread.toolManager) {
          throw new Error("Thread state does not have toolManager");
        }

        const toolWrapper =
          thread.toolManager.state.toolWrappers[toolRequestId];
        if (!toolWrapper) {
          throw new Error(
            `could not find toolWrapper with id ${toolRequestId}`,
          );
        }

        if (toolWrapper.tool.state.state != "done") {
          throw new Error(`Request not done`);
        }

        return toolWrapper.tool.state.result;
      });

      expect(result).toEqual({
        id: toolRequestId,
        type: "tool_result",
        result: {
          status: "ok",
          value: `node/test/fixtures/poem.txt\nactive node/test/fixtures/poem2.txt`,
        },
      });
    });
  });
});
