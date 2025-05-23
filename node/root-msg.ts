import type { ThreadId, ThreadMsg } from "./chat/thread";
import type { ChatMsg } from "./chat/chat";
import type { Input as CompactThreadInput } from "./tools/compact-thread";

export type RootMsg =
  | ThreadMsg
  | ChatMsg
  | {
      type: "sidebar-setup-resubmit";
      lastUserMessage: string;
    }
  | {
      type: "compact-thread";
      threadId: ThreadId;
      compactRequest: CompactThreadInput;
    };
