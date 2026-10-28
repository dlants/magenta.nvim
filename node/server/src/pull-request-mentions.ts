import type {
  NativeMessageIdx,
  ProviderMessage,
  ProviderMessageContent,
} from "./providers/provider-types.ts";

const PULL_REQUEST_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

/** Injected context (tracked files, reminders) would surface links nobody
 * mentioned; images and documents are base64 payloads. */
const SKIPPED_BLOCK_TYPES: ReadonlySet<ProviderMessageContent["type"]> =
  new Set([
    "image",
    "document",
    "system_reminder",
    "system_info",
    "context_update",
    "thread_context",
    "fork_notification",
  ]);

function collectUrls(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(PULL_REQUEST_URL)) into.add(match[0]);
  } else if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, into);
  } else if (value && typeof value === "object") {
    for (const [key, field] of Object.entries(value)) {
      if (key !== "data") collectUrls(field, into);
    }
  }
}

/** Scans the thread's messages for GitHub pull request links, off the hot
 * path: one native message per tick, lagging the conversation.
 *
 * Messages only grow by appending blocks (a streaming block lands only once
 * finished, and injections merge into a trailing user message), so per native
 * message we remember how many blocks were already scanned. */
export class PullRequestMentionScanner {
  private readonly urls = new Set<string>();
  private readonly scannedBlockCounts = new Map<NativeMessageIdx, number>();
  private scanning = false;
  private rescanRequested = false;
  private disposed = false;

  constructor(
    private readonly getMessages: () => ReadonlyArray<ProviderMessage>,
    private readonly onChanged: () => void,
  ) {}

  get mentionedPullRequests(): ReadonlyArray<string> {
    return [...this.urls];
  }

  schedule(): void {
    if (this.disposed) return;
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
        this.schedule();
      }
      return;
    }
    const before = this.urls.size;
    for (const block of pending.blocks) {
      if (!SKIPPED_BLOCK_TYPES.has(block.type)) collectUrls(block, this.urls);
    }
    this.scannedBlockCounts.set(pending.idx, pending.scannedCount);
    if (this.urls.size !== before) this.onChanged();
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
        const idx = (block as { nativeMessageIdx?: NativeMessageIdx })
          .nativeMessageIdx;
        if (idx === undefined) continue;
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
