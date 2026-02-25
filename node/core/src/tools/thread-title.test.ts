import { describe, it, expect } from "vitest";
import * as ThreadTitle from "./thread-title.ts";
import type { ToolRequestId } from "../tool-types.ts";

describe("thread-title unit tests", () => {
  it("returns title as tool result text", async () => {
    const invocation = ThreadTitle.execute(
      {
        id: "tool_1" as ToolRequestId,
        toolName: "thread_title" as const,
        input: { title: "My Title" },
      },
      {},
    );

    const result = await invocation.promise;
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      expect(result.result.value[0]).toEqual({
        type: "text",
        text: "My Title",
      });
    }
  });

  it("abort returns error", async () => {
    const invocation = ThreadTitle.execute(
      {
        id: "tool_2" as ToolRequestId,
        toolName: "thread_title" as const,
        input: { title: "Some Title" },
      },
      {},
    );

    invocation.abort();
    const result = await invocation.promise;
    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("aborted");
    }
  });
});
