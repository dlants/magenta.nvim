import { describe, expect, it } from "vitest";
import type { ProviderToolSpec } from "../providers/provider-types.ts";
import type { ToolName } from "../tool-types.ts";
import { formatToolSpecs } from "./format-tool-spec.ts";

describe("formatToolSpecs", () => {
  const spec: ProviderToolSpec = {
    name: "demo_tool" as ToolName,
    description: "Line one.\nLine two of the description.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The path.\nWith a second line.",
        },
        mode: {
          type: "string",
          enum: ["read", "write"],
        },
        tags: {
          type: "array",
          items: {
            type: "string",
            description: "A single tag.",
          },
        },
        nested: {
          type: "object",
          properties: {
            inner: {
              type: "number",
              description: "An inner field.",
            },
          },
          required: ["inner"],
        },
      },
      required: ["path"],
    },
  };

  it("renders descriptions with real newlines", () => {
    const output = formatToolSpecs([spec]);
    expect(output).not.toContain("\\n");
    expect(output).toContain("## demo_tool");
    expect(output).toContain("Line one.\nLine two of the description.");
    expect(output).toContain("The path.\n");
    expect(output).toContain("With a second line.");
    expect(output).toContain("path, required:");
    expect(output).toContain("mode:");
    expect(output).toContain('enum("read", "write")');
    expect(output).toContain("items:");
    expect(output).toContain("inner, required:");
    expect(output).toContain("An inner field.");
  });
});
