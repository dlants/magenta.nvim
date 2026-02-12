import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Result } from "../utils/result.ts";
import type {
  ProviderToolResult,
  ProviderToolResultContent,
} from "../agent/provider-types.ts";
import type { StaticTool, ToolName, ToolMsg } from "./types.ts";
import type { ToolRequest, Input } from "./specs/get-file.ts";
import type { FileIO, FileAccess, FileCategory } from "./environment.ts";
import { FILE_SIZE_LIMITS } from "./environment.ts";
import type { Logger } from "../logger.ts";
import type { Cwd, HomeDir } from "../utils/files.ts";
import type { Dispatch } from "../tea/tea.ts";
import { resolveFilePath } from "../utils/files.ts";
import { summarizeFile, formatSummary } from "../utils/file-summary.ts";

export const MAX_FILE_CHARACTERS = 40000;
export const MAX_LINE_CHARACTERS = 2000;
export const DEFAULT_LINES_FOR_LARGE_FILE = 100;

export type State =
  | { state: "processing" }
  | { state: "done"; result: ProviderToolResult };

export type Msg = {
  type: "finish";
  result: Result<ProviderToolResultContent[]>;
};

export type GetFileToolContext = {
  fileIO: FileIO;
  fileAccess: FileAccess;
  logger: Logger;
  cwd: Cwd;
  homeDir: HomeDir;
  myDispatch: Dispatch<Msg>;
};

export function abbreviateLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) {
    return line;
  }
  const halfMax = Math.floor(maxChars / 2);
  return `${line.slice(0, halfMax)}... [${line.length - maxChars} chars omitted] ...${line.slice(-halfMax)}`;
}

export function processTextContent(
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
      line = abbreviateLine(line, MAX_LINE_CHARACTERS);
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

export function validateFileSize(
  size: number,
  category: FileCategory,
): { isValid: boolean; maxSize: number } {
  const maxSize = FILE_SIZE_LIMITS[category] ?? 0;
  return { isValid: size <= maxSize, maxSize };
}

export class GetFileTool implements StaticTool {
  state: State;
  toolName = "get_file" as unknown as ToolName;
  aborted: boolean = false;
  private abortController: AbortController;

  constructor(
    public request: ToolRequest,
    public context: GetFileToolContext,
  ) {
    this.abortController = new AbortController();
    this.state = { state: "processing" };

    setTimeout(() => {
      this.executeGetFile().catch((error) => {
        this.context.logger.error(
          `Error executing get_file: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
  }

  isDone(): boolean {
    return this.state.state === "done";
  }

  isPendingUserAction(): boolean {
    return false;
  }

  abort(): ProviderToolResult {
    if (this.state.state === "done") {
      return this.getToolResult();
    }

    this.aborted = true;
    this.abortController.abort();

    const result: ProviderToolResult = {
      type: "tool_result",
      id: this.request.id,
      result: {
        status: "error",
        error: "Request was aborted by the user.",
      },
    };

    this.state = { state: "done", result };
    return result;
  }

  update(msg: ToolMsg) {
    const m = msg as unknown as Msg;
    switch (m.type) {
      case "finish":
        if (this.state.state === "processing") {
          this.state = {
            state: "done",
            result: {
              type: "tool_result",
              id: this.request.id,
              result: m.result,
            },
          };
        }
        return;

      default:
        assertUnreachable(m as never);
    }
  }

  private async executeGetFile() {
    if (this.aborted) return;

    const filePath = this.request.input.filePath;
    const absFilePath = resolveFilePath(
      this.context.cwd,
      filePath,
      this.context.homeDir,
    );

    const fileInfoResult = await this.context.fileAccess.getFileInfo(absFilePath);
    if (fileInfoResult.status === "error") {
      this.context.myDispatch({
        type: "finish",
        result: {
          status: "error",
          error: fileInfoResult.error,
        },
      });
      return;
    }

    const { size, category, mimeType } = fileInfoResult.value;

    if (category === "unsupported") {
      this.context.myDispatch({
        type: "finish",
        result: {
          status: "error",
          error: `Unsupported file type: ${mimeType}. Supported types: text files, images (JPEG, PNG, GIF, WebP), and PDF documents.`,
        },
      });
      return;
    }

    const sizeValidation = validateFileSize(size, category);
    if (!sizeValidation.isValid) {
      const sizeMB = (size / (1024 * 1024)).toFixed(2);
      const maxSizeMB = (sizeValidation.maxSize / (1024 * 1024)).toFixed(2);
      this.context.myDispatch({
        type: "finish",
        result: {
          status: "error",
          error: `File too large: ${sizeMB}MB (max ${maxSizeMB}MB for ${category} files)`,
        },
      });
      return;
    }

    if (this.aborted) return;

    let result: ProviderToolResultContent[];

    switch (category) {
      case "text": {
        const readResult = await this.context.fileIO.readFile(absFilePath);
        if (readResult.status === "error") {
          this.context.myDispatch({
            type: "finish",
            result: { status: "error", error: readResult.error },
          });
          return;
        }

        const lines = readResult.value.split("\n");
        const totalLines = lines.length;
        const startLine = this.request.input.startLine ?? 1;
        const startIndex = startLine - 1;

        if (startIndex >= totalLines) {
          this.context.myDispatch({
            type: "finish",
            result: {
              status: "error",
              error: `startLine ${startLine} is beyond end of file (${totalLines} lines)`,
            },
          });
          return;
        }

        const totalChars = lines.reduce(
          (sum, line) => sum + line.length + 1,
          0,
        );
        const isLargeFile =
          this.request.input.numLines === undefined &&
          totalChars > MAX_FILE_CHARACTERS;

        let summaryText: string | undefined;
        if (isLargeFile && startIndex === 0) {
          const content = lines.join("\n");
          const summary = summarizeFile(content, {
            charBudget: MAX_FILE_CHARACTERS,
          });
          summaryText = formatSummary(summary);
        }

        const processedResult = processTextContent(
          lines,
          startIndex,
          this.request.input.numLines,
          summaryText,
        );

        result = [{ type: "text", text: processedResult.text }];
        break;
      }

      case "pdf": {
        if (this.request.input.pdfPage !== undefined) {
          const pageResult = await this.context.fileAccess.extractPDFPage(
            absFilePath,
            this.request.input.pdfPage,
          );
          if (pageResult.status === "error") {
            this.context.myDispatch({
              type: "finish",
              result: { status: "error", error: pageResult.error },
            });
            return;
          }

          result = [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: pageResult.value,
              },
              title: `${filePath} - Page ${this.request.input.pdfPage}`,
            },
          ];
        } else {
          const pageCountResult =
            await this.context.fileAccess.getPDFPageCount(absFilePath);
          if (pageCountResult.status === "error") {
            this.context.myDispatch({
              type: "finish",
              result: { status: "error", error: pageCountResult.error },
            });
            return;
          }

          const pageCount = pageCountResult.value;
          result = [
            {
              type: "text",
              text: `PDF Document: ${filePath}\nPages: ${pageCount}\n\nUse the get_file tool with a pdfPage parameter (1-indexed) to fetch a specific page.`,
            },
          ];
        }
        break;
      }

      case "image": {
        const base64Result =
          await this.context.fileAccess.readBinaryFileBase64(absFilePath);
        if (base64Result.status === "error") {
          this.context.myDispatch({
            type: "finish",
            result: { status: "error", error: base64Result.error },
          });
          return;
        }

        result = [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mimeType as
                | "image/jpeg"
                | "image/png"
                | "image/gif"
                | "image/webp",
              data: base64Result.value,
            },
          },
        ];
        break;
      }

      default:
        assertUnreachable(category);
    }

    if (this.aborted) return;

    this.context.myDispatch({
      type: "finish",
      result: { status: "ok", value: result },
    });
  }

  getToolResult(): ProviderToolResult {
    switch (this.state.state) {
      case "processing":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: [
              {
                type: "text",
                text: "This tool use is being processed. Please proceed with your answer or address other parts of the question.",
              },
            ],
          },
        };
      case "done":
        return this.state.result;
      default:
        assertUnreachable(this.state);
    }
  }
}