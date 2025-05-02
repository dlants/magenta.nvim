import type { Nvim } from "nvim-node";
import type { MagentaOptions, Profile } from "../options";
import type { RootMsg } from "../root-msg";
import type { Dispatch } from "../tea/tea";
import { Thread, view as threadView } from "./thread";
import type { Lsp } from "../lsp";
import { assertUnreachable } from "../utils/assertUnreachable";
import { d } from "../tea/view";
import { ContextManager } from "../context/context-manager";

type State =
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

type Msg =
  | {
      type: "thread-initialized";
      thread: Thread;
    }
  | {
      type: "thread-error";
      error: Error;
    };

export type ChatMsg = {
  type: "chat-msg";
  msg: Msg;
};

export class Chat {
  state: State;

  constructor(
    private context: {
      dispatch: Dispatch<RootMsg>;
      options: MagentaOptions;
      nvim: Nvim;
      lsp: Lsp;
    },
  ) {
    this.state = {
      state: "pending",
    };

    this.initThread().catch((e: Error) => {
      this.context.dispatch({
        type: "chat-msg",
        msg: {
          type: "thread-error",
          error: e,
        },
      });
    });
  }

  update(msg: RootMsg) {
    if (msg.type == "chat-msg") {
      switch (msg.msg.type) {
        case "thread-initialized":
          this.state = {
            state: "initialized",
            thread: msg.msg.thread,
          };
          return;

        case "thread-error":
          this.state = {
            state: "error",
            error: msg.msg.error,
          };
          return;
        default:
          assertUnreachable(msg.msg);
      }
    }

    if (this.state.state == "initialized") {
      this.state.thread.update(msg);
    }
  }

  async getMessages() {
    if (this.state.state == "initialized") {
      return await this.state.thread.getMessages();
    }
    return [];
  }

  async initThread() {
    const contextManager = await ContextManager.create({
      dispatch: this.context.dispatch,
      nvim: this.context.nvim,
      options: this.context.options,
    });

    const thread = new Thread({
      dispatch: this.context.dispatch,
      contextManager,
      profile: getActiveProfile(
        this.context.options.profiles,
        this.context.options.activeProfile,
      ),
      nvim: this.context.nvim,
      lsp: this.context.lsp,
      options: this.context.options,
    });

    this.context.dispatch({
      type: "chat-msg",
      msg: {
        type: "thread-initialized",
        thread,
      },
    });
  }

  view() {
    switch (this.state.state) {
      case "pending":
        return d`Initializing...`;
      case "initialized":
        return threadView({
          thread: this.state.thread,
          dispatch: (msg) => this.context.dispatch({ type: "thread-msg", msg }),
        });
      case "error":
        return d`Error: ${this.state.error.message}`;
      default:
        assertUnreachable(this.state);
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
