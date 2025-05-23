import type { Nvim } from "../nvim/nvim-node";
import type { MagentaOptions, Profile } from "../options";
import type { RootMsg } from "../root-msg";
import type { Dispatch } from "../tea/tea";
import { Thread, view as threadView, type ThreadId } from "./thread";
import type { Lsp } from "../lsp";
import { assertUnreachable } from "../utils/assertUnreachable";
import { d, withBindings } from "../tea/view";
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

type ThreadWrapper =
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
  private threadWrappers: Map<ThreadId, ThreadWrapper>;

  constructor(
    private context: {
      dispatch: Dispatch<RootMsg>;
      bufferTracker: BufferTracker;
      options: MagentaOptions;
      nvim: Nvim;
      lsp: Lsp;
    },
  ) {
    this.threadWrappers = new Map();
    this.state = {
      state: "thread-overview",
      activeThreadId: undefined,
    };

    // wrap in setTimeout to force new eventloop frame, to avoid dispatch-in-dispatch
    setTimeout(() => {
      this.createNewThread().catch((e: Error) => {
        this.context.nvim.logger?.error(
          "Failed to create initial thread: " + e.message + "\n" + e.stack,
        );
      });
    });
  }

  update(msg: RootMsg) {
    if (msg.type == "chat-msg") {
      this.myUpdate(msg.msg);
      return;
    }

    if (msg.type == "thread-msg" && this.threadWrappers.has(msg.id)) {
      const threadState = this.threadWrappers.get(msg.id)!;
      if (threadState.state === "initialized") {
        threadState.thread.update(msg);
      }
    }
  }

  private myUpdate(msg: Msg) {
    switch (msg.type) {
      case "thread-initialized": {
        this.threadWrappers.set(msg.thread.id, {
          state: "initialized",
          thread: msg.thread,
        });

        this.state = {
          state: "thread-selected",
          activeThreadId: msg.thread.id,
        };
        return;
      }

      case "thread-error": {
        this.threadWrappers.set(msg.id, {
          state: "error",
          error: msg.error,
        });

        if (this.state.state === "thread-selected") {
          this.state = {
            state: "thread-overview",
            activeThreadId: msg.id,
          };
        }
        return;
      }

      case "new-thread":
        // wrap in setTimeout to force new eventloop frame, to avoid dispatch-in-dispatch
        setTimeout(() => {
          this.createNewThread().catch((e: Error) => {
            this.context.nvim.logger?.error("Failed to create new thread:", e);
          });
        });
        return;

      case "select-thread":
        if (this.threadWrappers.has(msg.id)) {
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
            "Failed to handle thread compaction:",
            e,
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
      this.threadWrappers.has(this.state.activeThreadId)
    ) {
      const threadState = this.threadWrappers.get(this.state.activeThreadId)!;
      if (threadState.state === "initialized") {
        return threadState.thread.getMessages();
      }
    }
    return [];
  }

  async createNewThread() {
    const id = this.threadCounter.get() as ThreadId;

    const threads = new Map(this.threadWrappers);
    threads.set(id, { state: "pending" });

    try {
      const contextManager = await ContextManager.create(
        (msg) =>
          this.context.dispatch({
            type: "thread-msg",
            id,
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

      const thread = new Thread(id, {
        ...this.context,
        contextManager,
        profile: getActiveProfile(
          this.context.options.profiles,
          this.context.options.activeProfile,
        ),
      });

      this.context.dispatch({
        type: "chat-msg",
        msg: {
          type: "thread-initialized",
          thread,
        },
      });
    } catch (e) {
      this.context.dispatch({
        type: "chat-msg",
        msg: {
          type: "thread-error",
          id,
          error: e as Error,
        },
      });
    }
  }

  renderThreadOverview() {
    const threadViews = Array.from(this.threadWrappers.entries()).map(
      ([id, threadState]) => {
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
    const threadWrapper = this.threadWrappers.get(this.state.activeThreadId);
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
    const sourceThreadWrapper = this.threadWrappers.get(threadId);
    if (!sourceThreadWrapper || sourceThreadWrapper.state !== "initialized") {
      throw new Error(`Thread ${threadId} not available for compaction`);
    }

    const sourceThread = sourceThreadWrapper.thread;

    const newThreadId = this.threadCounter.get() as ThreadId;
    this.threadWrappers.set(newThreadId, { state: "pending" });

    try {
      // Create a new context manager for the compacted thread
      const contextManager = await ContextManager.create(
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
          nvim: this.context.nvim,
          options: this.context.options,
        },
      );

      for (const filePath of contextFilePaths) {
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

      const newThread = new Thread(newThreadId, {
        ...this.context,
        contextManager,
        profile: sourceThread.state.profile, // Use the same profile as the source thread
      });

      // Switch to the new thread
      this.context.dispatch({
        type: "chat-msg",
        msg: {
          type: "thread-initialized",
          thread: newThread,
        },
      });

      this.context.dispatch({
        type: "thread-msg",
        id: newThreadId,
        msg: {
          type: "send-message",
          content: initialMessage,
        },
      });
    } catch (e) {
      this.context.dispatch({
        type: "chat-msg",
        msg: {
          type: "thread-error",
          id: newThreadId,
          error: e as Error,
        },
      });
    }
  }

  renderActiveThread() {
    const threadWrapper =
      this.state.activeThreadId &&
      this.threadWrappers.get(this.state.activeThreadId);

    if (!threadWrapper) {
      throw new Error(`no active thread`);
    }

    switch (threadWrapper.state) {
      case "pending":
        return d`Initializing thread...`;
      case "initialized": {
        const thread = threadWrapper.thread;
        return threadView({
          thread,
          dispatch: (msg) =>
            this.context.dispatch({
              type: "thread-msg",
              id: thread.id,
              msg,
            }),
        });
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
