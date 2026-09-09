import type {
  ProviderToolResult,
  ToolName,
  ToolRequestId,
} from "@magenta/server";
import { expect, it } from "vitest";
import { pollForToolResult, withDriver } from "../test/preamble.ts";

function okText(result: ProviderToolResult): string {
  expect(result.result.status).toBe("ok");
  const res = result.result as Extract<typeof result.result, { status: "ok" }>;
  expect(res.value).toHaveLength(1);
  const val0 = res.value[0];
  return (val0 as Extract<typeof val0, { type: "text" }>).text;
}

it("nvim_lua evaluates code and returns the result", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("run some lua");
    await driver.send();

    const toolRequestId = "lua-1" as ToolRequestId;
    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "ok",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: toolRequestId,
            toolName: "nvim_lua" as ToolName,
            input: { code: "return 1 + 2" },
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
    expect(okText(result)).toBe("3");
  });
});

it("nvim_lua handles a nil return value", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("run some lua");
    await driver.send();

    const toolRequestId = "lua-nil" as ToolRequestId;
    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "ok",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: toolRequestId,
            toolName: "nvim_lua" as ToolName,
            input: { code: "local x = 1" },
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
    expect(okText(result)).toBe("Executed successfully, no return value.");
  });
});

it("nvim_lua side effects are observable in neovim", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("run some lua");
    await driver.send();

    const toolRequestId = "lua-2" as ToolRequestId;
    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "ok",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: toolRequestId,
            toolName: "nvim_lua" as ToolName,
            input: {
              code: "vim.g.magenta_test = 42\nreturn vim.g.magenta_test",
            },
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
    expect(okText(result)).toBe("42");

    const value = await driver.nvim.call("nvim_exec_lua", [
      "return vim.g.magenta_test",
      [],
    ]);
    expect(value).toBe(42);
  });
});

it("nvim_lua surfaces Lua errors as error results", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("run some lua");
    await driver.send();

    const toolRequestId = "lua-3" as ToolRequestId;
    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "ok",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: toolRequestId,
            toolName: "nvim_lua" as ToolName,
            input: { code: "error('boom')" },
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
    expect(result.result.status).toBe("error");
    const res = result.result as Extract<
      typeof result.result,
      { status: "error" }
    >;
    expect(res.error).toContain("boom");
  });
});
