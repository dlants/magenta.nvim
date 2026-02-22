import type { Nvim } from "../nvim/nvim-node";
import type { MagentaOptions, Profile } from "../options";
import type { RootMsg } from "../root-msg";
import type { Dispatch } from "../tea/tea";
import { Thread, view as threadView, type InputMessage } from "./thread";
import type { Lsp } from "../lsp";
import { assertUnreachable } from "../utils/assertUnreachable";
import type { FileIO } from "../edl/file-io.ts";

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
import type { ThreadManager } from "../tools/thread-manager.ts";

import { MCPToolManager } from "../tools/mcp/manager.ts";
import type { ThreadId, ThreadType } from "./types.ts";
import { createSystemPrompt } from "../providers/system-prompt.ts";

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
      type: "fork-thread";
      sourceThreadId: ThreadId;
      strippedMessages: InputMessage[];
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
    };

export type ChatMsg = {
  type: "chat-msg";
  msg: Msg;
};

export class Chat implements ThreadManager {
  state: ChatState;
  public threadWrappers: { [id: ThreadId]: ThreadWrapper };
  public rememberedCommands: Set<string>;
  private mcpToolManager: MCPToolManager;
  private threadWaiters: Map<ThreadId, Array<(result: Result<string>) => void>>;

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
    this.threadWaiters = new Map();
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
        const agentStatus = thread.agent.getState().status;

        if (thread.state.yieldedResponse !== undefined) {
          this.resolveThreadWaiters(thread.id, {
            status: "ok",
            value: thread.state.yieldedResponse,
          });
        } else if (agentStatus.type === "error") {
          const result: Result<string> = {
            status: "error",
            error: agentStatus.error.message,
          };
          this.resolveThreadWaiters(thread.id, result);
        } else if (
          agentStatus.type === "stopped" &&
          agentStatus.stopReason === "aborted"
        ) {
          this.resolveThreadWaiters(thread.id, {
            status: "error",
            error: "Thread was aborted",
          });
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
          const errorResult: Result<string> = {
            status: "error",
            error: msg.error.message,
          };
          this.resolveThreadWaiters(msg.id, errorResult);
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

        const agentStatus = thread.agent.getState().status;

        // Check for yielded state first
        if (thread.state.yieldedResponse !== undefined) {
          return {
            status: "done",
            result: {
              status: "ok",
              value: thread.state.yieldedResponse,
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

  threadHasPendingApprovals(threadId: ThreadId): boolean {
    if (this.getThreadPendingApprovalTools(threadId).length > 0) return true;
    const wrapper = this.threadWrappers[threadId];
    if (!wrapper || wrapper.state !== "initialized") return false;
    return (
      (wrapper.thread.permissionShell?.getPendingPermissions().size ?? 0) > 0 ||
      (wrapper.thread.permissionFileIO?.getPendingPermissions().size ?? 0) > 0
    );
  }
  getThreadPendingApprovalTools(_threadId: ThreadId): never[] {
    return [];
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
            if (thread.state.yieldedResponse !== undefined) {
              return {
                type: "yielded" as const,
                response: thread.state.yieldedResponse,
              };
            }

            if (mode.type === "tool_use") {
              const hasPendingApproval =
                this.threadHasPendingApprovals(threadId);
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

  private resolveThreadWaiters(
    threadId: ThreadId,
    result: Result<string>,
  ): void {
    const waiters = this.threadWaiters.get(threadId);
    if (waiters && waiters.length > 0) {
      for (const resolve of waiters) {
        resolve(result);
      }
      this.threadWaiters.delete(threadId);
    }
  }

  async spawnThread(opts: {
    parentThreadId: ThreadId;
    prompt: string;
    threadType: ThreadType;
    contextFiles?: UnresolvedFilePath[];
  }): Promise<ThreadId> {
    const parentThreadId = opts.parentThreadId;
    const parentThreadWrapper = this.threadWrappers[parentThreadId];
    if (!parentThreadWrapper || parentThreadWrapper.state !== "initialized") {
      throw new Error(`Parent thread ${parentThreadId} not available`);
    }

    const parentThread = parentThreadWrapper.thread;
    const subagentThreadId = uuidv7() as ThreadId;

    const subagentProfile: Profile =
      opts.threadType === "subagent_fast"
        ? {
            ...parentThread.state.profile,
            model: parentThread.state.profile.fastModel,
            thinking: undefined,
            reasoning: undefined,
          }
        : parentThread.state.profile;

    const thread = await this.createThreadWithContext({
      threadId: subagentThreadId,
      profile: subagentProfile,
      contextFiles: opts.contextFiles || [],
      parent: parentThreadId,
      switchToThread: false,
      inputMessages: [{ type: "system", text: opts.prompt }],
      threadType: opts.threadType,
    });

    return thread.id;
  }

  waitForThread(threadId: ThreadId): Promise<Result<string>> {
    const threadResult = this.getThreadResult(threadId);
    if (threadResult.status === "done") {
      return Promise.resolve(threadResult.result);
    }

    return new Promise<Result<string>>((resolve) => {
      let waiters = this.threadWaiters.get(threadId);
      if (!waiters) {
        waiters = [];
        this.threadWaiters.set(threadId, waiters);
      }
      waiters.push(resolve);
    });
  }

  yieldResult(threadId: ThreadId, result: Result<string>): void {
    const threadWrapper = this.threadWrappers[threadId];
    if (threadWrapper && threadWrapper.state === "initialized") {
      if (result.status === "ok") {
        threadWrapper.thread.state.yieldedResponse = result.value;
      }
    }
    this.resolveThreadWaiters(threadId, result);
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
