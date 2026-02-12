import type { ToolRequest, ToolName, ToolMsg, Tool } from "./types.ts";
import type { FileIO } from "./environment.ts";
import type { Logger } from "../logger.ts";
import type { Cwd, HomeDir } from "../utils/files.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { EdlRegisters } from "../edl/index.ts";
import { EdlTool, type Msg as EdlMsg } from "./edl-tool.ts";
import {
  BashCommandTool,
  type Msg as BashCommandMsg,
} from "./bash-command-tool.ts";
import { validateInput as validateEdlInput } from "./specs/edl.ts";
import { validateInput as validateBashCommandInput } from "./specs/bash-command.ts";
import type { ToolRequest as EdlToolRequest } from "./specs/edl.ts";
import type { ToolRequest as BashCommandToolRequest } from "./specs/bash-command.ts";
import type { CommandExec, FileAccess } from "./environment.ts";
import {
  GetFileTool,
  type Msg as GetFileMsg,
} from "./get-file-tool.ts";
import { validateInput as validateGetFileInput } from "./specs/get-file.ts";
import type { ToolRequest as GetFileToolRequest } from "./specs/get-file.ts";

export type CreateToolContext = {
  fileIO: FileIO;
  logger: Logger;
  cwd: Cwd;
  homeDir: HomeDir;
  myDispatch: Dispatch<ToolMsg>;
  edlRegisters: EdlRegisters;
  commandExec: CommandExec;
  fileAccess: FileAccess;
};

export function createTool(
  request: ToolRequest,
  context: CreateToolContext,
): Tool | { status: "error"; error: string } {
  switch (request.toolName as string) {
    case "edl": {
      const validated = validateEdlInput(
        request.input as { [key: string]: unknown },
      );
      if (validated.status === "error") {
        return { status: "error", error: validated.error };
      }
      const edlRequest: EdlToolRequest = {
        id: request.id,
        toolName: "edl" as unknown as ToolName,
        input: validated.value,
      };
      return new EdlTool(edlRequest, {
        ...context,
        myDispatch: (msg: EdlMsg) =>
          context.myDispatch(msg as unknown as ToolMsg),
      });
    }
    case "bash_command": {
      const validated = validateBashCommandInput(
        request.input as { [key: string]: unknown },
      );
      if (validated.status === "error") {
        return { status: "error", error: validated.error };
      }
      const bashRequest: BashCommandToolRequest = {
        id: request.id,
        toolName: "bash_command" as unknown as ToolName,
        input: validated.value,
      };
      return new BashCommandTool(bashRequest, {
        ...context,
        myDispatch: (msg: BashCommandMsg) =>
          context.myDispatch(msg as unknown as ToolMsg),
      });
    }
    case "get_file": {
      const validated = validateGetFileInput(
        request.input as { [key: string]: unknown },
      );
      if (validated.status === "error") {
        return { status: "error", error: validated.error };
      }
      const getFileRequest: GetFileToolRequest = {
        id: request.id,
        toolName: "get_file" as unknown as ToolName,
        input: validated.value,
      };
      return new GetFileTool(getFileRequest, {
        ...context,
        myDispatch: (msg: GetFileMsg) =>
          context.myDispatch(msg as unknown as ToolMsg),
      });
    }
    default:
      return {
        status: "error",
        error: `Unknown tool: ${request.toolName}`,
      };
  }
}
