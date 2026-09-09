import type { ThreadId } from "@magenta/server";
import type { Chat } from "../chat/chat.ts";
import { d, type VDOMNode } from "../tea/view.ts";

export function renderPendingApprovals(
  chat: Chat,
  threadId: ThreadId,
): VDOMNode | undefined {
  const wrapper = chat.threadWrappers[threadId];
  if (wrapper?.state === "initialized") {
    const handler = wrapper.thread.sandboxViolationHandler;
    if (handler && handler.getPendingViolations().size > 0) {
      return d`\n${handler.view()}`;
    }
  }

  return undefined;
}
