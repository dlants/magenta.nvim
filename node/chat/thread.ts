import { Message, type MessageId, type Msg as MessageMsg } from "./message.ts";

import {
  ContextManager,
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
import { getDiagnostics } from "../utils/diagnostics.ts";
import { getQuickfixList, quickfixListToString } from "../nvim/nvim.ts";
import { getBuffersList } from "../utils/listBuffers.ts";
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
import type { NvimCwd, UnresolvedFilePath } from "../utils/files.ts";
import type { BufferTracker } from "../buffer-tracker.ts";
import {
  type Input as ThreadTitleInput,
  spec as threadTitleToolSpec,
} from "../tools/thread-title.ts";
import {
  resolveFilePath,
  relativePath,
  detectFileType,
} from "../utils/files.ts";

import type { Chat } from "./chat.ts";
import type { ThreadId, ThreadType } from "./types.ts";
import type { SystemPrompt } from "../providers/system-prompt.ts";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { $, within } from "zx";

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

export type InputMessage =
  | {
      type: "user";
      text: string;
    }
  | {
      type: "system";
      text: string;
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
      messages: InputMessage[];
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
    systemPrompt: SystemPrompt;
  };

  private myDispatch: Dispatch<Msg>;
  public toolManager: ToolManager;
  private counter: Counter;
  public fileSnapshots: FileSnapshots;
  public contextManager: ContextManager;

  constructor(
    public id: ThreadId,
    threadType: ThreadType,
    systemPrompt: SystemPrompt,
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
      systemPrompt: systemPrompt,
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
        if (
          msg.messages.length == 1 &&
          msg.messages[0].type == "user" &&
          msg.messages[0].text.startsWith("@compact")
        ) {
          this.compactThread(
            msg.messages[0].text.slice("@compact".length + 1),
          ).catch(this.handleSendMessageError.bind(this));
        } else {
          this.sendMessage(msg.messages).catch(
            this.handleSendMessageError.bind(this),
          );
          if (!this.state.title) {
            this.setThreadTitle(
              msg.messages.map((m) => m.text).join("\n"),
            ).catch((err: Error) =>
              this.context.nvim.logger.error(
                "Error getting thread title: " + err.message + "\n" + err.stack,
              ),
            );
          }
        }

        if (msg.messages.length) {
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
              contextManager: this.contextManager,
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
          systemPrompt: this.state.systemPrompt,
        };
        this.contextManager.reset();

        // Scroll to bottom after clearing
        setTimeout(() => {
          this.context.dispatch({
            type: "sidebar-msg",
            msg: {
              type: "scroll-to-bottom",
            },
          });
        }, 100);

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
            this.context.nvim.logger.error(
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
    if (lastMessage) {
      lastMessage.update({
        type: "stop",
        stopReason: stoppedState.stopReason,
        usage: stoppedState.usage,
      });
    }

    if (lastMessage && lastMessage.state.role == "assistant") {
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
    this.context.nvim.logger.error(error);
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
    messages?: InputMessage[],
  ): Promise<{ messageId: MessageId; addedMessage: boolean }> {
    const messageId = this.counter.get() as MessageId;

    // Process messages first to handle @file commands
    const messageContent: ProviderMessageContent[] = [];
    for (const m of messages || []) {
      messageContent.push({
        type: "text",
        text: m.text,
      });

      // Check for diagnostics keywords in user messages
      if (
        m.type === "user" &&
        (m.text.includes("@diag") || m.text.includes("@diagnostics"))
      ) {
        try {
          const diagnostics = await getDiagnostics(this.context.nvim);

          // Append diagnostics as a separate content block
          messageContent.push({
            type: "text",
            text: `Current diagnostics:\n${diagnostics}`,
          });
        } catch (error) {
          this.context.nvim.logger.error(
            `Failed to fetch diagnostics for message: ${error instanceof Error ? error.message : String(error)}`,
          );
          // Append error message as a separate content block
          messageContent.push({
            type: "text",
            text: `Error fetching diagnostics: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      // Check for quickfix keywords in user messages
      if (
        m.type === "user" &&
        (m.text.includes("@qf") || m.text.includes("@quickfix"))
      ) {
        try {
          const qflist = await getQuickfixList(this.context.nvim);
          const quickfixStr = await quickfixListToString(
            qflist,
            this.context.nvim,
          );

          // Append quickfix as a separate content block
          messageContent.push({
            type: "text",
            text: `Current quickfix list:\n${quickfixStr}`,
          });
        } catch (error) {
          this.context.nvim.logger.error(
            `Failed to fetch quickfix list for message: ${error instanceof Error ? error.message : String(error)}`,
          );
          // Append error message as a separate content block
          messageContent.push({
            type: "text",
            text: `Error fetching quickfix list: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      // Check for buffer keywords in user messages
      if (
        m.type === "user" &&
        (m.text.includes("@buf") || m.text.includes("@buffers"))
      ) {
        try {
          const buffersList = await getBuffersList(this.context.nvim);

          // Append buffers list as a separate content block
          messageContent.push({
            type: "text",
            text: `Current buffers list:\n${buffersList}`,
          });
        } catch (error) {
          this.context.nvim.logger.error(
            `Failed to fetch buffers list for message: ${error instanceof Error ? error.message : String(error)}`,
          );
          // Append error message as a separate content block
          messageContent.push({
            type: "text",
            text: `Error fetching buffers list: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      // Check for file commands in user messages
      if (m.type === "user") {
        const fileMatches = m.text.matchAll(/@file:(\S+)/g);
        for (const match of fileMatches) {
          const filePath = match[1] as UnresolvedFilePath;
          try {
            const absFilePath = resolveFilePath(this.context.cwd, filePath);
            const relFilePath = relativePath(this.context.cwd, absFilePath);
            const fileTypeInfo = await detectFileType(absFilePath);

            if (!fileTypeInfo) {
              throw new Error(`File ${filePath} does not exist`);
            }

            this.contextManager.update({
              type: "add-file-context",
              relFilePath,
              absFilePath,
              fileTypeInfo,
            });
          } catch (error) {
            this.context.nvim.logger.error(
              `Failed to add file to context for ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
            );
            messageContent.push({
              type: "text",
              text: `Error adding file to context for ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }

        const diffMatches = m.text.matchAll(/@diff:(\S+)/g);
        for (const match of diffMatches) {
          const filePath = match[1] as UnresolvedFilePath;
          try {
            const diffContent = await getGitDiff(filePath, this.context.cwd);
            messageContent.push({
              type: "text",
              text: `Git diff for \`${filePath}\`:\n\`\`\`diff\n${diffContent}\n\`\`\``,
            });
          } catch (error) {
            this.context.nvim.logger.error(
              `Failed to fetch git diff for \`${filePath}\`: ${error instanceof Error ? error.message : String(error)}`,
            );
            messageContent.push({
              type: "text",
              text: `Error fetching git diff for \`${filePath}\`: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }

        const stagedMatches = m.text.matchAll(/@staged:(\S+)/g);
        for (const match of stagedMatches) {
          const filePath = match[1] as UnresolvedFilePath;
          try {
            const stagedContent = await getStagedDiff(
              filePath,
              this.context.cwd,
            );
            messageContent.push({
              type: "text",
              text: `Staged diff for \`${filePath}\`:\n\`\`\`diff\n${stagedContent}\n\`\`\``,
            });
          } catch (error) {
            this.context.nvim.logger.error(
              `Failed to fetch staged diff for \`${filePath}\`: ${error instanceof Error ? error.message : String(error)}`,
            );
            messageContent.push({
              type: "text",
              text: `Error fetching staged diff for \`${filePath}\`: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
      }
    }

    // Now get context updates after all @file commands have been processed
    const contextUpdates = await this.contextManager.getContextUpdate();

    if (messages?.length || Object.keys(contextUpdates).length) {
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
          contextManager: this.contextManager,
        },
      );

      this.state.messages.push(message);
      this.state.lastUserMessageId = message.state.id;
      return { messageId, addedMessage: true };
    }

    return { messageId, addedMessage: false };
  }

  async sendMessage(inputMessages?: InputMessage[]): Promise<void> {
    await this.prepareUserMessage(inputMessages);
    const messages = this.getMessages();

    const provider = getProvider(this.context.nvim, this.state.profile);
    const request = provider.sendMessage({
      model: this.state.profile.model,
      messages,
      onStreamEvent: (event) => {
        this.myDispatch({
          type: "stream-event",
          event,
        });
      },
      tools: this.toolManager.getToolSpecs(this.state.threadType),
      systemPrompt: this.state.systemPrompt,
      ...(this.state.profile.thinking &&
        this.state.profile.provider === "anthropic" && {
          thinking: this.state.profile.thinking,
        }),
      ...(this.state.profile.reasoning &&
        this.state.profile.provider === "openai" && {
          reasoning: this.state.profile.reasoning,
        }),
    });

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

  async compactThread(text: string): Promise<void> {
    const userMsgContent = `\
Use the compact_thread tool to analyze my next prompt and extract only the relevant parts of our conversation history.

My next prompt will be:
${text}`;

    const request = getProvider(
      this.context.nvim,
      this.state.profile,
    ).forceToolUse({
      model: this.state.profile.model,
      // In this request we will be using a different set of tools, which will invalidate any cache we may have so far.
      // Also, since we're compacting, we do not expect this thread to be used in the future.
      disableCaching: true,
      messages: [
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
      spec: compactThreadSpec,
      systemPrompt: this.state.systemPrompt,
    });

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
          inputMessages: [
            {
              type: "system",
              text: `# Previous thread summary:
${compactRequest.input.summary}
# The user would like you to address this prompt next:
`,
            },
            { type: "user", text: text },
          ],
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
        const contextContent = this.contextManager.contextUpdatesToContent(
          message.state.contextUpdates,
        );
        messageContent.push(...contextContent);
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
    ).forceToolUse({
      model: this.context.profile.fastModel,
      messages: [
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
      spec: threadTitleToolSpec,
      systemPrompt: this.state.systemPrompt,
      disableCaching: true,
    });
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

      // Find the most recent stop event by iterating content in reverse order
      for (
        let contentIdx = message.state.content.length - 1;
        contentIdx >= 0;
        contentIdx--
      ) {
        const content = message.state.content[contentIdx];
        let stopInfo: { stopReason: StopReason; usage: Usage } | undefined;

        if (content.type === "tool_use" && content.request.status === "ok") {
          // For tool use content, check toolMeta
          const toolMeta = message.state.toolMeta[content.request.value.id];
          stopInfo = toolMeta?.stop;
        } else {
          // For regular content, check stops map
          stopInfo = message.state.stops[contentIdx];
        }

        if (stopInfo) {
          return (
            stopInfo.usage.inputTokens +
            stopInfo.usage.outputTokens +
            (stopInfo.usage.cacheHits || 0) +
            (stopInfo.usage.cacheMisses || 0)
          );
        }
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
    return d`\
${titleView}
${LOGO}

magenta is for agentic flow

${thread.context.contextManager.view()}`;
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

export const LOGO = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "logo.txt"),
  "utf-8",
);

const MESSAGE_ANIMATION = ["⠁", "⠂", "⠄", "⠂"];

/**
 * Helper functions for new @ commands
 */
async function getGitDiff(
  filePath: UnresolvedFilePath,
  cwd: NvimCwd,
): Promise<string> {
  try {
    const result = await within(async () => {
      $.cwd = cwd;
      return await $`git diff ${filePath}`;
    });
    return result.stdout || "(no unstaged changes)";
  } catch (error) {
    throw new Error(
      `Failed to get git diff: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function getStagedDiff(
  filePath: UnresolvedFilePath,
  cwd: NvimCwd,
): Promise<string> {
  try {
    const result = await within(async () => {
      $.cwd = cwd;
      return await $`git diff --staged ${filePath}`;
    });
    return result.stdout || "(no staged changes)";
  } catch (error) {
    throw new Error(
      `Failed to get staged diff: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
