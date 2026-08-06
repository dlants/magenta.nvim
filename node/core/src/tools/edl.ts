import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OnToolApplied } from "../capabilities/context-tracker.ts";
import type { FileIO } from "../capabilities/file-io.ts";
import {
  type EdlRegisters,
  type FileMutationSummary,
  runScript,
} from "../edl/index.ts";
import {
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  type ProviderToolResult,
  type ProviderToolSpec,
} from "../providers/provider-types.ts";
import type {
  GenericToolRequest,
  ToolInvocation,
  ToolName,
} from "../tool-types.ts";
import {
  FileCategory,
  type HomeDir,
  type NvimCwd,
  resolveFilePath,
} from "../utils/files.ts";
import type { Result } from "../utils/result.ts";

const EDL_DESCRIPTION = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "edl-description.md"),
  "utf-8",
);

export type EdlTraceEntry = { command: string; snippet: string };

export type EdlDisplayData = {
  mutations: { path: string; summary: FileMutationSummary }[];
  fileErrors: {
    path: string;
    error: string;
    failedMutations: number;
    failedCommands: string[];
  }[];
  finalSelectionCount: number | undefined;
  trace: EdlTraceEntry[];
};

export type StructuredResult = {
  toolName: "edl";
  displayData?: EdlDisplayData;
  formattedResult: string;
};

export type ToolRequest = GenericToolRequest<"edl", Input>;

export function execute(
  request: ToolRequest,
  context: {
    cwd: NvimCwd;
    homeDir: HomeDir;
    fileIO: FileIO;
    edlRegisters: EdlRegisters;
    onToolApplied?: OnToolApplied;
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
        { cwd: context.cwd, homeDir: context.homeDir },
      );

      if (aborted) {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: "Request was aborted by the user.",
          },
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
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
          context.onToolApplied?.(
            absFilePath,
            {
              type: "edl-edit",
              content: mutation.content,
              previousContent: mutation.previousContent,
            },
            {
              category: FileCategory.TEXT,
              mimeType: "text/plain",
              extension: "",
            },
          );
        }

        const displayData: EdlDisplayData = {
          mutations: result.data.mutations.map((m) => ({
            path: m.path,
            summary: m.summary,
          })),
          fileErrors: result.data.fileErrors.map((fe) => ({
            path: fe.path,
            error: fe.error,
            failedMutations: fe.failedMutations,
            failedCommands: fe.failedCommands,
          })),
          finalSelectionCount: result.data.finalSelection
            ? result.data.finalSelection.ranges.length
            : undefined,
          trace: result.data.trace,
        };

        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "ok",
            value: [
              {
                type: "text",
                text: result.formatted,
                nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
              },
            ],
            structuredResult: {
              toolName: "edl",
              displayData,
              formattedResult: result.formatted,
            },
          },
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        };
      } else {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: result.error,
          },
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
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
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        };
      }
      const errorMessage = `Failed to execute EDL script: ${error instanceof Error ? error.message : String(error)}`;
      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "error",
          error: errorMessage,
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
