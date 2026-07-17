import type { ToolName, ToolRequestId } from "@magenta/core";
import { describe, expect, it } from "vitest";
import { pollForToolResult, withDriver } from "../test/preamble.ts";
import { abridgeScript } from "./scratchpad.ts";

describe("node/render-tools/scratchpad.ts abridgeScript", () => {
  it("truncates lines longer than the preview max length", () => {
    const longLine = `append pos0 ${"x".repeat(200)}`;
    const abridged = abridgeScript(longLine);
    expect(abridged.endsWith("...")).toBe(true);
    expect(abridged.length).toBeLessThan(longLine.length);
  });

  it("collapses scripts longer than the preview max lines", () => {
    const script = Array.from(
      { length: 12 },
      (_v, i) => `append pos${i} value${i}`,
    ).join("\n");
    const abridged = abridgeScript(script);
    const abridgedLines = abridged.split("\n");
    expect(abridgedLines).toHaveLength(6);
    expect(abridgedLines[0]).toBe("append pos0 value0");
    expect(abridgedLines[4]).toBe("append pos4 value4");
    expect(abridgedLines[5]).toBe("... (7 more lines)");
  });
});

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

  it("previews only the last 10 lines of a long streamed script", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText("stream a long scratchpad script");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStreamWithText(
        "stream a long scratchpad script",
      );
      const script = Array.from(
        { length: 15 },
        (_v, i) => `append pos${i} value${i}`,
      ).join("\n");
      const fullInput = JSON.stringify({ script });
      stream.streamToolUsePartial(
        "scratchpad-stream-long" as ToolRequestId,
        "scratchpad" as ToolName,
        [fullInput],
      );
      await stream.settle();
      await driver.assertDisplayBufferContains("📝 scratchpad:");
      await driver.assertDisplayBufferContains("append pos14 value14");
      await driver.assertDisplayBufferContains("append pos5 value5");
      await driver.assertDisplayBufferDoesNotContain("append pos4 value4");
      stream.abort();
    });
  });

  it("does not render a scratchpad preview before the script key streams", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText("stream a partial scratchpad script");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStreamWithText(
        "stream a partial scratchpad script",
      );
      stream.streamToolUsePartial(
        "scratchpad-stream-partial" as ToolRequestId,
        "scratchpad" as ToolName,
        ['{"script"'],
      );
      await stream.settle();
      await driver.assertDisplayBufferDoesNotContain("📝 scratchpad:");
      stream.abort();
    });
  });
});
