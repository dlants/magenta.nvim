import { assertUnreachable } from "../utils/assertUnreachable.ts";
import {
  d,
  withBindings,
  withCode,
  withExtmark,
  type VDOMNode,
} from "../tea/view.ts";
import type { Result } from "../utils/result.ts";
import type { CompletedToolInfo } from "./types.ts";

import type { Nvim } from "../nvim/nvim-node";
import {
  resolveFilePath,
  displayPath,
  FileCategory,
  type UnresolvedFilePath,
  type NvimCwd,
  type HomeDir,
} from "../utils/files.ts";
import type { MagentaOptions } from "../options.ts";
import { canReadFile, canWriteFile } from "./permissions.ts";
import type {
  ProviderToolResult,
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { StaticTool, ToolName, GenericToolRequest } from "./types.ts";
import {
  runScript,
  analyzeFileAccess,
  type FileAccessInfo,
  type EdlRegisters,
} from "../edl/index.ts";
import type { FileMutationSummary } from "../edl/types.ts";
import type { BufferTracker } from "../buffer-tracker.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { Msg as ThreadMsg } from "../chat/thread.ts";
import { BufferAwareFileIO } from "./buffer-file-io.ts";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const EDL_DESCRIPTION = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "edl-description.md"),
  "utf-8",
);

type EdlDisplayData = {
  mutations: { path: string; summary: FileMutationSummary }[];
  fileErrorCount: number;
  finalSelectionCount: number | undefined;
};

const EDL_DISPLAY_PREFIX = "__EDL_DISPLAY__";
export type ToolRequest = GenericToolRequest<"edl", Input>;

export type State =
  | {
      state: "pending";
    }
  | {
      state: "pending-user-action";
      deniedFiles: DeniedFileAccess[];
    }
  | {
      state: "processing";
    }
  | {
      state: "done";
      result: ProviderToolResult;
    };

type DeniedFileAccess = FileAccessInfo & {
  displayPath: string;
};

export type Msg =
  | {
      type: "finish";
      result: Result<ProviderToolResultContent[]>;
    }
  | {
      type: "permissions-ok";
    }
  | {
      type: "permissions-denied";
      deniedFiles: DeniedFileAccess[];
    }
  | {
      type: "user-approval";
      approved: boolean;
    };

export class EdlTool implements StaticTool {
  state: State;
  toolName = "edl" as const;
  autoRespond = true;
  aborted: boolean = false;

  constructor(
    public request: ToolRequest,
    public context: {
      nvim: Nvim;
      cwd: NvimCwd;
      homeDir: HomeDir;
      options: MagentaOptions;
      myDispatch: (msg: Msg) => void;
      bufferTracker: BufferTracker;
      threadDispatch: Dispatch<ThreadMsg>;
      edlRegisters: EdlRegisters;
    },
  ) {
    this.state = {
      state: "pending",
    };

    setTimeout(() => {
      this.checkPermissions().catch((error) => {
        this.context.nvim.logger.error(
          `Error checking EDL permissions: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
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
      return this.getToolResult();
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
        if (this.state.state == "processing") {
          this.state = {
            state: "done",
            result: {
              type: "tool_result",
              id: this.request.id,
              result: msg.result,
            },
          };
        }
        return;

      case "permissions-ok":
        if (this.state.state === "pending") {
          this.state = { state: "processing" };
          this.executeScript().catch((error) => {
            this.context.nvim.logger.error(
              `Error executing EDL script: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        }
        return;

      case "permissions-denied":
        if (this.state.state === "pending") {
          this.state = {
            state: "pending-user-action",
            deniedFiles: msg.deniedFiles,
          };
        }
        return;

      case "user-approval":
        if (this.state.state === "pending-user-action") {
          if (msg.approved) {
            this.state = { state: "processing" };
            this.executeScript().catch((error) => {
              this.context.nvim.logger.error(
                `Error executing EDL script: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
          } else {
            this.state = {
              state: "done",
              result: {
                type: "tool_result",
                id: this.request.id,
                result: {
                  status: "error",
                  error:
                    "The user did not approve the file access required by this EDL script.",
                },
              },
            };
          }
        }
        return;

      default:
        assertUnreachable(msg);
    }
  }

  async checkPermissions() {
    if (this.aborted) return;

    const script = this.request.input.script;
    let fileAccesses: FileAccessInfo[];
    try {
      fileAccesses = analyzeFileAccess(script);
    } catch {
      // If parsing fails, we'll let executeScript handle the error
      this.context.myDispatch({ type: "permissions-ok" });
      return;
    }

    if (fileAccesses.length === 0) {
      this.context.myDispatch({ type: "permissions-ok" });
      return;
    }

    const deniedFiles: DeniedFileAccess[] = [];

    for (const access of fileAccesses) {
      const absPath = resolveFilePath(
        this.context.cwd,
        access.path as UnresolvedFilePath,
        this.context.homeDir,
      );
      const dp = displayPath(this.context.cwd, absPath, this.context.homeDir);

      if (access.read) {
        const canRead = await canReadFile(absPath, this.context);
        if (!canRead) {
          deniedFiles.push({ ...access, displayPath: dp });
          continue;
        }
      }

      if (access.write) {
        const hasWrite = canWriteFile(absPath, this.context);
        if (!hasWrite) {
          deniedFiles.push({ ...access, displayPath: dp });
        }
      }
    }

    if (deniedFiles.length === 0) {
      this.context.myDispatch({ type: "permissions-ok" });
    } else {
      this.context.myDispatch({
        type: "permissions-denied",
        deniedFiles,
      });
    }
  }
  async executeScript() {
    try {
      const script = this.request.input.script;
      const fileIO = new BufferAwareFileIO(this.context);
      const result = await runScript(script, fileIO, this.context.edlRegisters);

      if (this.aborted) return;

      if (result.status === "ok") {
        this.context.edlRegisters.registers = result.edlRegisters.registers;
        this.context.edlRegisters.nextSavedId = result.edlRegisters.nextSavedId;

        for (const mutation of result.data.mutations) {
          const absFilePath = resolveFilePath(
            this.context.cwd,
            mutation.path as Parameters<typeof resolveFilePath>[1],
            this.context.homeDir,
          );
          this.context.threadDispatch({
            type: "context-manager-msg",
            msg: {
              type: "tool-applied",
              absFilePath,
              tool: {
                type: "edl-edit",
                content: mutation.content,
              },
              fileTypeInfo: {
                category: FileCategory.TEXT,
                mimeType: "text/plain",
                extension: "",
              },
            },
          });
        }

        const displayData: EdlDisplayData = {
          mutations: result.data.mutations.map((m) => ({
            path: m.path,
            summary: m.summary,
          })),
          fileErrorCount: result.data.fileErrors.length,
          finalSelectionCount: result.data.finalSelection
            ? result.data.finalSelection.ranges.length
            : undefined,
        };

        this.context.myDispatch({
          type: "finish",
          result: {
            status: "ok",
            value: [
              {
                type: "text",
                text: `${EDL_DISPLAY_PREFIX}${JSON.stringify(displayData)}`,
              },
              { type: "text", text: result.formatted },
            ],
          },
        });
      } else {
        this.context.myDispatch({
          type: "finish",
          result: {
            status: "error",
            error: result.error,
          },
        });
      }
    } catch (error) {
      if (this.aborted) return;
      this.context.myDispatch({
        type: "finish",
        result: {
          status: "error",
          error: `Failed to execute EDL script: ${(error as Error).message}`,
        },
      });
    }
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
                text: `Waiting for user approval to access files required by this EDL script.`,
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
        return d`📝⚙️ edl checking permissions...`;
      case "pending-user-action": {
        const fileList = this.state.deniedFiles
          .map((f) => {
            const access = f.write ? "read/write" : "read";
            return `  ${f.displayPath} (${access})`;
          })
          .join("\n");
        return d`📝⏳ EDL script needs file access:
${fileList}
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
      }
      case "processing":
        return d`📝⚙️ edl script executing...`;
      case "done":
        return renderCompletedSummary({
          request: this.request as CompletedToolInfo["request"],
          result: this.state.result,
        });
      default:
        assertUnreachable(this.state);
    }
  }

  renderPreview() {
    const abridged = abridgeScript(this.request.input.script);
    switch (this.state.state) {
      case "pending":
      case "pending-user-action":
      case "processing":
        return withCode(d`\`\`\`
${abridged}
\`\`\``);
      case "done":
        return renderCompletedPreview({
          request: this.request as CompletedToolInfo["request"],
          result: this.state.result,
        });
      default:
        assertUnreachable(this.state);
    }
  }

  renderDetail() {
    const scriptBlock = withCode(d`\`\`\`
${this.request.input.script}
\`\`\``);
    switch (this.state.state) {
      case "pending":
      case "pending-user-action":
      case "processing":
        return scriptBlock;
      case "done":
        return d`${scriptBlock}
${renderCompletedDetail({
  request: this.request as CompletedToolInfo["request"],
  result: this.state.result,
})}`;
      default:
        assertUnreachable(this.state);
    }
  }
  displayInput() {
    const script = this.request.input.script;
    const preview =
      script.length > 100 ? script.substring(0, 100) + "..." : script;
    return `edl: {
    script: ${preview}
}`;
  }
}

const PREVIEW_MAX_LINES = 10;
const PREVIEW_MAX_LINE_LENGTH = 80;

function abridgeScript(script: string): string {
  const lines = script.split("\n");
  const preview = lines
    .slice(0, PREVIEW_MAX_LINES)
    .map((line) =>
      line.length > PREVIEW_MAX_LINE_LENGTH
        ? line.substring(0, PREVIEW_MAX_LINE_LENGTH) + "..."
        : line,
    );
  if (lines.length > PREVIEW_MAX_LINES) {
    preview.push(`... (${lines.length - PREVIEW_MAX_LINES} more lines)`);
  }
  return preview.join("\n");
}
function isError(result: CompletedToolInfo["result"]): boolean {
  return result.result.status === "error";
}

function getStatusEmoji(result: CompletedToolInfo["result"]): string {
  return isError(result) ? "❌" : "✅";
}

function extractEdlDisplayData(
  info: CompletedToolInfo,
): EdlDisplayData | undefined {
  if (info.result.result.status !== "ok") return undefined;
  const content = info.result.result.value;
  for (const item of content) {
    if (item.type === "text" && item.text.startsWith(EDL_DISPLAY_PREFIX)) {
      try {
        return JSON.parse(
          item.text.slice(EDL_DISPLAY_PREFIX.length),
        ) as EdlDisplayData;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
function extractFormattedResult(info: CompletedToolInfo): string {
  if (info.result.result.status !== "ok") {
    return info.result.result.error;
  }
  const content = info.result.result.value;
  for (const item of content) {
    if (item.type === "text" && !item.text.startsWith(EDL_DISPLAY_PREFIX)) {
      return item.text;
    }
  }
  return "";
}

export function renderCompletedSummary(info: CompletedToolInfo): VDOMNode {
  const status = getStatusEmoji(info.result);
  const data = extractEdlDisplayData(info);

  if (data) {
    const totalMutations = data.mutations.reduce(
      (acc, m) =>
        acc +
        m.summary.replacements +
        m.summary.insertions +
        m.summary.deletions,
      0,
    );
    const filesCount = data.mutations.length;
    const fileErrorCount = data.fileErrorCount;
    const errorSuffix =
      fileErrorCount > 0
        ? ` (${String(fileErrorCount)} file error${fileErrorCount !== 1 ? "s" : ""})`
        : "";
    return d`📝${status} edl: ${String(totalMutations)} mutations in ${String(filesCount)} file${filesCount !== 1 ? "s" : ""}${errorSuffix}`;
  }

  return d`📝${status} edl script`;
}

export function renderCompletedPreview(info: CompletedToolInfo): VDOMNode {
  const input = info.request.input as Input;
  const abridged = abridgeScript(input.script);
  const scriptBlock = withCode(d`\`\`\`
${abridged}
\`\`\``);
  const data = extractEdlDisplayData(info);
  if (!data || isError(info.result)) return scriptBlock;

  const lines: string[] = [];

  for (const { path, summary } of data.mutations) {
    const parts: string[] = [];
    if (summary.replacements > 0) parts.push(`${summary.replacements} replace`);
    if (summary.insertions > 0) parts.push(`${summary.insertions} insert`);
    if (summary.deletions > 0) parts.push(`${summary.deletions} delete`);
    lines.push(
      `  ${path}: ${parts.join(", ")} (+${summary.linesAdded}/-${summary.linesRemoved})`,
    );
  }

  if (data.finalSelectionCount != undefined) {
    lines.push(
      `  Final selection: ${data.finalSelectionCount} range${data.finalSelectionCount !== 1 ? "s" : ""}`,
    );
  }

  return d`${scriptBlock}
${lines.join("\n")}`;
}

export function renderCompletedDetail(info: CompletedToolInfo): VDOMNode {
  const input = info.request.input as Input;
  const scriptBlock = withCode(d`\`\`\`
${input.script}
\`\`\``);
  return d`${scriptBlock}
${extractFormattedResult(info)}`;
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

export type Input = {
  script: string;
};

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
