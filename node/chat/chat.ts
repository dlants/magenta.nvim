import type { Nvim } from "../nvim/nvim-node";
import type { MagentaOptions, Profile } from "../options";
import type { RootMsg } from "../root-msg";
import type { Dispatch } from "../tea/tea";
import { Thread, view as threadView, type ThreadId } from "./thread";
import { CHAT_TOOL_NAMES, type ToolName } from "../tools/tool-registry.ts";
import type { ToolRequestId } from "../tools/toolManager.ts";
import type { Lsp } from "../lsp";
import { assertUnreachable } from "../utils/assertUnreachable";
import { d, withBindings, type VDOMNode } from "../tea/view";
import { Counter } from "../utils/uniqueId.ts";
import { ContextManager } from "../context/context-manager.ts";
import type { BufferTracker } from "../buffer-tracker.ts";
import {
  relativePath,
  resolveFilePath,
  type UnresolvedFilePath,
} from "../utils/files.ts";
import { getcwd } from "../nvim/nvim.ts";
import type { MessageId } from "./message.ts";
import type { Result } from "../utils/result.ts";

type Parent = {
  threadId: ThreadId;
  toolRequestId: ToolRequestId;
  yielded: boolean;
};

type ThreadWrapper = (
  | {
      state: "pending";
    }
  | {
      state: "initialized";
      thread: Thread;
    }
  | {
      state: "error";
      error: Error;
    }
) & {
  parent: Parent | undefined;
};

type ChatState =
  | {
      state: "thread-overview";
      activeThreadId: ThreadId | undefined;
    }
  | {
      state: "thread-selected";
      activeThreadId: ThreadId;
    };

export type Msg =
  | {
      type: "thread-initialized";
      thread: Thread;
    }
  | {
      type: "thread-error";
      id: ThreadId;
      error: Error;
    }
  | {
      type: "new-thread";
    }
  | {
      type: "compact-thread";
      threadId: ThreadId;
      contextFilePaths: UnresolvedFilePath[];
      initialMessage: string;
    }
  | {
      type: "spawn-subagent-thread";
      parentThreadId: ThreadId;
      parentToolRequestId: ToolRequestId;
      allowedTools: ToolName[];
      initialPrompt: string;
      contextFiles?: UnresolvedFilePath[];
    }
  | {
      type: "yield-to-parent";
      childThreadId: ThreadId;
      parentThreadId: ThreadId;
      parentToolRequestId: ToolRequestId;
      result: Result<string>;
    }
  | {
      type: "select-thread";
      id: ThreadId;
    }
  | {
      type: "threads-overview";
    };

export type ChatMsg = {
  type: "chat-msg";
  msg: Msg;
};

export class Chat {
  private threadCounter = new Counter();
  state: ChatState;
  private threadWrappers: { [id: ThreadId]: ThreadWrapper };

  constructor(
    private context: {
      dispatch: Dispatch<RootMsg>;
      bufferTracker: BufferTracker;
      options: MagentaOptions;
      nvim: Nvim;
      lsp: Lsp;
    },
  ) {
    this.threadWrappers = {};
    this.state = {
      state: "thread-overview",
      activeThreadId: undefined,
    };

    setTimeout(() => {
      this.createNewThread().catch((e: Error) => {
        this.context.nvim.logger?.error(
          "Failed to create thread: " + e.message + "\n" + e.stack,
        );
      });
    });
  }

  update(msg: RootMsg) {
    if (msg.type == "chat-msg") {
      this.myUpdate(msg.msg);
      return;
    }

    if (msg.type == "thread-msg" && msg.id in this.threadWrappers) {
      const threadState = this.threadWrappers[msg.id];
      if (threadState.state === "initialized") {
        const thread = threadState.thread;
        thread.update(msg);

        if (
          threadState.parent &&
          (thread.state.conversation.state == "yielded" ||
            thread.state.conversation.state == "error")
        ) {
          this.handleYieldToParent({
            childThreadId: thread.id,
            parentThreadId: threadState.parent.threadId,
            parentToolRequestId: threadState.parent.toolRequestId,
            result:
              thread.state.conversation.state == "yielded"
                ? {
                    status: "ok",
                    value: thread.state.conversation.response,
                  }
                : {
                    status: "error",
                    error:
                      thread.state.conversation.error.message +
                      "\n" +
                      thread.state.conversation.error.stack,
                  },
          });
        }
      }
    }
  }

  private myUpdate(msg: Msg) {
    switch (msg.type) {
      case "thread-initialized": {
        this.threadWrappers[msg.thread.id] = {
          state: "initialized",
          thread: msg.thread,
          parent: this.threadWrappers[msg.thread.id].parent,
        };

        this.state = {
          state: "thread-selected",
          activeThreadId: msg.thread.id,
        };
        return;
      }

      case "thread-error": {
        const prev = this.threadWrappers[msg.id];
        this.threadWrappers[msg.id] = {
          state: "error",
          error: msg.error,
          parent: undefined,
        };

        if (this.state.state === "thread-selected") {
          this.state = {
            state: "thread-overview",
            activeThreadId: msg.id,
          };
        }

        if (prev) {
          let parent: Parent | undefined;
          if (prev.state == "pending" || prev.state == "initialized") {
            parent = prev.parent;
          }

          if (parent) {
            this.handleYieldToParent({
              childThreadId: msg.id,
              parentThreadId: parent.threadId,
              parentToolRequestId: parent.toolRequestId,
              result: {
                status: "error",
                error: msg.error.message + "\n" + msg.error.stack,
              },
            });
          }
        }

        return;
      }

      case "new-thread":
        // wrap in setTimeout to force new eventloop frame, to avoid dispatch-in-dispatch
        setTimeout(() => {
          this.createNewThread().catch((e: Error) => {
            this.context.nvim.logger?.error(
              "Failed to create new thread: " + e.message + "\n" + e.stack,
            );
          });
        });
        return;

      case "select-thread":
        if (msg.id in this.threadWrappers) {
          this.state = {
            state: "thread-selected",
            activeThreadId: msg.id,
          };
        }
        return;

      case "threads-overview":
        this.state = {
          state: "thread-overview",
          activeThreadId: this.state.activeThreadId,
        };
        return;

      case "compact-thread": {
        this.handleCompactThread(msg).catch((e: Error) => {
          this.context.nvim.logger?.error(
            "Failed to handle thread compaction: " + e.message + "\n" + e.stack,
          );
        });
        return;
      }

      case "spawn-subagent-thread": {
        this.handleSpawnSubagentThread(msg).catch((e: Error) => {
          this.context.nvim.logger?.error(
            `Failed to spawn sub-agent thread: ${e.message} ${e.stack}`,
          );
        });
        return;
      }

      case "yield-to-parent": {
        this.handleYieldToParent(msg);
        return;
      }

      default:
        assertUnreachable(msg);
    }
  }

  getMessages() {
    if (
      this.state.state === "thread-selected" &&
      this.state.activeThreadId in this.threadWrappers
    ) {
      const threadState = this.threadWrappers[this.state.activeThreadId];
      if (threadState.state === "initialized") {
        return threadState.thread.getMessages();
      }
    }
    return [];
  }

  private async createThreadWithContext({
    threadId,
    profile,
    allowedTools,
    contextFiles = [],
    parent,
    switchToThread = true,
    initialMessage,
  }: {
    threadId: ThreadId;
    profile: Profile;
    allowedTools: ToolName[];
    contextFiles?: UnresolvedFilePath[];
    parent?: {
      threadId: ThreadId;
      toolRequestId: ToolRequestId;
    };
    switchToThread?: boolean;
    initialMessage?: string;
  }) {
    this.threadWrappers[threadId] = {
      state: "pending",
      parent: parent && { ...parent, yielded: false },
    };

    const contextManager = await ContextManager.create(
      (msg) =>
        this.context.dispatch({
          type: "thread-msg",
          id: threadId,
          msg: {
            type: "context-manager-msg",
            msg,
          },
        }),
      {
        dispatch: this.context.dispatch,
        bufferTracker: this.context.bufferTracker,
        nvim: this.context.nvim,
        options: this.context.options,
      },
    );

    if (contextFiles.length > 0) {
      for (const filePath of contextFiles) {
        const cwd = await getcwd(this.context.nvim);
        const absFilePath = resolveFilePath(cwd, filePath);
        const relFilePath = relativePath(cwd, absFilePath);
        contextManager.update({
          type: "add-file-context",
          absFilePath,
          relFilePath,
          messageId: 0 as MessageId,
        });
      }
    }

    const thread = new Thread(
      threadId,
      {
        ...this.context,
        contextManager,
        profile,
      },
      allowedTools,
      parent,
    );

    this.context.dispatch({
      type: "chat-msg",
      msg: {
        type: "thread-initialized",
        thread,
      },
    });

    if (switchToThread) {
      this.context.dispatch({
        type: "chat-msg",
        msg: {
          type: "select-thread",
          id: threadId,
        },
      });
    }

    if (initialMessage) {
      this.context.dispatch({
        type: "thread-msg",
        id: threadId,
        msg: {
          type: "send-message",
          content: initialMessage,
        },
      });
    }

    return thread;
  }

  async createNewThread() {
    const id = this.threadCounter.get() as ThreadId;

    await this.createThreadWithContext({
      threadId: id,
      profile: getActiveProfile(
        this.context.options.profiles,
        this.context.options.activeProfile,
      ),
      allowedTools: CHAT_TOOL_NAMES,
    });
  }

  renderThreadOverview() {
    const threadViews = Object.entries(this.threadWrappers).map(
      ([idStr, threadState]) => {
        const id = Number(idStr) as ThreadId;
        let status = "";
        const marker = id == this.state.activeThreadId ? "*" : "-";
        switch (threadState.state) {
          case "pending":
            status = `${marker} ${id} - loading...\n`;
            break;
          case "initialized": {
            status = `${marker} ${id} ${threadState.thread.state.title ?? "[Untitled]"}\n`;
            break;
          }
          case "error":
            status = `${marker} ${id} - error: ${threadState.error.message}\n`;
            break;
        }

        return withBindings(d`${status}`, {
          "<CR>": () =>
            this.context.dispatch({
              type: "chat-msg",
              msg: { type: "select-thread", id },
            }),
        });
      },
    );

    return d`\
# Threads

${threadViews.length ? threadViews : "No threads yet"}`;
  }

  getActiveThread(): Thread {
    if (!this.state.activeThreadId) {
      throw new Error(`Chat is not initialized yet... no active thread`);
    }
    const threadWrapper = this.threadWrappers[this.state.activeThreadId];
    if (!(threadWrapper && threadWrapper.state == "initialized")) {
      throw new Error(
        `Thread ${this.state.activeThreadId} not initialized yet...`,
      );
    }
    return threadWrapper.thread;
  }

  async handleCompactThread({
    threadId,
    contextFilePaths,
    initialMessage,
  }: {
    threadId: ThreadId;
    contextFilePaths: UnresolvedFilePath[];
    initialMessage: string;
  }) {
    const sourceThreadWrapper = this.threadWrappers[threadId];
    if (!sourceThreadWrapper || sourceThreadWrapper.state !== "initialized") {
      throw new Error(`Thread ${threadId} not available for compaction`);
    }

    const sourceThread = sourceThreadWrapper.thread;
    const newThreadId = this.threadCounter.get() as ThreadId;

    await this.createThreadWithContext({
      threadId: newThreadId,
      profile: sourceThread.state.profile,
      allowedTools: CHAT_TOOL_NAMES,
      contextFiles: contextFilePaths,
      initialMessage: initialMessage,
    });
  }

  async handleSpawnSubagentThread({
    parentThreadId,
    parentToolRequestId,
    allowedTools,
    initialPrompt,
    contextFiles,
  }: {
    parentThreadId: ThreadId;
    parentToolRequestId: ToolRequestId;
    allowedTools: ToolName[];
    initialPrompt: string;
    contextFiles?: UnresolvedFilePath[];
  }) {
    const parentThreadWrapper = this.threadWrappers[parentThreadId];
    if (!parentThreadWrapper || parentThreadWrapper.state !== "initialized") {
      throw new Error(`Parent thread ${parentThreadId} not available`);
    }

    const parentThread = parentThreadWrapper.thread;
    const subagentThreadId = this.threadCounter.get() as ThreadId;

    const subagentAllowedTools: ToolName[] = allowedTools.includes(
      "yield_to_parent",
    )
      ? allowedTools
      : [...allowedTools, "yield_to_parent"];

    try {
      const thread = await this.createThreadWithContext({
        threadId: subagentThreadId,
        profile: parentThread.state.profile,
        allowedTools: subagentAllowedTools,
        contextFiles: contextFiles || [],
        parent: {
          threadId: parentThreadId,
          toolRequestId: parentToolRequestId,
        },
        switchToThread: true,
        initialMessage: initialPrompt,
      });

      this.context.dispatch({
        type: "thread-msg",
        id: parentThreadId,
        msg: {
          type: "tool-manager-msg",
          msg: {
            type: "tool-msg",
            msg: {
              id: parentToolRequestId,
              toolName: "spawn_subagent",
              msg: {
                type: "subagent-created",
                threadId: thread.id,
              },
            },
          },
        },
      });
    } catch (e) {
      const error = e as Error;
      this.context.dispatch({
        type: "thread-msg",
        id: parentThreadId,
        msg: {
          type: "tool-manager-msg",
          msg: {
            type: "tool-msg",
            msg: {
              id: parentToolRequestId,
              toolName: "spawn_subagent",
              msg: {
                type: "finish",
                result: {
                  status: "error",
                  error: error.message + "\n" + error.stack,
                },
              },
            },
          },
        },
      });
    }
  }

  handleYieldToParent({
    childThreadId,
    parentThreadId,
    parentToolRequestId,
    result,
  }: {
    childThreadId: ThreadId;
    parentThreadId: ThreadId;
    parentToolRequestId: ToolRequestId;
    result: Result<string>;
  }) {
    const parentThreadWrapper = this.threadWrappers[parentThreadId];
    if (parentThreadWrapper && parentThreadWrapper.state === "initialized") {
      const parentThread = parentThreadWrapper.thread;

      setTimeout(() =>
        this.context.dispatch({
          type: "thread-msg",
          id: parentThread.id,
          msg: {
            type: "tool-manager-msg",
            msg: {
              type: "tool-msg",
              msg: {
                id: parentToolRequestId,
                toolName: "spawn_subagent",
                msg: {
                  type: "finish",
                  result,
                },
              },
            },
          },
        }),
      );
    }

    if (
      this.state.state === "thread-selected" &&
      this.state.activeThreadId === childThreadId
    ) {
      this.state = {
        state: "thread-selected",
        activeThreadId: parentThreadId,
      };
    }
  }

  renderActiveThread() {
    const threadWrapper =
      this.state.activeThreadId &&
      this.threadWrappers[this.state.activeThreadId];

    if (!threadWrapper) {
      throw new Error(`no active thread`);
    }

    switch (threadWrapper.state) {
      case "pending":
        return d`Initializing thread...`;
      case "initialized": {
        const thread = threadWrapper.thread;
        let parentView: string | VDOMNode;

        if (threadWrapper.parent) {
          const parent = threadWrapper.parent;
          parentView = withBindings(
            d`Parent thread: ${parent.threadId.toString()}\n`,
            {
              "<CR>": () =>
                this.context.dispatch({
                  type: "chat-msg",
                  msg: {
                    type: "select-thread",
                    id: parent.threadId,
                  },
                }),
            },
          );
        } else {
          parentView = "";
        }

        return d`${parentView}${threadView({
          thread,
          dispatch: (msg) =>
            this.context.dispatch({
              type: "thread-msg",
              id: thread.id,
              msg,
            }),
        })}`;
      }
      case "error":
        return d`Error: ${threadWrapper.error.message}`;
      default:
        assertUnreachable(threadWrapper);
    }
  }

  view() {
    if (this.state.state === "thread-overview") {
      return this.renderThreadOverview();
    } else {
      return this.renderActiveThread();
    }
  }
}

function getActiveProfile(profiles: Profile[], activeProfile: string) {
  const profile = profiles.find((p) => p.name == activeProfile);
  if (!profile) {
    throw new Error(`Profile ${activeProfile} not found.`);
  }
  return profile;
}
