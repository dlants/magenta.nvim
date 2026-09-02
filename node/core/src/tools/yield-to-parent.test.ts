import { describe, expect, it } from "vitest";
import type { ToolRequestId } from "../tool-types.ts";
import * as YieldToParent from "./yield-to-parent.ts";

describe("yield-to-parent unit tests", () => {
  it("acknowledges on the wire and publishes the input structurally", async () => {
    const invocation = YieldToParent.execute({
      id: "tool_1" as ToolRequestId,
      toolName: "yield_to_parent" as const,
      input: { result: "the answer" },
    });

    const { result } = await invocation.promise;
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value).toMatchObject([
        { type: "text", text: "Yield acknowledged." },
      ]);
      expect(result.structuredResult).toEqual({
        toolName: "yield_to_parent",
        input: { result: "the answer" },
      });
    }
  });

  it("publishes a schema'd input verbatim", async () => {
    const input = { verdict: "approve", score: 7, notes: ["a", "b"] };
    const invocation = YieldToParent.execute({
      id: "tool_1" as ToolRequestId,
      toolName: "yield_to_parent" as const,
      input,
    });

    const { result } = await invocation.promise;
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.structuredResult).toEqual({
        toolName: "yield_to_parent",
        input,
      });
      expect(JSON.stringify(result.value)).not.toContain("approve");
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

    const { result } = await invocation.promise;
    expect(result.status).toBe("ok");
  });
});
