import * as Part from "./part.ts";
import * as ToolManager from "../tools/toolManager.ts";
import { type Role } from "./chat.ts";
import { type Dispatch, type Thunk } from "../tea/tea.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, type View, withBindings } from "../tea/view.ts";
import { displayDiffs } from "../tools/diff.ts";
import type { Lsp } from "../lsp.ts";
import type { Nvim } from "nvim-node";

export type MessageId = number & { __messageId: true };
export type Model = {
  id: MessageId;
  role: Role;
  parts: Part.Model[];
  edits: {
    [filePath: string]: {
      requestIds: ToolManager.ToolRequestId[];
      status:
        | {
            status: "pending";
          }
        | {
            status: "error";
            message: string;
          };
    };
  };
};

export type Msg =
  | {
      type: "append-text";
      text: string;
    }
  | {
      type: "add-tool-request";
      requestId: ToolManager.ToolRequestId;
    }
  | {
      type: "add-malformed-tool-reqeust";
      error: string;
      rawRequest: unknown;
    }
  | {
      type: "tool-manager-msg";
      msg: ToolManager.Msg;
    }
  | {
      type: "diff-error";
      filePath: string;
      requestId?: ToolManager.ToolRequestId;
      message: string;
    }
  | {
      type: "part-msg";
      partIdx: number;
      msg: Part.Msg;
    }
  | {
      type: "init-edit";
      filePath: string;
    }
  | {
      type: "edit-message";
      action: "delete" | "regenerate" | "edit";
      role: Role;
      id: number;
    };

export function init({ nvim, lsp }: { nvim: Nvim; lsp: Lsp }) {
  const partModel = Part.init({ nvim, lsp });

  const update = (
    msg: Msg,
    model: Model,
    toolManager: ToolManager.Model,
  ): [Model, Thunk<Msg>] | [Model] => {
    switch (msg.type) {
      case "append-text": {
        const lastPart = model.parts[model.parts.length - 1];
        if (lastPart && lastPart.type == "text") {
          lastPart.text += msg.text;
        } else {
          model.parts.push({
            type: "text",
            text: msg.text,
          });
        }
        break;
      }

      case "add-malformed-tool-reqeust":
        model.parts.push({
          type: "malformed-tool-request",
          error: msg.error,
          rawRequest: msg.rawRequest,
        });
        break;

      case "add-tool-request": {
        const toolWrapper = toolManager.toolWrappers[msg.requestId];
        if (!toolWrapper) {
          throw new Error(`Tool request not found: ${msg.requestId}`);
        }

        switch (toolWrapper.model.type) {
          case "insert":
          case "replace": {
            const filePath = toolWrapper.model.request.input.filePath;
            if (!model.edits[filePath]) {
              model.edits[filePath] = {
                status: { status: "pending" },
                requestIds: [],
              };
            }

            model.edits[filePath].requestIds.push(msg.requestId);

            model.parts.push({
              type: "tool-request",
              requestId: msg.requestId,
            });

            return [model];
          }

          case "get_file":
          case "list_buffers":
          case "hover":
          case "find_references":
          case "list_directory":
          case "diagnostics":
            model.parts.push({
              type: "tool-request",
              requestId: msg.requestId,
            });
            return [model];
          default:
            return assertUnreachable(toolWrapper.model);
        }
      }

      case "part-msg": {
        const [nextPart] = partModel.update(msg.msg, model.parts[msg.partIdx]);
        model.parts[msg.partIdx] = nextPart;
        return [model];
      }

      case "diff-error": {
        // NOTE: nothing to do, should be handled by parent (chat)
        return [model];
      }

      case "tool-manager-msg": {
        // NOTE: nothing to do, should be handled by parent (chat)
        return [model];
      }

      case "edit-message": {
        // NOTE: nothing to do, should be handled by parent (chat)
        return [model];
      }

      case "init-edit": {
        const edits = model.edits[msg.filePath];
        if (!edits) {
          throw new Error(
            `Received msg edit request for file ${msg.filePath} but it is not in map of edits.`,
          );
        }
        return [
          model,
          async (dispatch: Dispatch<Msg>) => {
            try {
              await displayDiffs({
                context: { nvim },
                filePath: msg.filePath,
                diffId: `message_${model.id}`,
                edits: edits.requestIds.map((requestId) => {
                  const toolWrapper = toolManager.toolWrappers[requestId];
                  if (!toolWrapper) {
                    throw new Error(
                      `Expected a toolWrapper with id ${requestId} but found none.`,
                    );
                  }
                  if (
                    !(
                      toolWrapper.model.type == "insert" ||
                      toolWrapper.model.type == "replace"
                    )
                  ) {
                    throw new Error(
                      `Expected only file edit tools in edits map, but found request ${requestId} of type ${toolWrapper.model.type}`,
                    );
                  }

                  return toolWrapper.model.request;
                }),
                dispatch: (msg) => dispatch(msg),
              });
            } catch (error) {
              nvim.logger?.error(
                new Error(`diff-error: ${JSON.stringify(error)}`),
              );

              dispatch({
                type: "diff-error",
                filePath: msg.filePath,
                message: JSON.stringify(error),
              });
            }
          },
        ];
      }
      default:
        assertUnreachable(msg);
    }
    return [model];
  };

  const view: View<{
    model: Model;
    toolManager: ToolManager.Model;
    dispatch: Dispatch<Msg>;
  }> = ({ model, toolManager, dispatch }) => {
    const fileEdits = [];
    for (const filePath in model.edits) {
      const edit = model.edits[filePath];
      const reviewEdit = withBindings(d`**[👀 review edits ]**`, {
        "<CR>": () =>
          dispatch({
            type: "init-edit",
            filePath,
          }),
      });

      fileEdits.push(
        d`  ${filePath} (${edit.requestIds.length.toString()} edits). ${reviewEdit}${
          edit.status.status == "error"
            ? d`\nError applying edit: ${edit.status.message}`
            : ""
        }\n`,
      );
    }

    const role = createRoleHeader(model, dispatch);

    return d`\
${role}
${model.parts.map(
  (part, partIdx) =>
    d`${partModel.view({
      model: part,
      toolManager,
      dispatch: (msg) => dispatch({ type: "part-msg", partIdx, msg }),
    })}\n`,
)}${
      fileEdits.length
        ? d`
Edits:
${fileEdits}`
        : ""
    }`;
  };

  return { update, view };
}

function createRoleHeader(model: Model, dispatch: Dispatch<Msg>) {
  const { role, id } = model;
  const dispatchEdit =
    (action: Extract<Msg, { type: "edit-message" }>["action"]) => () =>
      dispatch({ type: "edit-message", action, role, id });
  switch (role) {
    case "user":
      return withBindings(d`# ${role}:`, {
        d: dispatchEdit("delete"),
        r: dispatchEdit("regenerate"),
        e: dispatchEdit("edit"),
      });
    case "assistant":
      return withBindings(d`# ${role}:`, {
        r: dispatchEdit("regenerate"),
        d: dispatchEdit("delete"),
      });
    default:
      assertUnreachable(role);
  }
}
