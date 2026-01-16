import { type ToolRequestId } from "./toolManager.ts";
import { it, expect } from "vitest";
import { withDriver } from "../test/preamble";
import { pollUntil } from "../utils/async.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { GotoDefinitionTool } from "./gotoDefinition.ts";
import type { ToolName } from "./types.ts";
import path from "path";
import fs from "fs";

it("goto_definition end-to-end", async () => {
  await withDriver({}, async (driver) => {
    await driver.editFile("test.ts");
    await driver.showSidebar();

    await driver.inputMagentaText(`Find the definition of a symbol`);
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
            toolName: "goto_definition" as ToolName,
            input: {
              filePath: "test.ts" as UnresolvedFilePath,
              symbol: "val",
            },
          },
        },
      ],
    });

    const result = await pollUntil(
      () => {
        const thread = driver.magenta.chat.getActiveThread();
        if (!thread || !thread.state || typeof thread.state !== "object") {
          throw new Error("Thread state is not valid");
        }

        const tool = thread.toolManager.getTool(toolRequestId);
        if (!(tool && tool.toolName == "goto_definition")) {
          throw new Error(`could not find tool with id ${toolRequestId}`);
        }

        const gotoDefTool = tool as unknown as GotoDefinitionTool;
        if (gotoDefTool.state.state != "done") {
          throw new Error(`Request not done`);
        }

        return gotoDefTool.state.result;
      },
      { timeout: 5000 },
    );

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

    expect(text).toContain("Definition at test.ts:");
    expect(text).toContain("const val");
  });
});

it("goto_definition symbol not found", async () => {
  await withDriver({}, async (driver) => {
    const testFilePath = path.join(driver.magenta.cwd, "test.ts");
    await fs.promises.writeFile(testFilePath, "const foo = 'bar';");

    await driver.showSidebar();

    await driver.inputMagentaText(`Find definition of nonexistent symbol`);
    await driver.send();

    const toolRequestId = "id2" as ToolRequestId;
    const request = await driver.mockAnthropic.awaitPendingRequest();
    request.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: toolRequestId,
            toolName: "goto_definition" as ToolName,
            input: {
              filePath: "test.ts" as UnresolvedFilePath,
              symbol: "nonexistent",
            },
          },
        },
      ],
    });

    const result = await pollUntil(
      () => {
        const thread = driver.magenta.chat.getActiveThread();
        if (!thread || !thread.state || typeof thread.state !== "object") {
          throw new Error("Thread state is not valid");
        }

        const tool = thread.toolManager.getTool(toolRequestId);
        if (!(tool && tool.toolName == "goto_definition")) {
          throw new Error(`could not find tool with id ${toolRequestId}`);
        }

        const gotoDefTool = tool as unknown as GotoDefinitionTool;
        if (gotoDefTool.state.state != "done") {
          throw new Error(`Request not done`);
        }

        return gotoDefTool.state.result;
      },
      { timeout: 5000 },
    );

    expect(result.type).toBe("tool_result");
    expect(result.id).toBe(toolRequestId);
    expect(result.result.status).toBe("error");
    const res = result.result as Extract<
      typeof result.result,
      { status: "error" }
    >;
    expect(res.error).toBe('Symbol "nonexistent" not found in file.');
  });
});
