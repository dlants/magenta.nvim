import { Emitter } from "../emitter.ts";
import type { ProviderMessageContent } from "../providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "../providers/provider-types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Result } from "../utils/result.ts";

export type CommentId = string & { __commentId: true };

/** Re-declared here (see `node/nvim/buffer.ts`) so core can echo the buffer
 * identifier back to the agent without depending on the neovim layer. */
export type BufNr = number & { __bufnr: true };

export type CommentMessage = { from: "user" | "agent"; text: string };

/** Everything core knows about where a comment lives: strings and numbers the
 * nvim layer resolved for it. Core never derives this. */
export type CommentLocation = {
  /** How the buffer is named to the agent: a cwd-relative path when
   * file-backed, otherwise the bufname. */
  bufferLabel: string;
  bufnr: BufNr;
} & (
  | {
      state: "anchored";
      /** 1-indexed inclusive, as shown to the agent. */
      lines: { start: number; end: number };
      /** The commented text, for the `<selection>` body. */
      selection: string;
    }
  | { state: "stale" }
);

export type Comment = {
  id: CommentId;
  location: CommentLocation;
  messages: CommentMessage[];
};

export type CommentCloseReason = "deleted" | "buffer-unloaded";

export type CommentUpdateEntry = {
  commentId: CommentId;
  location: CommentLocation;
} & (
  | {
      status: "new-messages";
      /** The undelivered user messages this entry carries; never empty. */
      messages: [CommentMessage, ...CommentMessage[]];
    }
  | { status: CommentCloseReason }
);

export type CommentStoreEvents = {
  /** Something the nvim layer needs to redraw changed. */
  changed: [];
};

function locationLabel(location: CommentLocation): string {
  if (location.state === "stale") {
    return `${location.bufferLabel} (range deleted)`;
  }
  const { start, end } = location.lines;
  return start === end
    ? `${location.bufferLabel}:${start}`
    : `${location.bufferLabel}:${start}-${end}`;
}

function statusLabel(entry: CommentUpdateEntry): string {
  switch (entry.status) {
    case "new-messages":
      return entry.messages.length === 1
        ? "1 new message"
        : `${entry.messages.length} new messages`;
    case "deleted":
      return "deleted";
    case "buffer-unloaded":
      return "closed: buffer unloaded";
    default:
      return assertUnreachable(entry);
  }
}

/**
 * Holds the side conversations the user has started on ranges of buffers. Pure
 * state: no buffers, no extmarks, no rendering. The nvim layer resolves a
 * `CommentLocation` and hands it in; core turns undelivered messages into the
 * `<comment_update>` block the agent reads.
 */
export class CommentStore extends Emitter<CommentStoreEvents> {
  readonly comments: { [id: CommentId]: Comment } = {};

  /** Number of messages of each comment already delivered to the agent. */
  private deliveredCounts: { [id: CommentId]: number } = {};
  /** Entries for comments that have already been dropped: the terminal notice,
   * preceded by any user messages that were still undelivered at close time. */
  private queuedEntries: CommentUpdateEntry[] = [];
  /** Order in which comments first became pending, so the manifest reads in
   * submission order. */
  private pendingOrder: CommentId[] = [];
  private nextId = 1;

  addComment(location: CommentLocation, text: string): CommentId {
    const id = `c${this.nextId++}` as CommentId;
    this.comments[id] = { id, location, messages: [{ from: "user", text }] };
    this.deliveredCounts[id] = 0;
    this.markPending(id);
    this.emit("changed");
    return id;
  }

  addUserMessage(id: CommentId, text: string): void {
    const comment = this.comments[id];
    if (!comment) {
      return;
    }
    comment.messages.push({ from: "user", text });
    this.markPending(id);
    this.emit("changed");
  }

  /** The `reply` tool's entry point. */
  addAgentMessage(id: CommentId, text: string): Result<undefined> {
    const comment = this.comments[id];
    if (!comment) {
      return { status: "error", error: `No open comment with id \`${id}\`.` };
    }
    comment.messages.push({ from: "agent", text });
    // the agent wrote this, so it needs no delivery
    this.deliveredCounts[id] = comment.messages.length;
    this.emit("changed");
    return { status: "ok", value: undefined };
  }

  setLocation(id: CommentId, location: CommentLocation): void {
    const comment = this.comments[id];
    if (!comment) {
      return;
    }
    comment.location = location;
    this.emit("changed");
  }

  /** Terminal. Queues the manifest entry, then drops the comment. */
  closeComment(id: CommentId, reason: CommentCloseReason): void {
    const comment = this.comments[id];
    if (!comment) {
      return;
    }
    const undelivered = this.undeliveredMessages(id);
    if (undelivered.length) {
      this.queuedEntries.push({
        commentId: id,
        location: comment.location,
        status: "new-messages",
        messages: undelivered as [CommentMessage, ...CommentMessage[]],
      });
    }
    this.queuedEntries.push({
      commentId: id,
      location: comment.location,
      status: reason,
    });
    delete this.comments[id];
    delete this.deliveredCounts[id];
    this.markPending(id);
    this.emit("changed");
  }

  /** Undelivered user messages of a still-open comment. */
  private undeliveredMessages(id: CommentId): CommentMessage[] {
    const comment = this.comments[id];
    if (!comment) {
      return [];
    }
    return comment.messages
      .slice(this.deliveredCounts[id] ?? 0)
      .filter((m) => m.from === "user");
  }

  private markPending(id: CommentId) {
    if (!this.pendingOrder.includes(id)) {
      this.pendingOrder.push(id);
    }
  }

  private buildEntries(): CommentUpdateEntry[] {
    const queuedById = new Map<CommentId, CommentUpdateEntry[]>();
    for (const entry of this.queuedEntries) {
      const list = queuedById.get(entry.commentId) ?? [];
      list.push(entry);
      queuedById.set(entry.commentId, list);
    }
    const entries: CommentUpdateEntry[] = [];
    for (const id of this.pendingOrder) {
      const queued = queuedById.get(id);
      if (queued) {
        entries.push(...queued);
        continue;
      }
      const comment = this.comments[id];
      if (!comment) {
        continue;
      }
      const messages = this.undeliveredMessages(id);
      if (messages.length) {
        entries.push({
          commentId: id,
          location: comment.location,
          status: "new-messages",
          messages: messages as [CommentMessage, ...CommentMessage[]],
        });
      }
    }
    return entries;
  }

  hasPendingUpdates(): boolean {
    return this.buildEntries().length > 0;
  }

  /** The single `<comment_update>` content part for undelivered messages. Pure. */
  getPendingUpdate(): ProviderMessageContent[] {
    return commentUpdatesToContent(this.buildEntries());
  }

  /** Marks everything `getPendingUpdate` would return as delivered, and returns
   * the structured entries for the thread's display ledger. */
  commitPending(): CommentUpdateEntry[] {
    const entries = this.buildEntries();
    for (const entry of entries) {
      const comment = this.comments[entry.commentId];
      if (comment) {
        this.deliveredCounts[entry.commentId] = comment.messages.length;
      }
    }
    this.queuedEntries = [];
    this.pendingOrder = [];
    if (entries.length) {
      this.emit("changed");
    }
    return entries;
  }

  /** Ids with undelivered user messages — the `pending` render style. */
  pendingCommentIds(): CommentId[] {
    return (Object.keys(this.comments) as CommentId[]).filter(
      (id) => this.undeliveredMessages(id).length > 0,
    );
  }

  /** Ids the agent may reply to right now. */
  listOpenCommentIds(): CommentId[] {
    return Object.keys(this.comments) as CommentId[];
  }
}

export function commentUpdatesToContent(
  entries: CommentUpdateEntry[],
): ProviderMessageContent[] {
  if (entries.length === 0) {
    return [];
  }
  const manifest = entries
    .map(
      (entry) =>
        `${entry.commentId} ${locationLabel(entry.location)} (${statusLabel(entry)})`,
    )
    .join("\n");

  const bodies: string[] = [];
  for (const entry of entries) {
    if (entry.status !== "new-messages") {
      continue;
    }
    const { location } = entry;
    const messages = entry.messages
      .map((m) => `<user>${m.text}</user>`)
      .join("\n");
    if (location.state === "stale") {
      bodies.push(`\
- \`${entry.commentId}\` buffer ${location.bufnr} \`${location.bufferLabel}\` (the commented range was deleted)
${messages}`);
      continue;
    }
    bodies.push(`\
- \`${entry.commentId}\` buffer ${location.bufnr} \`${location.bufferLabel}\` lines ${location.lines.start}-${location.lines.end}
<selection>
${location.selection}
</selection>
${messages}`);
  }

  const header = `\
These are comments the user has left on ranges of buffers. Use the \`reply\` tool to answer. You will be notified if comments change.`;

  return [
    {
      type: "text",
      text: `<comment_update>\n${header}\n<summary>\n${manifest}\n</summary>${
        bodies.length ? `\n${bodies.join("\n")}` : ""
      }\n</comment_update>`,
      nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
    },
  ];
}
