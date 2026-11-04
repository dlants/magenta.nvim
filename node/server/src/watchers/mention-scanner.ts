import type {
  NativeMessageIdx,
  ProviderMessage,
  ProviderMessageContent,
} from "../providers/provider-types.ts";

import type { ResourceRef, WatcherTriggerMatcher } from "./watcher-registry.ts";

/** Injected context (tracked files, reminders) would surface keys nobody
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

function collectKeys(
  value: unknown,
  matchers: ReadonlyArray<WatcherTriggerMatcher>,
  into: Map<string, ResourceRef>,
): void {
  if (typeof value === "string") {
    for (const m of matchers) {
      for (const match of value.matchAll(m.regex)) {
        const key = match[m.keyGroup];
        if (key) into.set(`${m.watcher}\0${key}`, { watcher: m.watcher, key });
      }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, matchers, into);
  } else if (value && typeof value === "object") {
    for (const [key, field] of Object.entries(value)) {
      if (key !== "data") collectKeys(field, matchers, into);
    }
  }
}

/** Scans the thread's messages for watcher trigger matches, off the hot
 * path: one native message per tick, lagging the conversation.
 *
 * Messages only grow by appending blocks (a streaming block lands only once
 * finished, and injections merge into a trailing user message), so per native
 * message we remember how many blocks were already scanned. */
export class MentionScanner {
  private readonly refs = new Map<string, ResourceRef>();
  private readonly scannedBlockCounts = new Map<NativeMessageIdx, number>();
  private scanning = false;
  private rescanRequested = false;
  private disposed = false;
  /** The managers replace their display array only when messages change (not
   * on streaming deltas), so identity tells us whether there is anything new. */
  private lastSeenMessages: ReadonlyArray<ProviderMessage> | undefined;

  constructor(
    private readonly getMessages: () => ReadonlyArray<ProviderMessage>,
    private readonly getMatchers: () => ReadonlyArray<WatcherTriggerMatcher>,
    private readonly onChanged: () => void,
  ) {}

  get mentioned(): ReadonlyArray<ResourceRef> {
    return [...this.refs.values()];
  }

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
    const before = this.refs.size;
    const matchers = this.getMatchers();
    for (const block of pending.blocks) {
      if (!SKIPPED_BLOCK_TYPES.has(block.type))
        collectKeys(block, matchers, this.refs);
    }
    this.scannedBlockCounts.set(pending.idx, pending.scannedCount);
    if (this.refs.size !== before) this.onChanged();
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
