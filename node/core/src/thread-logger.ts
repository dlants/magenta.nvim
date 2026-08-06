import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ThreadId, ThreadType } from "./chat-types.ts";
import type { Logger } from "./logger.ts";
import type { ProviderMessage } from "./providers/provider-types.ts";
import { threadConversationLogPath, threadMetaPath } from "./utils/files.ts";

export type ForkProvenance = {
  fromThreadId: ThreadId;
  nativeMessageIdx: number;
};

export type ThreadLogEntry =
  | {
      type: "thread_start";
      threadId: ThreadId;
      timestamp: string;
      threadType: ThreadType;
    }
  | {
      type: "fork";
      timestamp: string;
      fromThreadId: ThreadId;
      nativeMessageIdx: number;
    }
  | {
      type: "message";
      timestamp: string;
      message: ProviderMessage;
    }
  | {
      type: "compaction";
      timestamp: string;
      summary?: string | undefined;
      chunkCount: number;
    }
  | { type: "restart"; timestamp: string }
  | { type: "title"; timestamp: string; title: string };

/**
 * Best-effort, append-only archive of a thread's full conversation.
 *
 * Writes are serialized through an internal promise chain and never awaited by
 * thread execution or UI. All filesystem errors are caught and routed to the
 * diagnostic `Logger`, never rethrown. This is magenta-internal plumbing (like
 * diagnostic logging), so it uses node `fs` directly rather than the `FileIO`
 * abstraction.
 */
export type ThreadLoggerOptions = {
  baseDir?: string;
  forkedFrom?: ForkProvenance;
  /** Name of the magenta script that spawned this thread, if any. */
  scriptName?: string;
  /** Working directory the thread ran in. */
  cwd?: string;
};

export class ThreadLogger {
  private filePath: string;
  private metaPath: string;
  private threadType: ThreadType;
  private scriptName: string | undefined;
  private cwd: string | undefined;
  private title: string | undefined;
  private metaChain: Promise<void> = Promise.resolve();
  private persistedCount = 0;
  private ready: Promise<void>;

  /** Pending serialized lines awaiting a write. */
  private buffer: string[] = [];
  private draining = false;
  private drainPromise: Promise<void> = Promise.resolve();

  constructor(
    threadId: ThreadId,
    threadType: ThreadType,
    private getMessages: () => ReadonlyArray<ProviderMessage>,
    private getMessageCount: () => number,
    private logger: Logger,
    opts: ThreadLoggerOptions = {},
  ) {
    this.filePath = threadConversationLogPath(threadId, opts.baseDir);
    this.metaPath = threadMetaPath(threadId, opts.baseDir);
    this.threadType = threadType;
    this.scriptName = opts.scriptName;
    this.cwd = opts.cwd;
    const dir = path.dirname(this.filePath);
    this.ready = fs.mkdir(dir, { recursive: true }).then(
      () => undefined,
      (err) => {
        this.logger.error(
          `ThreadLogger: failed to create directory ${dir}`,
          err,
        );
      },
    );

    // Write the sidecar up front so the archive can classify this thread even
    // if it never gets a title.
    this.writeMeta();

    this.append({
      type: "thread_start",
      threadId,
      timestamp: new Date().toISOString(),
      threadType,
    });

    if (opts.forkedFrom) {
      this.append({
        type: "fork",
        timestamp: new Date().toISOString(),
        fromThreadId: opts.forkedFrom.fromThreadId,
        nativeMessageIdx: opts.forkedFrom.nativeMessageIdx,
      });
    }
  }

  /**
   * Flush completed messages during a turn. The final message may still be
   * streaming, so it is withheld until `onTurnEnded`.
   */
  onUpdate(): void {
    const stableCount = Math.max(0, this.getMessageCount() - 1);
    if (stableCount > this.persistedCount) {
      const messages = this.getMessages();
      this.flush(messages, stableCount);
    }
  }

  /** Flush all messages once the turn has fully settled. */
  onTurnEnded(): void {
    const totalCount = this.getMessageCount();
    if (totalCount > this.persistedCount) {
      const messages = this.getMessages();
      this.flush(messages, totalCount);
    }
  }

  /**
   * Append all messages at index >= persistedCount, up to `stableCount`.
   * Idempotent by cursor, so calling repeatedly with a growing array never
   * double-writes. Fire-and-forget: returns immediately.
   */
  private flush(
    messages: ReadonlyArray<ProviderMessage>,
    stableCount: number,
  ): void {
    if (stableCount <= this.persistedCount) {
      return;
    }
    const timestamp = new Date().toISOString();
    for (let i = this.persistedCount; i < stableCount; i++) {
      this.append({ type: "message", timestamp, message: messages[i] });
    }
    this.persistedCount = stableCount;
  }

  recordCompaction(opts: { summary?: string; chunkCount: number }): void {
    this.append({
      type: "compaction",
      timestamp: new Date().toISOString(),
      summary: opts.summary,
      chunkCount: opts.chunkCount,
    });
  }

  /**
   * Persist a thread title: append a `title` entry to the JSONL and overwrite
   * the `meta.json` sidecar. Both are best-effort and fire-and-forget.
   */
  recordTitle(title: string): void {
    this.append({
      type: "title",
      timestamp: new Date().toISOString(),
      title,
    });
    this.title = title;
    this.writeMeta();
  }

  private writeMeta(): void {
    const contents = JSON.stringify({
      ...(this.title !== undefined ? { title: this.title } : {}),
      threadType: this.threadType,
      ...(this.scriptName !== undefined ? { scriptName: this.scriptName } : {}),
      ...(this.cwd !== undefined ? { cwd: this.cwd } : {}),
    });
    this.metaChain = this.metaChain
      .then(() => this.ready)
      .then(() => fs.writeFile(this.metaPath, contents))
      .catch((err) => {
        this.logger.error(
          `ThreadLogger: failed to write meta ${this.metaPath}`,
          err,
        );
      });
  }

  recordRestart(): void {
    this.append({
      type: "restart",
      timestamp: new Date().toISOString(),
    });
  }

  resetCursor(): void {
    this.persistedCount = 0;
  }

  /** Resolves once all enqueued writes have flushed. For tests. */
  async flushed(): Promise<void> {
    while (this.draining) {
      await this.drainPromise;
    }
    await this.metaChain;
  }

  private append(entry: ThreadLogEntry): void {
    this.buffer.push(`${JSON.stringify(entry)}\n`);
    if (!this.draining) {
      this.draining = true;
      this.drainPromise = this.drain();
    }
  }

  /**
   * Best-effort write loop. Coalesces all buffered lines into a single append
   * per iteration and keeps running until the buffer drains. Because pushes to
   * the buffer are synchronous, once the loop observes an empty buffer no more
   * work can be pending, so it is safe to stop.
   */
  private async drain(): Promise<void> {
    try {
      await this.ready;
      while (this.buffer.length > 0) {
        const chunk = this.buffer.join("");
        this.buffer.length = 0;
        try {
          await fs.appendFile(this.filePath, chunk);
        } catch (err) {
          this.logger.error(
            `ThreadLogger: failed to append to ${this.filePath}`,
            err,
          );
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
