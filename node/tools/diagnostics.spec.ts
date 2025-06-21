import { type ToolRequestId } from "./toolManager.ts";
import { describe, it, expect } from "vitest";
import { withDriver } from "../test/preamble";
import { pollUntil } from "../utils/async.ts";
import type { ToolName } from "./types.ts";
import type { DiagnosticsTool } from "./diagnostics.ts";

describe("node/tools/diagnostics.spec.ts", () => {
  it("diagnostics end-to-end", { timeout: 10000 }, async () => {
    await withDriver({}, async (driver) => {
      await driver.editFile("node/test/fixtures/test.ts");
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

      const request = await driver.mockAnthropic.awaitPendingRequest();
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

      const result = await pollUntil(
        () => {
          const thread = driver.magenta.chat.getActiveThread();

          const tool = thread.toolManager.getTool(toolRequestId);
          if (!(tool && tool.toolName == "diagnostics")) {
            throw new Error(`could not find tool with id ${toolRequestId}`);
          }

          const diagnosticsTool = tool as unknown as DiagnosticsTool;
          if (diagnosticsTool.state.state != "done") {
            throw new Error(`Request not done`);
          }

          return diagnosticsTool.state.result;
        },
        { timeout: 5000 },
      );

      expect(result).toEqual({
        type: "tool_result",
        id: toolRequestId,
        result: {
          status: "ok",
          value: [
            {
              type: "text",
              text: `file: node/test/fixtures/test.ts source: typescript, severity: 1, message: "Property 'd' does not exist on type '{ c: "test"; }'."`,
            },
          ],
        },
      });
    });
  });
});
