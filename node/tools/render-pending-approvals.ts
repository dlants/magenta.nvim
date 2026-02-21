import type { Chat } from "../chat/chat.ts";
import type { ThreadId } from "../chat/types.ts";
import { d, type VDOMNode } from "../tea/view.ts";

export function renderPendingApprovals(
  chat: Chat,
  threadId: ThreadId,
): VDOMNode | undefined {
  const parts: VDOMNode[] = [];

  const tools = chat.getThreadPendingApprovalTools(threadId);
  for (const t of tools) {
    parts.push(d`\n${t.renderSummary()}`);
  }

  const wrapper = chat.threadWrappers[threadId];
  if (wrapper?.state === "initialized") {
    if (
      wrapper.thread.permissionFileIO &&
      wrapper.thread.permissionFileIO.getPendingPermissions().size > 0
    ) {
      parts.push(d`\n${wrapper.thread.permissionFileIO.view()}`);
    }
    if (
      wrapper.thread.permissionShell &&
      wrapper.thread.permissionShell.getPendingPermissions().size > 0
    ) {
      parts.push(d`\n${wrapper.thread.permissionShell.view()}`);
    }
  }

  if (parts.length === 0) return undefined;
  return d`${parts}`;
}
