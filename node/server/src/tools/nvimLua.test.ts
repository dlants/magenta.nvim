import { describe, expect, it } from "vitest";
import type { LuaExecutor } from "../capabilities/lua-executor.ts";
import type { ExecutedToolResult, ToolRequestId } from "../tool-types.ts";
import * as NvimLua from "./nvimLua.ts";

function createTool(code: string, executor: LuaExecutor) {
  return NvimLua.execute(
    {
      id: "tool_1" as ToolRequestId,
      toolName: "nvim_lua",
      input: { code },
    },
    { luaExecutor: executor },
  );
}

async function getResultText(invocation: {
  promise: Promise<ExecutedToolResult>;
}): Promise<{ status: string; text: string }> {
  const { result } = await invocation.promise;
  if (result.status === "ok") {
    return {
      status: "ok",
      text: (result.value[0] as { type: "text"; text: string }).text,
    };
  }
  return { status: "error", text: result.error };
}

describe("nvimLua unit tests", () => {
  it("serializes a table return value", async () => {
    const executor: LuaExecutor = {
      execLua: () => Promise.resolve({ a: 1, b: [2, 3] }),
    };
    const result = await getResultText(createTool("return {}", executor));
    expect(result.status).toBe("ok");
    expect(JSON.parse(result.text)).toEqual({ a: 1, b: [2, 3] });
  });

  it("reports a no-return-value message for undefined", async () => {
    const executor: LuaExecutor = {
      execLua: () => Promise.resolve(undefined),
    };
    const result = await getResultText(createTool("vim.g.x = 1", executor));
    expect(result.status).toBe("ok");
    expect(result.text).toContain("no return value");
  });

  it("reports a no-return-value message for null", async () => {
    const executor: LuaExecutor = {
      execLua: () => Promise.resolve(null),
    };
    const result = await getResultText(createTool("return nil", executor));
    expect(result.status).toBe("ok");
    expect(result.text).toContain("no return value");
  });

  it("returns an error result when execLua rejects", async () => {
    const executor: LuaExecutor = {
      execLua: () => Promise.reject(new Error("boom")),
    };
    const result = await getResultText(createTool("error('boom')", executor));
    expect(result.status).toBe("error");
    expect(result.text).toContain("boom");
  });

  it("returns an aborted error when abort is called before resolve", async () => {
    let resolve!: (value: unknown) => void;
    const executor: LuaExecutor = {
      execLua: () => new Promise((r) => (resolve = r)),
    };
    const invocation = createTool("return 1", executor);
    invocation.abort();
    resolve({ a: 1 });
    const result = await getResultText(invocation);
    expect(result.status).toBe("error");
    expect(result.text).toContain("aborted");
  });

  it("returns an aborted error when abort is called before reject", async () => {
    let reject!: (error: unknown) => void;
    const executor: LuaExecutor = {
      execLua: () => new Promise((_, r) => (reject = r)),
    };
    const invocation = createTool("error('boom')", executor);
    invocation.abort();
    reject(new Error("boom"));
    const result = await getResultText(invocation);
    expect(result.status).toBe("error");
    expect(result.text).toContain("aborted");
  });

  it("falls back to String() for non-serializable return values", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const executor: LuaExecutor = {
      execLua: () => Promise.resolve(circular),
    };
    const result = await getResultText(createTool("return {}", executor));
    expect(result.status).toBe("ok");
    expect(result.text).toContain("[object Object]");
  });

  it("validateInput rejects non-string code", () => {
    expect(NvimLua.validateInput({ code: 42 }).status).toBe("error");
    expect(NvimLua.validateInput({ code: "return 1" }).status).toBe("ok");
  });
});
