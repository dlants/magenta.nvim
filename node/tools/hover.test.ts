import { type ToolRequestId } from "./toolManager.ts";
import { it, expect } from "vitest";
import { pollForToolResult, withDriver } from "../test/preamble";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { ToolName } from "./types.ts";
import path from "path";
import fs from "fs";

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

it("hover with word boundaries", async () => {
  await withDriver({}, async (driver) => {
    // Create a test file with both "Transport" and "AutoTransport"
    const testFilePath = path.join(driver.magenta.cwd, "test.ts");
    await fs.promises.writeFile(
      testFilePath,
      "interface Transport { id: string; }\n" +
        "interface AutoTransport extends Transport { auto: boolean; }\n" +
        "const t: Transport = { id: '1' };\n" +
        "const at: AutoTransport = { id: '2', auto: true };",
    );

    await driver.editFileAndWaitForLsp("test.ts");
    await driver.showSidebar();

    await driver.inputMagentaText(`Try hovering Transport`);
    await driver.send();

    const toolRequestId = "id2" as ToolRequestId;
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
              symbol: "Transport",
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

    // Should hover on the first "Transport" (line 1), not "AutoTransport" (line 2)
    expect(text).toContain("interface Transport");
    expect(text).toContain("Definition locations:");
    expect(text).toContain("test.ts:1:"); // First line where "Transport" is defined
    expect(text).not.toContain("AutoTransport"); // Should not hover on "AutoTransport"
  });
});

it("hover with context disambiguation", async () => {
  await withDriver({}, async (driver) => {
    // Create a test file with multiple instances of "res"
    const testFilePath = path.join(driver.magenta.cwd, "test.ts");
    await fs.promises.writeFile(
      testFilePath,
      "{\n" +
        "  const res = request1()\n" +
        "}\n" +
        "\n" +
        "{\n" +
        "  const res = request2()\n" +
        "}\n",
    );

    await driver.editFileAndWaitForLsp("test.ts");
    await driver.showSidebar();

    await driver.inputMagentaText(`Try hovering res with context`);
    await driver.send();

    const toolRequestId = "id3" as ToolRequestId;
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
              symbol: "res",
              context: "  const res = request2()",
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

    // Should hover on the second "res" (line 6), not the first (line 2)
    expect(text).toContain("Definition locations:");
    expect(text).toContain("test.ts:6:"); // Sixth line where the second "res" is defined
    expect(text).not.toContain("test.ts:2:"); // Should not hover on first "res"
  });
});

it("hover with context not found", async () => {
  await withDriver({}, async (driver) => {
    const testFilePath = path.join(driver.magenta.cwd, "test.ts");
    await fs.promises.writeFile(testFilePath, "const foo = 'bar';");

    await driver.showSidebar();

    await driver.inputMagentaText(`Try hovering with invalid context`);
    await driver.send();

    const toolRequestId = "id4" as ToolRequestId;
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
              symbol: "foo",
              context: "nonexistent context",
            },
          },
        },
      ],
    });

    // After tool completes, thread auto-responds and creates a new stream
    const request2 = await driver.mockAnthropic.awaitPendingStream();
    request2.respond({
      stopReason: "end_turn",
      text: "Got an error from hover.",
      toolRequests: [],
    });

    const result = await pollForToolResult(driver, toolRequestId);

    expect(result.type).toBe("tool_result");
    expect(result.id).toBe(toolRequestId);
    expect(result.result.status).toBe("error");
    const res = result.result as Extract<
      typeof result.result,
      { status: "error" }
    >;
    expect(res.error).toBe('Context "nonexistent context" not found in file.');
  });
});
