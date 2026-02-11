import type { Result } from "../../utils/result.ts";
import type { ProviderToolSpec } from "../../agent/provider-types.ts";
import type { ToolName, GenericToolRequest } from "../types.ts";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const EDL_DESCRIPTION = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "edl-description.md"),
  "utf-8",
);

export type Input = {
  script: string;
};

export type ToolRequest = GenericToolRequest<ToolName, Input>;

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.script !== "string") {
    return {
      status: "error",
      error: "expected req.input.script to be a string",
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}

export const spec: ProviderToolSpec = {
  name: "edl" as ToolName,
  description: EDL_DESCRIPTION,
  input_schema: {
    type: "object",
    properties: {
      script: {
        type: "string",
        description: "The EDL script to execute",
      },
    },
    required: ["script"],
  },
};
