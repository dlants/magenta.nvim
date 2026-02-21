import type { Nvim } from "../nvim/nvim-node";
import type { MagentaOptions, Profile } from "../options";
import type { RootMsg } from "../root-msg";
import type { Dispatch } from "../tea/tea";
import { Thread, view as threadView, type InputMessage } from "./thread";
import type { Lsp } from "../lsp";
import { assertUnreachable } from "../utils/assertUnreachable";
import type { FileIO } from "../edl/file-io.ts";
import { InMemoryFileIO } from "../edl/in-memory-file-io.ts";
import { d, withBindings, type VDOMNode } from "../tea/view";
import { v7 as uuidv7 } from "uuid";
import { ContextManager } from "../context/context-manager.ts";
import type { BufferTracker } from "../buffer-tracker.ts";
import {
  type AbsFilePath,
  type HomeDir,
  type NvimCwd,
  type UnresolvedFilePath,
} from "../utils/files.ts";
import type { Result } from "../utils/result.ts";
import { wrapStaticToolMsg, type ToolRequestId } from "../tools/toolManager.ts";
import type { Tool, StaticTool, ToolName } from "../tools/types.ts";
import { MCPToolManager } from "../tools/mcp/manager.ts";
import type { WaitForSubagentsTool } from "../tools/wait-for-subagents.ts";
import type { SpawnSubagentTool } from "../tools/spawn-subagent.ts";
import type { ThreadId, ThreadType } from "./types.ts";
import { createSystemPrompt } from "../providers/system-prompt.ts";
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
  compactFileIO?: InMemoryFileIO;
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
      type: "fork-thread";
      sourceThreadId: ThreadId;
      strippedMessages: InputMessage[];
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
      type: "threads-navigate-up";
    }
  | {
      type: "threads-overview";
    }
  | {
      type: "spawn-compact-thread";
      parentThreadId: ThreadId;
      fileContents: string;
      nextPrompt?: string;
    };

export type ChatMsg = {
  type: "chat-msg";
  msg: Msg;
};

export class Chat {
  state: ChatState;
  public threadWrappers: { [id: ThreadId]: ThreadWrapper };
  public rememberedCommands: Set<string>;
  private mcpToolManager: MCPToolManager;

  constructor(
    private context: {
      dispatch: Dispatch<RootMsg>;
      getDisplayWidth: () => number;
      bufferTracker: BufferTracker;
      options: MagentaOptions;
      cwd: NvimCwd;
      homeDir: HomeDir;
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
                id: threadId as ThreadId,
                msg: {
                  type: "abort",
                },
              });
            }
          }
        }

        // it's ok to do this on every dispatch. After the initial yielded/error message, the thread should be dormant
        // and should not generate any more thread messages. As such, this won't be terribly inefficient.
        const mode = thread.state.mode;
        const agentStatus = thread.agent.getState().status;

        if (threadState.parentThreadId) {
          if (mode.type === "control_flow" && mode.operation.type === "yield") {
            this.notifyParent({
              threadId: thread.id,
              parentThreadId: threadState.parentThreadId,
              result: { status: "ok", value: mode.operation.response },
            });
          } else if (agentStatus.type === "error") {
            this.notifyParent({
              threadId: thread.id,
              parentThreadId: threadState.parentThreadId,
              result: { status: "error", error: agentStatus.error.message },
            });
          }
        }
        // Detect compact thread completion
        if (
          threadState.compactFileIO &&
          threadState.parentThreadId &&
          agentStatus.type === "stopped" &&
          agentStatus.stopReason === "end_turn"
        ) {
          this.handleCompactThreadComplete(
            threadState.parentThreadId,
            threadState.compactFileIO,
          );
          delete threadState.compactFileIO;
        }
      }
    }
  }

  private myUpdate(msg: Msg) {
    switch (msg.type) {
      case "thread-initialized": {
        const prev = this.threadWrappers[msg.thread.id];
        const wrapper: ThreadWrapper = {
          state: "initialized",
          thread: msg.thread,
          parentThreadId: prev.parentThreadId,
        };
        if (prev.compactFileIO) {
          wrapper.compactFileIO = prev.compactFileIO;
        }
        this.threadWrappers[msg.thread.id] = wrapper;

        if (!this.state.activeThreadId) {
          this.state = {
            state: "thread-selected",
            activeThreadId: msg.thread.id,
          };
        }

        // Scroll to bottom when a new thread is created
        setTimeout(() => {
          this.context.dispatch({
            type: "sidebar-msg",
            msg: {
              type: "scroll-to-bottom",
            },
          });
        }, 100);

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

      case "threads-navigate-up":
        // If we're viewing a thread and it has a parent, navigate to parent
        if (
          this.state.state === "thread-selected" &&
          this.state.activeThreadId
        ) {
          const threadWrapper = this.threadWrappers[this.state.activeThreadId];
          if (threadWrapper && threadWrapper.parentThreadId) {
            // Navigate to parent thread
            this.state = {
              state: "thread-selected",
              activeThreadId: threadWrapper.parentThreadId,
            };

            // Scroll to bottom when navigating to parent
            setTimeout(() => {
              this.context.dispatch({
                type: "sidebar-msg",
                msg: {
                  type: "scroll-to-last-user-message",
                },
              });
            }, 100);

            return;
          }
        }

        // Otherwise, navigate to thread overview
        this.state = {
          state: "thread-overview",
          activeThreadId: this.state.activeThreadId,
        };
        return;

      case "threads-overview":
        // Force navigation to thread overview regardless of current state
        this.state = {
          state: "thread-overview",
          activeThreadId: this.state.activeThreadId,
        };
        return;

      case "fork-thread": {
        this.handleForkThread(msg).catch((e: Error) => {
          this.context.nvim.logger.error(
            "Failed to handle thread fork: " + e.message + "\n" + e.stack,
          );
        });
        return;
      }

      case "spawn-compact-thread": {
        this.handleSpawnCompactThread(msg).catch((e: Error) => {
          this.context.nvim.logger.error(
            `Failed to spawn compact thread: ${e.message} ${e.stack}`,
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

  /** Get the active agent for use as context in forceToolUse calls */
  getContextAgent() {
    if (
      this.state.state === "thread-selected" &&
      this.state.activeThreadId in this.threadWrappers
    ) {
      const threadState = this.threadWrappers[this.state.activeThreadId];
      if (threadState.state === "initialized") {
        return threadState.thread.agent;
      }
    }
    return undefined;
  }

  private async createThreadWithContext({
    threadId,
    profile,
    contextFiles = [],
    parent,
    switchToThread,
    inputMessages,
    threadType,
    fileIO,
  }: {
    threadId: ThreadId;
    profile: Profile;
    contextFiles?: UnresolvedFilePath[];
    parent?: ThreadId;
    switchToThread: boolean;
    inputMessages?: InputMessage[];
    threadType: ThreadType;
    fileIO?: FileIO;
  }) {
    this.threadWrappers[threadId] = {
      state: "pending",
      parentThreadId: parent,
    };

    const [contextManager, systemPrompt] = await Promise.all([
      ContextManager.create(
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
          homeDir: this.context.homeDir,
          nvim: this.context.nvim,
          options: this.context.options,
        },
      ),
      createSystemPrompt(threadType, {
        nvim: this.context.nvim,
        cwd: this.context.cwd,
        options: this.context.options,
      }),
    ]);

    if (contextFiles.length > 0) {
      await contextManager.addFiles(contextFiles);
    }

    const thread = new Thread(
      threadId,
      threadType,
      systemPrompt,
      {
        ...this.context,
        contextManager,
        mcpToolManager: this.mcpToolManager,
        profile,
        chat: this,
      },
      undefined,
      fileIO,
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
    const id = uuidv7() as ThreadId;

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
      const threadId = idStr as ThreadId;
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

      case "yielded":
        return "✅ yielded";

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

  getThreadDisplayName(threadId: ThreadId): string {
    const threadWrapper = this.threadWrappers[threadId];
    if (!threadWrapper || threadWrapper.state !== "initialized") {
      return "[Untitled]";
    }

    const thread = threadWrapper.thread;
    if (thread.state.title) {
      return thread.state.title;
    }

    // Find the first user message text
    const messages = thread.getProviderMessages();
    for (const message of messages) {
      if (message.role === "user") {
        for (const content of message.content) {
          if (content.type === "text" && content.text.trim()) {
            const text = content.text.trim();
            return text.length > 50 ? text.substring(0, 50) + "..." : text;
          }
        }
      }
    }

    return "[Untitled]";
  }

  private renderThread(
    threadId: ThreadId,
    isChild: boolean,
    activeThreadId: ThreadId | undefined,
  ): VDOMNode {
    const displayName = this.getThreadDisplayName(threadId);
    const status = this.formatThreadStatus(threadId);
    const marker = threadId === activeThreadId ? "*" : "-";
    const indent = isChild ? "  " : "";

    const displayLine = `${indent}${marker} ${displayName}: ${status}`;

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

  async handleForkThread({
    sourceThreadId,
    strippedMessages,
  }: {
    sourceThreadId: ThreadId;
    strippedMessages: InputMessage[];
  }) {
    const sourceThreadWrapper = this.threadWrappers[sourceThreadId];
    if (!sourceThreadWrapper || sourceThreadWrapper.state !== "initialized") {
      throw new Error(`Thread ${sourceThreadId} not available for forking`);
    }

    const sourceThread = sourceThreadWrapper.thread;
    const sourceAgent = sourceThread.agent;

    // Abort any in-progress operations and wait for completion
    // This handles both streaming and tool_use states
    const agentStatus = sourceAgent.getState().status;
    if (
      agentStatus.type === "streaming" ||
      (agentStatus.type === "stopped" && agentStatus.stopReason === "tool_use")
    ) {
      await sourceThread.abortAndWait();
    }

    const newThreadId = uuidv7() as ThreadId;

    // Clone the agent with dispatch pointing to the new thread
    const clonedAgent = sourceAgent.clone((msg) =>
      this.context.dispatch({
        type: "thread-msg",
        id: newThreadId,
        msg: { type: "agent-msg", msg },
      }),
    );

    // Create the new thread with the cloned agent
    this.threadWrappers[newThreadId] = {
      state: "pending",
      parentThreadId: undefined,
    };

    const [contextManager, systemPrompt] = await Promise.all([
      ContextManager.create(
        (msg) =>
          this.context.dispatch({
            type: "thread-msg",
            id: newThreadId,
            msg: {
              type: "context-manager-msg",
              msg,
            },
          }),
        {
          dispatch: this.context.dispatch,
          bufferTracker: this.context.bufferTracker,
          cwd: this.context.cwd,
          homeDir: this.context.homeDir,
          nvim: this.context.nvim,
          options: this.context.options,
        },
      ),
      createSystemPrompt("root", {
        nvim: this.context.nvim,
        cwd: this.context.cwd,
        options: this.context.options,
      }),
    ]);

    // Copy context files from source thread
    for (const [absFilePath, fileContext] of Object.entries(
      sourceThread.contextManager.files,
    )) {
      contextManager.update({
        type: "add-file-context",
        absFilePath: absFilePath as AbsFilePath,
        relFilePath: fileContext.relFilePath,
        fileTypeInfo: fileContext.fileTypeInfo,
      });
    }

    const thread = new Thread(
      newThreadId,
      "root",
      systemPrompt,
      {
        ...this.context,
        contextManager,
        mcpToolManager: this.mcpToolManager,
        profile: sourceThread.state.profile,
        chat: this,
      },
      clonedAgent,
    );

    this.context.dispatch({
      type: "chat-msg",
      msg: {
        type: "thread-initialized",
        thread,
      },
    });

    this.context.dispatch({
      type: "chat-msg",
      msg: {
        type: "select-thread",
        id: newThreadId,
      },
    });

    // Send the stripped messages to the new thread
    if (strippedMessages.length > 0) {
      this.context.dispatch({
        type: "thread-msg",
        id: newThreadId,
        msg: {
          type: "send-message",
          messages: strippedMessages,
        },
      });
    }
  }

  private handleCompactThreadComplete(
    parentThreadId: ThreadId,
    compactFileIO: InMemoryFileIO,
  ) {
    const summary = compactFileIO.getFileContents("/thread.md");
    if (summary === undefined) {
      this.context.nvim.logger.error(
        "Failed to read compact result from in-memory file /thread.md",
      );
      return;
    }

    setTimeout(() => {
      this.context.dispatch({
        type: "thread-msg",
        id: parentThreadId,
        msg: {
          type: "compact-complete",
          summary,
        },
      });
    });
  }
  async handleSpawnCompactThread({
    parentThreadId,
    fileContents,
    nextPrompt,
  }: Extract<Msg, { type: "spawn-compact-thread" }>) {
    const parentThreadWrapper = this.threadWrappers[parentThreadId];
    if (!parentThreadWrapper || parentThreadWrapper.state !== "initialized") {
      throw new Error(`Parent thread ${parentThreadId} not available`);
    }

    const parentThread = parentThreadWrapper.thread;
    const compactThreadId = uuidv7() as ThreadId;

    const compactProfile: Profile = {
      ...parentThread.state.profile,
      model: parentThread.state.profile.fastModel,
      thinking: undefined,
      reasoning: undefined,
    };

    const compactFileIO = new InMemoryFileIO({ "/thread.md": fileContents });

    const inputMessages: InputMessage[] = [
      {
        type: "user",
        text: `Here is a conversation transcript that needs to be compacted. The file is at: /thread.md

<file_contents>
${fileContents}
</file_contents>

Your job is to reduce the size of this transcript using the edl tool. The goal is to make it significantly shorter while preserving the essential information needed for the conversation to continue.

Guidelines:
- Remove iterations where multiple attempts were made before arriving at a result — just keep the final result
- Remove verbose tool outputs, error messages, and stack traces that are no longer relevant
- Remove sections that discuss completed tasks that don't affect future work
- Preserve: the current state of what's being worked on, any pending tasks, key decisions made, and important context
- Use the edl tool to edit the file at /thread.md
- You can use get_file to re-read /thread.md if needed
- You may need to make multiple edl calls to reduce different sections${nextPrompt ? `\n\nThe user's next prompt after compaction will be:\n"${nextPrompt}"\n\nPrioritize retaining information relevant to this next prompt.` : ""}`,
      },
    ];

    const thread = await this.createThreadWithContext({
      threadId: compactThreadId,
      profile: compactProfile,
      parent: parentThreadId,
      switchToThread: false,
      inputMessages,
      threadType: "compact",
      fileIO: compactFileIO,
    });

    this.threadWrappers[thread.id].compactFileIO = compactFileIO;
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
    const subagentThreadId = uuidv7() as ThreadId;

    // Create profile for subagent - use fast model if threadType is "subagent_fast"
    const subagentProfile: Profile =
      threadType === "subagent_fast"
        ? {
            ...parentThread.state.profile,
            model: parentThread.state.profile.fastModel,
            // Disable reasoning/thinking for fast model since it often doesn't support it
            thinking: undefined,
            reasoning: undefined,
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
            type: "tool-msg",
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
        });
      } catch (e) {
        this.context.dispatch({
          type: "thread-msg",
          id: parentThreadId,
          msg: {
            type: "tool-msg",
            id: spawnToolRequestId,
            toolName: "spawn_foreach" as ToolName,
            msg: wrapStaticToolMsg({
              type: "foreach-subagent-created",
              result: {
                status: "error" as const,
                error:
                  e instanceof Error ? e.message + "\n" + e.stack : String(e),
              },
              element: foreachElement,
            }),
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
            type: "tool-msg",
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
        });
      } catch (e) {
        this.context.dispatch({
          type: "thread-msg",
          id: parentThreadId,
          msg: {
            type: "tool-msg",
            id: spawnToolRequestId,
            toolName: "spawn_subagent" as ToolName,
            msg: wrapStaticToolMsg({
              type: "subagent-created",
              result: {
                status: "error" as const,
                error:
                  e instanceof Error ? e.message + "\n" + e.stack : String(e),
              },
            }),
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
        const mode = thread.state.mode;
        const agentStatus = thread.agent.getState().status;

        // Check for yielded state first
        if (mode.type === "control_flow" && mode.operation.type === "yield") {
          return {
            status: "done",
            result: {
              status: "ok",
              value: mode.operation.response,
            },
          };
        }

        // Check for error state
        if (agentStatus.type === "error") {
          return {
            status: "done",
            result: {
              status: "error",
              error: agentStatus.error.message,
            },
          };
        }

        // Check for aborted state
        if (
          agentStatus.type === "stopped" &&
          agentStatus.stopReason === "aborted"
        ) {
          return {
            status: "done",
            result: {
              status: "error",
              error: "Thread was aborted",
            },
          };
        }

        // All other states are considered pending
        return { status: "pending" };
      }

      default:
        return assertUnreachable(threadWrapper);
    }
  }

  getThreadPendingApprovalTools(threadId: ThreadId): (Tool | StaticTool)[] {
    const wrapper = this.threadWrappers[threadId];
    if (!wrapper || wrapper.state !== "initialized") return [];
    const mode = wrapper.thread.state.mode;
    if (mode.type !== "tool_use") return [];
    const result: (Tool | StaticTool)[] = [];
    for (const [, tool] of mode.activeTools) {
      if (tool.isPendingUserAction()) {
        result.push(tool);
      }
    }
    return result;
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
        const mode = thread.state.mode;
        const agentStatus = thread.agent.getState().status;

        const summary = {
          title: thread.state.title,
          status: (() => {
            // Check mode for thread-specific states first
            if (
              mode.type === "control_flow" &&
              mode.operation.type === "yield"
            ) {
              return {
                type: "yielded" as const,
                response: mode.operation.response,
              };
            }

            if (mode.type === "tool_use") {
              let hasPendingApproval = false;
              for (const [, tool] of mode.activeTools) {
                if (tool.isPendingUserAction()) {
                  hasPendingApproval = true;
                  break;
                }
              }
              return {
                type: "running" as const,
                activity: hasPendingApproval
                  ? "waiting for approval"
                  : "executing tools",
              };
            }

            // Then check agent status
            switch (agentStatus.type) {
              case "error":
                return {
                  type: "error" as const,
                  message: agentStatus.error.message,
                };

              case "stopped":
                return {
                  type: "stopped" as const,
                  reason: agentStatus.stopReason,
                };

              case "streaming":
                return {
                  type: "running" as const,
                  activity: "streaming response",
                };

              default:
                return assertUnreachable(agentStatus);
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
      const mode = parentThread.state.mode;

      if (mode.type !== "tool_use") {
        return;
      }

      for (const [, tool] of mode.activeTools) {
        if (
          tool.toolName === "wait_for_subagents" &&
          (tool as WaitForSubagentsTool).state.state === "waiting"
        ) {
          setTimeout(() => {
            this.context.dispatch({
              type: "thread-msg",
              id: parentThread.id,
              msg: {
                type: "tool-msg",
                id: tool.request.id,
                toolName: "wait_for_subagents" as ToolName,
                msg: wrapStaticToolMsg({
                  type: "check-threads",
                }),
              },
            });
          });
        } else if (
          tool.toolName === "spawn_foreach" &&
          (tool as SpawnForeachTool).state.state === "running"
        ) {
          setTimeout(() => {
            this.context.dispatch({
              type: "thread-msg",
              id: parentThread.id,
              msg: {
                type: "tool-msg",
                id: tool.request.id,
                toolName: "spawn_foreach" as ToolName,
                msg: wrapStaticToolMsg({
                  type: "subagent-completed",
                  threadId,
                  result,
                }),
              },
            });
          });
        } else if (
          tool.toolName === "spawn_subagent" &&
          (tool as SpawnSubagentTool).state.state === "waiting-for-subagent"
        ) {
          setTimeout(() => {
            this.context.dispatch({
              type: "thread-msg",
              id: parentThread.id,
              msg: {
                type: "tool-msg",
                id: tool.request.id,
                toolName: "spawn_subagent" as ToolName,
                msg: wrapStaticToolMsg({
                  type: "check-thread",
                }),
              },
            });
          });
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
          const parentDisplayName = this.getThreadDisplayName(parent);
          parentView = withBindings(d`Parent thread: ${parentDisplayName}\n`, {
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
