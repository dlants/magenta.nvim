import { getBufferIfOpen } from "../utils/buffers.ts";
import fs from "fs";
import path from "path";
import { glob } from "glob";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, withBindings, withInlineCode, withExtmark } from "../tea/view.ts";
import { type StaticToolRequest } from "./toolManager.ts";
import { type Result } from "../utils/result.ts";
import type { Nvim } from "../nvim/nvim-node";
import { readGitignore } from "./util.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { Dispatch } from "../tea/tea.ts";
import {
  relativePath,
  resolveFilePath,
  type UnresolvedFilePath,
  detectFileType,
  validateFileSize,
  FileCategory,
  type NvimCwd,
} from "../utils/files.ts";
import type { StaticTool, ToolName } from "./types.ts";
import type { Msg as ThreadMsg } from "../chat/thread.ts";
import type { ContextManager } from "../context/context-manager.ts";
import type {
  ProviderTextContent,
  ProviderImageContent,
} from "../providers/provider-types.ts";
import { extractPdfText } from "../utils/pdf.ts";
import type { MagentaOptions } from "../options.ts";
import type { Row0Indexed } from "../nvim/window.ts";

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
      result: Result<(ProviderTextContent | ProviderImageContent)[]>;
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

  constructor(
    public request: Extract<StaticToolRequest, { toolName: "get_file" }>,
    public context: {
      nvim: Nvim;
      cwd: NvimCwd;
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

  /** this is expected to be invoked as part of a dispatch, so we don't need to dispatch here to update the view
   */
  abort() {
    this.state = {
      state: "done",
      result: {
        type: "tool_result",
        id: this.request.id,
        result: { status: "error", error: `The user aborted this request.` },
      },
    };
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
    const filePath = this.request.input.filePath;
    const absFilePath = resolveFilePath(this.context.cwd, filePath);

    if (
      this.context.contextManager.files[absFilePath] &&
      !this.request.input.force
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

    const relFilePath = relativePath(this.context.cwd, absFilePath);

    if (this.state.state === "pending") {
      // Check if file matches any auto-allow globs first
      if (await this.isFileAutoAllowed(relFilePath)) {
        this.context.myDispatch({
          type: "automatic-approval",
        });
        return;
      }

      if (!absFilePath.startsWith(this.context.cwd)) {
        this.context.myDispatch({ type: "request-user-approval" });
        return;
      }

      if (relFilePath.split(path.sep).some((part) => part.startsWith("."))) {
        this.context.myDispatch({ type: "request-user-approval" });
        return;
      }

      const ig = await readGitignore(this.context.cwd);
      if (ig.ignores(relFilePath)) {
        this.context.myDispatch({ type: "request-user-approval" });
        return;
      }
    }

    this.context.myDispatch({
      type: "automatic-approval",
    });
  }

  private async isFileAutoAllowed(relFilePath: string): Promise<boolean> {
    if (this.context.options.getFileAutoAllowGlobs.length === 0) {
      return false;
    }

    for (const pattern of this.context.options.getFileAutoAllowGlobs) {
      try {
        const matches = await glob(pattern, {
          cwd: this.context.cwd,
          nocase: true,
          nodir: true,
        });

        if (matches.includes(relFilePath)) {
          return true;
        }
      } catch (error) {
        // Log error but continue checking other patterns
        this.context.nvim.logger.error(
          `Error checking getFileAutoAllowGlobs pattern "${pattern}": ${(error as Error).message}`,
        );
      }
    }

    return false;
  }

  async readFile() {
    const filePath = this.request.input.filePath;
    const absFilePath = resolveFilePath(this.context.cwd, filePath);

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

    let result: ProviderTextContent | ProviderImageContent;

    if (fileTypeInfo.category === FileCategory.TEXT) {
      const bufferContents = await getBufferIfOpen({
        unresolvedPath: filePath,
        context: this.context,
      });

      let textContent: string;
      if (bufferContents.status === "ok") {
        textContent = (
          await bufferContents.buffer.getLines({
            start: 0 as Row0Indexed,
            end: -1 as Row0Indexed,
          })
        ).join("\n");
      } else if (bufferContents.status == "not-found") {
        textContent = await fs.promises.readFile(absFilePath, "utf-8");
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

      this.context.threadDispatch({
        type: "context-manager-msg",
        msg: {
          type: "tool-applied",
          absFilePath,
          tool: {
            type: "get-file",
            content: textContent,
          },
          fileTypeInfo,
        },
      });

      result = {
        type: "text",
        text: textContent,
      };
    } else if (fileTypeInfo.category === FileCategory.PDF) {
      // Extract text from PDF
      const pdfTextResult = await extractPdfText(absFilePath);
      if (pdfTextResult.status === "error") {
        this.context.myDispatch({
          type: "finish",
          result: {
            status: "error",
            error: pdfTextResult.error,
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
            type: "get-file",
            content: pdfTextResult.value,
          },
          fileTypeInfo,
        },
      });

      result = {
        type: "text",
        text: pdfTextResult.value,
      };
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
          result = {
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
          };
          break;
        default:
          assertUnreachable(fileTypeInfo.category);
      }
    }

    this.context.myDispatch({
      type: "finish",
      result: {
        status: "ok",
        value: [result],
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

  renderSummary() {
    switch (this.state.state) {
      case "pending":
      case "processing":
        return d`👀⚙️ ${withInlineCode(d`\`${this.request.input.filePath}\``)}`;
      case "pending-user-action":
        return d`👀⏳ May I read file ${withInlineCode(d`\`${this.request.input.filePath}\``)}?

┌────────────────┐
│ ${withBindings(
          withExtmark(d`[ NO ]`, {
            hl_group: ["ErrorMsg", "@markup.strong.markdown"],
          }),
          {
            "<CR>": () =>
              this.context.myDispatch({
                type: "user-approval",
                approved: false,
              }),
          },
        )} ${withBindings(
          withExtmark(d`[ YES ]`, {
            hl_group: ["String", "@markup.strong.markdown"],
          }),
          {
            "<CR>": () =>
              this.context.myDispatch({
                type: "user-approval",
                approved: true,
              }),
          },
        )} │
└────────────────┘`;
      case "done":
        if (this.state.result.result.status == "error") {
          return d`👀❌ ${withInlineCode(d`\`${this.request.input.filePath}\``)}`;
        } else {
          // Count lines in the result
          let lineCount = 0;
          if (
            this.state.result.result.value &&
            this.state.result.result.value.length > 0
          ) {
            const firstValue = this.state.result.result.value[0];
            if (firstValue.type === "text") {
              lineCount = firstValue.text.split("\n").length;
            }
          }
          const lineCountStr = lineCount > 0 ? ` [+ ${lineCount}]` : "";
          return d`👀✅ ${withInlineCode(d`\`${this.request.input.filePath}\``)}${lineCountStr}`;
        }
      default:
        assertUnreachable(this.state);
    }
  }
}

export const spec: ProviderToolSpec = {
  name: "get_file" as ToolName,
  description: `Get the full contents of a given file. The file will be added to the thread context.
If a file is part of your context, avoid using get_file on it again, since you will get notified about any future changes about the file.

Supports:
- Text files (source code, markdown, JSON, XML, etc.) - added to context for tracking changes
- Images (JPEG, PNG, GIF, WebP) - returned as base64 encoded content
- PDF documents - returned as base64 encoded content

File size limits: 1MB for text files, 10MB for images, 32MB for PDFs.`,
  input_schema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: `The path of the file. e.g. "./src/index.ts". This can be relative to the project root, or an absolute path.`,
      },
      force: {
        type: "boolean",
        description:
          "If true, get the full file contents even if the file is already part of the context.",
      },
    },
    required: ["filePath"],
  },
};

export type Input = {
  filePath: UnresolvedFilePath;
  force?: boolean;
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

  return {
    status: "ok",
    value: input as Input,
  };
}
