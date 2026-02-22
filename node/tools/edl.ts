import type { Result } from "../utils/result.ts";

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
import type { ToolName, GenericToolRequest, ToolInvocation } from "./types.ts";
import { runScript, type EdlRegisters } from "../edl/index.ts";
import type { FileMutationSummary } from "../edl/types.ts";
import type { BufferTracker } from "../buffer-tracker.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { Msg as ThreadMsg } from "../chat/thread.ts";
import type { FileIO } from "../capabilities/file-io.ts";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const EDL_DESCRIPTION = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "edl-description.md"),
  "utf-8",
);

export type EdlDisplayData = {
  mutations: { path: string; summary: FileMutationSummary }[];
  fileErrorCount: number;
  finalSelectionCount: number | undefined;
};

export const EDL_DISPLAY_PREFIX = "__EDL_DISPLAY__";
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
