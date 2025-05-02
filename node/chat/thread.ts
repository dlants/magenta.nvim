import { Part } from "./part.ts";
import {
  Message,
  view as messageView,
  type MessageId,
  type Msg as MessageMsg,
} from "./message.ts";

import { ContextManager } from "../context/context-manager.ts";
import { type Dispatch } from "../tea/tea.ts";
import { d, withBindings, type View } from "../tea/view.ts";
import {
  ToolManager,
  type ToolRequest,
  type ToolRequestId,
} from "../tools/toolManager.ts";
import { type Result } from "../utils/result.ts";
import { Counter } from "../utils/uniqueId.ts";
import type { Nvim } from "nvim-node";
import type { Lsp } from "../lsp.ts";
import {
  getProvider as getProvider,
  type ProviderMessage,
  type ProviderMessageContent,
  type StopReason,
  type Usage,
} from "../providers/provider.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { getOption } from "../nvim/nvim.ts";
import { type MagentaOptions, type Profile } from "../options.ts";
import type { RootMsg } from "../root-msg.ts";

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
    }
  | {
      state: "error";
      error: Error;
      lastAssistantMessage?: Message;
    };

export type Msg =
  | { type: "update-profile"; profile: Profile }
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
      type: "init-tool-use";
      request: Result<ToolRequest, { rawRequest: unknown }>;
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
      profile: Profile;
    }
  | {
      type: "show-message-debug-info";
    }
  | {
      type: "message-msg";
      msg: MessageMsg;
      id: MessageId;
    };

export type ThreadMsg = {
  type: "thread-msg";
  msg: Msg;
};

export class Thread {
  public state: {
    lastUserMessageId: MessageId;
    profile: Profile;
    conversation: ConversationState;
    messages: Message[];
  };

  private dispatch: Dispatch<RootMsg>;
  private myDispatch: Dispatch<Msg>;
  public toolManager: ToolManager;
  public contextManager: ContextManager;
  private counter: Counter;
  private nvim: Nvim;
  private lsp: Lsp;
  private options: MagentaOptions;

  constructor({
    dispatch,
    profile,
    nvim,
    contextManager,
    lsp,
    options,
  }: {
    dispatch: Dispatch<RootMsg>;
    profile: Profile;
    nvim: Nvim;
    lsp: Lsp;
    contextManager: ContextManager;
    options: MagentaOptions;
  }) {
    this.dispatch = dispatch;
    this.myDispatch = (msg) =>
      this.dispatch({
        type: "thread-msg",
        msg,
      });

    this.nvim = nvim;
    this.lsp = lsp;
    this.counter = new Counter();
    this.contextManager = contextManager;
    this.options = options;
    this.toolManager = new ToolManager({
      dispatch: this.dispatch,
      nvim: this.nvim,
      lsp: this.lsp,
      options: this.options,
    });

    this.state = {
      lastUserMessageId: this.counter.last() as MessageId,
      profile,
      conversation: {
        state: "stopped",
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      messages: [],
    };
  }

  update(msg: RootMsg): void {
    if (msg.type == "thread-msg") {
      this.myUpdate(msg.msg);
    } else if (msg.type == "tool-manager-msg") {
      this.toolManager.update(msg.msg);
      this.maybeAutorespond();
    } else if (msg.type == "context-manager-msg") {
      this.contextManager.update(msg.msg);
    }
  }

  private myUpdate(msg: Msg): void {
    switch (msg.type) {
      case "update-profile":
        this.state.profile = msg.profile;
        break;
      case "add-message": {
        const message = new Message({
          dispatch: this.dispatch,
          state: {
            id: this.counter.get() as MessageId,
            role: msg.role,
            parts: [],
            edits: {},
          },
          nvim: this.nvim,
          toolManager: this.toolManager,
        });
        this.state.messages.push(message);

        if (message.state.role == "user") {
          this.state.lastUserMessageId = message.state.id;
        }

        if (msg.content) {
          message.update({
            type: "append-text",
            text: msg.content,
          });
          return;
        }
        return;
      }

      case "conversation-state": {
        this.state.conversation = msg.conversation;

        switch (msg.conversation.state) {
          case "stopped": {
            const lastMessage =
              this.state.messages[this.state.messages.length - 1];
            if (lastMessage?.state.role === "assistant") {
              lastMessage.state.parts.push(
                new Part({
                  state: {
                    type: "stop-msg",
                    stopReason: msg.conversation.stopReason,
                    usage: msg.conversation.usage,
                  },
                  toolManager: this.toolManager,
                }),
              );
            }
            this.maybeAutorespond();
            return;
          }

          case "error": {
            const lastAssistantMessage =
              this.state.messages[this.state.messages.length - 1];
            if (lastAssistantMessage?.state.role == "assistant") {
              this.state.messages.pop();

              // save the last message so we can show a nicer error message.
              (
                this.state.conversation as Extract<
                  ConversationState,
                  { state: "error" }
                >
              ).lastAssistantMessage = lastAssistantMessage;
            }

            const lastUserMessage =
              this.state.messages[this.state.messages.length - 1];
            if (lastUserMessage?.state.role == "user") {
              this.state.messages.pop();

              // dispatch a followup action next tick
              setTimeout(
                () =>
                  this.dispatch({
                    type: "sidebar-setup-resubmit",
                    lastUserMessage: lastUserMessage.state.parts
                      .map((p) => (p.state.type == "text" ? p.state.text : ""))
                      .join(""),
                  }),
                1,
              );
            }
            break;
          }

          case "message-in-flight":
            break;

          default:
            assertUnreachable(msg.conversation);
        }
        break;
      }

      case "send-message": {
        const lastMessage = this.state.messages[this.state.messages.length - 1];
        if (lastMessage && lastMessage.state.role == "user") {
          this.sendMessage().catch((error: Error) =>
            this.myDispatch({
              type: "conversation-state",
              conversation: {
                state: "error",
                error,
              },
            }),
          );
        } else {
          this.nvim.logger?.error(
            `Cannot send when the last message has role ${lastMessage && lastMessage.state.role}`,
          );
        }
        break;
      }

      case "stream-response": {
        const lastMessage = this.state.messages[this.state.messages.length - 1];
        if (lastMessage?.state.role !== "assistant") {
          this.state.messages.push(
            new Message({
              dispatch: this.dispatch,
              state: {
                id: this.counter.get() as MessageId,
                role: "assistant",
                parts: [],
                edits: {},
              },
              nvim: this.nvim,
              toolManager: this.toolManager,
            }),
          );
        }

        const message = this.state.messages[this.state.messages.length - 1];
        message.update({
          type: "append-text",
          text: msg.text,
        });
        return;
      }

      case "init-tool-use": {
        const lastMessage = this.state.messages[this.state.messages.length - 1];
        if (lastMessage?.state.role !== "assistant") {
          this.state.messages.push(
            new Message({
              dispatch: this.dispatch,
              state: {
                id: this.counter.get() as MessageId,
                role: "assistant",
                parts: [],
                edits: {},
              },
              nvim: this.nvim,
              toolManager: this.toolManager,
            }),
          );
        }

        if (msg.request.status == "error") {
          const message = this.state.messages[this.state.messages.length - 1];
          message.update({
            type: "add-malformed-tool-reqeust",
            error: msg.request.error,
            rawRequest: msg.request.rawRequest,
          });

          return;
        } else {
          this.toolManager.update({
            type: "init-tool-use",
            request: msg.request.value,
          });

          const message = this.state.messages[this.state.messages.length - 1];
          message.update({
            type: "add-tool-request",
            requestId: msg.request.value.id,
          });
          return;
        }
      }

      case "clear": {
        this.state = {
          lastUserMessageId: this.counter.last() as MessageId,
          profile: msg.profile,
          conversation: {
            state: "stopped",
            stopReason: "end_turn",
            usage: { inputTokens: 0, outputTokens: 0 },
          },
          messages: [],
        };
        return undefined;
      }

      case "show-message-debug-info": {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this.showDebugInfo();
        return;
      }

      case "message-msg": {
        const message = this.state.messages.find((m) => m.state.id == msg.id);
        if (!message) {
          throw new Error(`Unable to find message with id ${msg.id}`);
        }
        message.update(msg.msg);
        return;
      }

      default:
        assertUnreachable(msg);
    }
  }

  /** If the agent is waiting on tool use, check the last message to see if all tools have been resolved. If so,
   * automatically respond.
   */
  maybeAutorespond(): void {
    if (
      !(
        this.state.conversation.state == "stopped" &&
        this.state.conversation.stopReason == "tool_use"
      )
    ) {
      return;
    }

    const lastMessage = this.state.messages[this.state.messages.length - 1];
    if (!(lastMessage && lastMessage.state.role == "assistant")) {
      return;
    }

    const isBlocking = (requestId: ToolRequestId) => {
      const toolWrapper = this.toolManager.state.toolWrappers[requestId];
      return toolWrapper.tool.state.state != "done";
    };

    for (const part of lastMessage.state.parts) {
      if (part.state.type == "tool-request") {
        if (isBlocking(part.state.requestId)) {
          return;
        }
      }
    }

    this.sendMessage().catch((error: Error) =>
      this.myDispatch({
        type: "conversation-state",
        conversation: {
          state: "error",
          error,
        },
      }),
    );
  }

  async sendMessage(): Promise<void> {
    const messages = await this.getMessages();

    this.myDispatch({
      type: "conversation-state",
      conversation: {
        state: "message-in-flight",
        sendDate: new Date(),
      },
    });
    const res = await getProvider(this.nvim, this.state.profile).sendMessage(
      messages,
      (text) => {
        this.myDispatch({
          type: "stream-response",
          text,
        });
      },
    );

    if (res.toolRequests?.length) {
      for (const request of res.toolRequests) {
        this.myDispatch({
          type: "init-tool-use",
          request,
        });
      }
    }
    this.myDispatch({
      type: "conversation-state",
      conversation: {
        state: "stopped",
        stopReason: res?.stopReason || "end_turn",
        usage: res?.usage || { inputTokens: 0, outputTokens: 0 },
      },
    });
  }

  async showDebugInfo() {
    const messages = await this.getMessages();
    const provider = getProvider(this.nvim, this.state.profile);
    const params = provider.createStreamParameters(messages);
    const nTokens = await provider.countTokens(messages);

    // Create a floating window
    const bufnr = await this.nvim.call("nvim_create_buf", [false, true]);
    await this.nvim.call("nvim_buf_set_option", [bufnr, "bufhidden", "wipe"]);
    const [editorWidth, editorHeight] = (await Promise.all([
      getOption("columns", this.nvim),
      getOption("lines", this.nvim),
    ])) as [number, number];
    const width = 80;
    const height = editorHeight - 20;
    await this.nvim.call("nvim_open_win", [
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
    await this.nvim.call("nvim_buf_set_lines", [bufnr, 0, -1, false, lines]);

    // Set buffer options
    await this.nvim.call("nvim_buf_set_option", [bufnr, "modifiable", false]);
    await this.nvim.call("nvim_buf_set_option", [bufnr, "filetype", "json"]);
  }

  async getMessages(): Promise<ProviderMessage[]> {
    const messages = this.state.messages.flatMap((msg) => {
      let messageContent: ProviderMessageContent[] = [];
      const out: ProviderMessage[] = [];

      for (const part of msg.state.parts) {
        const { content, result } = part.toMessageContent();

        if (content) {
          messageContent.push(content);
        }

        if (result) {
          if (messageContent.length) {
            out.push({
              role: msg.state.role,
              content: messageContent,
            });
            messageContent = [];
          }

          out.push({
            role: "user",
            content: [result],
          });
        }
      }

      if (messageContent.length) {
        out.push({
          role: msg.state.role,
          content: messageContent,
        });
      }

      return out.map((m) => ({
        message: m,
        messageId: msg.state.id,
      }));
    });

    const contextMessages = await this.contextManager.getContextMessages(
      this.counter.last() as MessageId,
    );

    if (contextMessages) {
      this.nvim.logger?.debug(
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
}

export const view: View<{
  thread: Thread;
  dispatch: Dispatch<Msg>;
}> = ({ thread, dispatch }) => {
  if (
    thread.state.messages.length == 0 &&
    Object.keys(thread.contextManager.files).length == 0 &&
    thread.state.conversation.state == "stopped"
  ) {
    return d`${LOGO}`;
  }

  return d`${thread.state.messages.map(
    (m) =>
      d`${messageView({
        message: m,
        dispatch: (msg) =>
          dispatch({
            type: "message-msg",
            id: m.state.id,
            msg,
          }),
      })}\n`,
  )}${
    thread.state.conversation.state == "message-in-flight"
      ? d`Awaiting response ${
          MESSAGE_ANIMATION[
            Math.floor(
              (new Date().getTime() -
                thread.state.conversation.sendDate.getTime()) /
                333,
            ) % MESSAGE_ANIMATION.length
          ]
        }`
      : thread.state.conversation.state == "stopped"
        ? withBindings(d`Stopped (${thread.state.conversation.stopReason})`, {
            "<CR>": () => dispatch({ type: "show-message-debug-info" }),
          })
        : d`Error ${thread.state.conversation.error.message}${thread.state.conversation.error.stack ? "\n" + thread.state.conversation.error.stack : ""}${
            thread.state.conversation.lastAssistantMessage
              ? "\n\nLast assistant message:\n" +
                JSON.stringify(
                  thread.state.conversation.lastAssistantMessage,
                  null,
                  2,
                )
              : ""
          }`
  }${
    thread.state.conversation.state != "message-in-flight" &&
    !thread.contextManager.isContextEmpty()
      ? d`\n${thread.contextManager.view()}`
      : ""
  }`;
};

export const LOGO = `\

   ________
  ╱        ╲
 ╱         ╱
╱         ╱
╲__╱__╱__╱

# magenta.nvim`;

const MESSAGE_ANIMATION = ["⠁", "⠂", "⠄", "⠂"];
