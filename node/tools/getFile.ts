import { getBufferIfOpen } from "../utils/buffers.ts";
import fs from "fs";
import path from "path";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, withBindings } from "../tea/view.ts";
import { type StaticToolRequest } from "./toolManager.ts";
import { type Result } from "../utils/result.ts";
import { getcwd } from "../nvim/nvim.ts";
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
  type FileTypeInfo,
} from "../utils/files.ts";
import type { StaticTool, ToolName } from "./types.ts";
import type { Msg as ThreadMsg } from "../chat/thread.ts";
import type { ContextManager } from "../context/context-manager.ts";
import type {
  ProviderTextContent,
  ProviderImageContent,
  ProviderDocumentContent,
} from "../providers/provider-types.ts";

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
      result: Result<
        (ProviderTextContent | ProviderImageContent | ProviderDocumentContent)[]
      >;
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
      contextManager: ContextManager;
      threadDispatch: Dispatch<ThreadMsg>;
      myDispatch: Dispatch<Msg>;
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
    const cwd = await getcwd(this.context.nvim);
    const absFilePath = resolveFilePath(cwd, filePath);

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

    const relFilePath = relativePath(cwd, absFilePath);

    if (this.state.state === "pending") {
      if (!absFilePath.startsWith(cwd)) {
        this.context.myDispatch({ type: "request-user-approval" });
        return;
      }

      if (relFilePath.split(path.sep).some((part) => part.startsWith("."))) {
        this.context.myDispatch({ type: "request-user-approval" });
        return;
      }

      const ig = await readGitignore(cwd);
      if (ig.ignores(relFilePath)) {
        this.context.myDispatch({ type: "request-user-approval" });
        return;
      }
    }

    this.context.myDispatch({
      type: "automatic-approval",
    });
  }

  async readFile() {
    const filePath = this.request.input.filePath;
    const cwd = await getcwd(this.context.nvim);
    const absFilePath = resolveFilePath(cwd, filePath);

    let fileTypeInfo: FileTypeInfo;
    try {
      fileTypeInfo = await detectFileType(absFilePath);
    } catch (error) {
      this.context.myDispatch({
        type: "finish",
        result: {
          status: "error",
          error: `Failed to detect file type: ${error instanceof Error ? error.message : String(error)}`,
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

    if (
      this.state.state === "processing" &&
      !this.state.approved &&
      sizeValidation.actualSize > 1024 * 1024
    ) {
      this.context.myDispatch({
        type: "finish",
        result: {
          status: "error",
          error: "Large file requires user approval",
        },
      });
      return;
    }

    let result:
      | ProviderTextContent
      | ProviderImageContent
      | ProviderDocumentContent;

    if (fileTypeInfo.category === FileCategory.TEXT) {
      const bufferContents = await getBufferIfOpen({
        unresolvedPath: filePath,
        context: this.context,
      });

      let textContent: string;
      if (bufferContents.status === "ok") {
        textContent = (
          await bufferContents.buffer.getLines({ start: 0, end: -1 })
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
        },
      });

      result = {
        type: "text",
        text: textContent,
      };
    } else {
      const buffer = await fs.promises.readFile(absFilePath);
      const base64Data = buffer.toString("base64");

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
        case FileCategory.PDF:
          result = {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
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
        return d`👀⚙️ \`${this.request.input.filePath}\``;
      case "pending-user-action":
        return d`👀⏳ May I read file  \`${this.request.input.filePath}\`? ${withBindings(
          d`**[ NO ]**`,
          {
            "<CR>": () =>
              this.context.myDispatch({
                type: "user-approval",
                approved: false,
              }),
          },
        )} ${withBindings(d`**[ OK ]**`, {
          "<CR>": () =>
            this.context.myDispatch({ type: "user-approval", approved: true }),
        })}`;
      case "done":
        if (this.state.result.result.status == "error") {
          return d`👀❌ \`${this.request.input.filePath}\``;
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
          return d`👀✅ \`${this.request.input.filePath}\`${lineCountStr}`;
        }
      default:
        assertUnreachable(this.state);
    }
  }

  displayInput() {
    return `get_file: ${JSON.stringify(this.request.input, null, 2)}`;
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
    // NOTE: openai requries all properties to be required.
    // https://community.openai.com/t/api-rejects-valid-json-schema/906163
    required: ["filePath", "force"],
    additionalProperties: false,
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
