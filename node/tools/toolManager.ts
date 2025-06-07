import * as GetFile from "./getFile.ts";
import * as Insert from "./insert.ts";
import * as Replace from "./replace.ts";
import * as ListBuffers from "./listBuffers.ts";
import * as ListDirectory from "./listDirectory.ts";
import * as Hover from "./hover.ts";
import * as FindReferences from "./findReferences.ts";
import * as Diagnostics from "./diagnostics.ts";
import * as BashCommand from "./bashCommand.ts";
import * as InlineEdit from "./inline-edit-tool.ts";
import * as ReplaceSelection from "./replace-selection-tool.ts";
import * as ThreadTitle from "./thread-title.ts";
import * as CompactThread from "./compact-thread.ts";
import * as SpawnSubagent from "./spawn-subagent.ts";
import * as YieldToParent from "./yield-to-parent.ts";

import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, withBindings } from "../tea/view.ts";
import { type Dispatch, type Thunk } from "../tea/tea.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { Lsp } from "../lsp.ts";
import type { MagentaOptions } from "../options.ts";
import type { RootMsg } from "../root-msg.ts";
import type { MessageId } from "../chat/message.ts";
import type { ThreadId } from "../chat/thread.ts";
import type { BufferTracker } from "../buffer-tracker.ts";

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
  inline_edit: {
    controller: InlineEdit.InlineEditTool;
    input: InlineEdit.Input;
    msg: InlineEdit.Msg;
  };
  replace_selection: {
    controller: ReplaceSelection.ReplaceSelectionTool;
    input: ReplaceSelection.Input;
    msg: ReplaceSelection.Msg;
  };
  thread_title: {
    controller: ThreadTitle.ThreadTitleTool;
    input: ThreadTitle.Input;
    msg: ThreadTitle.Msg;
  };
  compact_thread: {
    controller: CompactThread.CompactThreadTool;
    input: CompactThread.Input;
    msg: never;
  };
  spawn_subagent: {
    controller: SpawnSubagent.SpawnSubagentTool;
    input: SpawnSubagent.Input;
    msg: SpawnSubagent.Msg;
  };
  yield_to_parent: {
    controller: YieldToParent.YieldToParentTool;
    input: YieldToParent.Input;
    msg: YieldToParent.Msg;
  };
};

export type ToolRequest = {
  [K in keyof ToolMap]: {
    id: ToolRequestId;
    toolName: K;
    input: ToolMap[K]["input"];
  };
}[keyof ToolMap];

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
  showDetails: boolean;
};

export type Msg =
  | {
      type: "init-tool-use";
      threadId: ThreadId;
      messageId: MessageId;
      request: ToolRequest;
    }
  | {
      type: "toggle-display";
      id: ToolRequestId;
      showDetails: boolean;
    }
  | {
      type: "tool-msg";
      msg: ToolMsg;
    };

type State = {
  toolWrappers: {
    [id: ToolRequestId]: ToolModelWrapper;
  };
  rememberedCommands: Set<string>;
};

export class ToolManager {
  state: State;

  constructor(
    public myDispatch: (msg: Msg) => void,
    private context: {
      dispatch: Dispatch<RootMsg>;
      bufferTracker: BufferTracker;
      threadId: ThreadId;
      nvim: Nvim;
      lsp: Lsp;
      options: MagentaOptions;
      parent?: {
        threadId: ThreadId;
        toolRequestId: ToolRequestId;
      };
    },
  ) {
    this.state = {
      toolWrappers: {},
      rememberedCommands: new Set(),
    };
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
        toolWrapper.showDetails
          ? d`\nid: ${toolWrapper.tool.request.id}\n${toolWrapper.tool.displayInput()}\n${this.reunderToolResult(toolWrapper.tool.request.id)}`
          : ""
      }`,
      {
        "<CR>": () =>
          this.myDispatch({
            type: "toggle-display",
            id: toolWrapper.tool.request.id,
            showDetails: !toolWrapper.showDetails,
          }),
      },
    );
  }

  reunderToolResult(id: ToolRequestId) {
    const toolWrapper = this.state.toolWrappers[id];
    const tool = toolWrapper.tool;

    if (tool.state.state === "done") {
      const result = tool.state.result;
      if (result.result.status === "error") {
        return `\nError: ${result.result.error}`;
      } else {
        return `\nResult:\n${result.result.value}\n`;
      }
    } else {
      return "";
    }
  }

  update(msg: Msg): void {
    switch (msg.type) {
      case "toggle-display": {
        const toolWrapper = this.state.toolWrappers[msg.id];
        if (!toolWrapper) {
          throw new Error(`Could not find tool use with request id ${msg.id}`);
        }

        toolWrapper.showDetails = msg.showDetails;

        return undefined;
      }

      case "init-tool-use": {
        const request = msg.request;

        switch (request.toolName) {
          case "get_file": {
            const getFileTool = new GetFile.GetFileTool(request, {
              nvim: this.context.nvim,
              threadDispatch: (msg) =>
                this.context.dispatch({
                  type: "thread-msg",
                  id: this.context.threadId,
                  msg,
                }),
              myDispatch: (msg) =>
                this.myDispatch({
                  type: "tool-msg",
                  msg: {
                    id: request.id,
                    toolName: request.toolName,
                    msg,
                  },
                }),
            });

            this.state.toolWrappers[request.id] = {
              tool: getFileTool,
              showDetails: false,
            };

            return;
          }

          case "list_buffers": {
            const [listBuffersTool, thunk] = ListBuffers.ListBuffersTool.create(
              request,
              { nvim: this.context.nvim },
            );

            this.state.toolWrappers[request.id] = {
              tool: listBuffersTool,
              showDetails: false,
            };

            return this.acceptThunk(listBuffersTool, thunk);
          }

          case "insert": {
            const insertTool = new Insert.InsertTool(
              request,
              msg.threadId,
              msg.messageId,
              {
                ...this.context,
                myDispatch: (msg) =>
                  this.myDispatch({
                    type: "tool-msg",
                    msg: {
                      id: request.id,
                      toolName: request.toolName,
                      msg,
                    },
                  }),
              },
            );

            this.state.toolWrappers[request.id] = {
              tool: insertTool,
              showDetails: false,
            };
            return;
          }

          case "replace": {
            const replaceTool = new Replace.ReplaceTool(
              request,
              msg.threadId,
              msg.messageId,
              {
                ...this.context,
                myDispatch: (msg) =>
                  this.myDispatch({
                    type: "tool-msg",
                    msg: {
                      id: request.id,
                      toolName: request.toolName,
                      msg,
                    },
                  }),
              },
            );

            this.state.toolWrappers[request.id] = {
              tool: replaceTool,
              showDetails: false,
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
              showDetails: false,
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
              showDetails: false,
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
              showDetails: false,
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
              showDetails: false,
            };

            return this.acceptThunk(diagnosticsTool, thunk);
          }

          case "bash_command": {
            const bashCommandTool = new BashCommand.BashCommandTool(request, {
              nvim: this.context.nvim,
              myDispatch: (msg) =>
                this.myDispatch({
                  type: "tool-msg",
                  msg: {
                    id: request.id,
                    toolName: "bash_command",
                    msg,
                  },
                }),
              options: this.context.options,
              rememberedCommands: this.state.rememberedCommands,
            });

            this.state.toolWrappers[request.id] = {
              tool: bashCommandTool,
              showDetails: false,
            };
            return;
          }

          case "inline_edit": {
            throw new Error(`Not supported.`);
          }
          case "replace_selection": {
            throw new Error(`Not supported.`);
          }

          case "thread_title": {
            const threadTitleTool = new ThreadTitle.ThreadTitleTool(request, {
              nvim: this.context.nvim,
              myDispatch: (msg) =>
                this.myDispatch({
                  type: "tool-msg",
                  msg: {
                    id: request.id,
                    toolName: "thread_title",
                    msg,
                  },
                }),
            });

            this.state.toolWrappers[request.id] = {
              tool: threadTitleTool,
              showDetails: false,
            };
            return;
          }

          case "compact_thread": {
            const compactThreadTool = new CompactThread.CompactThreadTool(
              request,
              {
                nvim: this.context.nvim,
              },
            );

            this.state.toolWrappers[request.id] = {
              tool: compactThreadTool,
              showDetails: false,
            };
            return;
          }

          case "spawn_subagent": {
            const spawnSubagentTool = new SpawnSubagent.SpawnSubagentTool(
              request,
              {
                nvim: this.context.nvim,
                dispatch: this.context.dispatch,
                threadId: this.context.threadId,
                myDispatch: (msg) =>
                  this.myDispatch({
                    type: "tool-msg",
                    msg: {
                      id: request.id,
                      toolName: "spawn_subagent",
                      msg,
                    },
                  }),
              },
            );

            this.state.toolWrappers[request.id] = {
              tool: spawnSubagentTool,
              showDetails: false,
            };
            return;
          }

          case "yield_to_parent": {
            const yieldToParentTool = new YieldToParent.YieldToParentTool(
              request,
              {
                nvim: this.context.nvim,
                dispatch: this.context.dispatch,
                threadId: this.context.threadId,
                myDispatch: (msg) =>
                  this.myDispatch({
                    type: "tool-msg",
                    msg: {
                      id: request.id,
                      toolName: "yield_to_parent",
                      msg,
                    },
                  }),
                ...(this.context.parent && { parent: this.context.parent }),
              },
            );

            this.state.toolWrappers[request.id] = {
              tool: yieldToParentTool,
              showDetails: false,
            };
            return;
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

        if (msg.msg.toolName == "bash_command") {
          const toolMsg = msg.msg.msg;
          if (
            toolMsg.type == "user-approval" &&
            toolMsg.approved &&
            toolMsg.remember
          ) {
            this.state.rememberedCommands.add(
              (toolWrapper.tool as BashCommand.BashCommandTool).request.input
                .command,
            );
          }
        }
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
    // wrap in setTimeout to force a new eventloop frame, to avoid dispatch-in-dispatch
    setTimeout(() => {
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
    });
  }
}
