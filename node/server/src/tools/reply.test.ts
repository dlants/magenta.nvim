import { describe, expect, it } from "vitest";
import { CommentStore } from "../context/comment-store.ts";
import type { ToolRequestId } from "../tool-types.ts";
import * as Reply from "./reply.ts";

describe("reply validateInput", () => {
  it("accepts a well formed batch", () => {
    expect(
      Reply.validateInput({ replies: [{ commentId: "c1", text: "hi" }] }),
    ).toEqual({
      status: "ok",
      value: { replies: [{ commentId: "c1", text: "hi" }] },
    });
  });

  it("rejects a missing or non-array replies", () => {
    expect(Reply.validateInput({}).status).toEqual("error");
    expect(Reply.validateInput({ replies: "c1" }).status).toEqual("error");
  });

  it("rejects a non-object entry", () => {
    expect(Reply.validateInput({ replies: ["c1"] }).status).toEqual("error");
    expect(Reply.validateInput({ replies: [null] }).status).toEqual("error");
  });

  it("rejects a non-string commentId or text", () => {
    expect(
      Reply.validateInput({ replies: [{ commentId: 3, text: "hi" }] }).status,
    ).toEqual("error");
    expect(
      Reply.validateInput({ replies: [{ commentId: "c1" }] }).status,
    ).toEqual("error");
  });
});

describe("reply execute", () => {
  it("returns a non-empty result for an empty batch", async () => {
    const invocation = Reply.execute(
      {
        id: "tool_1" as ToolRequestId,
        toolName: "reply",
        input: { replies: [] },
      },
      { commentStore: new CommentStore() },
    );
    const { result } = await invocation.promise;
    if (result.status !== "ok") {
      throw new Error("expected ok");
    }
    expect((result.value[0] as { text: string }).text).toEqual(
      "No replies were provided.",
    );
    expect(result.structuredResult).toEqual({ toolName: "reply", replies: [] });
  });
});
