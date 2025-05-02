import type { ToolManagerMsg } from "./tools/toolManager";
import type { ThreadMsg } from "./chat/thread";
import type { ChatMsg } from "./chat/chat";
import type { ContextManagerMsg } from "./context/context-manager";

export type RootMsg =
  | ToolManagerMsg
  | ThreadMsg
  | ChatMsg
  | ContextManagerMsg
  | {
      type: "sidebar-setup-resubmit";
      lastUserMessage: string;
    };
