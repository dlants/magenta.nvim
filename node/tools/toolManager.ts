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
import * as WaitForSubagents from "./wait-for-subagents.ts";
import * as YieldToParent from "./yield-to-parent.ts";

import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { type Dispatch } from "../tea/tea.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { Lsp } from "../lsp.ts";
import type { MagentaOptions } from "../options.ts";
import type { RootMsg } from "../root-msg.ts";
import type { MessageId } from "../chat/message.ts";
import type { ThreadId } from "../chat/thread.ts";
import type { BufferTracker } from "../buffer-tracker.ts";
import type { Chat } from "../chat/chat.ts";
import type {
  ToolMsg,
  ToolName,
  ToolRequestId,
  ToolRequest,
  ToolManagerToolMsg,
  Tool,
} from "./types.ts";
import type { ProviderToolSpec } from "../providers/provider-types.ts";
import type { StaticToolName } from "./tool-registry.ts";
import { MCPToolManager } from "./mcp/manager.ts";
import type { MCPTool } from "./mcp/tool.ts";
import { unwrapMcpToolMsg } from "./mcp/types.ts";
export type { Tool, ToolRequestId } from "./types.ts";

export type StaticToolMap = {
  get_file: {
    controller: GetFile.GetFileTool;
    input: GetFile.Input;
    msg: GetFile.Msg;
    spec: typeof GetFile.spec;
  };
  insert: {
    controller: Insert.InsertTool;
    input: Insert.Input;
    msg: Insert.Msg;
    spec: typeof Insert.spec;
  };
  replace: {
    controller: Replace.ReplaceTool;
    input: Replace.Input;
    msg: Replace.Msg;
    spec: typeof Replace.spec;
  };
  list_buffers: {
    controller: ListBuffers.ListBuffersTool;
    input: ListBuffers.Input;
    msg: ListBuffers.Msg;
    spec: typeof ListBuffers.spec;
  };
  list_directory: {
    controller: ListDirectory.ListDirectoryTool;
    input: ListDirectory.Input;
    msg: ListDirectory.Msg;
    spec: typeof ListDirectory.spec;
  };
  hover: {
    controller: Hover.HoverTool;
    input: Hover.Input;
    msg: Hover.Msg;
    spec: typeof Hover.spec;
  };
  find_references: {
    controller: FindReferences.FindReferencesTool;
    input: FindReferences.Input;
    msg: FindReferences.Msg;
    spec: typeof FindReferences.spec;
  };
  diagnostics: {
    controller: Diagnostics.DiagnosticsTool;
    input: Diagnostics.Input;
    msg: Diagnostics.Msg;
    spec: typeof Diagnostics.spec;
  };
  bash_command: {
    controller: BashCommand.BashCommandTool;
    input: BashCommand.Input;
    msg: BashCommand.Msg;
    spec: typeof BashCommand.spec;
  };
  inline_edit: {
    controller: InlineEdit.InlineEditTool;
    input: InlineEdit.Input;
    msg: InlineEdit.Msg;
    spec: typeof InlineEdit.spec;
  };
  replace_selection: {
    controller: ReplaceSelection.ReplaceSelectionTool;
    input: ReplaceSelection.Input;
    msg: ReplaceSelection.Msg;
    spec: typeof ReplaceSelection.spec;
  };
  thread_title: {
    controller: ThreadTitle.ThreadTitleTool;
    input: ThreadTitle.Input;
    msg: ThreadTitle.Msg;
    spec: typeof ThreadTitle.spec;
  };
  compact_thread: {
    controller: CompactThread.CompactThreadTool;
    input: CompactThread.Input;
    msg: never;
    spec: typeof CompactThread.spec;
  };
  spawn_subagent: {
    controller: SpawnSubagent.SpawnSubagentTool;
    input: SpawnSubagent.Input;
    msg: SpawnSubagent.Msg;
    spec: typeof SpawnSubagent.spec;
  };
  wait_for_subagents: {
    controller: WaitForSubagents.WaitForSubagentsTool;
    input: WaitForSubagents.Input;
    msg: WaitForSubagents.Msg;
    spec: typeof WaitForSubagents.spec;
  };
  yield_to_parent: {
    controller: YieldToParent.YieldToParentTool;
    input: YieldToParent.Input;
    msg: YieldToParent.Msg;
    spec: typeof YieldToParent.spec;
  };
};

export type StaticToolRequest = {
  [K in keyof StaticToolMap]: {
    id: ToolRequestId;
    toolName: K;
    input: StaticToolMap[K]["input"];
  };
}[keyof StaticToolMap];

type StaticTool = {
  [K in keyof StaticToolMap]: StaticToolMap[K]["controller"];
}[keyof StaticToolMap];

export function wrapStaticToolMsg(
  msg: StaticToolMap[keyof StaticToolMap]["msg"],
): ToolMsg {
  return msg as unknown as ToolMsg;
}

export function unwrapStaticToolMsg<
  StaticToolName extends keyof StaticToolMap = keyof StaticToolMap,
>(msg: ToolMsg): StaticToolMap[StaticToolName]["msg"] {
  return msg as unknown as StaticToolMap[StaticToolName]["msg"];
}

export type Msg =
  | {
      type: "init-tool-use";
      threadId: ThreadId;
      messageId: MessageId;
      request: ToolRequest;
    }
  | ToolManagerToolMsg;

export class ToolManager {
  private tools: {
    [id: ToolRequestId]: StaticTool;
  };

  constructor(
    public myDispatch: (msg: Msg) => void,
    private context: {
      dispatch: Dispatch<RootMsg>;
      mcpToolManager: MCPToolManager;
      bufferTracker: BufferTracker;
      threadId: ThreadId;
      nvim: Nvim;
      lsp: Lsp;
      options: MagentaOptions;
      chat: Chat;
    },
  ) {
    this.tools = {};
  }
  private static readonly TOOL_SPEC_MAP: {
    [K in StaticToolName]: ProviderToolSpec;
  } = {
    get_file: GetFile.spec,
    insert: Insert.spec,
    replace: Replace.spec,
    list_buffers: ListBuffers.spec,
    list_directory: ListDirectory.spec,
    hover: Hover.spec,
    find_references: FindReferences.spec,
    diagnostics: Diagnostics.spec,
    bash_command: BashCommand.spec,
    inline_edit: InlineEdit.spec,
    replace_selection: ReplaceSelection.spec,
    thread_title: ThreadTitle.spec,
    compact_thread: CompactThread.spec,
    spawn_subagent: SpawnSubagent.spec,
    yield_to_parent: YieldToParent.spec,
    wait_for_subagents: WaitForSubagents.spec,
  };

  getToolSpecs(toolNames: ToolName[]): ProviderToolSpec[] {
    const specs: ProviderToolSpec[] = [];

    for (const toolName of toolNames) {
      if (this.context.mcpToolManager.isMCPTool(toolName)) {
        const mcpSpecs = this.context.mcpToolManager.getToolSpecs();
        const mcpSpec = mcpSpecs.find((spec) => spec.name === toolName);
        if (mcpSpec) {
          specs.push(mcpSpec);
        }
      } else {
        const staticSpec =
          ToolManager.TOOL_SPEC_MAP[toolName as StaticToolName];
        if (staticSpec) {
          specs.push(staticSpec);
        }
      }
    }

    return specs;
  }

  getTool(id: ToolRequestId): Tool {
    const mcpTool = this.context.mcpToolManager.getTool(id);
    if (mcpTool) {
      return mcpTool;
    }

    return this.tools[id] as unknown as Tool;
  }

  renderToolResult(id: ToolRequestId) {
    const tool: MCPTool | StaticTool =
      this.context.mcpToolManager.getTool(id) || this.tools[id];

    if (tool.state.state === "done") {
      const result = tool.state.result;
      if (result.result.status === "error") {
        return `\nError: ${result.result.error}`;
      } else {
        return `\nResult:\n${JSON.stringify(result.result.value, null, 2)}\n`;
      }
    } else {
      return "";
    }
  }

  update(msg: Msg): void {
    switch (msg.type) {
      case "init-tool-use": {
        const request = msg.request;

        // Check if this is an MCP tool
        if (this.context.mcpToolManager.isMCPTool(request.toolName)) {
          const mcpRequest: ToolRequest = {
            id: request.id,
            toolName: request.toolName,
            input: request.input,
          };

          this.context.mcpToolManager.initMCPTool(
            mcpRequest,
            (msg) => this.myDispatch(msg),
            {
              nvim: this.context.nvim,
            },
          );

          return;
        }

        // Handle static tools
        const staticRequest = request as StaticToolRequest;
        switch (staticRequest.toolName) {
          case "get_file": {
            const threadWrapper =
              this.context.chat.threadWrappers[msg.threadId];
            if (threadWrapper.state != "initialized") {
              throw new Error(
                `Expected thread ${msg.threadId} to be initialized for get_file tool.`,
              );
            }

            const getFileTool = new GetFile.GetFileTool(staticRequest, {
              nvim: this.context.nvim,
              contextManager: threadWrapper.thread.contextManager,
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
                    id: staticRequest.id,
                    toolName: staticRequest.toolName as ToolName,
                    msg: msg as unknown as ToolMsg,
                  },
                }),
            });

            this.tools[staticRequest.id] = getFileTool;

            return;
          }

          case "list_buffers": {
            const listBuffersTool = new ListBuffers.ListBuffersTool(
              staticRequest,
              {
                nvim: this.context.nvim,
                myDispatch: (msg) =>
                  this.myDispatch({
                    type: "tool-msg",
                    msg: {
                      id: staticRequest.id,
                      toolName: staticRequest.toolName as ToolName,
                      msg: msg as unknown as ToolMsg,
                    },
                  }),
              },
            );

            this.tools[staticRequest.id] = listBuffersTool;

            return;
          }

          case "insert": {
            const insertTool = new Insert.InsertTool(
              staticRequest,
              msg.threadId,
              msg.messageId,
              {
                ...this.context,
                myDispatch: (msg) =>
                  this.myDispatch({
                    type: "tool-msg",
                    msg: {
                      id: staticRequest.id,
                      toolName: staticRequest.toolName as ToolName,
                      msg: msg as unknown as ToolMsg,
                    },
                  }),
              },
            );

            this.tools[staticRequest.id] = insertTool;
            return;
          }

          case "replace": {
            const replaceTool = new Replace.ReplaceTool(
              staticRequest,
              msg.threadId,
              msg.messageId,
              {
                ...this.context,
                myDispatch: (msg) =>
                  this.myDispatch({
                    type: "tool-msg",
                    msg: {
                      id: staticRequest.id,
                      toolName: staticRequest.toolName as ToolName,
                      msg: msg as unknown as ToolMsg,
                    },
                  }),
              },
            );

            this.tools[staticRequest.id] = replaceTool;

            return;
          }

          case "list_directory": {
            const listDirTool = new ListDirectory.ListDirectoryTool(
              staticRequest,
              {
                nvim: this.context.nvim,
                myDispatch: (msg) =>
                  this.myDispatch({
                    type: "tool-msg",
                    msg: {
                      id: staticRequest.id,
                      toolName: staticRequest.toolName as ToolName,
                      msg: msg as unknown as ToolMsg,
                    },
                  }),
              },
            );

            this.tools[staticRequest.id] = listDirTool;
            return;
          }

          case "hover": {
            const hoverTool = new Hover.HoverTool(staticRequest, {
              nvim: this.context.nvim,
              lsp: this.context.lsp,
              myDispatch: (msg) =>
                this.myDispatch({
                  type: "tool-msg",
                  msg: {
                    id: staticRequest.id,
                    toolName: staticRequest.toolName as ToolName,
                    msg: msg as unknown as ToolMsg,
                  },
                }),
            });

            this.tools[staticRequest.id] = hoverTool;
            return;
          }

          case "find_references": {
            const findReferencesTool = new FindReferences.FindReferencesTool(
              staticRequest,
              {
                nvim: this.context.nvim,
                lsp: this.context.lsp,
                myDispatch: (msg) =>
                  this.myDispatch({
                    type: "tool-msg",
                    msg: {
                      id: staticRequest.id,
                      toolName: staticRequest.toolName as ToolName,
                      msg: msg as unknown as ToolMsg,
                    },
                  }),
              },
            );

            this.tools[staticRequest.id] = findReferencesTool;
            return;
          }

          case "diagnostics": {
            const diagnosticsTool = new Diagnostics.DiagnosticsTool(
              staticRequest,
              {
                nvim: this.context.nvim,
                myDispatch: (msg) =>
                  this.myDispatch({
                    type: "tool-msg",
                    msg: {
                      id: staticRequest.id,
                      toolName: staticRequest.toolName as ToolName,
                      msg: msg as unknown as ToolMsg,
                    },
                  }),
              },
            );

            this.tools[staticRequest.id] = diagnosticsTool;
            return;
          }

          case "bash_command": {
            const bashCommandTool = new BashCommand.BashCommandTool(
              staticRequest,
              {
                nvim: this.context.nvim,
                myDispatch: (msg) =>
                  this.myDispatch({
                    type: "tool-msg",
                    msg: {
                      id: staticRequest.id,
                      toolName: "bash_command" as ToolName,
                      msg: msg as unknown as ToolMsg,
                    },
                  }),
                options: this.context.options,
                rememberedCommands: this.context.chat.rememberedCommands,
              },
            );

            this.tools[staticRequest.id] = bashCommandTool;
            return;
          }

          case "inline_edit": {
            throw new Error(`Not supported.`);
          }
          case "replace_selection": {
            throw new Error(`Not supported.`);
          }

          case "thread_title": {
            const threadTitleTool = new ThreadTitle.ThreadTitleTool(
              staticRequest,
              {
                nvim: this.context.nvim,
                myDispatch: (msg) =>
                  this.myDispatch({
                    type: "tool-msg",
                    msg: {
                      id: staticRequest.id,
                      toolName: "thread_title" as ToolName,
                      msg: msg as unknown as ToolMsg,
                    },
                  }),
              },
            );

            this.tools[staticRequest.id] = threadTitleTool;
            return;
          }

          case "compact_thread": {
            const compactThreadTool = new CompactThread.CompactThreadTool(
              staticRequest,
              {
                nvim: this.context.nvim,
              },
            );

            this.tools[staticRequest.id] = compactThreadTool;
            return;
          }

          case "spawn_subagent": {
            const spawnSubagentTool = new SpawnSubagent.SpawnSubagentTool(
              staticRequest,
              {
                nvim: this.context.nvim,
                dispatch: this.context.dispatch,
                threadId: this.context.threadId,
                myDispatch: (msg) =>
                  this.myDispatch({
                    type: "tool-msg",
                    msg: {
                      id: staticRequest.id,
                      toolName: "spawn_subagent" as ToolName,
                      msg: msg as unknown as ToolMsg,
                    },
                  }),
              },
            );

            this.tools[staticRequest.id] = spawnSubagentTool;
            return;
          }

          case "wait_for_subagents": {
            const waitForSubagentsTool =
              new WaitForSubagents.WaitForSubagentsTool(staticRequest, {
                nvim: this.context.nvim,
                dispatch: this.context.dispatch,
                threadId: this.context.threadId,
                chat: this.context.chat,
                myDispatch: (msg) =>
                  this.myDispatch({
                    type: "tool-msg",
                    msg: {
                      id: staticRequest.id,
                      toolName: "wait_for_subagents" as ToolName,
                      msg: msg as unknown as ToolMsg,
                    },
                  }),
              });

            this.tools[staticRequest.id] = waitForSubagentsTool;
            return;
          }

          case "yield_to_parent": {
            const yieldToParentTool = new YieldToParent.YieldToParentTool(
              staticRequest,
              {
                nvim: this.context.nvim,
                dispatch: this.context.dispatch,
                threadId: this.context.threadId,
                myDispatch: (msg) =>
                  this.myDispatch({
                    type: "tool-msg",
                    msg: {
                      id: staticRequest.id,
                      toolName: "yield_to_parent" as ToolName,
                      msg: msg as unknown as ToolMsg,
                    },
                  }),
              },
            );

            this.tools[staticRequest.id] = yieldToParentTool;
            return;
          }

          default:
            return assertUnreachable(staticRequest);
        }
      }

      case "tool-msg": {
        if (this.context.mcpToolManager.isMCPTool(msg.msg.toolName)) {
          this.context.mcpToolManager.updateTool(
            msg.msg.id,
            unwrapMcpToolMsg(msg.msg.msg),
          );
          return;
        }

        // Handle static tool messages
        const tool = this.tools[msg.msg.id];
        if (!tool) {
          throw new Error(`Could not find tool with request id ${msg.msg.id}`);
        }

        const staticToolMsg = unwrapStaticToolMsg(msg.msg.msg);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
        tool.update(staticToolMsg as any);

        if (msg.msg.toolName == "bash_command") {
          const bashMsg = staticToolMsg as BashCommand.Msg;
          if (
            bashMsg.type == "user-approval" &&
            bashMsg.approved &&
            bashMsg.remember
          ) {
            this.context.chat.rememberedCommands.add(
              (tool as BashCommand.BashCommandTool).request.input.command,
            );
          }
        }
        return;
      }
      default:
        return assertUnreachable(msg);
    }
  }
}
