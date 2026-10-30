import type { Session, Thread, ThreadCompactor } from "@magenta/server";
import type { Chat } from "../chat/chat.ts";
import type { NvimThread } from "../chat/thread.ts";

/** The thread the sidebar's left column shows (or last showed). Tests only:
 * production commands resolve their thread from the invoking buffer. */
export function leftThread(chat: Chat): NvimThread {
  const id = chat.state.left;
  if (!id) throw new Error(`Chat is not initialized yet... no active thread`);
  return chat.getThread(id);
}

/** White-box: the live session behind a Chat, registered by the test driver.
 * Chat itself only sees session state. */
const sessions = new WeakMap<Chat, Session>();
export function registerServerSession(chat: Chat, session: Session): void {
  sessions.set(chat, session);
}
export function serverSession(chat: Chat): Session {
  const session = sessions.get(chat);
  if (!session) throw new Error("No server session registered for this chat");
  return session;
}

function serverRecord(view: NvimThread) {
  const record = serverSession(view.context.chat).getThread(view.id);
  if (record?.state !== "initialized") {
    throw new Error(`Thread ${view.id} is not ready`);
  }
  return record;
}

/** White-box: the live server Thread behind a view. Views only see thread
 * state; tests that inspect server internals reach through the session. */
export function serverThread(view: NvimThread): Thread {
  return serverRecord(view).thread;
}

export function serverCompactor(view: NvimThread): ThreadCompactor | undefined {
  return serverRecord(view).compactor;
}

/** White-box: forget recent attention pings so the next one is sent. */
export function resetAttentionThrottle(chat: Chat): void {
  chat.resetAttentionThrottleForTest();
}
