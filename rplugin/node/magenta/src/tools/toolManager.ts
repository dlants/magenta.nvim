import * as GetFile from "./getFile.ts";
import * as Insert from "./insert.ts";
import * as Replace from "./replace.ts";
import * as ListBuffers from "./listBuffers.ts";
import { Dispatch, Update } from "../tea/tea.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages.mjs";

export type ToolRequest =
  | GetFile.GetFileToolUseRequest
  | Insert.InsertToolUseRequest
  | Replace.ReplaceToolRequest
  | ListBuffers.ListBuffersToolRequest;

export type ToolModel =
  | GetFile.Model
  | Insert.Model
  | Replace.Model
  | ListBuffers.Model;

export type ToolRequestId = string & { __toolRequestId: true };

export const TOOL_SPECS = [
  GetFile.spec,
  Insert.spec,
  Replace.spec,
  ListBuffers.spec,
];

export type Model = {
  toolModels: {
    [id: ToolRequestId]: ToolModel;
  };
};

export function getToolResult(model: ToolModel): ToolResultBlockParam {
  switch (model.type) {
    case "get-file":
      return GetFile.getToolResult(model);
    case "insert":
      return Insert.getToolResult(model);
    case "replace":
      return Replace.getToolResult(model);
    case "list-buffers":
      return ListBuffers.getToolResult(model);

    default:
      return assertUnreachable(model);
  }
}

export function renderTool(model: ToolModel, dispatch: Dispatch<Msg>) {
  switch (model.type) {
    case "get-file":
      return GetFile.view({ model });
    case "list-buffers":
      return ListBuffers.view({ model });
    case "insert":
      return Insert.view({
        model,
        dispatch: (msg) =>
          dispatch({
            type: "tool-msg",
            id: model.request.id,
            msg: { type: "insert", msg },
          }),
      });
    case "replace":
      return Replace.view({
        model,
        dispatch: (msg) =>
          dispatch({
            type: "tool-msg",
            id: model.request.id,
            msg: { type: "replace", msg },
          }),
      });

    default:
      assertUnreachable(model);
  }
}

export type Msg =
  | {
      type: "init-tool-use";
      request:
        | GetFile.GetFileToolUseRequest
        | ListBuffers.ListBuffersToolRequest
        | Insert.InsertToolUseRequest
        | Replace.ReplaceToolRequest;
    }
  | {
      type: "tool-msg";
      id: ToolRequestId;
      msg:
        | {
            type: "get-file";
            msg: GetFile.Msg;
          }
        | {
            type: "list-buffers";
            msg: ListBuffers.Msg;
          }
        | {
            type: "insert";
            msg: Insert.Msg;
          }
        | {
            type: "replace";
            msg: Replace.Msg;
          };
    };

export function initModel(): Model {
  return {
    toolModels: {},
  };
}

export const update: Update<Msg, Model> = (msg, model) => {
  switch (msg.type) {
    case "init-tool-use": {
      const request = msg.request;
      switch (request.name) {
        case "get_file": {
          const [getFileModel, thunk] = GetFile.initModel(request);
          return [
            {
              ...model,
              toolModels: {
                ...model.toolModels,
                [request.id]: getFileModel,
              },
            },
            (dispatch) =>
              thunk((msg) =>
                dispatch({
                  type: "tool-msg",
                  id: request.id,
                  msg: {
                    type: "get-file",
                    msg,
                  },
                }),
              ),
          ];
        }

        case "list_buffers": {
          const [listBuffersModel, thunk] = ListBuffers.initModel(request);
          return [
            {
              ...model,
              toolModels: {
                ...model.toolModels,
                [request.id]: listBuffersModel,
              },
            },
            (dispatch) =>
              thunk((msg) =>
                dispatch({
                  type: "tool-msg",
                  id: request.id,
                  msg: {
                    type: "list-buffers",
                    msg,
                  },
                }),
              ),
          ];
        }

        case "insert": {
          const [insertModel] = Insert.initModel(request);
          return [
            {
              ...model,
              toolModels: {
                ...model.toolModels,
                [request.id]: insertModel,
              },
            },
          ];
        }

        case "replace": {
          const [insertModel] = Replace.initModel(request);
          return [
            {
              ...model,
              toolModels: {
                ...model.toolModels,
                [request.id]: insertModel,
              },
            },
          ];
        }

        default:
          return assertUnreachable(request);
      }
    }

    case "tool-msg": {
      const toolModel = model.toolModels[msg.id];
      if (!toolModel) {
        throw new Error(`Expected to find tool with id ${msg.id}`);
      }

      switch (msg.msg.type) {
        case "get-file": {
          const [nextToolModel, thunk] = GetFile.update(
            msg.msg.msg,
            toolModel as GetFile.Model,
          );

          return [
            {
              ...model,
              toolModels: {
                ...model.toolModels,
                [msg.id]: nextToolModel,
              },
            },
            thunk
              ? (dispatch) =>
                  thunk((innerMsg) =>
                    dispatch({
                      type: "tool-msg",
                      id: msg.id,
                      msg: {
                        type: "get-file",
                        msg: innerMsg,
                      },
                    }),
                  )
              : undefined,
          ];
        }

        case "list-buffers": {
          const [nextToolModel, thunk] = ListBuffers.update(
            msg.msg.msg,
            toolModel as ListBuffers.Model,
          );

          return [
            {
              ...model,
              toolModels: {
                ...model.toolModels,
                [msg.id]: nextToolModel,
              },
            },
            thunk
              ? (dispatch) =>
                  thunk((innerMsg) =>
                    dispatch({
                      type: "tool-msg",
                      id: msg.id,
                      msg: {
                        type: "list-buffers",
                        msg: innerMsg,
                      },
                    }),
                  )
              : undefined,
          ];
        }

        case "insert": {
          const [nextToolModel, thunk] = Insert.update(
            msg.msg.msg,
            toolModel as Insert.Model,
          );

          return [
            {
              ...model,
              toolModels: {
                ...model.toolModels,
                [msg.id]: nextToolModel,
              },
            },
            thunk
              ? (dispatch) =>
                  thunk((innerMsg) =>
                    dispatch({
                      type: "tool-msg",
                      id: msg.id,
                      msg: {
                        type: "insert",
                        msg: innerMsg,
                      },
                    }),
                  )
              : undefined,
          ];
        }

        case "replace": {
          const [nextToolModel, thunk] = Replace.update(
            msg.msg.msg,
            toolModel as Replace.Model,
          );

          return [
            {
              ...model,
              toolModels: {
                ...model.toolModels,
                [msg.id]: nextToolModel,
              },
            },
            thunk
              ? (dispatch) =>
                  thunk((innerMsg) =>
                    dispatch({
                      type: "tool-msg",
                      id: msg.id,
                      msg: {
                        type: "replace",
                        msg: innerMsg,
                      },
                    }),
                  )
              : undefined,
          ];
        }

        default:
          return assertUnreachable(msg.msg);
      }
    }

    default:
      assertUnreachable(msg);
  }
};
