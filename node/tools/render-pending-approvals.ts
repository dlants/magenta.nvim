import type { Chat } from "../chat/chat.ts";
import type { ThreadId } from "../chat/types.ts";
import { d, type VDOMNode } from "../tea/view.ts";

export function renderPendingApprovals(
  chat: Chat,
  threadId: ThreadId,
): VDOMNode | undefined {
  const tools = chat.getThreadPendingApprovalTools(threadId);
  if (tools.length === 0) return undefined;
  return d`${tools.map((t) => d`\n${t.renderSummary()}`)}`;
}
