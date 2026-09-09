import { describe, expect, it } from "vitest";
import { validateAgainstSchema } from "./validate-schema.ts";

const schema = {
  type: "object",
  properties: {
    start: { type: "string" },
    stop: { type: "string" },
    count: { type: "integer" },
    tags: { type: "array", items: { type: "string" } },
    mode: { type: "string", enum: ["a", "b"] },
  },
  required: ["start"],
  additionalProperties: false,
};

describe("validateAgainstSchema", () => {
  it("accepts a valid object", () => {
    expect(
      validateAgainstSchema(
        { start: "main", count: 2, tags: ["x"], mode: "a" },
        schema,
      ),
    ).toEqual([]);
  });

  it("flags a missing required property", () => {
    const errors = validateAgainstSchema({ stop: "x" }, schema);
    expect(errors.some((e) => e.includes("start"))).toBe(true);
  });

  it("flags a wrong scalar type", () => {
    const errors = validateAgainstSchema({ start: 5 }, schema);
    expect(errors.some((e) => e.includes("expected type string"))).toBe(true);
  });

  it("flags a non-integer for integer", () => {
    const errors = validateAgainstSchema({ start: "m", count: 1.5 }, schema);
    expect(errors.some((e) => e.includes("count"))).toBe(true);
  });

  it("flags array item type mismatches", () => {
    const errors = validateAgainstSchema(
      { start: "m", tags: ["ok", 3] },
      schema,
    );
    expect(errors.some((e) => e.includes("tags[1]"))).toBe(true);
  });

  it("flags an out-of-enum value", () => {
    const errors = validateAgainstSchema({ start: "m", mode: "c" }, schema);
    expect(errors.some((e) => e.includes("mode"))).toBe(true);
  });

  it("flags unexpected properties when additionalProperties is false", () => {
    const errors = validateAgainstSchema({ start: "m", extra: 1 }, schema);
    expect(errors.some((e) => e.includes("extra"))).toBe(true);
  });
});
