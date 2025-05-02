import * as GetFile from "./getFile.ts";
import * as Insert from "./insert.ts";
import * as Replace from "./replace.ts";
import * as ListBuffers from "./listBuffers.ts";
import * as ListDirectory from "./listDirectory.ts";
import * as Hover from "./hover.ts";
import * as FindReferences from "./findReferences.ts";
import * as Diagnostics from "./diagnostics.ts";
import * as BashCommand from "./bashCommand.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { type Result } from "../utils/result.ts";
import { d, withBindings } from "../tea/view.ts";
import { type Dispatch, type Thunk } from "../tea/tea.ts";
import type { Nvim } from "nvim-node";
import type { Lsp } from "../lsp.ts";
import type { MagentaOptions } from "../options.ts";
import type { RootMsg } from "../root-msg.ts";

export const TOOL_SPECS = [
  GetFile.spec,
  Insert.spec,
  Replace.spec,
  ListBuffers.spec,
  ListDirectory.spec,
  Hover.spec,
  FindReferences.spec,
  Diagnostics.spec,
  BashCommand.spec,
];

export type ToolRequestId = string & { __toolRequestId: true };

export type ToolMap = {
  get_file: {
    controller: GetFile.GetFileTool;
    input: GetFile.Input;
    msg: GetFile.Msg;
  };
  insert: {
    controller: Insert.InsertTool;
    input: Insert.Input;
    msg: Insert.Msg;
  };
  replace: {
    controller: Replace.ReplaceTool;
    input: Replace.Input;
    msg: Replace.Msg;
  };
  list_buffers: {
    controller: ListBuffers.ListBuffersTool;
    input: ListBuffers.Input;
    msg: ListBuffers.Msg;
  };
  list_directory: {
    controller: ListDirectory.ListDirectoryTool;
    input: ListDirectory.Input;
    msg: ListDirectory.Msg;
  };
  hover: {
    controller: Hover.HoverTool;
    input: Hover.Input;
    msg: Hover.Msg;
  };
  find_references: {
    controller: FindReferences.FindReferencesTool;
    input: FindReferences.Input;
    msg: FindReferences.Msg;
  };
  diagnostics: {
    controller: Diagnostics.DiagnosticsTool;
    input: Diagnostics.Input;
    msg: Diagnostics.Msg;
  };
  bash_command: {
    controller: BashCommand.BashCommandTool;
    input: BashCommand.Input;
    msg: BashCommand.Msg;
  };
};

export type ToolRequest = {
  [K in keyof ToolMap]: {
    id: ToolRequestId;
    toolName: K;
    input: ToolMap[K]["input"];
  };
}[keyof ToolMap];

export type ToolName = keyof ToolMap;

export type ToolMsg = {
  [K in keyof ToolMap]: {
    id: ToolRequestId;
    toolName: K;
    msg: ToolMap[K]["msg"];
  };
}[keyof ToolMap];

type Tool = {
  [K in keyof ToolMap]: ToolMap[K]["controller"];
}[keyof ToolMap];

export type ToolModelWrapper = {
  tool: Tool;
  showRequest: boolean;
  showResult: boolean;
};

export type Msg =
  | {
      type: "init-tool-use";
      request: ToolRequest;
    }
  | {
      type: "toggle-display";
      id: ToolRequestId;
      showRequest: boolean;
      showResult: boolean;
    }
  | {
      type: "tool-msg";
      msg: ToolMsg;
    };

export type ToolManagerMsg = {
  type: "tool-manager-msg";
  msg: Msg;
};

export function validateToolInput(
  type: unknown,
  args: { [key: string]: unknown },
): Result<ToolMap[ToolName]["input"]> {
  switch (type) {
    case "get_file":
      return GetFile.validateInput(args);
    case "insert":
      return Insert.validateInput(args);
    case "replace":
      return Replace.validateInput(args);
    case "list_buffers":
      return ListBuffers.validateInput();
    case "list_directory":
      return ListDirectory.validateInput(args);
    case "hover":
      return Hover.validateInput(args);
    case "find_references":
      return FindReferences.validateInput(args);
    case "diagnostics":
      return Diagnostics.validateInput();
    case "bash_command":
      return BashCommand.validateInput(args);
    default:
      return {
        status: "error",
        error: `Unexpected request type ${type as string}`,
      };
  }
}

type State = {
  toolWrappers: {
    [id: ToolRequestId]: ToolModelWrapper;
  };
  rememberedCommands: Set<string>;
};

export class ToolManager {
  state: State;
  myDispatch: Dispatch<Msg>;

  constructor(
    private context: {
      dispatch: Dispatch<RootMsg>;
      nvim: Nvim;
      lsp: Lsp;
      options: MagentaOptions;
    },
  ) {
    this.state = {
      toolWrappers: {},
      rememberedCommands: new Set(),
    };
    this.myDispatch = (msg) =>
      this.context.dispatch({
        type: "tool-manager-msg",
        msg,
      });
  }

  displayResult(model: Tool) {
    if (model.state.state === "done") {
      const result = model.state.result;
      if (result.result.status === "error") {
        return `\nError: ${result.result.error}`;
      } else {
        return `\nResult:\n\`\`\`\n${result.result.value}\n\`\`\``;
      }
    } else {
      return "";
    }
  }

  renderTool(toolWrapper: State["toolWrappers"][ToolRequestId]) {
    return withBindings(
      d`${toolWrapper.tool.view((msg) =>
        this.myDispatch({
          type: "tool-msg",
          msg: {
            id: toolWrapper.tool.request.id,
            toolName: toolWrapper.tool.toolName,
            msg: msg,
          } as ToolMsg,
        }),
      )}${
        toolWrapper.showRequest
          ? d`\nid: ${toolWrapper.tool.request.id}\n${toolWrapper.tool.displayInput()}`
          : ""
      }${toolWrapper.showResult ? this.displayResult(toolWrapper.tool) : ""}`,
      {
        "<CR>": () =>
          this.myDispatch({
            type: "toggle-display",
            id: toolWrapper.tool.request.id,
            showRequest: !toolWrapper.showRequest,
            showResult: !toolWrapper.showResult,
          }),
      },
    );
  }

  update(msg: Msg): void {
    switch (msg.type) {
      case "toggle-display": {
        const toolWrapper = this.state.toolWrappers[msg.id];
        if (!toolWrapper) {
          throw new Error(`Could not find tool use with request id ${msg.id}`);
        }

        toolWrapper.showRequest = msg.showRequest;
        toolWrapper.showResult = msg.showResult;

        return undefined;
      }

      case "init-tool-use": {
        const request = msg.request;

        switch (request.toolName) {
          case "get_file": {
            const [getFileTool, thunk] = GetFile.GetFileTool.create(request, {
              nvim: this.context.nvim,
            });

            this.state.toolWrappers[request.id] = {
              tool: getFileTool,
              showRequest: false,
              showResult: false,
            };

            return this.acceptThunk(getFileTool, thunk);
          }

          case "list_buffers": {
            const [listBuffersTool, thunk] = ListBuffers.ListBuffersTool.create(
              request,
              { nvim: this.context.nvim },
            );

            this.state.toolWrappers[request.id] = {
              tool: listBuffersTool,
              showRequest: false,
              showResult: false,
            };

            return this.acceptThunk(listBuffersTool, thunk);
          }

          case "insert": {
            const insertTool = new Insert.InsertTool(request);

            this.state.toolWrappers[request.id] = {
              tool: insertTool,
              showRequest: false,
              showResult: false,
            };

            return;
          }

          case "replace": {
            const replaceTool = new Replace.ReplaceTool(request);

            this.state.toolWrappers[request.id] = {
              tool: replaceTool,
              showRequest: false,
              showResult: false,
            };

            return;
          }

          case "list_directory": {
            const [listDirTool, thunk] = ListDirectory.ListDirectoryTool.create(
              request,
              { nvim: this.context.nvim },
            );

            this.state.toolWrappers[request.id] = {
              tool: listDirTool,
              showRequest: false,
              showResult: false,
            };

            return this.acceptThunk(listDirTool, thunk);
          }

          case "hover": {
            const [hoverTool, thunk] = Hover.HoverTool.create(request, {
              nvim: this.context.nvim,
              lsp: this.context.lsp,
            });

            this.state.toolWrappers[request.id] = {
              tool: hoverTool,
              showRequest: false,
              showResult: false,
            };

            return this.acceptThunk(hoverTool, thunk);
          }

          case "find_references": {
            const [findReferencesTool, thunk] =
              FindReferences.FindReferencesTool.create(request, {
                nvim: this.context.nvim,
                lsp: this.context.lsp,
              });

            this.state.toolWrappers[request.id] = {
              tool: findReferencesTool,
              showRequest: false,
              showResult: false,
            };

            return this.acceptThunk(findReferencesTool, thunk);
          }

          case "diagnostics": {
            const [diagnosticsTool, thunk] = Diagnostics.DiagnosticsTool.create(
              request,
              { nvim: this.context.nvim },
            );

            this.state.toolWrappers[request.id] = {
              tool: diagnosticsTool,
              showRequest: false,
              showResult: false,
            };

            return this.acceptThunk(diagnosticsTool, thunk);
          }

          case "bash_command": {
            const [bashCommandTool, thunk] = BashCommand.BashCommandTool.create(
              request,
              {
                nvim: this.context.nvim,
                options: this.context.options,
                rememberedCommands: this.state.rememberedCommands,
              },
            );

            this.state.toolWrappers[request.id] = {
              tool: bashCommandTool,
              showRequest: false,
              showResult: false,
            };

            return this.acceptThunk(bashCommandTool, thunk);
          }

          default:
            return assertUnreachable(request);
        }
      }

      case "tool-msg": {
        const toolWrapper = this.state.toolWrappers[msg.msg.id];
        // any is safe here since we have correspondence between tool & msg type
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
        const thunk = toolWrapper.tool.update(msg.msg.msg as any);
        return thunk ? this.acceptThunk(toolWrapper.tool, thunk) : undefined;
      }

      default:
        return assertUnreachable(msg);
    }
  }

  /** Placeholder while I refactor the architecture. I'd like to stop passing thunks around, as I think it will make
   * things simpler to understand.
   */
  acceptThunk(tool: Tool, thunk: Thunk<ToolMsg["msg"]>): void {
    thunk((msg) =>
      this.myDispatch({
        type: "tool-msg",
        msg: {
          id: tool.request.id,
          toolName: tool.toolName,
          msg,
        } as ToolMsg,
      }),
    ).catch((e: Error) =>
      this.myDispatch({
        type: "tool-msg",
        msg: {
          id: tool.request.id,
          toolName: tool.toolName,
          msg: {
            type: "finish",
            result: {
              status: "error",
              error: e.message,
            },
          },
        } as ToolMsg,
      }),
    );
  }
}
