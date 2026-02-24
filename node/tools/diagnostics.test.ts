import { type ToolRequestId } from "./toolManager.ts";
import { describe, it, expect } from "vitest";
import {
  pollForToolResult,
  withDriver,
  normalizePaths,
} from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";
import type { ToolName } from "./types.ts";

describe("node/tools/diagnostics.test.ts", () => {
  it("diagnostics end-to-end", { timeout: 10000 }, async () => {
    await withDriver({}, async (driver, dirs) => {
      await driver.editFile("test.ts");
      await driver.showSidebar();

      await driver.inputMagentaText(`Try getting the diagnostics`);
      await driver.send();

      const toolRequestId = "id" as ToolRequestId;

      await pollUntil(
        async () => {
          const state = driver.magenta.chatApp.getState();
          if (state.status != "running") {
            throw new Error(`app crashed`);
          }
          const diagnostics = (await driver.nvim.call("nvim_exec_lua", [
            `return vim.diagnostic.get(nil)`,
            [],
          ])) as unknown[];

          if (diagnostics.length === 0) {
            throw new Error("No diagnostics available yet");
          }
        },
        { timeout: 5000 },
      );

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "ok, here goes",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "diagnostics" as ToolName,
              input: {},
            },
          },
        ],
      });

      const result = await pollForToolResult(driver, toolRequestId);

      expect(normalizePaths(result, dirs.tmpDir)).toEqual({
        type: "tool_result",
        id: toolRequestId,
        result: {
          status: "ok",
          value: [
            {
              type: "text",
              text: `file: <tmpDir>/test.ts source: typescript, severity: 1, message: "Property 'd' does not exist on type '{ c: "test"; }'."`,
            },
          ],
        },
      });
    });
  });
});
