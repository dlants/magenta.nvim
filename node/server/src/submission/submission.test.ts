import { describe, expect, it } from "vitest";
import { parseCompact, parseDelivery, pendingMessage } from "./index.ts";

describe("parseDelivery", () => {
  it("treats bare text as an immediate send", () => {
    expect(parseDelivery("hello there")).toEqual({
      delivery: "now",
      message: "hello there",
    });
  });
  it("recognizes @async and @next, stripping the prefix", () => {
    expect(parseDelivery("@async keep going")).toEqual({
      delivery: "async",
      message: "keep going",
    });
    expect(parseDelivery("@next then this")).toEqual({
      delivery: "next",
      message: "then this",
    });
  });
  it("leaves @compact in the message for the delivery-time pass", () => {
    expect(parseDelivery("@next @compact do the thing")).toEqual({
      delivery: "next",
      message: "@compact do the thing",
    });
  });
  it("only treats a prefix at the start as significant", () => {
    expect(parseDelivery("please run @async later")).toMatchObject({
      delivery: "now",
    });
  });
});

describe("parseCompact", () => {
  it("recognizes @compact, with and without a follow-up prompt", () => {
    expect(parseCompact(pendingMessage("@compact"))).toEqual({
      compact: true,
      rest: "",
    });
    expect(parseCompact(pendingMessage("@compact now do it"))).toEqual({
      compact: true,
      rest: "now do it",
    });
  });
  it("leaves other text alone", () => {
    expect(parseCompact(pendingMessage("@compactor is a tool"))).toEqual({
      compact: false,
      rest: "@compactor is a tool",
    });
  });
});
