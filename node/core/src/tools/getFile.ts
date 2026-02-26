import type { FileIO } from "../capabilities/file-io.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";

import { type Result } from "../utils/result.ts";
import type {
  ProviderToolResult,
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider-types.ts";
import {
  resolveFilePath,
  type UnresolvedFilePath,
  detectFileTypeViaFileIO,
  FileCategory,
  FILE_SIZE_LIMITS,
  type NvimCwd,
  type HomeDir,
} from "../utils/files.ts";
import type {
  ToolName,
  GenericToolRequest,
  ToolInvocation,
} from "../tool-types.ts";
import type {
  ContextTracker,
  OnToolApplied,
} from "../capabilities/context-tracker.ts";

import {
  extractPDFPage,
  getSummaryAsProviderContent,
} from "../utils/pdf-pages.ts";

import { summarizeFile, formatSummary } from "../utils/file-summary.ts";

export type ToolRequest = GenericToolRequest<"get_file", Input>;

const MAX_FILE_CHARACTERS = 40000;
const MAX_LINE_CHARACTERS = 2000;
const DEFAULT_LINES_FOR_LARGE_FILE = 100;

function processTextContentStandalone(
  lines: string[],
  startIndex: number,
  requestedNumLines: number | undefined,
  summaryText?: string,
): { text: string; isComplete: boolean; hasAbridgedLines: boolean } {
  const totalLines = lines.length;
  const totalChars = lines.reduce((sum, line) => sum + line.length + 1, 0);

  const isLargeFile =
    requestedNumLines === undefined && totalChars > MAX_FILE_CHARACTERS;

  if (isLargeFile && summaryText) {
    return {
      text: summaryText,
      isComplete: false,
      hasAbridgedLines: false,
    };
  }

  let hasAbridgedLines = false;
  const outputLines: string[] = [];

  let effectiveNumLines: number | undefined;
  if (isLargeFile) {
    effectiveNumLines = DEFAULT_LINES_FOR_LARGE_FILE;
  } else {
    effectiveNumLines = requestedNumLines;
  }

  const maxLinesToProcess =
    effectiveNumLines !== undefined
      ? Math.min(startIndex + effectiveNumLines, totalLines)
      : totalLines;

  for (let i = startIndex; i < maxLinesToProcess; i++) {
    let line = lines[i];

    if (line.length > MAX_LINE_CHARACTERS) {
      const halfMax = Math.floor(MAX_LINE_CHARACTERS / 2);
      line = `${line.slice(0, halfMax)}... [${line.length - MAX_LINE_CHARACTERS} chars omitted] ...${line.slice(-halfMax)}`;
      hasAbridgedLines = true;
    }

    outputLines.push(line);
  }

  const endIndex = startIndex + outputLines.length;
  const isComplete =
    startIndex === 0 && endIndex === totalLines && !hasAbridgedLines;

  let text = outputLines.join("\n");

  if (!isComplete || startIndex > 0 || endIndex < totalLines) {
    const header = `[Lines ${startIndex + 1}-${endIndex} of ${totalLines}]${hasAbridgedLines ? " (some lines abridged)" : ""}\n\n`;
    text = header + text;

    if (endIndex < totalLines) {
      text += `\n\n[${totalLines - endIndex} more lines not shown. Use startLine=${endIndex + 1} to continue.]`;
    }
  }

  return { text, isComplete, hasAbridgedLines };
}

export function execute(
  request: ToolRequest,
  context: {
    cwd: NvimCwd;
    homeDir: HomeDir;
    fileIO: FileIO;
    contextTracker: ContextTracker;
    onToolApplied: OnToolApplied;
  },
): ToolInvocation {
  let aborted = false;

  const abortResult: ProviderToolResult = {
    type: "tool_result",
    id: request.id,
    result: { status: "error", error: "Request was aborted by the user." },
  };

  const promise = (async (): Promise<ProviderToolResult> => {
    try {
      const filePath = request.input.filePath;
      const absFilePath = resolveFilePath(
        context.cwd,
        filePath,
        context.homeDir,
      );

      const hasLineParams =
        request.input.startLine !== undefined ||
        request.input.numLines !== undefined;

      if (
        context.contextTracker.files[absFilePath] &&
        !request.input.force &&
        request.input.pdfPage === undefined &&
        !hasLineParams
      ) {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "ok",
            value: [
              {
                type: "text",
                text: `This file is already part of the thread context. \
You already have the most up-to-date information about the contents of this file.`,
              },
            ],
          },
        };
      }

      const fileTypeInfo = await detectFileTypeViaFileIO(
        absFilePath,
        context.fileIO,
      );
      if (aborted) return abortResult;

      if (!fileTypeInfo) {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: `File ${filePath} does not exist.`,
          },
        };
      }

      if (fileTypeInfo.category === FileCategory.UNSUPPORTED) {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: `Unsupported file type: ${fileTypeInfo.mimeType}. Supported types: text files, images (JPEG, PNG, GIF, WebP), and PDF documents.`,
          },
        };
      }

      const statResult = await context.fileIO.stat(absFilePath);
      if (aborted) return abortResult;
      const actualSize = statResult?.size ?? 0;
      const maxSize =
        fileTypeInfo.category === FileCategory.TEXT
          ? Infinity
          : fileTypeInfo.category === FileCategory.IMAGE
            ? FILE_SIZE_LIMITS.IMAGE
            : fileTypeInfo.category === FileCategory.PDF
              ? FILE_SIZE_LIMITS.PDF
              : 0;

      if (actualSize > maxSize) {
        const sizeMB = (actualSize / (1024 * 1024)).toFixed(2);
        const maxSizeMB = (maxSize / (1024 * 1024)).toFixed(2);
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: `File too large: ${sizeMB}MB (max ${maxSizeMB}MB for ${fileTypeInfo.category} files)`,
          },
        };
      }

      let result: ProviderToolResultContent[];

      if (fileTypeInfo.category === FileCategory.TEXT) {
        const rawContent = await context.fileIO.readFile(absFilePath);
        if (aborted) return abortResult;

        const lines = rawContent.split("\n");
        const totalLines = lines.length;
        const startLine = request.input.startLine ?? 1;
        const startIndex = startLine - 1;

        if (startIndex >= totalLines) {
          return {
            type: "tool_result",
            id: request.id,
            result: {
              status: "error",
              error: `startLine ${startLine} is beyond end of file (${totalLines} lines)`,
            },
          };
        }

        const totalChars = lines.reduce(
          (sum, line) => sum + line.length + 1,
          0,
        );
        const isLargeFile =
          request.input.numLines === undefined &&
          totalChars > MAX_FILE_CHARACTERS;

        let summaryText: string | undefined;
        if (isLargeFile && startIndex === 0) {
          const content = lines.join("\n");
          const summary = summarizeFile(content, {
            charBudget: MAX_FILE_CHARACTERS,
          });
          summaryText = formatSummary(summary);
        }

        const processedResult = processTextContentStandalone(
          lines,
          startIndex,
          request.input.numLines,
          summaryText,
        );

        if (
          processedResult.isComplete &&
          !processedResult.hasAbridgedLines &&
          startIndex === 0
        ) {
          context.onToolApplied(
            absFilePath,
            { type: "get-file", content: lines.join("\n") },
            fileTypeInfo,
          );
        }

        result = [{ type: "text", text: processedResult.text }];
      } else if (fileTypeInfo.category === FileCategory.PDF) {
        const existingFileInfo = context.contextTracker.files[absFilePath];
        const agentView = existingFileInfo?.agentView;

        if (request.input.pdfPage !== undefined) {
          if (
            agentView?.type === "pdf" &&
            agentView.pages.includes(request.input.pdfPage)
          ) {
            return {
              type: "tool_result",
              id: request.id,
              result: {
                status: "ok",
                value: [
                  {
                    type: "text",
                    text: `Page ${request.input.pdfPage} of ${filePath} has already been provided to you in this conversation.`,
                  },
                ],
              },
            };
          }

          const pageResult = await extractPDFPage(
            absFilePath,
            request.input.pdfPage,
          );
          if (aborted) return abortResult;

          if (pageResult.status === "error") {
            return {
              type: "tool_result",
              id: request.id,
              result: { status: "error", error: pageResult.error },
            };
          }

          result = [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: Buffer.from(pageResult.value).toString("base64"),
              },
              title: `${filePath} - Page ${request.input.pdfPage}`,
            },
          ];

          context.onToolApplied(
            absFilePath,
            {
              type: "get-file-pdf",
              content: { type: "page", pdfPage: request.input.pdfPage },
            },
            fileTypeInfo,
          );
        } else {
          if (agentView?.type === "pdf" && agentView.summary) {
            return {
              type: "tool_result",
              id: request.id,
              result: {
                status: "ok",
                value: [
                  {
                    type: "text",
                    text: `The summary information for ${filePath} has already been provided to you in this conversation.`,
                  },
                ],
              },
            };
          }

          const pageCountResult =
            await getSummaryAsProviderContent(absFilePath);
          if (aborted) return abortResult;

          if (pageCountResult.status === "error") {
            return {
              type: "tool_result",
              id: request.id,
              result: { status: "error", error: pageCountResult.error },
            };
          }

          context.onToolApplied(
            absFilePath,
            { type: "get-file-pdf", content: { type: "summary" } },
            fileTypeInfo,
          );

          result = pageCountResult.value;
        }
      } else {
        const buffer = await context.fileIO.readBinaryFile(absFilePath);
        if (aborted) return abortResult;

        const statResult = await context.fileIO.stat(absFilePath);
        if (aborted) return abortResult;

        const mtime = statResult?.mtimeMs ?? Date.now();

        context.onToolApplied(
          absFilePath,
          { type: "get-file-binary", mtime },
          fileTypeInfo,
        );

        const base64Data = buffer.toString("base64");

        switch (fileTypeInfo.category) {
          case FileCategory.IMAGE:
            result = [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: fileTypeInfo.mimeType as
                    | "image/jpeg"
                    | "image/png"
                    | "image/gif"
                    | "image/webp",
                  data: base64Data,
                },
              },
            ];
            break;
          default:
            assertUnreachable(fileTypeInfo.category);
        }
      }

      return {
        type: "tool_result",
        id: request.id,
        result: { status: "ok", value: result },
      };
    } catch (error) {
      if (aborted) return abortResult;
      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "error",
          error: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  })();

  return {
    promise,
    abort: () => {
      aborted = true;
    },
  };
}

export const spec: ProviderToolSpec = {
  name: "get_file" as ToolName,
  description: `Get the full contents of a given file. The file will be added to the thread context.
If a file is part of your context, avoid using get_file on it again, since you will get notified about any future changes about the file.

Supports:
- Text files (source code, markdown, JSON, XML, etc.) - added to context for tracking changes
- Images (JPEG, PNG, GIF, WebP) - returned as base64 encoded content
- PDF documents - returned as base64 encoded content

For large text files, content may be truncated. Use startLine and numLines to navigate.
Very long lines (>2000 chars) will be abridged.

File size limits: 1MB for text files, 10MB for images, 32MB for PDFs.`,
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
        description: `\
For PDF files, you can use this 1-indexed parameter to fetch the given page of the file.
Omitting this parameter for pdf files returns just the summary of the pdf.`,
      },
      startLine: {
        type: "number",
        description: `1-indexed line number to start reading from. If omitted, starts from line 1.`,
      },
      numLines: {
        type: "number",
        description: `Number of lines to return. If omitted, returns as many lines as fit within the token limit.`,
      },
    },
    required: ["filePath"],
  },
};

export type Input = {
  filePath: UnresolvedFilePath;
  force?: boolean;
  pdfPage?: number;
  startLine?: number;
  numLines?: number;
};

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
