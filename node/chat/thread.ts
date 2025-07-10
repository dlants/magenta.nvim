import { Message, type MessageId, type Msg as MessageMsg } from "./message.ts";

import {
  ContextManager,
  contextUpdatesToContent,
  type Msg as ContextManagerMsg,
} from "../context/context-manager.ts";
import { type Dispatch } from "../tea/tea.ts";
import { d, type View, type VDOMNode } from "../tea/view.ts";
import {
  ToolManager,
  type Msg as ToolManagerMsg,
  type StaticToolRequest,
} from "../tools/toolManager.ts";
import { MCPToolManager } from "../tools/mcp/manager.ts";
import { Counter } from "../utils/uniqueId.ts";
import { FileSnapshots } from "../tools/file-snapshots.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { Lsp } from "../lsp.ts";
import {
  getProvider as getProvider,
  type ProviderMessage,
  type ProviderMessageContent,
  type ProviderStreamEvent,
  type ProviderStreamRequest,
  type ProviderToolUseRequest,
  type StopReason,
  type Usage,
} from "../providers/provider.ts";
import { spec as compactThreadSpec } from "../tools/compact-thread.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { type MagentaOptions, type Profile } from "../options.ts";
import type { RootMsg } from "../root-msg.ts";
import type {
  AbsFilePath,
  NvimCwd,
  UnresolvedFilePath,
} from "../utils/files.ts";
import type { BufferTracker } from "../buffer-tracker.ts";
import {
  type Input as ThreadTitleInput,
  spec as threadTitleToolSpec,
} from "../tools/thread-title.ts";

import type { Chat } from "./chat.ts";
import type { ThreadId, ThreadType } from "./types.ts";
import { getSystemPrompt } from "../providers/system-prompt.ts";

export type StoppedConversationState = {
  state: "stopped";
  stopReason: StopReason;
  usage: Usage;
};

export type ConversationState =
  | {
      state: "message-in-flight";
      sendDate: Date;
      request: ProviderStreamRequest;
    }
  | {
      state: "compacting";
      sendDate: Date;
      request: ProviderToolUseRequest;
      userMsgContent: string;
    }
  | StoppedConversationState
  | {
      state: "error";
      error: Error;
      lastAssistantMessage?: Message;
    }
  | {
      state: "yielded";
      response: string;
    };

export type Msg =
  | { type: "set-title"; title: string }
  | { type: "update-profile"; profile: Profile }
  | {
      type: "stream-event";
      event: ProviderStreamEvent;
    }
  | {
      type: "send-message";
      content: string;
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
      type: "abort";
    }
  // | {
  //     type: "show-message-debug-info";
  //   }
  | {
      type: "message-msg";
      msg: MessageMsg;
      id: MessageId;
    }
  | {
      type: "take-file-snapshot";
      unresolvedFilePath: UnresolvedFilePath;
      messageId: MessageId;
    }
  | {
      type: "tool-manager-msg";
      msg: ToolManagerMsg;
    }
  | {
      type: "context-manager-msg";
      msg: ContextManagerMsg;
    };

export type ThreadMsg = {
  type: "thread-msg";
  id: ThreadId;
  msg: Msg;
};

export class Thread {
  public state: {
    title?: string | undefined;
    lastUserMessageId: MessageId;
    profile: Profile;
    conversation: ConversationState;
    messages: Message[];
    threadType: ThreadType;
  };

  private myDispatch: Dispatch<Msg>;
  public toolManager: ToolManager;
  private counter: Counter;
  public fileSnapshots: FileSnapshots;
  public contextManager: ContextManager;

  constructor(
    public id: ThreadId,
    threadType: ThreadType,
    public context: {
      dispatch: Dispatch<RootMsg>;
      chat: Chat;
      mcpToolManager: MCPToolManager;
      bufferTracker: BufferTracker;
      profile: Profile;
      nvim: Nvim;
      cwd: NvimCwd;
      lsp: Lsp;
      contextManager: ContextManager;
      options: MagentaOptions;
    },
  ) {
    this.myDispatch = (msg) =>
      this.context.dispatch({
        type: "thread-msg",
        id: this.id,
        msg,
      });

    this.counter = new Counter();
    this.toolManager = new ToolManager(
      (msg) =>
        this.myDispatch({
          type: "tool-manager-msg",
          msg,
        }),
      {
        ...this.context,
        threadId: this.id,
      },
    );

    this.fileSnapshots = new FileSnapshots(this.context.nvim);
    this.contextManager = this.context.contextManager;

    this.state = {
      lastUserMessageId: this.counter.last() as MessageId,
      profile: this.context.profile,
      conversation: {
        state: "stopped",
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      messages: [],
      threadType: threadType,
    };
  }

  update(msg: RootMsg): void {
    if (msg.type == "thread-msg" && msg.id == this.id) {
      this.myUpdate(msg.msg);
    }
  }

  private myUpdate(msg: Msg): void {
    switch (msg.type) {
      case "update-profile":
        this.state.profile = msg.profile;
        break;

      case "conversation-state": {
        this.state.conversation = msg.conversation;

        switch (msg.conversation.state) {
          case "stopped": {
            this.handleConversationStop(msg.conversation);
            break;
          }

          case "error": {
            if (
              this.state.conversation.state == "stopped" &&
              this.state.conversation.stopReason == "aborted"
            ) {
              break;
            }
            const lastAssistantMessage =
              this.state.messages[this.state.messages.length - 1];
            if (lastAssistantMessage?.state.role == "assistant") {
              this.state.messages.pop();

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

              setTimeout(
                () =>
                  this.context.dispatch({
                    type: "sidebar-msg",
                    msg: {
                      type: "setup-resubmit",
                      lastUserMessage: lastUserMessage.state.content
                        .map((p) => (p.type == "text" ? p.text : ""))
                        .join(""),
                    },
                  }),
                1,
              );
            }
            break;
          }

          case "yielded":
          case "message-in-flight":
          case "compacting":
            break;

          default:
            assertUnreachable(msg.conversation);
        }

        break;
      }

      case "send-message": {
        if (msg.content?.startsWith("@compact")) {
          this.compactThread(msg.content.slice("@compact".length + 1)).catch(
            this.handleSendMessageError.bind(this),
          );
        } else {
          this.sendMessage(msg.content).catch(
            this.handleSendMessageError.bind(this),
          );
          if (!this.state.title) {
            this.setThreadTitle(msg.content).catch((err: Error) =>
              this.context.nvim.logger?.error(
                "Error getting thread title: " + err.message + "\n" + err.stack,
              ),
            );
          }
        }

        if (msg.content) {
          // NOTE: this is a bit hacky. We want to scroll after the user message has been populated in the display
          // buffer. the 100ms timeout is not the most precise way to do that, but it works for now
          setTimeout(() => {
            this.context.dispatch({
              type: "sidebar-msg",
              msg: {
                type: "scroll-to-last-user-message",
              },
            });
          }, 100);
        }
        break;
      }

      case "stream-event": {
        const lastMessage = this.state.messages[this.state.messages.length - 1];
        if (lastMessage?.state.role !== "assistant") {
          const messageId = this.counter.get() as MessageId;
          const message = new Message(
            {
              id: messageId,
              role: "assistant",
            },
            {
              ...this.context,
              threadId: this.id,
              myDispatch: (msg) =>
                this.myDispatch({
                  type: "message-msg",
                  id: messageId,
                  msg,
                }),
              toolManager: this.toolManager,
              fileSnapshots: this.fileSnapshots,
            },
          );

          this.state.messages.push(message);
        }

        const message = this.state.messages[this.state.messages.length - 1];
        message.update({
          type: "stream-event",
          event: msg.event,
        });

        return;
      }

      case "clear": {
        this.abortInProgressOperations();

        this.state = {
          lastUserMessageId: this.counter.last() as MessageId,
          profile: msg.profile,
          conversation: {
            state: "stopped",
            stopReason: "end_turn",
            usage: { inputTokens: 0, outputTokens: 0 },
          },
          messages: [],
          threadType: this.state.threadType,
        };
        this.contextManager.reset();

        return undefined;
      }

      case "message-msg": {
        const message = this.state.messages.find((m) => m.state.id == msg.id);
        if (!message) {
          throw new Error(`Unable to find message with id ${msg.id}`);
        }
        message.update(msg.msg);
        return;
      }

      case "take-file-snapshot": {
        this.fileSnapshots
          .willEditFile(msg.unresolvedFilePath, msg.messageId)
          .catch((e: Error) => {
            this.context.nvim.logger?.error(
              `Failed to take file snapshot: ${e.message}`,
            );
          });
        return;
      }

      case "tool-manager-msg": {
        this.toolManager.update(msg.msg);
        this.maybeAutoRespond();
        return;
      }

      case "context-manager-msg": {
        this.contextManager.update(msg.msg);
        return;
      }

      case "abort": {
        this.abortInProgressOperations();

        this.handleConversationStop({
          state: "stopped",
          stopReason: "aborted",
          usage: {
            inputTokens: -1,
            outputTokens: -1,
          },
        });

        return;
      }

      case "set-title": {
        this.state.title = msg.title;
        return;
      }

      default:
        assertUnreachable(msg);
    }
  }

  private handleConversationStop(stoppedState: StoppedConversationState) {
    const lastMessage = this.state.messages[this.state.messages.length - 1];
    lastMessage.update({
      type: "stop",
      stopReason: stoppedState.stopReason,
      usage: stoppedState.usage,
    });

    if (lastMessage.state.role == "assistant") {
      const lastContentBlock =
        lastMessage.state.content[lastMessage.state.content.length - 1];
      if (
        lastContentBlock.type == "tool_use" &&
        lastContentBlock.request.status == "ok"
      ) {
        const request = lastContentBlock.request.value;
        if (request.toolName == "yield_to_parent") {
          const yieldRequest = request as Extract<
            StaticToolRequest,
            { toolName: "yield_to_parent" }
          >;
          this.myUpdate({
            type: "conversation-state",
            conversation: {
              state: "yielded",
              response: yieldRequest.input.result,
            },
          });
          return;
        }
      }
    }

    this.state.conversation = stoppedState;

    this.maybeAutoRespond();
  }

  private abortInProgressOperations(): void {
    if (
      this.state.conversation.state === "message-in-flight" ||
      this.state.conversation.state === "compacting"
    ) {
      this.state.conversation.request.abort();
    }

    const lastMessage = this.state.messages[this.state.messages.length - 1];
    if (lastMessage) {
      for (const content of lastMessage.state.content) {
        if (content.type === "tool_use") {
          const tool = this.toolManager.getTool(content.id);
          if (!tool.isDone()) {
            tool.abort();
          }
        }
      }
    }
  }

  maybeAutoRespond(): void {
    if (
      this.state.conversation.state == "stopped" &&
      this.state.conversation.stopReason == "tool_use"
    ) {
      const lastMessage = this.state.messages[this.state.messages.length - 1];
      if (lastMessage && lastMessage.state.role == "assistant") {
        for (const content of lastMessage.state.content) {
          if (content.type == "tool_use" && content.request.status == "ok") {
            const request = content.request.value;
            const tool = this.toolManager.getTool(request.id);

            if (tool.request.toolName == "yield_to_parent" || !tool.isDone()) {
              // terminate early if we have a blocking tool use. This will not send a reply message
              return;
            }
          }
        }

        this.sendMessage().catch(this.handleSendMessageError.bind(this));
      }
    }
  }

  private handleSendMessageError = (error: Error): void => {
    this.context.nvim.logger?.error(error);
    if (this.state.conversation.state == "message-in-flight") {
      this.myDispatch({
        type: "conversation-state",
        conversation: {
          state: "error",
          error,
        },
      });
    }
  };

  private async prepareUserMessage(
    content?: string,
  ): Promise<{ messageId: MessageId; addedMessage: boolean }> {
    const messageId = this.counter.get() as MessageId;
    const contextUpdates = await this.contextManager.getContextUpdate();

    if ((content && content.length) || Object.keys(contextUpdates).length) {
      const messageContent: ProviderMessageContent[] =
        content && content.length
          ? [
              {
                type: "text",
                text: content,
              },
            ]
          : [];

      const message = new Message(
        {
          id: messageId,
          role: "user",
          content: messageContent,
          contextUpdates: Object.keys(contextUpdates).length
            ? contextUpdates
            : undefined,
        },
        {
          dispatch: this.context.dispatch,
          threadId: this.id,
          myDispatch: (msg) =>
            this.myDispatch({
              type: "message-msg",
              id: messageId,
              msg,
            }),
          nvim: this.context.nvim,
          cwd: this.context.cwd,
          toolManager: this.toolManager,
          fileSnapshots: this.fileSnapshots,
          options: this.context.options,
        },
      );

      this.state.messages.push(message);
      this.state.lastUserMessageId = message.state.id;
      return { messageId, addedMessage: true };
    }

    return { messageId, addedMessage: false };
  }

  async sendMessage(content?: string): Promise<void> {
    await this.prepareUserMessage(content);
    const messages = this.getMessages();

    const provider = getProvider(this.context.nvim, this.state.profile);
    const request = provider.sendMessage(
      messages,
      (event) => {
        this.myDispatch({
          type: "stream-event",
          event,
        });
      },
      this.toolManager.getToolSpecs(this.state.threadType),
      { systemPrompt: getSystemPrompt(this.state.threadType) },
    );

    this.myDispatch({
      type: "conversation-state",
      conversation: {
        state: "message-in-flight",
        sendDate: new Date(),
        request,
      },
    });

    const res = await request.promise;
    this.myDispatch({
      type: "conversation-state",
      conversation: {
        state: "stopped",
        stopReason: res?.stopReason || "end_turn",
        usage: res?.usage || { inputTokens: 0, outputTokens: 0 },
      },
    });
  }

  async compactThread(content: string): Promise<void> {
    const userMsgContent = `\
Use the compact_thread tool to analyze my next prompt and extract only the relevant parts of our conversation history.

My next prompt will be:
${content}`;

    const request = getProvider(
      this.context.nvim,
      this.state.profile,
    ).forceToolUse(
      [
        ...this.getMessages(),
        {
          role: "user",
          content: [
            {
              type: "text",
              text: userMsgContent,
            },
          ],
        },
      ],
      compactThreadSpec,
      { systemPrompt: getSystemPrompt(this.state.threadType) },
    );

    this.myDispatch({
      type: "conversation-state",
      conversation: {
        state: "compacting",
        sendDate: new Date(),
        request,
        userMsgContent,
      },
    });

    const result = await request.promise;

    if (result.toolRequest.status === "ok") {
      const compactRequest = result.toolRequest.value as Extract<
        StaticToolRequest,
        { toolName: "compact_thread" }
      >;

      this.context.dispatch({
        type: "chat-msg",
        msg: {
          type: "compact-thread",
          threadId: this.id,
          contextFilePaths: compactRequest.input.contextFiles,
          initialMessage: `\
# Previous thread summary:
${compactRequest.input.summary}

# The user would like you to address this prompt next:
${content}`,
        },
      });

      // Update the conversation state to show successful compaction
      this.myDispatch({
        type: "conversation-state",
        conversation: {
          state: "stopped",
          stopReason: "end_turn",
          usage: result.usage || { inputTokens: 0, outputTokens: 0 },
        },
      });
    } else {
      this.myDispatch({
        type: "conversation-state",
        conversation: {
          state: "error",
          error: new Error(
            `Failed to compact thread: ${JSON.stringify(result.toolRequest.error)}`,
          ),
        },
      });
    }
  }

  getMessages(): ProviderMessage[] {
    const messages = this.state.messages.flatMap((message) => {
      let messageContent: ProviderMessageContent[] = [];
      const out: ProviderMessage[] = [];

      function commitMessages() {
        if (messageContent.length) {
          out.push({
            role: message.state.role,
            content: messageContent,
          });
          messageContent = [];
        }
      }

      /** result blocks must go into user messages
       */
      function pushResponseMessage(content: ProviderMessageContent) {
        commitMessages();
        out.push({
          role: "user",
          content: [content],
        });
      }

      if (message.state.contextUpdates) {
        messageContent.push(
          contextUpdatesToContent(message.state.contextUpdates),
        );
      }

      for (const contentBlock of message.state.content) {
        messageContent.push(contentBlock);

        if (contentBlock.type == "tool_use") {
          if (contentBlock.request.status == "ok") {
            const request = contentBlock.request.value;
            const tool = this.toolManager.getTool(request.id);
            pushResponseMessage(tool.getToolResult());
          } else {
            pushResponseMessage({
              type: "tool_result",
              id: contentBlock.id,
              result: contentBlock.request,
            });
          }
        }
      }

      commitMessages();

      return out.map((m) => ({
        message: m,
        messageId: message.state.id,
      }));
    });

    return messages.map((m) => m.message);
  }

  async setThreadTitle(userMessage: string) {
    const request = getProvider(
      this.context.nvim,
      this.context.profile,
    ).forceToolUse(
      [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `\
The user has provided the following prompt:
${userMessage}

Come up with a succinct thread title for this prompt. It should be less than 80 characters long.
`,
            },
          ],
        },
      ],
      threadTitleToolSpec,
      { systemPrompt: getSystemPrompt(this.state.threadType) },
    );
    const result = await request.promise;
    if (result.toolRequest.status == "ok") {
      this.myDispatch({
        type: "set-title",
        title: (result.toolRequest.value.input as ThreadTitleInput).title,
      });
    }
  }

  getLastStopTokenCount(): number {
    for (
      let msgIdx = this.state.messages.length - 1;
      msgIdx >= 0;
      msgIdx -= 1
    ) {
      const message = this.state.messages[msgIdx];
      const lastStop =
        message.state.stops[
          Math.max(...Object.keys(message.state.stops).map((s) => Number(s)))
        ];

      if (lastStop) {
        return (
          lastStop.usage.inputTokens +
          lastStop.usage.outputTokens +
          (lastStop.usage.cacheHits || 0) +
          (lastStop.usage.cacheMisses || 0)
        );
      }
    }

    return 0;
  }
}

/**
 * Helper function to render the animation frame for in-progress operations
 */
const getAnimationFrame = (sendDate: Date): string => {
  const frameIndex =
    Math.floor((new Date().getTime() - sendDate.getTime()) / 333) %
    MESSAGE_ANIMATION.length;

  return MESSAGE_ANIMATION[frameIndex];
};

/**
 * Helper function to render the conversation state message
 */
const renderConversationState = (conversation: ConversationState): VDOMNode => {
  switch (conversation.state) {
    case "message-in-flight":
      return d`Streaming response ${getAnimationFrame(conversation.sendDate)}`;
    case "compacting":
      return d`Compacting thread ${getAnimationFrame(conversation.sendDate)}`;
    case "stopped":
      return d``;
    case "yielded":
      return d`↗️ yielded to parent: ${conversation.response}`;
    case "error":
      return d`Error ${conversation.error.message}${
        conversation.error.stack ? "\n" + conversation.error.stack : ""
      }${
        conversation.lastAssistantMessage
          ? "\n\nLast assistant message:\n" +
            conversation.lastAssistantMessage.toString()
          : ""
      }`;
    default:
      assertUnreachable(conversation);
  }
};

/**
 * Helper function to determine if context manager view should be shown
 */
const shouldShowContextManager = (
  conversation: ConversationState,
  contextManager: ContextManager,
): boolean => {
  return (
    conversation.state !== "message-in-flight" &&
    conversation.state !== "compacting" &&
    !contextManager.isContextEmpty()
  );
};

export const view: View<{
  thread: Thread;
  dispatch: Dispatch<Msg>;
}> = ({ thread }) => {
  const titleView = thread.state.title
    ? d`# ${thread.state.title}`
    : d`# [ Untitled ]`;

  if (
    thread.state.messages.length == 0 &&
    thread.state.conversation.state == "stopped" &&
    thread.state.conversation.stopReason == "end_turn"
  ) {
    return d`${titleView}\n${LOGO}\n${thread.context.contextManager.view()}`;
  }

  const conversationStateView = renderConversationState(
    thread.state.conversation,
  );
  const contextManagerView = shouldShowContextManager(
    thread.state.conversation,
    thread.context.contextManager,
  )
    ? d`\n${thread.context.contextManager.view()}`
    : d``;

  let compactingUserMsg = d``;
  if (thread.state.conversation.state == "compacting") {
    const userMsgContent = thread.state.conversation.userMsgContent;
    compactingUserMsg = d`\
# user:
${userMsgContent}\n`;
  }

  return d`\
${titleView}
${thread.state.messages.map((m) => d`${m.view()}\n`)}\
${compactingUserMsg}\
${conversationStateView}\
${contextManagerView}`;
};

export const LOGO = `\

   ________
  ╱        ╲
 ╱         ╱
╱         ╱
╲__╱__╱__╱

# magenta.nvim`;

const MESSAGE_ANIMATION = ["⠁", "⠂", "⠄", "⠂"];
