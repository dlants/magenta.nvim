import { describe, expect, it } from "vitest";
import { parseSubmission } from "./index.ts";

describe("parseSubmission", () => {
  it("treats bare text as an immediate send", () => {
    expect(parseSubmission("hello there")).toEqual({
      type: "send",
      delivery: "now",
      message: {
        text: "hello there",
        parts: [{ type: "text", text: "hello there" }],
      },
    });
  });

  it("recognizes @async and @next, stripping the prefix", () => {
    const asyncIntent = parseSubmission("@async keep going");
    expect(asyncIntent).toMatchObject({ delivery: "async" });
    expect(asyncIntent.type === "send" && asyncIntent.message.text).toBe(
      "keep going",
    );
    const nextIntent = parseSubmission("@next then this");
    expect(nextIntent).toMatchObject({ delivery: "next" });
    expect(nextIntent.type === "send" && nextIntent.message.text).toBe(
      "then this",
    );
  });

  it("recognizes @compact, with and without a follow-up prompt", () => {
    expect(parseSubmission("@compact")).toEqual({
      type: "compact",
      nextPrompt: undefined,
    });
    const withPrompt = parseSubmission("@compact now do the thing");
    expect(withPrompt.type === "compact" && withPrompt.nextPrompt?.text).toBe(
      "now do the thing",
    );
  });

  it("drops a delivery prefix on a compaction's follow-up prompt", () => {
    const intent = parseSubmission("@compact @async now do the thing");
    expect(intent.type === "compact" && intent.nextPrompt?.text).toBe(
      "now do the thing",
    );
  });

  it("only treats a prefix at the start as significant", () => {
    const intent = parseSubmission("please run @async later");
    expect(intent).toMatchObject({ delivery: "now" });
    const notACommand = parseSubmission("@compactor is a tool");
    expect(notACommand).toMatchObject({ type: "send", delivery: "now" });
  });
});
