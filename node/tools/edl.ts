import { d, withCode, type VDOMNode } from "../tea/view.ts";
import type { Result } from "../utils/result.ts";
import type { CompletedToolInfo } from "./types.ts";
import type { DisplayContext } from "./types.ts";

import type { Nvim } from "../nvim/nvim-node";
import {
  resolveFilePath,
  FileCategory,
  type NvimCwd,
  type HomeDir,
} from "../utils/files.ts";

import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type {
  ToolName,
  GenericToolRequest,
  ToolInvocation,
  ToolRequest as UnionToolRequest,
} from "./types.ts";
import { runScript, type EdlRegisters } from "../edl/index.ts";
import type { FileMutationSummary } from "../edl/types.ts";
import type { BufferTracker } from "../buffer-tracker.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { Msg as ThreadMsg } from "../chat/thread.ts";
import type { FileIO } from "../edl/file-io.ts";
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

export function execute(
  request: ToolRequest,
  context: {
    nvim: Nvim;
    cwd: NvimCwd;
    homeDir: HomeDir;
    fileIO: FileIO;
    bufferTracker: BufferTracker;
    threadDispatch: Dispatch<ThreadMsg>;
    edlRegisters: EdlRegisters;
  },
): ToolInvocation {
  let aborted = false;

  const promise = (async (): Promise<ProviderToolResult> => {
    try {
      const script = request.input.script;
      const result = await runScript(
        script,
        context.fileIO,
        context.edlRegisters,
      );

      if (aborted) {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: "Request was aborted by the user.",
          },
        };
      }

      if (result.status === "ok") {
        context.edlRegisters.registers = result.edlRegisters.registers;
        context.edlRegisters.nextSavedId = result.edlRegisters.nextSavedId;

        for (const mutation of result.data.mutations) {
          const absFilePath = resolveFilePath(
            context.cwd,
            mutation.path as Parameters<typeof resolveFilePath>[1],
            context.homeDir,
          );
          context.threadDispatch({
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

        return {
          type: "tool_result",
          id: request.id,
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
        };
      } else {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: result.error,
          },
        };
      }
    } catch (error) {
      if (aborted) {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: "Request was aborted by the user.",
          },
        };
      }
      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "error",
          error: `Failed to execute EDL script: ${error instanceof Error ? error.message : String(error)}`,
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

export function renderInFlightSummary(
  _request: UnionToolRequest,
  _displayContext: DisplayContext,
): VDOMNode {
  return d`📝⚙️ edl script executing...`;
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
