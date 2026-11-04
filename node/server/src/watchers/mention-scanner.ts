import type {
  NativeMessageIdx,
  ProviderMessage,
  ProviderMessageContent,
} from "../providers/provider-types.ts";

/** Injected context (tracked files, reminders, watch updates) would surface
 * keys nobody mentioned and could cascade; search results and reasoning are
 * not the user's or agent's references; images and documents are base64. */
const SKIPPED_BLOCK_TYPES: ReadonlySet<ProviderMessageContent["type"]> =
  new Set([
    "image",
    "document",
    "system_reminder",
    "system_info",
    "context_update",
    "thread_context",
    "fork_notification",
    "server_tool_use",
    "web_search_tool_result",
    "thinking",
    "redacted_thinking",
  ]);
const SKIPPED_FIELDS: ReadonlySet<string> = new Set([
  "type",
  "id",
  "data",
  "citations",
]);
const MAX_STRING_CHARS = 64 * 1024;
const MAX_SCAN_CHARS = 256 * 1024;

/** String leaves rather than `JSON.stringify`, so newlines stay newlines. */
function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    into.push(value.slice(0, MAX_STRING_CHARS));
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
  } else if (value && typeof value === "object") {
    for (const [key, field] of Object.entries(value)) {
      if (!SKIPPED_FIELDS.has(key)) collectStrings(field, into);
    }
  }
}

/** Splits into calls of at most `MAX_SCAN_CHARS` total. */
function batches(texts: string[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const t of texts) {
    if (size + t.length > MAX_SCAN_CHARS && current.length) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(t);
    size += t.length;
  }
  if (current.length) out.push(current);
  return out;
}

/** Sends the thread's new message strings to the watchers' `scan`, off the
 * hot path: one native message per tick, lagging the conversation. Scans are
 * not awaited; `scan` never throws.
 *
 * Messages only grow by appending blocks (a streaming block lands only once
 * finished, and injections merge into a trailing user message), so per native
 * message we remember how many blocks were already scanned. */
export class MentionScanner {
  private readonly scannedBlockCounts = new Map<NativeMessageIdx, number>();
  private scanning = false;
  private rescanRequested = false;
  private disposed = false;
  /** The managers replace their display array only when messages change (not
   * on streaming deltas), so identity tells us whether there is anything new. */
  private lastSeenMessages: ReadonlyArray<ProviderMessage> | undefined;

  constructor(
    private readonly getMessages: () => ReadonlyArray<ProviderMessage>,
    private readonly scan: (texts: string[]) => Promise<void>,
  ) {}

  schedule(): void {
    if (this.disposed) return;
    const messages = this.getMessages();
    if (messages === this.lastSeenMessages) return;
    this.lastSeenMessages = messages;
    if (this.scanning) {
      this.rescanRequested = true;
      return;
    }
    this.scanning = true;
    setImmediate(() => this.scanNextMessage());
  }

  dispose(): void {
    this.disposed = true;
  }

  private scanNextMessage(): void {
    if (this.disposed) return;
    const pending = this.nextUnscanned();
    if (!pending) {
      this.scanning = false;
      if (this.rescanRequested) {
        this.rescanRequested = false;
        this.scanning = true;
        setImmediate(() => this.scanNextMessage());
      }
      return;
    }
    const texts: string[] = [];
    for (const block of pending.blocks) {
      if (!SKIPPED_BLOCK_TYPES.has(block.type)) collectStrings(block, texts);
    }
    this.scannedBlockCounts.set(pending.idx, pending.scannedCount);
    for (const batch of batches(texts.filter((t) => t.length > 0))) {
      void this.scan(batch);
    }
    setImmediate(() => this.scanNextMessage());
  }

  private nextUnscanned():
    | {
        idx: NativeMessageIdx;
        blocks: ProviderMessageContent[];
        scannedCount: number;
      }
    | undefined {
    const byIdx = new Map<NativeMessageIdx, ProviderMessageContent[]>();
    for (const message of this.getMessages()) {
      for (const block of message.content) {
        const idx = block.nativeMessageIdx;
        let blocks = byIdx.get(idx);
        if (!blocks) {
          blocks = [];
          byIdx.set(idx, blocks);
        }
        blocks.push(block);
      }
    }
    for (const [idx, blocks] of byIdx) {
      const scanned = this.scannedBlockCounts.get(idx) ?? 0;
      if (blocks.length > scanned) {
        return {
          idx,
          blocks: blocks.slice(scanned),
          scannedCount: blocks.length,
        };
      }
    }
    return undefined;
  }
}
