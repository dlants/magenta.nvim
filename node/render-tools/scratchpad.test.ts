import type { ToolName, ToolRequestId } from "@magenta/core";
import { describe, expect, it } from "vitest";
import { pollForToolResult, withDriver } from "../test/preamble.ts";

describe("node/render-tools/scratchpad.test.ts", () => {
  it("renders the scratchpad summary and script input", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText("track something");
      await driver.send();

      const toolRequestId = "scratchpad-1" as ToolRequestId;
      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "ok",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "scratchpad" as ToolName,
              input: { script: "append pos0 hello\nappend pos1 world" },
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

      await driver.assertDisplayBufferContains("📝 scratchpad");
      await driver.assertDisplayBufferContains("append pos0 hello");
    });
  });

  it("renders a streamed scratchpad script preview", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText("stream a scratchpad script");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStreamWithText(
        "stream a scratchpad script",
      );
      const fullInput = JSON.stringify({
        script: "append pos0 streamed-value",
      });
      stream.streamToolUsePartial(
        "scratchpad-stream" as ToolRequestId,
        "scratchpad" as ToolName,
        [fullInput],
      );
      await stream.settle();
      await driver.assertDisplayBufferContains("📝 scratchpad:");
      await driver.assertDisplayBufferContains("append pos0 streamed-value");
      stream.abort();
    });
  });
});
