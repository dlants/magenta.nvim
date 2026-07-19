import { extractSystemReminderBlock } from "../agents/agents.ts";
import type {
  ContextTracker,
  OnToolApplied,
} from "../capabilities/context-tracker.ts";
import type { FileIO } from "../capabilities/file-io.ts";
import type {
  ProviderToolResult,
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "../providers/provider-types.ts";
import type {
  GenericToolRequest,
  ToolInvocation,
  ToolName,
} from "../tool-types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { formatSummary, summarizeFile } from "../utils/file-summary.ts";
import {
  type AbsFilePath,
  detectFileTypeViaFileIO,
  FILE_SIZE_LIMITS,
  FileCategory,
  type HomeDir,
  type NvimCwd,
  resolveFilePath,
  type UnresolvedFilePath,
} from "../utils/files.ts";

import {
  extractPDFPage,
  getSummaryAsProviderContent,
} from "../utils/pdf-pages.ts";
import type { Result } from "../utils/result.ts";

export type ToolRequest = GenericToolRequest<"get_files", Input>;

export type PerFileResult = {
  filePath: AbsFilePath;
  lineCount: number;
  systemReminder: string | undefined;
  isError: boolean;
};

export type StructuredResult = {
  toolName: "get_files";
  files: PerFileResult[];
};

const HARD_MAX_OUTPUT_CHARACTERS = 40000;
const MAX_FILE_CHARACTERS = HARD_MAX_OUTPUT_CHARACTERS;
const SUMMARY_CONTENT_BUDGET = 30000;
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
  let hitHardCap = false;
  const outputLines: string[] = [];
  let runningChars = 0;

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

    if (runningChars + line.length + 1 > HARD_MAX_OUTPUT_CHARACTERS) {
      hitHardCap = true;
      break;
    }

    outputLines.push(line);
    runningChars += line.length + 1;
  }

  const endIndex = startIndex + outputLines.length;
  const isComplete =
    startIndex === 0 && endIndex === totalLines && !hasAbridgedLines;

  let text = outputLines.join("\n");

  if (!isComplete || startIndex > 0 || endIndex < totalLines) {
    const header = `[Lines ${startIndex + 1}-${endIndex} of ${totalLines}]${hasAbridgedLines ? " (some lines abridged)" : ""}\n\n`;
    text = header + text;

    if (endIndex < totalLines) {
      const reason = hitHardCap
        ? `Output truncated at ${HARD_MAX_OUTPUT_CHARACTERS} char hard cap. `
        : "";
      text += `\n\n[${reason}${totalLines - endIndex} more lines not shown. Use startLine=${endIndex + 1} to continue.]`;
    }
  }

  return { text, isComplete, hasAbridgedLines };
}

export type FileRequest = {
  filePath: UnresolvedFilePath;
  force?: boolean;
  pdfPage?: number;
  startLine?: number;
  numLines?: number;
};

type ReadOneFileContext = {
  cwd: NvimCwd;
  homeDir: HomeDir;
  fileIO: FileIO;
  contextTracker: ContextTracker;
  onToolApplied: OnToolApplied;
  isAborted: () => boolean;
};

type ReadOneFileOutcome =
  | { aborted: true }
  | {
      aborted?: false;
      blocks: ProviderToolResultContent[];
      structured: PerFileResult;
    };

function errorOutcome(
  absFilePath: AbsFilePath,
  message: string,
): ReadOneFileOutcome {
  return {
    blocks: [
      {
        type: "text",
        text: message,
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ],
    structured: {
      filePath: absFilePath,
      lineCount: 0,
      systemReminder: undefined,
      isError: true,
    },
  };
}

async function readOneFile(
  fileReq: FileRequest,
  context: ReadOneFileContext,
): Promise<ReadOneFileOutcome> {
  const { isAborted } = context;
  const filePath = fileReq.filePath;
  const absFilePath = resolveFilePath(context.cwd, filePath, context.homeDir);

  const hasLineParams =
    fileReq.startLine !== undefined || fileReq.numLines !== undefined;

  if (
    context.contextTracker.files[absFilePath] &&
    !fileReq.force &&
    fileReq.pdfPage === undefined &&
    !hasLineParams
  ) {
    return {
      blocks: [
        {
          type: "text",
          text: `This file is already part of the thread context. \
You already have the most up-to-date information about the contents of this file.`,
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ],
      structured: {
        filePath: absFilePath,
        lineCount: 0,
        systemReminder: undefined,
        isError: false,
      },
    };
  }

  const fileTypeInfo = await detectFileTypeViaFileIO(
    absFilePath,
    context.fileIO,
  );
  if (isAborted()) return { aborted: true };

  if (!fileTypeInfo) {
    return errorOutcome(absFilePath, `File ${filePath} does not exist.`);
  }

  if (fileTypeInfo.category === FileCategory.UNSUPPORTED) {
    return errorOutcome(
      absFilePath,
      `Unsupported file type: ${fileTypeInfo.mimeType}. Supported types: text files, images (JPEG, PNG, GIF, WebP), and PDF documents.`,
    );
  }

  const statResult = await context.fileIO.stat(absFilePath);
  if (isAborted()) return { aborted: true };
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
    return errorOutcome(
      absFilePath,
      `File too large: ${sizeMB}MB (max ${maxSizeMB}MB for ${fileTypeInfo.category} files)`,
    );
  }

  let result: ProviderToolResultContent[];
  let lineCount = 0;
  let systemReminder: string | undefined;

  if (fileTypeInfo.category === FileCategory.TEXT) {
    const rawContent = await context.fileIO.readFile(absFilePath);
    if (isAborted()) return { aborted: true };

    if (absFilePath.toLowerCase().endsWith(".md")) {
      systemReminder = extractSystemReminderBlock(rawContent);
    }

    const lines = rawContent.split("\n");
    const totalLines = lines.length;
    const startLine = fileReq.startLine ?? 1;
    const startIndex = startLine - 1;

    if (startIndex >= totalLines) {
      return errorOutcome(
        absFilePath,
        `startLine ${startLine} is beyond end of file (${totalLines} lines)`,
      );
    }

    const totalChars = lines.reduce((sum, line) => sum + line.length + 1, 0);
    const isLargeFile =
      fileReq.numLines === undefined && totalChars > MAX_FILE_CHARACTERS;

    let summaryText: string | undefined;
    if (isLargeFile && startIndex === 0) {
      const content = lines.join("\n");
      const summary = summarizeFile(content, {
        charBudget: SUMMARY_CONTENT_BUDGET,
      });
      summaryText = formatSummary(summary);
    }

    const processedResult = processTextContentStandalone(
      lines,
      startIndex,
      fileReq.numLines,
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

    result = [
      {
        type: "text",
        text: processedResult.text,
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ];
    lineCount = processedResult.text.split("\n").length;
  } else if (fileTypeInfo.category === FileCategory.PDF) {
    const existingFileInfo = context.contextTracker.files[absFilePath];
    const agentView = existingFileInfo?.agentView;

    if (fileReq.pdfPage !== undefined) {
      if (
        agentView?.type === "pdf" &&
        agentView.pages.includes(fileReq.pdfPage)
      ) {
        return {
          blocks: [
            {
              type: "text",
              text: `Page ${fileReq.pdfPage} of ${filePath} has already been provided to you in this conversation.`,
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
            },
          ],
          structured: {
            filePath: absFilePath,
            lineCount: 0,
            systemReminder: undefined,
            isError: false,
          },
        };
      }

      const pageResult = await extractPDFPage(absFilePath, fileReq.pdfPage);
      if (isAborted()) return { aborted: true };

      if (pageResult.status === "error") {
        return errorOutcome(absFilePath, pageResult.error);
      }

      result = [
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: Buffer.from(pageResult.value).toString("base64"),
          },
          title: `${filePath} - Page ${fileReq.pdfPage}`,
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ];

      context.onToolApplied(
        absFilePath,
        {
          type: "get-file-pdf",
          content: { type: "page", pdfPage: fileReq.pdfPage },
        },
        fileTypeInfo,
      );
    } else {
      if (agentView?.type === "pdf" && agentView.summary) {
        return {
          blocks: [
            {
              type: "text",
              text: `The summary information for ${filePath} has already been provided to you in this conversation.`,
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
            },
          ],
          structured: {
            filePath: absFilePath,
            lineCount: 0,
            systemReminder: undefined,
            isError: false,
          },
        };
      }

      const pageCountResult = await getSummaryAsProviderContent(absFilePath);
      if (isAborted()) return { aborted: true };

      if (pageCountResult.status === "error") {
        return errorOutcome(absFilePath, pageCountResult.error);
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
    if (isAborted()) return { aborted: true };

    const binStatResult = await context.fileIO.stat(absFilePath);
    if (isAborted()) return { aborted: true };

    const mtime = binStatResult?.mtimeMs ?? Date.now();

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
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          },
        ];
        break;
      default:
        assertUnreachable(fileTypeInfo.category);
    }
  }

  return {
    blocks: result,
    structured: {
      filePath: absFilePath,
      lineCount,
      systemReminder,
      isError: false,
    },
  };
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
    nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
  };

  const promise = (async (): Promise<ProviderToolResult> => {
    try {
      const value: ProviderToolResultContent[] = [];
      const files: PerFileResult[] = [];

      for (const fileReq of request.input.files) {
        if (aborted) return abortResult;

        const outcome = await readOneFile(fileReq, {
          cwd: context.cwd,
          homeDir: context.homeDir,
          fileIO: context.fileIO,
          contextTracker: context.contextTracker,
          onToolApplied: context.onToolApplied,
          isAborted: () => aborted,
        });

        if (outcome.aborted) return abortResult;

        value.push({
          type: "text",
          text: `=== ${fileReq.filePath} ===`,
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        });
        value.push(...outcome.blocks);
        files.push(outcome.structured);
      }

      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "ok",
          value,
          structuredResult: {
            toolName: "get_files",
            files,
          },
        },
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
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
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
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
  name: "get_files" as ToolName,
  description: `Get the contents of one or more files. Text files will be added to the thread context.
Provide a \`files\` array; each entry reads one file with its own options. Reading several files in a single call avoids round trips.
If a file is part of your context, avoid reading it again, since you will get notified about any future changes about the file.

Supports:
- Text files (source code, markdown, JSON, XML, etc.) - added to context for tracking changes
- Images (JPEG, PNG, GIF, WebP) - returned as base64 encoded content
- PDF documents - returned as base64 encoded content

Each file's content is preceded by a \`=== <path> ===\` header. A problem reading one file (missing/unsupported/too large) yields an error note for that file only and does not fail the others.

Output is hard-capped at 40,000 characters (~10k tokens) per file. This cap cannot be bypassed by force or numLines.
For files that exceed the cap:
- When no startLine/numLines is given, a high-signal summary is returned.
- Use startLine and numLines to page through specific ranges. If your numLines is too large, output is truncated and a continuation hint with the next startLine is provided.
Very long lines (>2000 chars) will be abridged.

File size limits: 1MB for text files, 10MB for images, 32MB for PDFs.`,
  input_schema: {
    type: "object",
    properties: {
      files: {
        type: "array",
        description: "The files to read. Provide at least one entry.",
        items: {
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
      },
    },
    required: ["files"],
  },
};

export type Input = {
  files: FileRequest[];
};

function validateFileRequest(input: {
  [key: string]: unknown;
}): Result<FileRequest> {
  if (typeof input.filePath !== "string") {
    return {
      status: "error",
      error: "expected file.filePath to be a string",
    };
  }

  if (input.force !== undefined && typeof input.force !== "boolean") {
    return {
      status: "error",
      error: "expected file.force to be a boolean",
    };
  }

  if (input.pdfPage !== undefined && typeof input.pdfPage !== "number") {
    return {
      status: "error",
      error: "expected file.pdfPage to be a number",
    };
  }

  if (
    input.pdfPage !== undefined &&
    (input.pdfPage < 1 || !Number.isInteger(input.pdfPage))
  ) {
    return {
      status: "error",
      error:
        "expected file.pdfPage to be a positive integer (1-indexed page number)",
    };
  }

  if (input.startLine !== undefined && typeof input.startLine !== "number") {
    return {
      status: "error",
      error: "expected file.startLine to be a number",
    };
  }

  if (
    input.startLine !== undefined &&
    (input.startLine < 1 || !Number.isInteger(input.startLine))
  ) {
    return {
      status: "error",
      error:
        "expected file.startLine to be a positive integer (1-indexed line number)",
    };
  }

  if (input.numLines !== undefined && typeof input.numLines !== "number") {
    return {
      status: "error",
      error: "expected file.numLines to be a number",
    };
  }

  if (
    input.numLines !== undefined &&
    (input.numLines < 1 || !Number.isInteger(input.numLines))
  ) {
    return {
      status: "error",
      error: "expected file.numLines to be a positive integer",
    };
  }

  return {
    status: "ok",
    value: input as FileRequest,
  };
}

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (!Array.isArray(input.files)) {
    return {
      status: "error",
      error: "expected req.input.files to be an array",
    };
  }

  if (input.files.length === 0) {
    return {
      status: "error",
      error: "expected req.input.files to have at least one entry",
    };
  }

  for (const file of input.files) {
    if (typeof file !== "object" || file === null) {
      return {
        status: "error",
        error: "expected each entry of req.input.files to be an object",
      };
    }

    const fileResult = validateFileRequest(file as { [key: string]: unknown });
    if (fileResult.status === "error") {
      return fileResult;
    }
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
