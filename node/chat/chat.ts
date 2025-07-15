import type { Nvim } from "../nvim/nvim-node";
import type { MagentaOptions, Profile } from "../options";
import type { RootMsg } from "../root-msg";
import type { Dispatch } from "../tea/tea";
import { Thread, view as threadView, type InputMessage } from "./thread";
import type { Lsp } from "../lsp";
import { assertUnreachable } from "../utils/assertUnreachable";
import { d, withBindings, type VDOMNode } from "../tea/view";
import { Counter } from "../utils/uniqueId.ts";
import { ContextManager } from "../context/context-manager.ts";
import type { BufferTracker } from "../buffer-tracker.ts";
import {
  detectFileType,
  relativePath,
  resolveFilePath,
  type NvimCwd,
  type UnresolvedFilePath,
} from "../utils/files.ts";
import type { Result } from "../utils/result.ts";
import { wrapStaticToolMsg, type ToolRequestId } from "../tools/toolManager.ts";
import type { ToolName } from "../tools/types.ts";
import { MCPToolManager } from "../tools/mcp/manager.ts";
import type { WaitForSubagentsTool } from "../tools/wait-for-subagents.ts";
import type { ThreadId, ThreadType } from "./types.ts";
import type {
  ForEachElement,
  SpawnForeachTool,
} from "../tools/spawn-foreach.ts";

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
  parentThreadId: ThreadId | undefined;
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
      inputMessages: InputMessage[];
    }
  | {
      type: "spawn-subagent-thread";
      parentThreadId: ThreadId;
      spawnToolRequestId: ToolRequestId;
      inputMessages: InputMessage[];
      threadType: ThreadType;
      contextFiles?: UnresolvedFilePath[];
      foreachElement?: ForEachElement;
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
  public threadWrappers: { [id: ThreadId]: ThreadWrapper };
  public rememberedCommands: Set<string>;
  private mcpToolManager: MCPToolManager;

  constructor(
    private context: {
      dispatch: Dispatch<RootMsg>;
      bufferTracker: BufferTracker;
      options: MagentaOptions;
      cwd: NvimCwd;
      nvim: Nvim;
      lsp: Lsp;
    },
  ) {
    this.threadWrappers = {};
    this.rememberedCommands = new Set();
    this.state = {
      state: "thread-overview",
      activeThreadId: undefined,
    };

    this.mcpToolManager = new MCPToolManager(
      this.context.options.mcpServers,
      this.context,
    );

    setTimeout(() => {
      this.createNewThread().catch((e: Error) => {
        this.context.nvim.logger.error(
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

        if (msg.msg.type == "abort") {
          // Find all child threads of the parent thread and abort them directly
          for (const [threadId, threadWrapper] of Object.entries(
            this.threadWrappers,
          )) {
            if (
              threadWrapper.parentThreadId === thread.id &&
              threadWrapper.state === "initialized"
            ) {
              threadWrapper.thread.update({
                type: "thread-msg",
                id: Number(threadId) as ThreadId,
                msg: {
                  type: "abort",
                },
              });
            }
          }
        }

        // it's ok to do this on every dispatch. After the initial yielded/error message, the thread should be dormant
        // and should not generate any more thread messages. As such, this won't be terribly inefficient.
        if (
          threadState.parentThreadId &&
          (thread.state.conversation.state == "yielded" ||
            thread.state.conversation.state == "error")
        ) {
          this.notifyParent({
            threadId: thread.id,
            parentThreadId: threadState.parentThreadId,
            result:
              thread.state.conversation.state == "yielded"
                ? { status: "ok", value: thread.state.conversation.response }
                : {
                    status: "error",
                    error: thread.state.conversation.error.message,
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
          parentThreadId: this.threadWrappers[msg.thread.id].parentThreadId,
        };

        if (!this.state.activeThreadId) {
          this.state = {
            state: "thread-selected",
            activeThreadId: msg.thread.id,
          };
        }

        return;
      }

      case "thread-error": {
        const thread = this.threadWrappers[msg.id];
        this.threadWrappers[msg.id] = {
          state: "error",
          error: msg.error,
          parentThreadId: thread.parentThreadId,
        };

        if (this.state.state === "thread-selected") {
          this.state = {
            state: "thread-overview",
            activeThreadId: msg.id,
          };
        }

        if (thread) {
          if (thread.parentThreadId) {
            this.notifyParent({
              threadId: msg.id,
              parentThreadId: thread.parentThreadId,
              result: {
                status: "error",
                error: msg.error.message,
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
            this.context.nvim.logger.error(
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
          this.context.nvim.logger.error(
            "Failed to handle thread compaction: " + e.message + "\n" + e.stack,
          );
        });
        return;
      }

      case "spawn-subagent-thread": {
        this.handleSpawnSubagentThread(msg).catch((e: Error) => {
          this.context.nvim.logger.error(
            `Failed to spawn sub-agent thread: ${e.message} ${e.stack}`,
          );
        });
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
    contextFiles = [],
    parent,
    switchToThread,
    inputMessages,
    threadType,
  }: {
    threadId: ThreadId;
    profile: Profile;
    contextFiles?: UnresolvedFilePath[];
    parent?: ThreadId;
    switchToThread: boolean;
    inputMessages?: InputMessage[];
    threadType: ThreadType;
  }) {
    this.threadWrappers[threadId] = {
      state: "pending",
      parentThreadId: parent,
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
        cwd: this.context.cwd,
        nvim: this.context.nvim,
        options: this.context.options,
      },
    );

    if (contextFiles.length > 0) {
      await Promise.all(
        contextFiles.map(async (filePath) => {
          const absFilePath = resolveFilePath(this.context.cwd, filePath);
          const relFilePath = relativePath(this.context.cwd, absFilePath);
          const fileTypeInfo = await detectFileType(absFilePath);
          if (!fileTypeInfo) {
            this.context.nvim.logger.error(`File ${filePath} does not exist.`);
            return;
          }
          contextManager.update({
            type: "add-file-context",
            absFilePath,
            relFilePath,
            fileTypeInfo,
          });
        }),
      );
    }

    const thread = new Thread(threadId, threadType, {
      ...this.context,
      contextManager,
      mcpToolManager: this.mcpToolManager,
      profile,
      chat: this,
    });

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

    if (inputMessages) {
      this.context.dispatch({
        type: "thread-msg",
        id: threadId,
        msg: {
          type: "send-message",
          messages: inputMessages,
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
      switchToThread: true,
      threadType: "root",
    });
  }

  private buildThreadHierarchy(): {
    rootThreads: ThreadId[];
    childrenMap: Map<ThreadId, ThreadId[]>;
  } {
    const childrenMap = new Map<ThreadId, ThreadId[]>();
    const rootThreads: ThreadId[] = [];

    // Iterate through all threads to build hierarchy
    for (const [idStr, threadWrapper] of Object.entries(this.threadWrappers)) {
      const threadId = Number(idStr) as ThreadId;
      const parentId = threadWrapper.parentThreadId;

      if (parentId === undefined) {
        // This is a root thread
        rootThreads.push(threadId);
      } else {
        // This is a child thread, add to parent's children
        if (!childrenMap.has(parentId)) {
          childrenMap.set(parentId, []);
        }
        childrenMap.get(parentId)!.push(threadId);
      }
    }

    return { rootThreads, childrenMap };
  }

  private formatThreadStatus(threadId: ThreadId): string {
    const summary = this.getThreadSummary(threadId);

    switch (summary.status.type) {
      case "missing":
        return "❓ not found";

      case "pending":
        return "⏳ initializing";

      case "running":
        return `⏳ ${summary.status.activity}`;

      case "stopped":
        return `⏹️ stopped (${summary.status.reason})`;

      case "yielded": {
        const truncatedResponse =
          summary.status.response.length > 50
            ? summary.status.response.substring(0, 47) + "..."
            : summary.status.response;
        return `✅ yielded: ${truncatedResponse}`;
      }

      case "error": {
        const truncatedError =
          summary.status.message.length > 50
            ? summary.status.message.substring(0, 47) + "..."
            : summary.status.message;
        return `❌ error: ${truncatedError}`;
      }

      default:
        return assertUnreachable(summary.status);
    }
  }

  private renderThread(
    threadId: ThreadId,
    isChild: boolean,
    activeThreadId: ThreadId | undefined,
  ): VDOMNode {
    const summary = this.getThreadSummary(threadId);
    const title = summary.title || "[Untitled]";
    const status = this.formatThreadStatus(threadId);
    const marker = threadId === activeThreadId ? "*" : "-";
    const indent = isChild ? "  " : "";

    const displayLine = `${indent}${marker} ${threadId} ${title}: ${status}`;

    return withBindings(d`${displayLine}`, {
      "<CR>": () =>
        this.context.dispatch({
          type: "chat-msg",
          msg: {
            type: "select-thread",
            id: threadId,
          },
        }),
    });
  }

  renderThreadOverview() {
    if (Object.keys(this.threadWrappers).length === 0) {
      return d`# Threads

No threads yet`;
    }

    const { rootThreads, childrenMap } = this.buildThreadHierarchy();
    const threadViews: VDOMNode[] = [];

    // Render all root threads and their children
    for (const rootThreadId of rootThreads) {
      // Render the root thread
      threadViews.push(
        this.renderThread(rootThreadId, false, this.state.activeThreadId),
      );

      // Render children of this root thread
      const children = childrenMap.get(rootThreadId) || [];
      for (const childThreadId of children) {
        threadViews.push(
          this.renderThread(childThreadId, true, this.state.activeThreadId),
        );
      }
    }

    return d`# Threads

${threadViews.map((view) => d`${view}\n`)}`;
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
    inputMessages,
  }: {
    threadId: ThreadId;
    contextFilePaths: UnresolvedFilePath[];
    inputMessages: InputMessage[];
  }) {
    const sourceThreadWrapper = this.threadWrappers[threadId];
    if (!sourceThreadWrapper || sourceThreadWrapper.state !== "initialized") {
      throw new Error(`Thread ${threadId} not available for compaction`);
    }

    const sourceThread = sourceThreadWrapper.thread;
    const newThreadId = this.threadCounter.get() as ThreadId;

    await this.createThreadWithContext({
      threadType: "root",
      threadId: newThreadId,
      profile: sourceThread.state.profile,
      contextFiles: contextFilePaths,
      switchToThread: true,
      inputMessages,
    });
  }

  async handleSpawnSubagentThread({
    parentThreadId,
    spawnToolRequestId,
    inputMessages,
    contextFiles,
    threadType,
    foreachElement,
  }: {
    parentThreadId: ThreadId;
    spawnToolRequestId: ToolRequestId;
    inputMessages: InputMessage[];
    contextFiles?: UnresolvedFilePath[];
    threadType: ThreadType;
    foreachElement?: ForEachElement;
  }) {
    const parentThreadWrapper = this.threadWrappers[parentThreadId];
    if (!parentThreadWrapper || parentThreadWrapper.state !== "initialized") {
      throw new Error(`Parent thread ${parentThreadId} not available`);
    }

    const parentThread = parentThreadWrapper.thread;
    const subagentThreadId = this.threadCounter.get() as ThreadId;

    // Create profile for subagent - use fast model if threadType is "subagent_fast"
    const subagentProfile =
      threadType === "subagent_fast"
        ? {
            ...parentThread.state.profile,
            model: parentThread.state.profile.fastModel,
          }
        : parentThread.state.profile;

    if (foreachElement) {
      try {
        const thread = await this.createThreadWithContext({
          threadId: subagentThreadId,
          profile: subagentProfile,
          contextFiles: contextFiles || [],
          parent: parentThreadId,
          switchToThread: false,
          inputMessages,
          threadType,
        });

        this.context.dispatch({
          type: "thread-msg",
          id: parentThreadId,
          msg: {
            type: "tool-manager-msg",
            msg: {
              type: "tool-msg",
              msg: {
                id: spawnToolRequestId,
                toolName: "spawn_foreach" as ToolName,
                msg: wrapStaticToolMsg({
                  type: "foreach-subagent-created",
                  result: {
                    status: "ok" as const,
                    value: thread.id,
                  },
                  element: foreachElement,
                }),
              },
            },
          },
        });
      } catch (e) {
        this.context.dispatch({
          type: "thread-msg",
          id: parentThreadId,
          msg: {
            type: "tool-manager-msg",
            msg: {
              type: "tool-msg",
              msg: {
                id: spawnToolRequestId,
                toolName: "spawn_foreach" as ToolName,
                msg: wrapStaticToolMsg({
                  type: "foreach-subagent-created",
                  result: {
                    status: "error" as const,
                    error:
                      e instanceof Error
                        ? e.message + "\n" + e.stack
                        : String(e),
                  },
                  element: foreachElement,
                }),
              },
            },
          },
        });
      }
    } else {
      try {
        const thread = await this.createThreadWithContext({
          threadId: subagentThreadId,
          profile: subagentProfile,
          contextFiles: contextFiles || [],
          parent: parentThreadId,
          switchToThread: false,
          inputMessages,
          threadType,
        });

        this.context.dispatch({
          type: "thread-msg",
          id: parentThreadId,
          msg: {
            type: "tool-manager-msg",
            msg: {
              type: "tool-msg",
              msg: {
                id: spawnToolRequestId,
                toolName: "spawn_subagent" as ToolName,
                msg: wrapStaticToolMsg({
                  type: "subagent-created",
                  result: {
                    status: "ok" as const,
                    value: thread.id,
                  },
                }),
              },
            },
          },
        });
      } catch (e) {
        this.context.dispatch({
          type: "thread-msg",
          id: parentThreadId,
          msg: {
            type: "tool-manager-msg",
            msg: {
              type: "tool-msg",
              msg: {
                id: spawnToolRequestId,
                toolName: "spawn_subagent" as ToolName,
                msg: wrapStaticToolMsg({
                  type: "subagent-created",
                  result: {
                    status: "error" as const,
                    error:
                      e instanceof Error
                        ? e.message + "\n" + e.stack
                        : String(e),
                  },
                }),
              },
            },
          },
        });
      }
    }
  }

  getThreadResult(
    threadId: ThreadId,
  ): { status: "done"; result: Result<string> } | { status: "pending" } {
    const threadWrapper = this.threadWrappers[threadId];
    if (!threadWrapper) {
      return {
        status: "pending",
      };
    }

    switch (threadWrapper.state) {
      case "pending":
        return { status: "pending" };

      case "error":
        return {
          status: "done",
          result: {
            status: "error",
            error: threadWrapper.error.message,
          },
        };

      case "initialized": {
        const thread = threadWrapper.thread;
        const conversation = thread.state.conversation;

        switch (conversation.state) {
          case "yielded":
            return {
              status: "done",
              result: {
                status: "ok",
                value: conversation.response,
              },
            };

          case "error":
            return {
              status: "done",
              result: {
                status: "error",
                error: conversation.error.message,
              },
            };

          case "stopped":
            if (conversation.stopReason === "aborted") {
              return {
                status: "done",
                result: {
                  status: "error",
                  error: "Thread was aborted",
                },
              };
            }

            // If stopped normally but not yielded, consider it pending
            return { status: "pending" };

          case "message-in-flight":
          case "compacting":
            return { status: "pending" };

          default:
            return assertUnreachable(conversation);
        }
      }

      default:
        return assertUnreachable(threadWrapper);
    }
  }

  getThreadSummary(threadId: ThreadId): {
    title?: string | undefined;
    status:
      | { type: "missing" }
      | { type: "pending" }
      | { type: "running"; activity: string }
      | { type: "stopped"; reason: string }
      | { type: "yielded"; response: string }
      | { type: "error"; message: string };
  } {
    const threadWrapper = this.threadWrappers[threadId];
    if (!threadWrapper) {
      return {
        status: { type: "missing" },
      };
    }

    switch (threadWrapper.state) {
      case "pending":
        return {
          status: { type: "pending" },
        };

      case "error":
        return {
          status: {
            type: "error",
            message: threadWrapper.error.message,
          },
        };

      case "initialized": {
        const thread = threadWrapper.thread;
        const conversation = thread.state.conversation;

        const summary = {
          title: thread.state.title,
          status: (() => {
            switch (conversation.state) {
              case "yielded":
                return {
                  type: "yielded" as const,
                  response: conversation.response,
                };

              case "error":
                return {
                  type: "error" as const,
                  message: conversation.error.message,
                };

              case "stopped":
                return {
                  type: "stopped" as const,
                  reason: conversation.stopReason,
                };

              case "message-in-flight":
                return {
                  type: "running" as const,
                  activity: "streaming response",
                };

              case "compacting":
                return {
                  type: "running" as const,
                  activity: "compacting thread",
                };

              default:
                return assertUnreachable(conversation);
            }
          })(),
        };

        return summary;
      }

      default:
        return assertUnreachable(threadWrapper);
    }
  }

  notifyParent({
    threadId,
    parentThreadId,
    result,
  }: {
    threadId: ThreadId;
    parentThreadId: ThreadId;
    result: Result<string>;
  }) {
    const parentThreadWrapper = this.threadWrappers[parentThreadId];
    if (parentThreadWrapper && parentThreadWrapper.state === "initialized") {
      const parentThread = parentThreadWrapper.thread;

      const lastMessage =
        parentThread.state.messages[parentThread.state.messages.length - 1];
      if (!lastMessage || lastMessage.state.role !== "assistant") {
        return;
      }

      for (const content of lastMessage.state.content) {
        if (content.type === "tool_use" && content.request.status === "ok") {
          const request = content.request.value;
          if (request.toolName === "wait_for_subagents") {
            const tool = parentThread.toolManager.getTool(
              request.id,
            ) as unknown as WaitForSubagentsTool;
            if (tool && tool.state.state === "waiting") {
              setTimeout(() => {
                this.context.dispatch({
                  type: "thread-msg",
                  id: parentThread.id,
                  msg: {
                    type: "tool-manager-msg",
                    msg: {
                      type: "tool-msg",
                      msg: {
                        id: tool.request.id,
                        toolName: "wait_for_subagents" as ToolName,
                        msg: wrapStaticToolMsg({
                          type: "check-threads",
                        }),
                      },
                    },
                  },
                });
              });
            }
          } else if (request.toolName === "spawn_foreach") {
            // Handle foreach completion - notify parent that this thread has completed
            const tool = parentThread.toolManager.getTool(
              request.id,
            ) as unknown as SpawnForeachTool;
            if (tool && tool.state.state == "running") {
              setTimeout(() => {
                this.context.dispatch({
                  type: "thread-msg",
                  id: parentThread.id,
                  msg: {
                    type: "tool-manager-msg",
                    msg: {
                      type: "tool-msg",
                      msg: {
                        id: tool.request.id,
                        toolName: "spawn_foreach" as ToolName,
                        msg: wrapStaticToolMsg({
                          type: "subagent-completed",
                          threadId,
                          result,
                        }),
                      },
                    },
                  },
                });
              });
            }
          }
        }
      }
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

        if (threadWrapper.parentThreadId) {
          const parent = threadWrapper.parentThreadId;
          parentView = withBindings(d`Parent thread: ${parent.toString()}\n`, {
            "<CR>": () =>
              this.context.dispatch({
                type: "chat-msg",
                msg: {
                  type: "select-thread",
                  id: parent,
                },
              }),
          });
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
