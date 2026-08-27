import type {
  RequestAction,
  RequestContext,
  ThreadSupervisor,
} from "../thread-supervisor.ts";
import { injectText } from "../thread-supervisor.ts";
import type { CommentStore, CommentUpdateEntry } from "./comment-store.ts";

/** Contributes the `<comment_update>` block. `beforeRead` lets the owner
 * refresh comment positions (extmarks in the root layer) before the store is
 * read, so every request — not just the opening one — carries fresh
 * locations. */
export class CommentSupervisor implements ThreadSupervisor {
  readonly store: CommentStore;
  private readonly beforeRead: () => Promise<void>;
  private readonly onSent:
    | ((entries: CommentUpdateEntry[]) => void)
    | undefined;

  constructor(args: {
    store: CommentStore;
    beforeRead: () => Promise<void>;
    onSent?: (entries: CommentUpdateEntry[]) => void;
  }) {
    this.store = args.store;
    this.beforeRead = args.beforeRead;
    this.onSent = args.onSent;
  }

  async onBeforeRequest(context: RequestContext): Promise<RequestAction> {
    if (context.kind === "continuation" && !context.willRequest) {
      return { type: "none" };
    }
    await this.beforeRead();
    const text = this.store.getPendingUpdate();
    if (text === undefined) return { type: "none" };
    const entries = this.store.commitPending();
    if (entries.length) this.onSent?.(entries);
    return injectText(text);
  }
}
