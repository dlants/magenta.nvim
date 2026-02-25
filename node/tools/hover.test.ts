import {
  type ToolRequestId,
  type UnresolvedFilePath,
  type ToolName,
} from "@magenta/core";
import { it, expect } from "vitest";
import { pollForToolResult, withDriver } from "../test/preamble.ts";
it("hover end-to-end", async () => {
  await withDriver({}, async (driver) => {
    await driver.editFileAndWaitForLsp("test.ts");
    await driver.showSidebar();

    await driver.inputMagentaText(`Try hovering a symbol`);
    await driver.send();

    // wait for ts_ls to start/attach
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
            toolName: "hover" as ToolName,
            input: {
              filePath: "test.ts" as UnresolvedFilePath,
              symbol: "val.a.b.c",
            },
          },
        },
      ],
    });

    // After tool completes, thread auto-responds and creates a new stream
    const request2 = await driver.mockAnthropic.awaitPendingStream();
    request2.respond({
      stopReason: "end_turn",
      text: "Got the hover result.",
      toolRequests: [],
    });

    const result = await pollForToolResult(driver, toolRequestId);

    expect(result.type).toBe("tool_result");
    expect(result.id).toBe(toolRequestId);
    expect(result.result.status).toBe("ok");
    const res = result.result as Extract<
      typeof result.result,
      { status: "ok" }
    >;
    expect(res.value).toHaveLength(1);
    expect(res.value[0].type).toBe("text");

    const val0 = res.value[0];
    const text = (val0 as Extract<typeof val0, { type: "text" }>).text;

    expect(text).toBe(`
\`\`\`typescript
(property) c: "test"
\`\`\`


Definition locations:
  test.ts:4:7
`);
  });
});
