import { assertUnreachable } from "../utils/assertUnreachable";
import type {
  ProviderToolUseRequest,
  StopReason,
  Usage,
} from "../providers/provider";
import { d } from "../tea/view";
import type { Dispatch } from "../tea/tea";
import type { StaticToolRequest } from "../tools/toolManager";
import {
  InlineEditTool,
  type Msg as InlineEditMsg,
} from "../tools/inline-edit-tool";
import {
  ReplaceSelectionTool,
  type NvimSelection,
  type Msg as ReplaceSelectionMsg,
} from "../tools/replace-selection-tool";
import type { Nvim } from "../nvim/nvim-node";
import type { BufNr } from "../nvim/buffer";

type InlineEditToolRequest = Extract<
  StaticToolRequest,
  { toolName: "inline_edit" }
>;
type ReplaceSelectionToolRequest = Extract<
  StaticToolRequest,
  { toolName: "replace_selection" }
>;

export type State =
  | {
      state: "error";
      error: string;
    }
  | {
      state: "awaiting-prompt";
    }
  | {
      state: "response-pending";
      request: ProviderToolUseRequest;
    }
  | {
      state: "tool-use";
      tool: InlineEditTool | ReplaceSelectionTool;
      stopReason: StopReason;
      usage: Usage;
    };

export type Msg =
  | {
      type: "update-model";
      next: State;
    }
  | {
      type: "request-sent";
      request: ProviderToolUseRequest;
    }
  | {
      type: "init-request";
      request: InlineEditToolRequest | ReplaceSelectionToolRequest;
      stopReason: StopReason;
      usage: Usage;
    }
  | {
      type: "tool-msg";
      msg:
        | {
            toolName: "inline_edit";
            msg: InlineEditMsg;
          }
        | {
            toolName: "replace_selection";
            msg: ReplaceSelectionMsg;
          };
    };

export class InlineEditController {
  state: State;

  constructor(
    public context: {
      nvim: Nvim;
      bufnr: BufNr;
      selection: NvimSelection | undefined;
      dispatch: Dispatch<Msg>;
    },
  ) {
    this.state = {
      state: "awaiting-prompt",
    };
  }

  update(msg: Msg) {
    switch (msg.type) {
      case "update-model":
        this.state = msg.next;
        return;

      case "request-sent": {
        this.state = {
          state: "response-pending",
          request: msg.request,
        };

        msg.request.promise.then(
          (response) => {
            const toolRequestResult = response.toolRequest;
            if (toolRequestResult.status == "error") {
              this.context.dispatch({
                type: "update-model",
                next: {
                  state: "error",
                  error: toolRequestResult.error,
                },
              });
              return;
            }

            this.context.dispatch({
              type: "init-request",
              request: toolRequestResult.value as
                | InlineEditToolRequest
                | ReplaceSelectionToolRequest,

              stopReason: response.stopReason,
              usage: response.usage,
            });
          },
          (error: Error) => {
            this.context.dispatch({
              type: "update-model",
              next: {
                state: "error",
                error: error.message + "\n" + error.stack,
              },
            });
          },
        );

        return;
      }

      case "init-request":
        if (this.state.state == "response-pending") {
          if (msg.request.toolName == "inline_edit") {
            this.state = {
              state: "tool-use",
              stopReason: msg.stopReason,
              usage: msg.usage,
              tool: new InlineEditTool(msg.request, {
                nvim: this.context.nvim,
                bufnr: this.context.bufnr,
                myDispatch: (msg) =>
                  this.context.dispatch({
                    type: "tool-msg",
                    msg: {
                      toolName: "inline_edit",
                      msg,
                    },
                  }),
              }),
            };
          } else {
            if (!this.context.selection) {
              throw new Error(`Expected there to be a selection.`);
            }

            this.state = {
              state: "tool-use",
              stopReason: msg.stopReason,
              usage: msg.usage,
              tool: new ReplaceSelectionTool(
                msg.request,
                this.context.selection,
                {
                  nvim: this.context.nvim,
                  bufnr: this.context.bufnr,
                  myDispatch: (msg) =>
                    this.context.dispatch({
                      type: "tool-msg",
                      msg: {
                        toolName: "replace_selection",
                        msg,
                      },
                    }),
                },
              ),
            };
          }
        }
        return;

      case "tool-msg":
        if (this.state.state == "tool-use") {
          if (this.state.tool.toolName == msg.msg.toolName) {
            this.state.tool.update(msg.msg.msg);
          }
        }
        return;

      default:
        assertUnreachable(msg);
    }
  }

  view() {
    switch (this.state.state) {
      case "error":
        return d`Error: ${this.state.error}`;
      case "awaiting-prompt":
        return d``; // should never be shown...
      case "response-pending":
        return d`Input sent, awaiting response...`; // should never be shown...
      case "tool-use":
        return this.state.tool.view();

      default:
        return assertUnreachable(this.state);
    }
  }
}
