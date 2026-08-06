import type { ToolName, ToolRequestId } from "@magenta/core";
import { describe, expect, it } from "vitest";
import { pollForToolResult, withDriver } from "../test/preamble.ts";

describe("node/render-tools/edl.ts", () => {
  it("renders each failed command when a select fails", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText("edit the poem");
      await driver.send();

      const toolRequestId = "edl-fail" as ToolRequestId;
      const script = [
        "file `poem.txt`",
        "select /nonexistent-pattern/",
        'replace "X"',
        "delete",
      ].join("\n");

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "ok",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "edl" as ToolName,
              input: { script },
            },
          },
        ],
      });

      const request2 = await driver.mockAnthropic.awaitPendingStream();
      request2.respond({
        stopReason: "end_turn",
        text: "done",
        toolRequests: [],
      });

      const result = await pollForToolResult(driver, toolRequestId);
      expect(result.result.status).toBe("ok");

      await driver.assertDisplayBufferContains("3 commands failed");
      await driver.assertDisplayBufferContains("select /nonexistent-pattern/");
      await driver.assertDisplayBufferContains('replace "X"');
    });
  });
});
