import { assertUnreachable } from "../utils/assertUnreachable";
import type { Nvim } from "../nvim/nvim-node";

import type { MagentaOptions } from "../options";
import type { Dispatch } from "../tea/tea";
import type { RootMsg } from "../root-msg";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow";

import {
  relativePath,
  resolveFilePath,
  displayPath,
  type AbsFilePath,
  type HomeDir,
  type NvimCwd,
  type RelFilePath,
  type UnresolvedFilePath,
  detectFileType,
  FileCategory,
  type FileTypeInfo,
} from "../utils/files";
import type { Result } from "../utils/result";
import * as diff from "diff";
import type { FileIO } from "@magenta/core";
import { d, withBindings, withExtmark, withInlineCode } from "../tea/view";
import type { ProviderMessageContent } from "../providers/provider-types";
import open from "open";
import { getSummaryAsProviderContent } from "../utils/pdf-pages";

export type ToolApplication =
  | {
      type: "get-file";
      content: string;
    }
  | {
      type: "get-file-binary";
      mtime: number;
    }
  | {
      type: "get-file-pdf";
      content:
        | {
            type: "summary";
          }
        | {
            type: "page";
            pdfPage: number;
          };
    }
  | {
      type: "edl-edit";
      content: string;
    };

export type Msg =
  | {
      type: "add-file-context";
      relFilePath: RelFilePath;
      absFilePath: AbsFilePath;
      fileTypeInfo: FileTypeInfo;
    }
  | {
      type: "remove-file-context";
      absFilePath: AbsFilePath;
    }
  | {
      type: "open-file";
      absFilePath: AbsFilePath;
    }
  | {
      type: "tool-applied";
      absFilePath: AbsFilePath;
      tool: ToolApplication;
      fileTypeInfo: FileTypeInfo;
    };

export type Files = {
  [absFilePath: AbsFilePath]: {
    relFilePath: RelFilePath;
    fileTypeInfo: FileTypeInfo;
    /** What was the last update we sent to the agent about this file?
     */
    agentView:
      | { type: "text"; content: string }
      | { type: "binary" }
      | {
          type: "pdf";
          summary: boolean;
          pages: number[];
          supportsPageExtraction: boolean;
        }
      | undefined;
  };
};

export type Patch = string & { __patch: true };

export type WholeFileUpdate = {
  type: "whole-file";
  content: ProviderMessageContent[];
  pdfPage?: number; // If this update contains a specific PDF page
  pdfSummary?: boolean; // If this update contains PDF summary
};

export type DiffUpdate = {
  type: "diff";
  patch: Patch;
};

export type FileDeletedUpdate = {
  type: "file-deleted";
};

export type FileUpdate = WholeFileUpdate | DiffUpdate | FileDeletedUpdate;

export type FileUpdates = {
  [absFilePath: AbsFilePath]: {
    absFilePath: AbsFilePath;
    relFilePath: RelFilePath;
    update: Result<FileUpdate>;
  };
};

export class ContextManager {
  public files: Files;

  constructor(
    public myDispatch: Dispatch<Msg>,
    private context: {
      cwd: NvimCwd;
      homeDir: HomeDir;
      dispatch: Dispatch<RootMsg>;
      fileIO: FileIO;
      nvim: Nvim;
      options: MagentaOptions;
    },
    initialFiles: Files = {},
  ) {
    this.files = initialFiles;
  }

  /** Add files to the context manager.
   * Used when creating threads with context files or after compaction.
   */
  async addFiles(filePaths: UnresolvedFilePath[]): Promise<void> {
    for (const filePath of filePaths) {
      const absFilePath = resolveFilePath(
        this.context.cwd,
        filePath,
        this.context.homeDir,
      );
      const relFilePath = relativePath(
        this.context.cwd,
        absFilePath,
        this.context.homeDir,
      );

      const fileTypeInfo = await detectFileType(absFilePath);
      if (!fileTypeInfo) {
        this.context.nvim.logger.warn(
          `File ${filePath} does not exist, skipping in context`,
        );
        continue;
      }

      if (fileTypeInfo.category === FileCategory.UNSUPPORTED) {
        this.context.nvim.logger.warn(
          `Skipping ${filePath}: unsupported file type`,
        );
        continue;
      }

      this.files[absFilePath] = {
        relFilePath,
        fileTypeInfo,
        agentView: undefined,
      };
    }
  }

  reset() {
    // Reset agent view for all files
    for (const absFilePath in this.files) {
      this.files[absFilePath as AbsFilePath].agentView = undefined;
    }
  }

  update(msg: Msg): void {
    switch (msg.type) {
      case "add-file-context":
        if (msg.fileTypeInfo.category === FileCategory.UNSUPPORTED) {
          throw new Error(
            `Cannot add ${msg.relFilePath} to context: ${msg.fileTypeInfo.category} files are not supported in context (detected MIME type: ${msg.fileTypeInfo.mimeType})`,
          );
        }

        this.files[msg.absFilePath] = {
          relFilePath: msg.relFilePath,
          fileTypeInfo: msg.fileTypeInfo,
          agentView: undefined,
        };

        return;

      case "remove-file-context": {
        delete this.files[msg.absFilePath];
        return;
      }

      case "open-file": {
        const fileInfo = this.files[msg.absFilePath];

        if (fileInfo && fileInfo.fileTypeInfo.category !== FileCategory.TEXT) {
          // For non-text files (images, PDFs, etc.), use the OS's default application
          open(msg.absFilePath).catch((error: Error) => {
            this.context.nvim.logger.error(
              `Failed to open file with OS: ${error.message}`,
            );
          });
        } else {
          // For text files or files not in context, open in neovim
          openFileInNonMagentaWindow(msg.absFilePath, {
            nvim: this.context.nvim,
            cwd: this.context.cwd,
            homeDir: this.context.homeDir,
            options: this.context.options,
          }).catch((e: Error) => this.context.nvim.logger.error(e.message));
        }

        return;
      }

      case "tool-applied": {
        const relFilePath = relativePath(
          this.context.cwd,
          msg.absFilePath,
          this.context.homeDir,
        );

        // make sure we add the file to context
        if (!this.files[msg.absFilePath]) {
          this.files[msg.absFilePath] = {
            relFilePath,
            fileTypeInfo: msg.fileTypeInfo,
            agentView: undefined,
          };
        }

        this.updateAgentsViewOfFiles(msg.absFilePath, msg.tool);
        return;
      }
      default:
        assertUnreachable(msg);
    }
  }

  isContextEmpty(): boolean {
    return Object.keys(this.files).length == 0;
  }

  private updateAgentsViewOfFiles(
    absFilePath: AbsFilePath,
    tool: ToolApplication,
  ) {
    const fileInfo = this.files[absFilePath];
    if (!fileInfo) {
      throw new Error(`File ${absFilePath} not found in context`);
    }

    switch (tool.type) {
      case "get-file":
        if (fileInfo.fileTypeInfo.category === FileCategory.PDF) {
          throw new Error(
            `PDF file ${absFilePath} should use get-file-pdf action`,
          );
        } else {
          // For text files and other content
          fileInfo.agentView = {
            type: "text",
            content: tool.content,
          };
        }

        return;

      case "get-file-binary":
        fileInfo.agentView = {
          type: "binary",
        };
        return;

      case "get-file-pdf": {
        // Initialize or update PDF agent view
        if (fileInfo.agentView?.type === "pdf") {
          if (tool.content.type == "summary") {
            fileInfo.agentView.summary = true;
          } else {
            if (!fileInfo.agentView.pages.includes(tool.content.pdfPage)) {
              fileInfo.agentView.pages.push(tool.content.pdfPage);
              fileInfo.agentView.pages.sort((a, b) => a - b);
            }
          }
        } else {
          // Initialize PDF view if not already set
          fileInfo.agentView = {
            type: "pdf",
            summary: tool.content.type == "summary",
            pages: tool.content.type == "page" ? [tool.content.pdfPage] : [],
            supportsPageExtraction: true,
          };
        }
        return;
      }

      case "edl-edit": {
        fileInfo.agentView = { type: "text", content: tool.content };
        return;
      }
      default:
        assertUnreachable(tool);
    }
  }

  /** we're about to send a user message to the agent. Find any changes that have happened to the files in context
   * that the agent doesn't know about yet, and update them.
   */
  async getContextUpdate(): Promise<FileUpdates> {
    if (this.isContextEmpty()) {
      return {};
    }

    const keys = Object.keys(this.files) as AbsFilePath[];
    const entries = await Promise.all(
      keys.map(async (absFilePath) => {
        const result = await this.getFileMessageAndUpdateAgentViewOfFile({
          absFilePath,
        });
        return { absFilePath, result };
      }),
    );

    // Build results in insertion order of this.files
    const results: FileUpdates = {};
    for (const { absFilePath, result } of entries) {
      if (result?.update) {
        results[absFilePath] = result;
      }
    }

    return results;
  }

  private async getFileMessageAndUpdateAgentViewOfFile({
    absFilePath,
  }: {
    absFilePath: AbsFilePath;
  }): Promise<FileUpdates[keyof FileUpdates] | undefined> {
    const relFilePath = relativePath(
      this.context.cwd,
      absFilePath,
      this.context.homeDir,
    );
    const fileInfo = this.files[absFilePath];

    if (!fileInfo) {
      // File not in context, skip
      return undefined;
    }

    // Check if file exists first
    if (!(await this.context.fileIO.fileExists(absFilePath))) {
      // File has been deleted or moved, remove it from context
      delete this.files[absFilePath];

      return {
        absFilePath,
        relFilePath,
        update: {
          status: "ok",
          value: {
            type: "file-deleted",
          },
        },
      };
    }

    if (fileInfo.fileTypeInfo.category === FileCategory.TEXT) {
      return await this.handleTextFileUpdate(
        absFilePath,
        relFilePath,
        fileInfo,
      );
    } else {
      return this.handleBinaryFileUpdate(absFilePath, relFilePath, fileInfo);
    }
  }

  private async handleTextFileUpdate(
    absFilePath: AbsFilePath,
    relFilePath: RelFilePath,
    fileInfo: Files[AbsFilePath],
  ): Promise<FileUpdates[keyof FileUpdates] | undefined> {
    let currentFileContent: string;
    try {
      currentFileContent = await this.context.fileIO.readFile(absFilePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        delete this.files[absFilePath];
        return {
          absFilePath,
          relFilePath,
          update: {
            status: "ok",
            value: {
              type: "file-deleted",
            },
          },
        };
      }
      return {
        absFilePath,
        relFilePath,
        update: {
          status: "error",
          error: `Error reading file ${absFilePath}: ${(err as Error).message}\n${(err as Error).stack}`,
        },
      };
    }

    // For text files, track the agent's view and generate diffs
    const prevContent =
      fileInfo.agentView?.type === "text"
        ? fileInfo.agentView.content
        : undefined;

    fileInfo.agentView = {
      type: "text",
      content: currentFileContent,
    };

    if (!prevContent) {
      return {
        absFilePath,
        relFilePath,
        update: {
          status: "ok",
          value: {
            type: "whole-file",
            content: [
              { type: "text", text: `File \`${relFilePath}\`` },
              { type: "text", text: currentFileContent },
            ],
          },
        },
      };
    }

    if (prevContent === currentFileContent) {
      return undefined;
    }

    const patch = diff.createPatch(
      relFilePath,
      prevContent,
      currentFileContent,
      "previous",
      "current",
      {
        context: 2,
      },
    ) as Patch;

    return {
      absFilePath,
      relFilePath,
      update: {
        status: "ok",
        value: { type: "diff", patch },
      },
    };
  }

  private async handleBinaryFileUpdate(
    absFilePath: AbsFilePath,
    relFilePath: RelFilePath,
    fileInfo: Files[AbsFilePath],
  ): Promise<FileUpdates[keyof FileUpdates] | undefined> {
    // Handle binary files (images/PDFs) - always read from disk, no buffer tracking
    try {
      if (fileInfo.agentView != undefined) {
        switch (fileInfo.agentView.type) {
          case "text":
            throw new Error(
              `Unexpected text agentView type in handleBinaryFileUpdate`,
            );
          case "binary": {
            // do nothing - we're assuming that non-text files will not update during the thread
            return;
          }
          case "pdf": {
            if (!fileInfo.agentView.summary) {
              // Generate PDF summary and update agent view
              try {
                const summaryResult =
                  await getSummaryAsProviderContent(absFilePath);
                if (summaryResult.status === "ok") {
                  fileInfo.agentView.summary = true;

                  return {
                    absFilePath,
                    relFilePath,
                    update: {
                      status: "ok",
                      value: {
                        type: "whole-file",
                        content: summaryResult.value,
                        pdfSummary: true,
                      },
                    },
                  };
                } else {
                  return {
                    absFilePath,
                    relFilePath,
                    update: {
                      status: "error",
                      error: `Error generating PDF summary for ${absFilePath}: ${summaryResult.error}`,
                    },
                  };
                }
              } catch (err) {
                return {
                  absFilePath,
                  relFilePath,
                  update: {
                    status: "error",
                    error: `Error generating PDF summary for ${absFilePath}: ${(err as Error).message}`,
                  },
                };
              }
            }
            break;
          }
        }
      } else {
        if (fileInfo.fileTypeInfo.category == FileCategory.PDF) {
          // Generate PDF summary and create the pdf agentView with summary = true
          try {
            const summaryResult =
              await getSummaryAsProviderContent(absFilePath);
            if (summaryResult.status === "ok") {
              fileInfo.agentView = {
                type: "pdf",
                summary: true,
                pages: [],
                supportsPageExtraction: true,
              };

              return {
                absFilePath,
                relFilePath,
                update: {
                  status: "ok",
                  value: {
                    type: "whole-file",
                    content: summaryResult.value,
                    pdfSummary: true,
                  },
                },
              };
            } else {
              return {
                absFilePath,
                relFilePath,
                update: {
                  status: "error",
                  error: `Error generating PDF summary for ${absFilePath}: ${summaryResult.error}`,
                },
              };
            }
          } catch (err) {
            return {
              absFilePath,
              relFilePath,
              update: {
                status: "error",
                error: `Error generating PDF summary for ${absFilePath}: ${(err as Error).message}`,
              },
            };
          }
        } else if (fileInfo.fileTypeInfo.category == FileCategory.IMAGE) {
          // Handle other binary files (images) with base64
          try {
            const buffer =
              await this.context.fileIO.readBinaryFile(absFilePath);

            fileInfo.agentView = {
              type: "binary",
            };

            return {
              absFilePath,
              relFilePath,
              update: {
                status: "ok",
                value: {
                  type: "whole-file",
                  content: [
                    {
                      type: "image",
                      source: {
                        type: "base64",
                        media_type: fileInfo.fileTypeInfo.mimeType as
                          | "image/jpeg"
                          | "image/png"
                          | "image/gif"
                          | "image/webp",
                        data: buffer.toString("base64"),
                      },
                    },
                  ],
                },
              },
            };
          } catch (err) {
            return {
              absFilePath,
              relFilePath,
              update: {
                status: "error",
                error: `Error reading image file ${absFilePath}: ${(err as Error).message}`,
              },
            };
          }
        }
      }
    } catch (err) {
      return {
        absFilePath,
        relFilePath,
        update: {
          status: "error",
          error: `Error checking file stats for ${absFilePath}: ${(err as Error).message}`,
        },
      };
    }
  }

  /** renders a summary of all the files we're tracking, with the ability to delete or navigate to each file.
   */
  view() {
    const fileContext = [];
    if (Object.keys(this.files).length == 0) {
      return "";
    }

    for (const absFilePath in this.files) {
      const fileInfo = this.files[absFilePath as AbsFilePath];
      const pathForDisplay = displayPath(
        this.context.cwd,
        absFilePath as AbsFilePath,
        this.context.homeDir,
      );

      // Add PDF information if available
      const pdfInfo =
        fileInfo.agentView?.type === "pdf"
          ? this.formatPdfInfo({
              summary: fileInfo.agentView.summary,
              pages: fileInfo.agentView.pages,
            })
          : "";

      fileContext.push(
        withBindings(
          d`- ${withInlineCode(d`\`${pathForDisplay}\`${pdfInfo}`)}\n`,
          {
            dd: () =>
              this.myDispatch({
                type: "remove-file-context",
                absFilePath: absFilePath as AbsFilePath,
              }),
            "<CR>": () =>
              this.myDispatch({
                type: "open-file",
                absFilePath: absFilePath as AbsFilePath,
              }),
          },
        ),
      );
    }

    return d`\
${withExtmark(d`# context:`, { hl_group: "@markup.heading.1.markdown" })}
${fileContext}`;
  }

  private formatPageRanges(pages: number[]): string {
    if (pages.length === 0) return "";

    const ranges: string[] = [];
    let start = pages[0];
    let end = pages[0];

    for (let i = 1; i < pages.length; i++) {
      if (pages[i] === end + 1) {
        end = pages[i];
      } else {
        if (start === end) {
          ranges.push(start.toString());
        } else {
          ranges.push(`${start}-${end}`);
        }
        start = pages[i];
        end = pages[i];
      }
    }

    // Add the last range
    if (start === end) {
      ranges.push(start.toString());
    } else {
      ranges.push(`${start}-${end}`);
    }

    return ranges.join(", ");
  }

  private formatPdfInfo(options: {
    summary?: boolean | undefined;
    pages?: number[] | undefined;
  }): string {
    const parts: string[] = [];

    if (options.summary) {
      parts.push("summary");
    }

    if (options.pages && options.pages.length == 1) {
      parts.push(`page ${options.pages[0]}`);
    } else if (options.pages && options.pages.length > 1) {
      const pageRanges = this.formatPageRanges(options.pages);
      parts.push(`pages ${pageRanges}`);
    }

    if (parts.length > 0) {
      return ` (${parts.join(", ")})`;
    }

    return "";
  }

  renderContextUpdate(contextUpdates: FileUpdates | undefined) {
    if (!(contextUpdates && Object.keys(contextUpdates).length)) {
      return "";
    }

    const fileUpdates = [];
    for (const path in contextUpdates) {
      const absFilePath = path as AbsFilePath;
      const update = contextUpdates[absFilePath];

      if (update.update.status === "ok") {
        let changeIndicator = "";
        switch (update.update.value.type) {
          case "diff": {
            // Count additions and deletions in the patch
            const patch = update.update.value.patch;
            const additions = (patch.match(/^\+[^+]/gm) || []).length;
            const deletions = (patch.match(/^-[^-]/gm) || []).length;
            changeIndicator = `[ +${additions} / -${deletions} ]`;
            break;
          }
          case "whole-file": {
            // Count lines in the whole file content - use the last text block
            let lineCount = 0;
            const lastTextBlock = update.update.value.content.findLast(
              (block) => block.type === "text",
            );
            if (lastTextBlock && lastTextBlock.type === "text") {
              lineCount = (lastTextBlock.text.match(/\n/g) || []).length + 1;
            }
            changeIndicator = `[ +${lineCount} ]`;
            break;
          }
          case "file-deleted": {
            changeIndicator = "[ deleted ]";
            break;
          }
          default:
            assertUnreachable(update.update.value);
        }

        // Add PDF page information if available from the update
        const pdfInfo =
          update.update.value.type === "whole-file"
            ? this.formatPdfInfo({
                summary: update.update.value.pdfSummary,
                pages: update.update.value.pdfPage
                  ? [update.update.value.pdfPage]
                  : undefined,
              })
            : "";

        const pathForDisplay = displayPath(
          this.context.cwd,
          absFilePath,
          this.context.homeDir,
        );

        const filePathLink = withBindings(
          d`- \`${pathForDisplay}\`${pdfInfo}`,
          {
            "<CR>": () =>
              this.myDispatch({
                type: "open-file",
                absFilePath,
              }),
          },
        );

        fileUpdates.push(d`${filePathLink} ${changeIndicator}\n`);
      } else {
        fileUpdates.push(
          d`- \`${absFilePath}\` [Error: ${update.update.error}]\n`,
        );
      }
    }

    return fileUpdates.length > 0 ? d`Context Updates:\n${fileUpdates}\n` : "";
  }

  contextUpdatesToContent(
    contextUpdates: FileUpdates,
  ): ProviderMessageContent[] {
    const textParts: string[] = [];
    const filePathEntries: string[] = [];

    for (const path in contextUpdates) {
      const absFilePath = path as AbsFilePath;
      const update = contextUpdates[absFilePath];

      if (update.update.status === "ok") {
        switch (update.update.value.type) {
          case "whole-file": {
            let lineCount = 0;
            for (const c of update.update.value.content) {
              if (c.type === "text") {
                textParts.push(c.text);
                lineCount = (c.text.match(/\n/g) || []).length + 1;
              }
            }
            filePathEntries.push(`${update.relFilePath} (${lineCount} lines)`);
            break;
          }
          case "diff": {
            const patch = update.update.value.patch;
            const additions = (patch.match(/^\+[^+]/gm) || []).length;
            const deletions = (patch.match(/^-[^-]/gm) || []).length;
            filePathEntries.push(
              `${update.relFilePath} (+${additions}/-${deletions})`,
            );
            textParts.push(`\
- \`${absFilePath}\`
\`\`\`diff
${update.update.value.patch}
\`\`\``);
            break;
          }
          case "file-deleted": {
            filePathEntries.push(`${update.relFilePath} (deleted)`);
            textParts.push(`\
- \`${absFilePath}\`
This file has been deleted and removed from context.`);
            break;
          }
          default:
            assertUnreachable(update.update.value);
        }
      } else {
        filePathEntries.push(`${update.relFilePath} (error)`);
        textParts.push(`\
- \`${absFilePath}\`
Error fetching update: ${update.update.error}`);
      }
    }

    if (textParts.length === 0) {
      return [];
    }

    const header = `\
These files are part of your context. This is the latest information about the content of each file.
From now on, whenever any of these files are updated by the user, you will get a message letting you know.`;
    const fileList = `<file_paths>\n${filePathEntries.join("\n")}\n</file_paths>`;

    return [
      {
        type: "text",
        text: `<context_update>\n${fileList}\n${header}\n${textParts.join("\n")}\n</context_update>`,
      },
    ];
  }
}
