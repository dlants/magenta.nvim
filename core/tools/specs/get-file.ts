import type { Result } from "../../utils/result.ts";
import type { ProviderToolSpec } from "../../agent/provider-types.ts";
import type { ToolName, GenericToolRequest } from "../types.ts";
import type { UnresolvedFilePath } from "../../utils/files.ts";

const GET_FILE_DESCRIPTION = `Get the full contents of a given file. The file will be added to the thread context.
If a file is part of your context, avoid using get_file on it again, since you will get notified about any future changes about the file.

Supports:
- Text files (source code, markdown, JSON, XML, etc.) - added to context for tracking changes
- Images (JPEG, PNG, GIF, WebP) - returned as base64 encoded content
- PDF documents - returned as base64 encoded content

For large text files, content may be truncated. Use startLine and numLines to navigate.
Very long lines (>2000 chars) will be abridged.

File size limits: 1MB for text files, 10MB for images, 32MB for PDFs.`;

export type Input = {
  filePath: UnresolvedFilePath;
  force?: boolean;
  pdfPage?: number;
  startLine?: number;
  numLines?: number;
};

export type ToolRequest = GenericToolRequest<ToolName, Input>;

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.filePath != "string") {
    return {
      status: "error",
      error: "expected req.input.filePath to be a string",
    };
  }

  if (input.force !== undefined && typeof input.force !== "boolean") {
    return {
      status: "error",
      error: "expected req.input.force to be a boolean",
    };
  }

  if (input.pdfPage !== undefined && typeof input.pdfPage !== "number") {
    return {
      status: "error",
      error: "expected req.input.pdfPage to be a number",
    };
  }

  if (
    input.pdfPage !== undefined &&
    (input.pdfPage < 1 || !Number.isInteger(input.pdfPage))
  ) {
    return {
      status: "error",
      error:
        "expected req.input.pdfPage to be a positive integer (1-indexed page number)",
    };
  }

  if (input.startLine !== undefined && typeof input.startLine !== "number") {
    return {
      status: "error",
      error: "expected req.input.startLine to be a number",
    };
  }

  if (
    input.startLine !== undefined &&
    (input.startLine < 1 || !Number.isInteger(input.startLine))
  ) {
    return {
      status: "error",
      error:
        "expected req.input.startLine to be a positive integer (1-indexed line number)",
    };
  }

  if (input.numLines !== undefined && typeof input.numLines !== "number") {
    return {
      status: "error",
      error: "expected req.input.numLines to be a number",
    };
  }

  if (
    input.numLines !== undefined &&
    (input.numLines < 1 || !Number.isInteger(input.numLines))
  ) {
    return {
      status: "error",
      error: "expected req.input.numLines to be a positive integer",
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}

export const spec: ProviderToolSpec = {
  name: "get_file" as ToolName,
  description: GET_FILE_DESCRIPTION,
  input_schema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: `The path of the file. Prefer absolute paths (e.g. "/Users/name/project/src/index.ts"). Relative paths are resolved from the project root.`,
      },
      force: {
        type: "boolean",
        description:
          "If true, get the full file contents even if the file is already part of the context.",
      },
      pdfPage: {
        type: "number",
        description:
          "For PDF files, you can use this 1-indexed parameter to fetch the given page of the file.\nOmitting this parameter for pdf files returns just the summary of the pdf.",
      },
      startLine: {
        type: "number",
        description:
          "1-indexed line number to start reading from. If omitted, starts from line 1.",
      },
      numLines: {
        type: "number",
        description:
          "Number of lines to return. If omitted, returns as many lines as fit within the token limit.",
      },
    },
    required: ["filePath"],
  },
};