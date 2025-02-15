import * as Part from "./part.ts";
import * as Message from "./message.ts";
import * as ContextManager from "../context/context-manager.ts";
import {
  chainThunks,
  type Dispatch,
  parallelThunks,
  type Thunk,
  type Update,
  wrapThunk,
} from "../tea/tea.ts";
import { d, withBindings, type View } from "../tea/view.ts";
import * as ToolManager from "../tools/toolManager.ts";
import { type Result } from "../utils/result.ts";
import { Counter } from "../utils/uniqueId.ts";
import type { Nvim } from "nvim-node";
import type { Lsp } from "../lsp.ts";
import {
  getProvider as getProvider,
  type ProviderMessage,
  type ProviderMessageContent,
  type ProviderSetting,
  type StopReason,
  type Usage,
} from "../providers/provider.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { getOption } from "../nvim/nvim.ts";

export type Role = "user" | "assistant";

export type ConversationState =
  | {
      state: "message-in-flight";
      sendDate: Date;
    }
  | {
      state: "stopped";
      stopReason: StopReason;
      usage: Usage;
    };

export type Model = {
  lastUserMessageId: Message.MessageId;
  providerSetting: ProviderSetting;
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
  | { type: "choose-provider"; provider: ProviderSetting }
  | {
      type: "context-manager-msg";
      msg: ContextManager.Msg;
    }
  | {
      type: "add-file-context";
      absFilePath: string;
      relFilePath: string;
    }
  | {
      type: "add-message";
      role: Role;
      content?: string;
    }
  | {
      type: "edit-message";
      // delete will remove user message and all consecutive ones
      // regenerate will regenerate assistant message based on closest previous user message
      // edit will move message to the input buffer and remove all consecutive messages
      action: "delete" | "regenerate" | "edit";
      role: Role;
      id: number;
    }
  | {
      type: "prepend-input-buffer";
      text: string;
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
    }
  | {
      type: "show-message-debug-info";
    };

// Returns the message ID of the last user message or falls back to the counter's last value
function getLastUserMessageId(
  lastUserMessage: Message.Model | undefined,
  counter: Counter,
): Message.MessageId {
  if (lastUserMessage !== undefined) {
    return lastUserMessage.id;
  }
  return counter.last() as Message.MessageId;
}

export function init({ nvim, lsp }: { nvim: Nvim; lsp: Lsp }) {
  const counter = new Counter();
  const partModel = Part.init({ nvim, lsp });
  const toolManagerModel = ToolManager.init({ nvim, lsp });
  const contextManagerModel = ContextManager.init({ nvim });
  const messageModel = Message.init({ nvim, lsp });

  function initModel(): Model {
    return {
      lastUserMessageId: getLastUserMessageId(undefined, counter),
      providerSetting: {
        provider: "anthropic",
        model: "claude-3-5-sonnet-latest",
      },
      conversation: {
        state: "stopped",
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
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
        return [{ ...model, providerSetting: msg.provider }];
      case "add-message": {
        let message: Message.Model = {
          id: counter.get() as Message.MessageId,
          role: msg.role,
          parts: [],
          edits: {},
        };

        if (message.role == "user") {
          model.lastUserMessageId = message.id;
        }

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

      case "edit-message": {
        if (model.conversation.state !== "stopped") return [model];
        const messageIndex = model.messages.findIndex((m) => m.id === msg.id);
        if (messageIndex === -1) {
          return [model];
        }

        const { role, action } = msg;

        switch (action) {
          case "delete": {
            model.messages = model.messages.slice(0, messageIndex);
            const lastUserMessage = model.messages.findLast(
              (m) => m.role === "user",
            );
            model.lastUserMessageId = getLastUserMessageId(
              lastUserMessage,
              counter,
            );
            return [model];
          }
          case "regenerate": {
            const searchEndIndex = messageIndex + 1;
            // if it's assistant message, then find last previous user message
            const lastUserMessageIndex =
              role === "user"
                ? messageIndex
                : model.messages.findLastIndex(
                    (m, i) => m.role === "user" && i < searchEndIndex,
                  );

            if (lastUserMessageIndex === -1) {
              nvim.logger?.error(
                "Cannot regenerate message, no previous user message found",
              );
              return [model];
            }

            model.messages = model.messages.slice(0, lastUserMessageIndex + 1);
            model.lastUserMessageId = model.messages[lastUserMessageIndex].id;
            return [model, sendMessage(model)];
          }

          case "edit": {
            const { role, id } = msg;
            if (role !== "user") return [model];

            const messageIndex = model.messages.findIndex((m) => m.id === id);
            if (messageIndex === -1) return [model];
            const message = model.messages[messageIndex];

            const text = message.parts
              .filter((p) => p.type == "text")
              .map((p) => p.text)
              .join("");

            const dispatchPrepend: Thunk<Msg> = async (dispatch) =>
              Promise.resolve(dispatch({ type: "prepend-input-buffer", text }));
            const dispatchDeleteMsg: Thunk<Msg> = async (dispatch) =>
              Promise.resolve(
                dispatch({ type: "edit-message", role, id, action: "delete" }),
              );

            return [
              model,
              chainThunks<Msg>(dispatchPrepend, dispatchDeleteMsg),
            ];
          }

          default:
            assertUnreachable(action);
        }
        break;
      }

      case "conversation-state": {
        model.conversation = msg.conversation;
        if (msg.conversation.state == "stopped") {
          const lastMessage = model.messages[model.messages.length - 1];
          if (lastMessage?.role === "assistant") {
            lastMessage.parts.push({
              type: "stop-msg",
              stopReason: msg.conversation.stopReason,
              usage: msg.conversation.usage,
            });
          }
        }
        return [model, maybeAutorespond(model)];
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
          if (msg.msg.requestId) {
            const toolWrapper =
              model.toolManager.toolWrappers[msg.msg.requestId];
            if (toolWrapper) {
              toolWrapper.model.state = {
                state: "done",
                result: {
                  type: "tool_result",
                  id: msg.msg.requestId,
                  result: {
                    status: "error",
                    error: msg.msg.message,
                  },
                },
              };
            }
          } else {
            const message = model.messages[msg.idx];
            const edit = message.edits[msg.msg.filePath];
            edit.status = {
              status: "error",
              message: msg.msg.message,
            };
          }
        }

        if (msg.msg.type === "edit-message") {
          const message = msg.msg;
          return [
            model,
            parallelThunks<Msg>(
              wrapMessageThunk(msg.idx, messageThunk),
              async (dispatch) => Promise.resolve(dispatch(message)),
            ),
          ];
        }

        return [model, wrapMessageThunk(msg.idx, messageThunk)];
      }

      case "stream-response": {
        const lastMessage = model.messages[model.messages.length - 1];
        if (lastMessage?.role !== "assistant") {
          model.messages.push({
            id: counter.get() as Message.MessageId,
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
            id: counter.get() as Message.MessageId,
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
            id: counter.get() as Message.MessageId,
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
            wrapMessageThunk(model.messages.length - 1, messageThunk),
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

      case "add-file-context": {
        const [nextContextManager, contextManagerThunk] =
          contextManagerModel.update(
            {
              type: "add-file-context",
              absFilePath: msg.absFilePath,
              relFilePath: msg.relFilePath,
              messageId: model.lastUserMessageId,
            },
            model.contextManager,
          );
        model.contextManager = nextContextManager;
        return [
          model,
          parallelThunks(wrapThunk("context-manager-msg", contextManagerThunk)),
        ];
      }

      case "clear": {
        return [initModel()];
      }

      case "show-message-debug-info": {
        return [model, () => showDebugInfo(model)];
      }

      case "prepend-input-buffer": {
        //NOTE: this is handled by the parent component
        return [model];
      }

      default:
        assertUnreachable(msg);
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

    // all edits will also appear in the parts, so we don't need to check those twice.

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
        res = await getProvider(nvim, model.providerSetting).sendMessage(
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

        if (res.toolRequests?.length) {
          for (const request of res.toolRequests) {
            dispatch({
              type: "init-tool-use",
              request,
            });
          }
        }
      } finally {
        dispatch({
          type: "conversation-state",
          conversation: {
            state: "stopped",
            stopReason: res?.stopReason || "end_turn",
            usage: res?.usage || { inputTokens: 0, outputTokens: 0 },
          },
        });
      }
    };
  }

  const MESSAGE_ANIMATION = ["⠁", "⠂", "⠄", "⠂"];

  const view: View<{ model: Model; dispatch: Dispatch<Msg> }> = ({
    model,
    dispatch,
  }) => {
    if (
      model.messages.length == 0 &&
      Object.keys(model.contextManager.files).length == 0
    ) {
      return d`${LOGO}`;
    }

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
        : withBindings(d`Stopped (${model.conversation.stopReason})`, {
            "<CR>": () => dispatch({ type: "show-message-debug-info" }),
          })
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
        const { content, result } = partModel.toMessageParam(
          part,
          model.toolManager,
        );
        if (content) {
          messageContent.push(content);
        }
        if (result) {
          toolResponseContent.push(result);
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

      return out.map((m) => ({
        message: m,
        messageId: msg.id,
      }));
    });

    const contextMessages = await contextManagerModel.getContextMessages(
      counter.last() as Message.MessageId,
      model.contextManager,
    );

    if (contextMessages) {
      nvim.logger?.debug(
        `Got context messages: ${JSON.stringify(contextMessages)}`,
      );

      for (const contextMessage of contextMessages) {
        // we want to insert the contextMessage before the corresponding user message
        let idx = messages.findIndex(
          (m) => m.messageId >= contextMessage.messageId,
        );
        if (idx == -1) {
          idx = messages.length;
        }
        messages.splice(idx, 0, contextMessage);
      }
    }

    return messages.map((m) => m.message);
  }

  async function showDebugInfo(model: Model) {
    const messages = await getMessages(model);
    const provider = getProvider(nvim, model.providerSetting);
    const params = provider.createStreamParameters(messages);
    const nTokens = await provider.countTokens(messages);

    // Create a floating window
    const bufnr = await nvim.call("nvim_create_buf", [false, true]);
    await nvim.call("nvim_buf_set_option", [bufnr, "bufhidden", "wipe"]);
    const [editorWidth, editorHeight] = (await Promise.all([
      getOption("columns", nvim),
      await getOption("lines", nvim),
    ])) as [number, number];
    const width = 80;
    const height = editorHeight - 20;
    await nvim.call("nvim_open_win", [
      bufnr,
      true,
      {
        relative: "editor",
        width,
        height,
        col: Math.floor((editorWidth - width) / 2),
        row: Math.floor((editorHeight - height) / 2),
        style: "minimal",
        border: "single",
      },
    ]);

    const lines = JSON.stringify(params, null, 2).split("\n");
    lines.push(`nTokens: ${nTokens}`);
    await nvim.call("nvim_buf_set_lines", [bufnr, 0, -1, false, lines]);

    // Set buffer options
    await nvim.call("nvim_buf_set_option", [bufnr, "modifiable", false]);
    await nvim.call("nvim_buf_set_option", [bufnr, "filetype", "json"]);
  }

  return {
    initModel,
    update,
    view,
    getMessages,
  };
}

export const LOGO = `\

   ________
  ╱        ╲
 ╱         ╱
╱         ╱
╲__╱__╱__╱

# magenta.nvim`;
