import type { ThreadMsg } from "./chat/thread.ts";
import type { ChatMsg } from "./chat/chat.ts";

export type SidebarMsg =
  | {
      type: "setup-resubmit";
      lastUserMessage: string;
    }
  | {
      type: "scroll-to-last-user-message";
    }
  | {
      type: "scroll-to-bottom";
    };

export type RootMsg =
  | ThreadMsg
  | ChatMsg
  | {
      type: "sidebar-msg";
      msg: SidebarMsg;
    };
