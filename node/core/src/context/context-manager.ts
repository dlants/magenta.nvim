import * as diff from "diff";
import type {
  ContextTracker,
  ToolApplied,
  TrackedFileInfo,
} from "../capabilities/context-tracker.ts";
import type { FileIO } from "../capabilities/file-io.ts";
import { Emitter } from "../emitter.ts";
import type { Logger } from "../logger.ts";
import type { ProviderMessageContent } from "../providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "../providers/provider-types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import {
  type AbsFilePath,
  detectFileType,
  FileCategory,
  type FileTypeInfo,
  type HomeDir,
  type NvimCwd,
  type RelFilePath,
  relativePath,
  resolveFilePath,
  type UnresolvedFilePath,
} from "../utils/files.ts";
import { getSummaryAsProviderContent } from "../utils/pdf-pages.ts";
import type { Result } from "../utils/result.ts";

export type Patch = string & { __patch: true };

export type WholeFileUpdate = {
  type: "whole-file";
  content: ProviderMessageContent[];
  pdfPage?: number;
  pdfSummary?: boolean;
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

function pendingUpdatesEqual(a: FileUpdates, b: FileUpdates): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    const abs = k as AbsFilePath;
    const av = a[abs];
    const bv = b[abs];
    if (!bv) return false;
    if (av.update.status !== bv.update.status) return false;
    if (av.update.status === "error" && bv.update.status === "error") {
      if (av.update.error !== bv.update.error) return false;
      continue;
    }
    if (av.update.status === "ok" && bv.update.status === "ok") {
      const avv = av.update.value;
      const bvv = bv.update.value;
      if (avv.type !== bvv.type) return false;
      if (avv.type === "diff" && bvv.type === "diff") {
        if (avv.patch !== bvv.patch) return false;
      } else if (avv.type === "whole-file" && bvv.type === "whole-file") {
        if (JSON.stringify(avv.content) !== JSON.stringify(bvv.content)) {
          return false;
        }
      }
    }
  }
  return true;
}

export type FileStat = { mtimeMs: number; size: number };

export type Files = {
  [absFilePath: AbsFilePath]: {
    relFilePath: RelFilePath;
    fileTypeInfo: FileTypeInfo;
    agentView: TrackedFileInfo["agentView"];
    lastStat?: FileStat | undefined;
  };
};

export type ContextManagerEvents = {
  fileAdded: [absFilePath: AbsFilePath];
  fileRemoved: [absFilePath: AbsFilePath];
  filesReset: [];
  pendingUpdatesChanged: [];
};

export class ContextManager
  extends Emitter<ContextManagerEvents>
  implements ContextTracker
{
  public files: Files;
  private pendingUpdates: FileUpdates = {};
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private destroyed = false;
  private readonly pollIntervalMs: number | undefined;

  constructor(
    private logger: Logger,
    private fileIO: FileIO,
    private cwd: NvimCwd,
    private homeDir: HomeDir,
    initialFiles: Files = {},
    pollIntervalMs?: number,
  ) {
    super();
    this.files = initialFiles;
    this.pollIntervalMs = pollIntervalMs;
  }

  start(): void {
    if (this.destroyed || this.pollTimer) return;
    if (this.pollIntervalMs === undefined) return;
    this.pollTimer = setInterval(() => {
      void this.refreshPendingUpdates();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    this.removeAllListeners();
  }

  getPendingUpdates(): FileUpdates {
    return this.pendingUpdates;
  }

  async refreshPendingUpdates(): Promise<void> {
    if (this.destroyed) return;

    const next: FileUpdates = {};
    const keys = Object.keys(this.files) as AbsFilePath[];

    for (const absFilePath of keys) {
      const fileInfo = this.files[absFilePath];
      if (!fileInfo) continue;

      const relFilePath = relativePath(this.cwd, absFilePath, this.homeDir);
      const currentStat = await this.fileIO.stat(absFilePath);

      if (currentStat === undefined) {
        fileInfo.lastStat = undefined;
        next[absFilePath] = {
          absFilePath,
          relFilePath,
          update: {
            status: "ok",
            value: { type: "file-deleted" },
          },
        };
        continue;
      }

      const prevStat = fileInfo.lastStat;
      if (
        prevStat !== undefined &&
        prevStat.mtimeMs === currentStat.mtimeMs &&
        prevStat.size === currentStat.size
      ) {
        const existing = this.pendingUpdates[absFilePath];
        if (existing) {
          next[absFilePath] = existing;
        }
        continue;
      }

      const result = await this.peekFileUpdate(absFilePath);
      fileInfo.lastStat = currentStat;
      if (result?.update) {
        next[absFilePath] = result;
      }
    }

    if (!pendingUpdatesEqual(this.pendingUpdates, next)) {
      this.pendingUpdates = next;
      this.emit("pendingUpdatesChanged");
    } else {
      this.pendingUpdates = next;
    }
  }

  addFileContext(
    absFilePath: AbsFilePath,
    relFilePath: RelFilePath,
    fileTypeInfo: FileTypeInfo,
  ): void {
    if (fileTypeInfo.category === FileCategory.UNSUPPORTED) {
      throw new Error(
        `Cannot add ${relFilePath} to context: ${fileTypeInfo.category} files are not supported in context (detected MIME type: ${fileTypeInfo.mimeType})`,
      );
    }
    this.files[absFilePath] = {
      relFilePath,
      fileTypeInfo,
      agentView: undefined,
    };
    this.emit("fileAdded", absFilePath);
    this.scheduleRefreshPendingUpdates();
  }

  removeFileContext(absFilePath: AbsFilePath): void {
    delete this.files[absFilePath];
    delete this.pendingUpdates[absFilePath];
    this.emit("fileRemoved", absFilePath);
    this.scheduleRefreshPendingUpdates();
  }

  toolApplied(
    absFilePath: AbsFilePath,
    tool: ToolApplied,
    fileTypeInfo: FileTypeInfo,
  ): void {
    const relFilePath = relativePath(this.cwd, absFilePath, this.homeDir);

    const isNew = !this.files[absFilePath];
    if (isNew) {
      this.files[absFilePath] = {
        relFilePath,
        fileTypeInfo,
        agentView: undefined,
      };
    }

    this.updateAgentsViewOfFiles(absFilePath, tool);

    const fileInfo = this.files[absFilePath];
    if (fileInfo) {
      fileInfo.lastStat = undefined;
    }

    if (isNew) {
      this.emit("fileAdded", absFilePath);
    }
    this.scheduleRefreshPendingUpdates();
  }

  async addFiles(filePaths: UnresolvedFilePath[]): Promise<void> {
    for (const filePath of filePaths) {
      const absFilePath = resolveFilePath(this.cwd, filePath, this.homeDir);
      const relFilePath = relativePath(this.cwd, absFilePath, this.homeDir);

      const fileTypeInfo = await detectFileType(absFilePath);
      if (!fileTypeInfo) {
        this.logger.warn(
          `File ${filePath} does not exist, skipping in context`,
        );
        continue;
      }

      if (fileTypeInfo.category === FileCategory.UNSUPPORTED) {
        this.logger.warn(`Skipping ${filePath}: unsupported file type`);
        continue;
      }

      this.files[absFilePath] = {
        relFilePath,
        fileTypeInfo,
        agentView: undefined,
      };
      this.emit("fileAdded", absFilePath);
    }
    this.scheduleRefreshPendingUpdates();
  }

  reset(): void {
    for (const absFilePath in this.files) {
      const entry = this.files[absFilePath as AbsFilePath];
      entry.agentView = undefined;
      entry.lastStat = undefined;
    }
    this.pendingUpdates = {};
    this.emit("filesReset");
    this.scheduleRefreshPendingUpdates();
  }

  private scheduleRefreshPendingUpdates(): void {
    if (this.destroyed) return;
    void this.refreshPendingUpdates().catch((err: Error) => {
      this.logger.error(
        `Error refreshing pending updates: ${err.message}\n${err.stack ?? ""}`,
      );
    });
  }

  isContextEmpty(): boolean {
    return Object.keys(this.files).length === 0;
  }

  async getContextUpdate(): Promise<FileUpdates> {
    if (this.isContextEmpty()) {
      return {};
    }

    const keys = Object.keys(this.files) as AbsFilePath[];
    const entries = await Promise.all(
      keys.map(async (absFilePath) => {
        const result = await this.getFileMessageAndUpdateAgentViewOfFile({
          absFilePath,
          commit: true,
        });
        return { absFilePath, result };
      }),
    );

    const results: FileUpdates = {};
    for (const { absFilePath, result } of entries) {
      if (result?.update) {
        results[absFilePath] = result;
        const fileInfo = this.files[absFilePath];
        if (fileInfo) {
          fileInfo.lastStat = undefined;
        }
      }
    }

    await this.refreshPendingUpdates();

    return results;
  }

  contextUpdatesToContent(
    contextUpdates: FileUpdates,
  ): ProviderMessageContent[] {
    const textParts: string[] = [];
    const filePathEntries: string[] = [];
    const mediaParts: ProviderMessageContent[] = [];

    for (const path in contextUpdates) {
      const absFilePath = path as AbsFilePath;
      const update = contextUpdates[absFilePath];

      if (update.update.status === "ok") {
        switch (update.update.value.type) {
          case "whole-file": {
            let lineCount = 0;
            let mediaKind: "image" | "document" | null = null;
            for (const c of update.update.value.content) {
              if (c.type === "text") {
                textParts.push(c.text);
                lineCount = (c.text.match(/\n/g) || []).length + 1;
              } else if (c.type === "image" || c.type === "document") {
                mediaParts.push(c);
                mediaKind = c.type;
              }
            }
            if (mediaKind) {
              filePathEntries.push(
                `${update.relFilePath} (${mediaKind} attachment)`,
              );
              textParts.push(`\
- \`${absFilePath}\`
${mediaKind === "image" ? "Image" : "Document"} attached below.`);
            } else {
              filePathEntries.push(
                `${update.relFilePath} (${lineCount} lines)`,
              );
            }
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

    if (textParts.length === 0 && mediaParts.length === 0) {
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
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
      ...mediaParts,
    ];
  }

  private async getFileMessageAndUpdateAgentViewOfFile({
    absFilePath,
    commit,
  }: {
    absFilePath: AbsFilePath;
    commit: boolean;
  }): Promise<FileUpdates[keyof FileUpdates] | undefined> {
    const relFilePath = relativePath(this.cwd, absFilePath, this.homeDir);
    const fileInfo = this.files[absFilePath];

    if (!fileInfo) {
      return undefined;
    }

    if (!(await this.fileIO.fileExists(absFilePath))) {
      if (commit) {
        delete this.files[absFilePath];
      }
      return {
        absFilePath,
        relFilePath,
        update: {
          status: "ok",
          value: { type: "file-deleted" },
        },
      };
    }

    if (fileInfo.fileTypeInfo.category === FileCategory.TEXT) {
      return await this.handleTextFileUpdate(
        absFilePath,
        relFilePath,
        fileInfo,
        commit,
      );
    } else {
      return this.handleBinaryFileUpdate(
        absFilePath,
        relFilePath,
        fileInfo,
        commit,
      );
    }
  }

  async peekFileUpdate(
    absFilePath: AbsFilePath,
  ): Promise<FileUpdates[keyof FileUpdates] | undefined> {
    return this.getFileMessageAndUpdateAgentViewOfFile({
      absFilePath,
      commit: false,
    });
  }

  private async handleTextFileUpdate(
    absFilePath: AbsFilePath,
    relFilePath: RelFilePath,
    fileInfo: Files[AbsFilePath],
    commit: boolean,
  ): Promise<FileUpdates[keyof FileUpdates] | undefined> {
    let currentFileContent: string;
    try {
      currentFileContent = await this.fileIO.readFile(absFilePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        if (commit) {
          delete this.files[absFilePath];
        }
        return {
          absFilePath,
          relFilePath,
          update: {
            status: "ok",
            value: { type: "file-deleted" },
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

    const prevContent =
      fileInfo.agentView?.type === "text"
        ? fileInfo.agentView.content
        : undefined;

    if (commit) {
      fileInfo.agentView = {
        type: "text",
        content: currentFileContent,
      };
    }

    if (!prevContent) {
      return {
        absFilePath,
        relFilePath,
        update: {
          status: "ok",
          value: {
            type: "whole-file",
            content: [
              { type: "text", text: `File \`${relFilePath}\``, nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX },
              { type: "text", text: currentFileContent, nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX },
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
      { context: 2 },
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
    commit: boolean,
  ): Promise<FileUpdates[keyof FileUpdates] | undefined> {
    try {
      if (fileInfo.agentView !== undefined) {
        switch (fileInfo.agentView.type) {
          case "text":
            throw new Error(
              `Unexpected text agentView type in handleBinaryFileUpdate`,
            );
          case "binary":
            return;
          case "pdf": {
            if (!fileInfo.agentView.summary) {
              try {
                const summaryResult =
                  await getSummaryAsProviderContent(absFilePath);
                if (summaryResult.status === "ok") {
                  if (commit) {
                    fileInfo.agentView.summary = true;
                  }
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
        if (fileInfo.fileTypeInfo.category === FileCategory.PDF) {
          try {
            const summaryResult =
              await getSummaryAsProviderContent(absFilePath);
            if (summaryResult.status === "ok") {
              if (commit) {
                fileInfo.agentView = {
                  type: "pdf",
                  summary: true,
                  pages: [],
                  supportsPageExtraction: true,
                };
              }
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
        } else if (fileInfo.fileTypeInfo.category === FileCategory.IMAGE) {
          try {
            const buffer = await this.fileIO.readBinaryFile(absFilePath);
            if (commit) {
              fileInfo.agentView = { type: "binary" };
            }
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
                      nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
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

  private updateAgentsViewOfFiles(
    absFilePath: AbsFilePath,
    tool: ToolApplied,
  ): void {
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
          fileInfo.agentView = { type: "text", content: tool.content };
        }
        return;

      case "get-file-binary":
        fileInfo.agentView = { type: "binary" };
        return;

      case "get-file-pdf": {
        if (fileInfo.agentView?.type === "pdf") {
          if (tool.content.type === "summary") {
            fileInfo.agentView.summary = true;
          } else {
            if (!fileInfo.agentView.pages.includes(tool.content.pdfPage)) {
              fileInfo.agentView.pages.push(tool.content.pdfPage);
              fileInfo.agentView.pages.sort((a, b) => a - b);
            }
          }
        } else {
          fileInfo.agentView = {
            type: "pdf",
            summary: tool.content.type === "summary",
            pages: tool.content.type === "page" ? [tool.content.pdfPage] : [],
            supportsPageExtraction: true,
          };
        }
        return;
      }

      case "edl-edit":
        fileInfo.agentView = { type: "text", content: tool.content };
        return;

      default:
        assertUnreachable(tool);
    }
  }
}
