import { getBufferIfOpen } from "../utils/buffers.ts";
import fs from "fs";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import {
  d,
  withBindings,
  withInlineCode,
  withExtmark,
  type VDOMNode,
} from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { Nvim } from "../nvim/nvim-node";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { Dispatch } from "../tea/tea.ts";
import {
  resolveFilePath,
  displayPath,
  type UnresolvedFilePath,
  detectFileType,
  validateFileSize,
  FileCategory,
  type NvimCwd,
  type HomeDir,
} from "../utils/files.ts";
import type {
  StaticTool,
  ToolName,
  GenericToolRequest,
  DisplayContext,
} from "./types.ts";
import type { Msg as ThreadMsg } from "../chat/thread.ts";
import type { ContextManager } from "../context/context-manager.ts";
import type { ProviderToolResultContent } from "../providers/provider-types.ts";
import {
  extractPDFPage,
  getSummaryAsProviderContent,
} from "../utils/pdf-pages.ts";
import type { MagentaOptions } from "../options.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import { canReadFile } from "./permissions.ts";
import { summarizeFile, formatSummary } from "../utils/file-summary.ts";
import type { CompletedToolInfo } from "./types.ts";

export type ToolRequest = GenericToolRequest<"get_file", Input>;

const MAX_FILE_CHARACTERS = 40000;
const MAX_LINE_CHARACTERS = 2000;
const DEFAULT_LINES_FOR_LARGE_FILE = 100;

export type State =
  | {
      state: "pending";
    }
  | {
      state: "processing";
      approved: boolean;
    }
  | {
      state: "pending-user-action";
    }
  | {
      state: "done";
      result: ProviderToolResult;
    };

export type Msg =
  | {
      type: "finish";
      result: Result<ProviderToolResultContent[]>;
    }
  | {
      type: "automatic-approval";
    }
  | {
      type: "request-user-approval";
    }
  | {
      type: "user-approval";
      approved: boolean;
    };

export class GetFileTool implements StaticTool {
  state: State;
  toolName = "get_file" as const;
  aborted: boolean = false;

  constructor(
    public request: ToolRequest,
    public context: {
      nvim: Nvim;
      cwd: NvimCwd;
      homeDir: HomeDir;
      contextManager: ContextManager;
      threadDispatch: Dispatch<ThreadMsg>;
      myDispatch: Dispatch<Msg>;
      options: MagentaOptions;
    },
  ) {
    this.state = {
      state: "pending",
    };

    // wrap in setTimeout to force new eventloop frame, to avoid dispatch-in-dispatch
    setTimeout(() => {
      this.initReadFile().catch((error: Error) =>
        this.context.myDispatch({
          type: "finish",
          result: {
            status: "error",
            error: error.message + "\n" + error.stack,
          },
        }),
      );
    });
  }

  isDone(): boolean {
    return this.state.state === "done";
  }

  isPendingUserAction(): boolean {
    return this.state.state === "pending-user-action";
  }

  abort(): ProviderToolResult {
    if (this.state.state === "done") {
      return this.state.result;
    }

    this.aborted = true;

    const result: ProviderToolResult = {
      type: "tool_result",
      id: this.request.id,
      result: {
        status: "error",
        error: "Request was aborted by the user.",
      },
    };

    this.state = {
      state: "done",
      result,
    };

    return result;
  }

  update(msg: Msg) {
    switch (msg.type) {
      case "finish":
        this.state = {
          state: "done",
          result: {
            type: "tool_result",
            id: this.request.id,
            result: msg.result,
          },
        };

        return;
      case "request-user-approval":
        if (this.state.state == "pending") {
          this.state = {
            state: "pending-user-action",
          };
        }
        return;
      case "user-approval": {
        if (this.state.state === "pending-user-action") {
          if (msg.approved) {
            this.state = {
              state: "processing",
              approved: true,
            };

            // wrap in setTimeout to force a new eventloop frame, to avoid dispatch-in-dispatch
            setTimeout(() => {
              this.readFile().catch((error: Error) =>
                this.context.myDispatch({
                  type: "finish",
                  result: {
                    status: "error",
                    error: error.message + "\n" + error.stack,
                  },
                }),
              );
            });
            return;
          } else {
            this.state = {
              state: "done",
              result: {
                type: "tool_result",
                id: this.request.id,
                result: {
                  status: "error",
                  error: `The user did not allow the reading of this file.`,
                },
              },
            };
            return;
          }
        }
        return;
      }

      case "automatic-approval": {
        if (this.state.state == "pending") {
          this.state = {
            state: "processing",
            approved: true,
          };

          // wrap in setTimeout to force a new eventloop frame, to avoid dispatch-in-dispatch
          setTimeout(() => {
            this.readFile().catch((error: Error) =>
              this.context.myDispatch({
                type: "finish",
                result: {
                  status: "error",
                  error: error.message + "\n" + error.stack,
                },
              }),
            );
          });
        }
        return;
      }
      default:
        assertUnreachable(msg);
    }
  }

  async initReadFile(): Promise<void> {
    if (this.aborted) return;

    const filePath = this.request.input.filePath;
    const absFilePath = resolveFilePath(
      this.context.cwd,
      filePath,
      this.context.homeDir,
    );

    const hasLineParams =
      this.request.input.startLine !== undefined ||
      this.request.input.numLines !== undefined;

    if (
      this.context.contextManager.files[absFilePath] &&
      !this.request.input.force &&
      this.request.input.pdfPage === undefined &&
      !hasLineParams
    ) {
      this.context.myDispatch({
        type: "finish",
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
      });
      return;
    }

    if (this.state.state === "pending") {
      const allowed = await canReadFile(absFilePath, this.context);

      if (allowed) {
        this.context.myDispatch({
          type: "automatic-approval",
        });
      } else {
        this.context.myDispatch({ type: "request-user-approval" });
      }
    }
  }

  async readFile() {
    if (this.aborted) return;

    const filePath = this.request.input.filePath;
    const absFilePath = resolveFilePath(
      this.context.cwd,
      filePath,
      this.context.homeDir,
    );

    const fileTypeInfo = await detectFileType(absFilePath);
    if (!fileTypeInfo) {
      this.context.myDispatch({
        type: "finish",
        result: {
          status: "error",
          error: `File ${filePath} does not exist.`,
        },
      });
      return;
    }

    if (fileTypeInfo.category === FileCategory.UNSUPPORTED) {
      this.context.myDispatch({
        type: "finish",
        result: {
          status: "error",
          error: `Unsupported file type: ${fileTypeInfo.mimeType}. Supported types: text files, images (JPEG, PNG, GIF, WebP), and PDF documents.`,
        },
      });
      return;
    }

    const sizeValidation = await validateFileSize(
      absFilePath,
      fileTypeInfo.category,
    );
    if (!sizeValidation.isValid) {
      const sizeMB = (sizeValidation.actualSize / (1024 * 1024)).toFixed(2);
      const maxSizeMB = (sizeValidation.maxSize / (1024 * 1024)).toFixed(2);
      this.context.myDispatch({
        type: "finish",
        result: {
          status: "error",
          error: `File too large: ${sizeMB}MB (max ${maxSizeMB}MB for ${fileTypeInfo.category} files)`,
        },
      });
      return;
    }

    let result: ProviderToolResultContent[];

    if (fileTypeInfo.category === FileCategory.TEXT) {
      const bufferContents = await getBufferIfOpen({
        unresolvedPath: filePath,
        context: this.context,
      });

      let lines: string[];
      if (bufferContents.status === "ok") {
        lines = await bufferContents.buffer.getLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
        });
      } else if (bufferContents.status == "not-found") {
        const rawContent = await fs.promises.readFile(absFilePath, "utf-8");
        lines = rawContent.split("\n");
      } else {
        this.context.myDispatch({
          type: "finish",
          result: {
            status: "error",
            error: bufferContents.error,
          },
        });
        return;
      }

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

      // For large files, generate a file summary
      const totalChars = lines.reduce((sum, line) => sum + line.length + 1, 0);
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

      const processedResult = this.processTextContent(
        lines,
        startIndex,
        this.request.input.numLines,
        summaryText,
      );

      // Only add to context manager if returning full, unabridged content
      if (
        processedResult.isComplete &&
        !processedResult.hasAbridgedLines &&
        startIndex === 0
      ) {
        this.context.threadDispatch({
          type: "context-manager-msg",
          msg: {
            type: "tool-applied",
            absFilePath,
            tool: {
              type: "get-file",
              content: lines.join("\n"),
            },
            fileTypeInfo,
          },
        });
      }

      result = [
        {
          type: "text",
          text: processedResult.text,
        },
      ];
    } else if (fileTypeInfo.category === FileCategory.PDF) {
      // Check if we've already provided this PDF content to avoid redundant operations
      const existingFileInfo = this.context.contextManager.files[absFilePath];
      const agentView = existingFileInfo?.agentView;

      if (this.request.input.pdfPage !== undefined) {
        // Check if we've already sent this specific page
        if (
          agentView?.type === "pdf" &&
          agentView.pages.includes(this.request.input.pdfPage)
        ) {
          this.context.myDispatch({
            type: "finish",
            result: {
              status: "ok",
              value: [
                {
                  type: "text",
                  text: `Page ${this.request.input.pdfPage} of ${filePath} has already been provided to you in this conversation.`,
                },
              ],
            },
          });
          return;
        }

        // Extract specific page as binary PDF content
        const pageResult = await extractPDFPage(
          absFilePath,
          this.request.input.pdfPage,
        );
        if (pageResult.status === "error") {
          this.context.myDispatch({
            type: "finish",
            result: {
              status: "error",
              error: pageResult.error,
            },
          });
          return;
        }

        // For PDF pages, we use document content type
        result = [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: Buffer.from(pageResult.value).toString("base64"),
            },
            title: `${filePath} - Page ${this.request.input.pdfPage}`,
          },
        ];

        // Notify context manager about the PDF page extraction
        this.context.threadDispatch({
          type: "context-manager-msg",
          msg: {
            type: "tool-applied",
            absFilePath,
            tool: {
              type: "get-file-pdf",
              content: {
                type: "page",
                pdfPage: this.request.input.pdfPage,
              },
            },
            fileTypeInfo,
          },
        });
      } else {
        // Check if we've already sent the PDF summary
        if (agentView?.type === "pdf" && agentView.summary) {
          this.context.myDispatch({
            type: "finish",
            result: {
              status: "ok",
              value: [
                {
                  type: "text",
                  text: `The summary information for ${filePath} has already been provided to you in this conversation.`,
                },
              ],
            },
          });
          return;
        }

        // Get basic PDF info without pdfPage parameter
        const pageCountResult = await getSummaryAsProviderContent(absFilePath);
        if (pageCountResult.status === "error") {
          this.context.myDispatch({
            type: "finish",
            result: {
              status: "error",
              error: pageCountResult.error,
            },
          });
          return;
        }

        this.context.threadDispatch({
          type: "context-manager-msg",
          msg: {
            type: "tool-applied",
            absFilePath,
            tool: {
              type: "get-file-pdf",
              content: {
                type: "summary",
              },
            },
            fileTypeInfo,
          },
        });

        result = pageCountResult.value;
      }
    } else {
      // Handle other binary files (images)
      const buffer = await fs.promises.readFile(absFilePath);
      const base64Data = buffer.toString("base64");

      // Get file modification time for binary files
      const stats = await fs.promises.stat(absFilePath);
      const mtime = stats.mtime.getTime();

      // Notify context manager of the binary file
      this.context.threadDispatch({
        type: "context-manager-msg",
        msg: {
          type: "tool-applied",
          absFilePath,
          tool: {
            type: "get-file-binary",
            mtime,
          },
          fileTypeInfo,
        },
      });

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

    this.context.myDispatch({
      type: "finish",
      result: {
        status: "ok",
        value: result,
      },
    });

    return;
  }

  getToolResult(): ProviderToolResult {
    switch (this.state.state) {
      case "pending":
      case "processing":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: [
              {
                type: "text",
                text: `This tool use is being processed. Please proceed with your answer or address other parts of the question.`,
              },
            ],
          },
        };
      case "pending-user-action":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: [
              {
                type: "text",
                text: `Waiting for user approval to finish processing this tool use.`,
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

  private processTextContent(
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

  private formatFileDisplay() {
    return formatGetFileDisplay(this.request.input, {
      cwd: this.context.cwd,
      homeDir: this.context.homeDir,
    });
  }

  renderSummary() {
    switch (this.state.state) {
      case "pending":
      case "processing":
        return d`👀⚙️ ${this.formatFileDisplay()}`;
      case "pending-user-action":
        return d`👀⏳ May I read file ${this.formatFileDisplay()}?
${withBindings(
  withExtmark(d`> NO`, {
    hl_group: ["ErrorMsg", "@markup.strong.markdown"],
  }),
  {
    "<CR>": () =>
      this.context.myDispatch({
        type: "user-approval",
        approved: false,
      }),
  },
)}
${withBindings(
  withExtmark(d`> YES`, {
    hl_group: ["String", "@markup.strong.markdown"],
  }),
  {
    "<CR>": () =>
      this.context.myDispatch({
        type: "user-approval",
        approved: true,
      }),
  },
)}`;
      case "done":
        return renderCompletedSummary(
          {
            request: this.request as CompletedToolInfo["request"],
            result: this.state.result,
          },
          { cwd: this.context.cwd, homeDir: this.context.homeDir },
        );
      default:
        assertUnreachable(this.state);
    }
  }
}

function formatGetFileDisplay(
  input: Input,
  displayContext: DisplayContext,
): VDOMNode {
  const absFilePath = resolveFilePath(
    displayContext.cwd,
    input.filePath,
    displayContext.homeDir,
  );
  const pathForDisplay = displayPath(
    displayContext.cwd,
    absFilePath,
    displayContext.homeDir,
  );
  let extraInfo = "";
  if (input.pdfPage !== undefined) {
    extraInfo = ` (page ${input.pdfPage})`;
  } else if (input.startLine !== undefined || input.numLines !== undefined) {
    const start = input.startLine ?? 1;
    const num = input.numLines;
    extraInfo =
      num !== undefined
        ? ` (lines ${start}-${start + num - 1})`
        : ` (from line ${start})`;
  }
  return withInlineCode(d`\`${pathForDisplay}\`${extraInfo}`);
}

export function renderCompletedSummary(
  info: CompletedToolInfo,
  displayContext: DisplayContext,
): VDOMNode {
  const input = info.request.input as Input;
  const result = info.result.result;

  if (result.status === "error") {
    return d`👀❌ ${formatGetFileDisplay(input, displayContext)}`;
  }

  let lineCount = 0;
  if (result.value.length > 0) {
    const firstValue = result.value[0];
    if (firstValue.type === "text") {
      lineCount = firstValue.text.split("\n").length;
    }
  }
  const lineCountStr = lineCount > 0 ? ` [+ ${lineCount}]` : "";
  return d`👀✅ ${formatGetFileDisplay(input, displayContext)}${lineCountStr}`;
}

export function renderCompletedDetail(info: CompletedToolInfo): VDOMNode {
  const result = info.result.result;

  if (result.status === "error") {
    return d`Error: ${result.error}`;
  }

  const parts: VDOMNode[] = [];
  for (const content of result.value) {
    if (content.type === "text") {
      parts.push(d`${content.text}`);
    } else if (content.type === "image") {
      parts.push(d`[Image: ${content.source.media_type}]`);
    } else if (content.type === "document") {
      parts.push(d`[Document${content.title ? `: ${content.title}` : ""}]`);
    }
  }

  return d`${parts}`;
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
