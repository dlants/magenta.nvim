import { describe, it, expect } from "vitest";
import * as YieldToParent from "./yield-to-parent.ts";
import type { ToolRequestId } from "../tool-types.ts";

describe("yield-to-parent unit tests", () => {
  it("returns result text as tool result", async () => {
    const invocation = YieldToParent.execute({
      id: "tool_1" as ToolRequestId,
      toolName: "yield_to_parent" as const,
      input: { result: "the answer" },
    });

    const result = await invocation.promise;
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      expect(result.result.value).toEqual([
        { type: "text", text: "the answer" },
      ]);
    }
  });

  it("resolves synchronously (promise is already resolved)", async () => {
    const invocation = YieldToParent.execute({
      id: "tool_1" as ToolRequestId,
      toolName: "yield_to_parent" as const,
      input: { result: "immediate" },
    });

    // Promise.resolve() creates an already-resolved promise,
    // so we can race it against a sentinel to verify it's instant
    const sentinel = Symbol("not-resolved");
    const raceResult = await Promise.race([
      invocation.promise,
      Promise.resolve(sentinel),
    ]);

    // Both are already resolved, but the first one wins in Promise.race
    // when both are microtask-resolved. The key check is that it doesn't hang.
    expect(raceResult).not.toBe(sentinel);
  });

  it("abort is a no-op", async () => {
    const invocation = YieldToParent.execute({
      id: "tool_1" as ToolRequestId,
      toolName: "yield_to_parent" as const,
      input: { result: "still works" },
    });

    invocation.abort();

    const result = await invocation.promise;
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      expect(result.result.value).toEqual([
        { type: "text", text: "still works" },
      ]);
    }
  });
});
