import { type ToolRequestId } from "./toolManager.ts";
import { describe, it, expect } from "vitest";
import { withDriver } from "../test/preamble";
import { pollUntil } from "../utils/async.ts";

describe("node/tools/hover.spec.ts", () => {
  it("hover end-to-end", async () => {
    await withDriver({}, async (driver) => {
      await driver.editFile("node/test/fixtures/test.ts");
      await driver.showSidebar();

      await driver.inputMagentaText(`Try hovering a symbol`);
      await driver.send();

      // wait for ts_ls to start/attach
      const toolRequestId = "id" as ToolRequestId;
      await driver.mockAnthropic.respond({
        stopReason: "tool_use",
        text: "ok, here goes",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "hover",
              input: {
                filePath: "node/test/fixtures/test.ts",
                symbol: "val.a.b.c",
              },
            },
          },
        ],
      });

      const result = await pollUntil(
        () => {
          const state = driver.magenta.chat.state;
          if (state.state != "initialized") {
            throw new Error(`thread not ready`);
          }

          const thread = state.thread;
          if (!thread || !thread.state || typeof thread.state !== "object") {
            throw new Error("Thread state is not valid");
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
        },
        { timeout: 5000 },
      );

      expect(result).toEqual({
        type: "tool_result",
        id: toolRequestId,
        result: {
          status: "ok",
          value: `(markdown):\n\n\`\`\`typescript\n(property) c: "test"\n\`\`\`\n\n`,
        },
      });
    });
  });
});
