import * as Part from "./part.ts";
import * as Message from "./message.ts";
import * as ContextManager from "../context/context-manager.ts";
import {
  type Dispatch,
  parallelThunks,
  type Thunk,
  type Update,
  wrapThunk,
} from "../tea/tea.ts";
import { d, type View } from "../tea/view.ts";
import * as ToolManager from "../tools/toolManager.ts";
import { type Result } from "../utils/result.ts";
import { IdCounter } from "../utils/uniqueId.ts";
import type { Nvim } from "bunvim";
import type { Lsp } from "../lsp.ts";
import {
  getClient,
  type ProviderMessage,
  type ProviderMessageContent,
  type ProviderName,
  type StopReason,
} from "../providers/provider.ts";

export type Role = "user" | "assistant";

export type ConversationState =
  | {
      state: "message-in-flight";
      sendDate: Date;
    }
  | {
      state: "stopped";
      stopReason: StopReason;
    };

export type Model = {
  provider: ProviderName;
  conversation: ConversationState;
  messages: Message.Model[];
  toolManager: ToolManager.Model;
  contextManager: ContextManager.Model;
};

type WrappedMessageMsg = {
  type: "message-msg";
  msg: Message.Msg;
  idx: number;
};

export type Msg =
  | WrappedMessageMsg
  | { type: "choose-provider"; provider: ProviderName }
  | {
      type: "context-manager-msg";
      msg: ContextManager.Msg;
    }
  | {
      type: "add-message";
      role: Role;
      content?: string;
    }
  | {
      type: "stream-response";
      text: string;
    }
  | {
      type: "stream-error";
      error: Error;
    }
  | {
      type: "init-tool-use";
      request: Result<ToolManager.ToolRequest, { rawRequest: unknown }>;
    }
  | {
      type: "send-message";
    }
  | {
      type: "conversation-state";
      conversation: ConversationState;
    }
  | {
      type: "clear";
    }
  | {
      type: "tool-manager-msg";
      msg: ToolManager.Msg;
    };

export function init({ nvim, lsp }: { nvim: Nvim; lsp: Lsp }) {
  const idCounter = new IdCounter("message_");
  const partModel = Part.init({ nvim, lsp });
  const toolManagerModel = ToolManager.init({ nvim, lsp });
  const contextManagerModel = ContextManager.init({ nvim });

  const messageModel = Message.init({ nvim, lsp });

  function initModel(): Model {
    return {
      provider: "anthropic",
      conversation: { state: "stopped", stopReason: "end_turn" },
      messages: [],
      toolManager: toolManagerModel.initModel(),
      contextManager: contextManagerModel.initModel(),
    };
  }

  function wrapMessageThunk(
    messageIdx: number,
    thunk: Thunk<Message.Msg> | undefined,
  ): Thunk<WrappedMessageMsg> | undefined {
    if (!thunk) {
      return undefined;
    }
    return (dispatch: Dispatch<WrappedMessageMsg>) =>
      thunk((msg: Message.Msg) =>
        dispatch({ type: "message-msg", idx: messageIdx, msg }),
      );
  }

  const update: Update<Msg, Model, { nvim: Nvim }> = (msg, model, context) => {
    switch (msg.type) {
      case "choose-provider":
        return [{ ...model, provider: msg.provider }];
      case "add-message": {
        let message: Message.Model = {
          id: idCounter.get() as Message.MessageId,
          role: msg.role,
          parts: [],
          edits: {},
        };

        let messageThunk;
        if (msg.content) {
          const [next, thunk] = messageModel.update(
            { type: "append-text", text: msg.content },
            message,
            model.toolManager,
          );
          message = next;
          messageThunk = thunk;
        }
        model.messages.push(message);
        return [
          model,
          wrapMessageThunk(model.messages.length - 1, messageThunk),
        ];
      }

      case "conversation-state": {
        model.conversation = msg.conversation;
        return [model];
      }

      case "send-message": {
        const lastMessage = model.messages[model.messages.length - 1];
        if (lastMessage && lastMessage.role == "user") {
          return [model, sendMessage(model)];
        } else {
          nvim.logger?.error(
            `Cannot send when the last message has role ${lastMessage && lastMessage.role}`,
          );
          return [model];
        }
      }

      case "message-msg": {
        const [nextMessage, messageThunk] = messageModel.update(
          msg.msg,
          model.messages[msg.idx],
          model.toolManager,
        );
        model.messages[msg.idx] = nextMessage;

        let toolManagerMsg;
        if (msg.msg.type == "tool-manager-msg") {
          toolManagerMsg = msg.msg.msg;
        }

        if (
          msg.msg.type == "part-msg" &&
          msg.msg.msg.type == "tool-manager-msg"
        ) {
          toolManagerMsg = msg.msg.msg.msg;
        }

        if (toolManagerMsg) {
          const [nextToolManager, toolManagerThunk] = toolManagerModel.update(
            toolManagerMsg,
            model.toolManager,
            context,
          );
          model.toolManager = nextToolManager;
          return [
            model,
            parallelThunks<Msg>(
              wrapMessageThunk(msg.idx, messageThunk),
              wrapThunk("tool-manager-msg", toolManagerThunk),
            ),
          ];
        }

        if (msg.msg.type == "diff-error") {
          const message = model.messages[msg.idx];
          const edit = message.edits[msg.msg.filePath];
          edit.status = {
            status: "error",
            message: msg.msg.message,
          };

          // TODO: maybe update request status with error?
          // for (const requestId of edit.requestIds) {
          // }
          return [model];
        }

        return [model, wrapMessageThunk(msg.idx, messageThunk)];
      }

      case "stream-response": {
        const lastMessage = model.messages[model.messages.length - 1];
        if (lastMessage?.role !== "assistant") {
          model.messages.push({
            id: idCounter.get() as Message.MessageId,
            role: "assistant",
            parts: [],
            edits: {},
          });
        }

        const [nextMessage, messageThunk] = messageModel.update(
          { type: "append-text", text: msg.text },
          model.messages[model.messages.length - 1],
          model.toolManager,
        );
        model.messages[model.messages.length - 1] = nextMessage;

        return [
          model,
          wrapMessageThunk(model.messages.length - 1, messageThunk),
        ];
      }

      case "stream-error": {
        const lastMessage = model.messages[model.messages.length - 1];
        if (lastMessage?.role !== "assistant") {
          model.messages.push({
            id: idCounter.get() as Message.MessageId,
            role: "assistant",
            parts: [],
            edits: {},
          });
        }

        const [nextMessage, messageThunk] = messageModel.update(
          {
            type: "append-text",
            text: `Stream Error: ${msg.error.message}
${msg.error.stack}`,
          },
          model.messages[model.messages.length - 1],
          model.toolManager,
        );
        model.messages[model.messages.length - 1] = nextMessage;

        return [
          model,
          wrapMessageThunk(model.messages.length - 1, messageThunk),
        ];
      }

      case "init-tool-use": {
        const lastMessage = model.messages[model.messages.length - 1];
        if (lastMessage?.role !== "assistant") {
          model.messages.push({
            id: idCounter.get() as Message.MessageId,
            role: "assistant",
            parts: [],
            edits: {},
          });
        }

        if (msg.request.status == "error") {
          const [nextMessage, messageThunk] = messageModel.update(
            {
              type: "add-malformed-tool-reqeust",
              error: msg.request.error,
              rawRequest: msg.request.rawRequest,
            },
            model.messages[model.messages.length - 1],
            model.toolManager,
          );
          model.messages[model.messages.length - 1] = nextMessage;
          return [
            model,
            parallelThunks(
              wrapMessageThunk(model.messages.length - 1, messageThunk),
              maybeAutorespond(model),
            ),
          ];
        } else {
          const [nextToolManager, toolManagerThunk] = toolManagerModel.update(
            { type: "init-tool-use", request: msg.request.value },
            model.toolManager,
            context,
          );
          model.toolManager = nextToolManager;

          const [nextMessage, messageThunk] = messageModel.update(
            {
              type: "add-tool-request",
              requestId: msg.request.value.id,
            },
            model.messages[model.messages.length - 1],
            model.toolManager,
          );
          model.messages[model.messages.length - 1] = nextMessage;
          return [
            model,
            parallelThunks<Msg>(
              wrapMessageThunk(model.messages.length - 1, messageThunk),
              wrapThunk("tool-manager-msg", toolManagerThunk),
              maybeAutorespond(model),
            ),
          ];
        }
      }

      case "tool-manager-msg": {
        const [nextToolManager, toolManagerThunk] = toolManagerModel.update(
          msg.msg,
          model.toolManager,
          context,
        );
        model.toolManager = nextToolManager;
        const respondThunk = maybeAutorespond(model);
        return [
          model,
          parallelThunks(
            wrapThunk("tool-manager-msg", toolManagerThunk),
            respondThunk,
          ),
        ];
      }

      case "context-manager-msg": {
        const [nextContextManager, contextManagerThunk] =
          contextManagerModel.update(msg.msg, model.contextManager);
        model.contextManager = nextContextManager;
        return [
          model,
          parallelThunks(wrapThunk("context-manager-msg", contextManagerThunk)),
        ];
      }

      case "clear": {
        return [initModel()];
      }
    }
  };

  /** If the agent is waiting on tool use, check the last message to see if all tools have been resolved. If so,
   * automatically respond.
   */
  function maybeAutorespond(model: Model): Thunk<Msg> | undefined {
    if (
      !(
        model.conversation.state == "stopped" &&
        model.conversation.stopReason == "tool_use"
      )
    ) {
      return;
    }

    const lastMessage = model.messages[model.messages.length - 1];
    if (!(lastMessage && lastMessage.role == "assistant")) {
      return;
    }

    function isBlocking(requestId: ToolManager.ToolRequestId) {
      const toolWrapper = model.toolManager.toolWrappers[requestId];
      return toolWrapper.model.state.state != "done";
    }

    for (const part of lastMessage.parts) {
      if (part.type == "tool-request") {
        if (isBlocking(part.requestId)) {
          return;
        }
      }
    }

    for (const filePath in lastMessage.edits) {
      for (const requestId of lastMessage.edits[filePath].requestIds) {
        if (isBlocking(requestId)) {
          return;
        }
      }
    }

    return sendMessage(model);
  }

  function sendMessage(model: Model): Thunk<Msg> {
    return async function (dispatch: Dispatch<Msg>) {
      const messages = await getMessages(model);

      dispatch({
        type: "conversation-state",
        conversation: {
          state: "message-in-flight",
          sendDate: new Date(),
        },
      });
      let res;
      try {
        res = await getClient(nvim, model.provider).sendMessage(
          messages,
          (text) => {
            dispatch({
              type: "stream-response",
              text,
            });
          },
          (error) => {
            dispatch({
              type: "stream-error",
              error,
            });
          },
        );
      } finally {
        dispatch({
          type: "conversation-state",
          conversation: {
            state: "stopped",
            stopReason: res?.stopReason || "end_turn",
          },
        });
      }

      if (res.toolRequests?.length) {
        for (const request of res.toolRequests) {
          dispatch({
            type: "init-tool-use",
            request,
          });
        }
      }
    };
  }

  const MESSAGE_ANIMATION = ["⠁", "⠂", "⠄", "⠂"];

  const view: View<{ model: Model; dispatch: Dispatch<Msg> }> = ({
    model,
    dispatch,
  }) => {
    return d`${model.messages.map(
      (m, idx) =>
        d`${messageModel.view({
          model: m,
          toolManager: model.toolManager,
          dispatch: (msg) => {
            dispatch({ type: "message-msg", msg, idx });
          },
        })}\n`,
    )}${
      model.conversation.state == "message-in-flight"
        ? d`Awaiting response ${
            MESSAGE_ANIMATION[
              Math.floor(
                (new Date().getTime() - model.conversation.sendDate.getTime()) /
                  333,
              ) % MESSAGE_ANIMATION.length
            ]
          }`
        : d`Stopped (${model.conversation.stopReason || ""})`
    }${
      model.conversation.state == "stopped" &&
      !contextManagerModel.isContextEmpty(model.contextManager)
        ? d`\n${contextManagerModel.view({
            model: model.contextManager,
            dispatch: (msg) => dispatch({ type: "context-manager-msg", msg }),
          })}`
        : ""
    }`;
  };

  async function getMessages(model: Model): Promise<ProviderMessage[]> {
    const messages = model.messages.flatMap((msg) => {
      const messageContent: ProviderMessageContent[] = [];
      const toolResponseContent: ProviderMessageContent[] = [];

      for (const part of msg.parts) {
        const { content: param, result } = partModel.toMessageParam(
          part,
          model.toolManager,
        );
        messageContent.push(param);
        if (result) {
          toolResponseContent.push(result);
        }
      }

      for (const filePath in msg.edits) {
        for (const requestId of msg.edits[filePath].requestIds) {
          const toolWrapper = model.toolManager.toolWrappers[requestId];
          if (!toolWrapper) {
            throw new Error(
              `Expected to find tool use with requestId ${requestId}`,
            );
          }

          messageContent.push({
            type: "tool_use",
            request: toolWrapper.model.request,
          });

          toolResponseContent.push(
            toolManagerModel.getToolResult(toolWrapper.model),
          );
        }
      }

      const out: ProviderMessage[] = [
        {
          role: msg.role,
          content: messageContent,
        },
      ];

      if (toolResponseContent.length) {
        out.push({
          role: "user",
          content: toolResponseContent,
        });
      }

      return out;
    });

    const contextMessage = await contextManagerModel.getContextMessage(
      model.contextManager,
    );

    if (contextMessage) {
      nvim.logger?.debug(
        `Got context message: ${JSON.stringify(contextMessage)}`,
      );
      messages.push(contextMessage);
    }

    return messages;
  }

  return {
    initModel,
    update,
    view,
    getMessages,
  };
}
