import type { ThreadId } from "@magenta/server";
import type { ChatMsg } from "./chat/chat.ts";
import type { ThreadMsg } from "./chat/thread.ts";
import type { ScriptMsg } from "./scripts/script-manager.ts";

export type SidebarMsg =
  | {
      type: "append-to-input";
      threadId: ThreadId;
      text: string;
    }
  | {
      type: "scroll-to-last-user-message";
    }
  | {
      type: "set-cursor-to-bottom";
    };

export type RootMsg =
  | ThreadMsg
  | ChatMsg
  | ScriptMsg
  | {
      type: "sidebar-msg";
      msg: SidebarMsg;
    }
  | {
      type: "select-thread-effect";
      id: ThreadId;
    }
  | {
      type: "select-archived-thread-effect";
      id: ThreadId;
    }
  | {
      type: "set-thread-title-effect";
      id: ThreadId;
      title: string;
    };
