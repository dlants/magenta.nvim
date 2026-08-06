import type { ThreadId } from "@magenta/core";
import { type BufNr, type Line, NvimBuffer } from "./nvim/buffer.ts";
import type { Nvim } from "./nvim/nvim-node/index.ts";
import type { NvimWindow, Row0Indexed } from "./nvim/window.ts";
import type * as TEA from "./tea/tea.ts";
import { pos } from "./tea/view.ts";

/** Buffer name prefix used to identify magenta input buffers.
 * Must match the pattern in lua/magenta/completion/ sources.
 */
export const MAGENTA_INPUT_BUFFER_PREFIX = "Magenta Input";

/** Sanitize a thread title for use in a buffer name: single line, collapsed
 * whitespace, truncated. */
function sanitizeTitle(title: string): string {
  const cleaned = title.replace(/\s+/g, " ").trim();
  const MAX = 40;
  return cleaned.length > MAX ? cleaned.slice(0, MAX).trimEnd() : cleaned;
}

function displayBufferName(
  title: string | undefined,
  bufferId: string,
): string {
  const sanitized = title ? sanitizeTitle(title) : "";
  const lead = sanitized || "Thread";
  return `${lead} [Magenta ${bufferId}]`;
}

function inputBufferName(title: string | undefined, bufferId: string): string {
  const sanitized = title ? sanitizeTitle(title) : "";
  const lead = sanitized || "Thread";
  return `${lead} [${MAGENTA_INPUT_BUFFER_PREFIX} ${bufferId}]`;
}

type BufferEntry =
  | {
      state: "registered";
      buffer: NvimBuffer;
      inputBuffer: NvimBuffer;
    }
  | {
      state: "mounted";
      buffer: NvimBuffer;
      inputBuffer: NvimBuffer;
      app: TEA.App<unknown>;
      mountedApp: TEA.MountedApp;
    };

export type ThreadBufferKey = { kind: "thread"; threadId: ThreadId };
export type ArchivedThreadBufferKey = {
  kind: "archived-thread";
  threadId: ThreadId;
};
export type BufferKey =
  | ThreadBufferKey
  | { kind: "overview" }
  | { kind: "archive" }
  | ArchivedThreadBufferKey;

export type BufferInfo =
  | {
      key: Extract<BufferKey, { kind: "thread" }>;
      role: "display" | "input";
    }
  | {
      key: Extract<
        BufferKey,
        { kind: "overview" | "archive" | "archived-thread" }
      >;
      role: "display";
    }
  | { key: { kind: "shared-input" }; role: "input" };

export function threadKey(threadId: ThreadId): ThreadBufferKey {
  return { kind: "thread", threadId };
}

export function archiveThreadKey(threadId: ThreadId): ArchivedThreadBufferKey {
  return { kind: "archived-thread", threadId };
}

export function bufferKeysEqual(left: BufferKey, right: BufferKey): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "thread" && right.kind === "thread") {
    return left.threadId === right.threadId;
  }
  if (left.kind === "archived-thread" && right.kind === "archived-thread") {
    return left.threadId === right.threadId;
  }
  return true;
}

export class BufferManager {
  private threadEntries: Map<ThreadId, BufferEntry> = new Map();
  private archivedThreadBuffers: Map<ThreadId, NvimBuffer> = new Map();
  private overviewEntry: BufferEntry;
  private archiveEntry: BufferEntry;
  private sharedInputBuffer: NvimBuffer;
  /** Reverse lookup: buffer id → { key, role } */
  private bufNrToInfo: Map<BufNr, BufferInfo> = new Map();

  private createThreadApp: (threadId: ThreadId) => TEA.App<unknown>;
  private createOverviewApp: () => TEA.App<unknown>;
  private createArchiveApp: () => TEA.App<unknown>;

  private constructor(
    private nvim: Nvim,
    overviewEntry: BufferEntry,
    archiveEntry: BufferEntry,
    sharedInputBuffer: NvimBuffer,
    factories: {
      createThreadApp: (threadId: ThreadId) => TEA.App<unknown>;
      createOverviewApp: () => TEA.App<unknown>;
      createArchiveApp: () => TEA.App<unknown>;
    },
  ) {
    this.overviewEntry = overviewEntry;
    this.archiveEntry = archiveEntry;
    this.sharedInputBuffer = sharedInputBuffer;
    this.createThreadApp = factories.createThreadApp;
    this.createOverviewApp = factories.createOverviewApp;
    this.createArchiveApp = factories.createArchiveApp;
  }

  static async create(
    nvim: Nvim,
    factories: {
      createThreadApp: (threadId: ThreadId) => TEA.App<unknown>;
      createOverviewApp: () => TEA.App<unknown>;
      createArchiveApp: () => TEA.App<unknown>;
    },
  ): Promise<BufferManager> {
    const [overviewBuffer, archiveBuffer, inputBuffer] = await Promise.all([
      BufferManager.createDisplayBuffer(nvim, "[Magenta Threads]", false),
      BufferManager.createDisplayBuffer(nvim, "[Magenta Archive]", true),
      BufferManager.createReadOnlyInputBuffer(nvim, "[Magenta Overview Input]"),
    ]);
    const overviewEntry: BufferEntry = {
      state: "registered",
      buffer: overviewBuffer,
      inputBuffer,
    };
    const archiveEntry: BufferEntry = {
      state: "registered",
      buffer: archiveBuffer,
      inputBuffer,
    };
    const manager = new BufferManager(
      nvim,
      overviewEntry,
      archiveEntry,
      inputBuffer,
      factories,
    );
    manager.bufNrToInfo.set(overviewBuffer.id, {
      key: { kind: "overview" },
      role: "display",
    });
    manager.bufNrToInfo.set(archiveBuffer.id, {
      key: { kind: "archive" },
      role: "display",
    });
    manager.bufNrToInfo.set(inputBuffer.id, {
      key: { kind: "shared-input" },
      role: "input",
    });
    return manager;
  }

  async registerThread(
    threadId: ThreadId,
  ): Promise<{ displayBuffer: NvimBuffer; inputBuffer: NvimBuffer }> {
    const existing = this.threadEntries.get(threadId);
    if (existing)
      return {
        displayBuffer: existing.buffer,
        inputBuffer: existing.inputBuffer,
      };

    const bufferId = threadId.replace(/-/g, "");
    const [buffer, inputBuffer] = await Promise.all([
      BufferManager.createDisplayBuffer(
        this.nvim,
        displayBufferName(undefined, bufferId),
        true,
      ),
      BufferManager.createInputBuffer(
        this.nvim,
        inputBufferName(undefined, bufferId),
      ),
    ]);

    const entry: BufferEntry = {
      state: "registered",
      buffer,
      inputBuffer,
    };
    this.threadEntries.set(threadId, entry);
    this.bufNrToInfo.set(buffer.id, {
      key: threadKey(threadId),
      role: "display",
    });
    this.bufNrToInfo.set(inputBuffer.id, {
      key: threadKey(threadId),
      role: "input",
    });
    return { displayBuffer: buffer, inputBuffer };
  }

  private async ensureMounted(threadId: ThreadId): Promise<TEA.MountedApp> {
    const entry = this.threadEntries.get(threadId);
    if (!entry) {
      throw new Error(`No buffers registered for thread ${threadId}`);
    }

    if (entry.state === "mounted") {
      return entry.mountedApp;
    }

    const app = this.createThreadApp(threadId);

    const mountedApp = await app.mount({
      nvim: this.nvim,
      buffer: entry.buffer,
      startPos: pos(0 as Row0Indexed, 0),
      endPos: pos(-1 as Row0Indexed, -1),
    });

    this.threadEntries.set(threadId, {
      state: "mounted",
      buffer: entry.buffer,
      inputBuffer: entry.inputBuffer,
      app,
      mountedApp,
    });

    return mountedApp;
  }

  async ensureOverviewMounted(): Promise<{
    buffer: NvimBuffer;
    mountedApp: TEA.MountedApp;
  }> {
    if (this.overviewEntry.state !== "mounted") {
      const app = this.createOverviewApp();
      const mountedApp = await app.mount({
        nvim: this.nvim,
        buffer: this.overviewEntry.buffer,
        startPos: pos(0 as Row0Indexed, 0),
        endPos: pos(-1 as Row0Indexed, -1),
      });
      this.overviewEntry = {
        state: "mounted",
        buffer: this.overviewEntry.buffer,
        inputBuffer: this.overviewEntry.inputBuffer,
        app,
        mountedApp,
      };
    }

    return {
      buffer: this.overviewEntry.buffer,
      mountedApp: this.overviewEntry.mountedApp,
    };
  }

  async ensureArchiveMounted(): Promise<{
    buffer: NvimBuffer;
    mountedApp: TEA.MountedApp;
  }> {
    if (this.archiveEntry.state !== "mounted") {
      const app = this.createArchiveApp();
      const mountedApp = await app.mount({
        nvim: this.nvim,
        buffer: this.archiveEntry.buffer,
        startPos: pos(0 as Row0Indexed, 0),
        endPos: pos(-1 as Row0Indexed, -1),
      });
      this.archiveEntry = {
        state: "mounted",
        buffer: this.archiveEntry.buffer,
        inputBuffer: this.sharedInputBuffer,
        app,
        mountedApp,
      };
    }

    return {
      buffer: this.archiveEntry.buffer,
      mountedApp: this.archiveEntry.mountedApp,
    };
  }

  getOverviewBuffers(): { displayBuffer: NvimBuffer; inputBuffer: NvimBuffer } {
    return {
      displayBuffer: this.overviewEntry.buffer,
      inputBuffer: this.sharedInputBuffer,
    };
  }

  getArchiveBuffers(): { displayBuffer: NvimBuffer; inputBuffer: NvimBuffer } {
    return {
      displayBuffer: this.archiveEntry.buffer,
      inputBuffer: this.sharedInputBuffer,
    };
  }

  async registerArchivedThread(
    threadId: ThreadId,
  ): Promise<{ displayBuffer: NvimBuffer; inputBuffer: NvimBuffer }> {
    const existing = this.archivedThreadBuffers.get(threadId);
    if (existing) {
      return { displayBuffer: existing, inputBuffer: this.sharedInputBuffer };
    }

    const bufferId = threadId.replace(/-/g, "");
    const buffer = await BufferManager.createDisplayBuffer(
      this.nvim,
      `Archived Thread [Magenta Archive ${bufferId}]`,
      true,
    );
    await buffer.setOption("filetype", "markdown");
    await buffer.setOption("modifiable", false);
    this.archivedThreadBuffers.set(threadId, buffer);
    this.bufNrToInfo.set(buffer.id, {
      key: archiveThreadKey(threadId),
      role: "display",
    });
    return { displayBuffer: buffer, inputBuffer: this.sharedInputBuffer };
  }

  async setArchivedThreadContent(
    threadId: ThreadId,
    lines: Line[],
  ): Promise<NvimBuffer> {
    const { displayBuffer } = await this.registerArchivedThread(threadId);
    await displayBuffer.setOption("modifiable", true);
    try {
      await displayBuffer.setLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
        lines,
      });
    } finally {
      await displayBuffer.setOption("modifiable", false);
    }
    return displayBuffer;
  }

  getArchivedThreadBuffers(
    threadId: ThreadId,
  ): { displayBuffer: NvimBuffer; inputBuffer: NvimBuffer } | undefined {
    const buffer = this.archivedThreadBuffers.get(threadId);
    if (!buffer) return undefined;
    return { displayBuffer: buffer, inputBuffer: this.sharedInputBuffer };
  }

  async removeArchivedThread(threadId: ThreadId): Promise<void> {
    const buffer = this.archivedThreadBuffers.get(threadId);
    if (!buffer) return;
    this.archivedThreadBuffers.delete(threadId);
    this.bufNrToInfo.delete(buffer.id);
    await buffer.delete({ force: true }).catch(() => {
      // The buffer may already have been wiped externally.
    });
  }

  getThreadBuffers(
    threadId: ThreadId,
  ): { displayBuffer: NvimBuffer; inputBuffer: NvimBuffer } | undefined {
    const entry = this.threadEntries.get(threadId);
    if (!entry) return undefined;
    return { displayBuffer: entry.buffer, inputBuffer: entry.inputBuffer };
  }

  /** Rename a thread's display and input buffers to reflect its title. */
  async setThreadTitle(threadId: ThreadId, title: string): Promise<void> {
    const entry = this.threadEntries.get(threadId);
    if (!entry) return;
    const bufferId = threadId.replace(/-/g, "");
    await Promise.all([
      entry.buffer.setName(displayBufferName(title, bufferId)),
      entry.inputBuffer.setName(inputBufferName(title, bufferId)),
    ]);
  }

  /** Remove a thread's buffers and state. Idempotent: a no-op if already gone.
   * Deletes both backing NvimBuffers best-effort. */
  async removeThread(threadId: ThreadId): Promise<void> {
    const entry = this.threadEntries.get(threadId);
    if (!entry) return;
    this.threadEntries.delete(threadId);
    this.bufNrToInfo.delete(entry.buffer.id);
    this.bufNrToInfo.delete(entry.inputBuffer.id);
    await Promise.all(
      [entry.buffer, entry.inputBuffer].map((buf) =>
        buf
          .delete({ force: true })
          .catch((e: Error) =>
            this.nvim.logger.error(
              `Error deleting buffer for thread ${threadId}: ${e.message}`,
            ),
          ),
      ),
    );
  }

  /** Recreate the overview display after it was externally deleted. */
  async recreateOverview(): Promise<void> {
    const deadBuffer = this.overviewEntry.buffer;
    this.bufNrToInfo.delete(deadBuffer.id);
    await deadBuffer.delete({ force: true }).catch(() => {
      // The buffer may already have been wiped externally.
    });
    const buffer = await BufferManager.createDisplayBuffer(
      this.nvim,
      "[Magenta Threads]",
      false,
    );
    this.overviewEntry = {
      state: "registered",
      buffer,
      inputBuffer: this.sharedInputBuffer,
    };
    this.bufNrToInfo.set(buffer.id, {
      key: { kind: "overview" },
      role: "display",
    });
  }

  /** Recreate the archive-list display after it was externally deleted. */
  async recreateArchive(): Promise<void> {
    const deadBuffer = this.archiveEntry.buffer;
    this.bufNrToInfo.delete(deadBuffer.id);
    await deadBuffer.delete({ force: true }).catch(() => {
      // The buffer may already have been wiped externally.
    });
    const buffer = await BufferManager.createDisplayBuffer(
      this.nvim,
      "[Magenta Archive]",
      true,
    );
    this.archiveEntry = {
      state: "registered",
      buffer,
      inputBuffer: this.sharedInputBuffer,
    };
    this.bufNrToInfo.set(buffer.id, {
      key: { kind: "archive" },
      role: "display",
    });
  }

  /** Recreate the read-only input shared by non-live-thread views. */
  async recreateSharedInput(): Promise<void> {
    const deadBuffer = this.sharedInputBuffer;
    this.bufNrToInfo.delete(deadBuffer.id);
    await deadBuffer.delete({ force: true }).catch(() => {
      // The buffer may already have been wiped externally.
    });
    this.sharedInputBuffer = await BufferManager.createReadOnlyInputBuffer(
      this.nvim,
      "[Magenta Overview Input]",
    );
    this.bufNrToInfo.set(this.sharedInputBuffer.id, {
      key: { kind: "shared-input" },
      role: "input",
    });
    this.overviewEntry.inputBuffer = this.sharedInputBuffer;
    this.archiveEntry.inputBuffer = this.sharedInputBuffer;
  }

  /** Look up which view a buffer belongs to and its role. */
  lookupBuffer(bufNr: BufNr): BufferInfo | undefined {
    return this.bufNrToInfo.get(bufNr);
  }

  /** Check if a buffer id belongs to any magenta buffer. */
  isMagentaBuffer(bufNr: BufNr): boolean {
    return this.bufNrToInfo.has(bufNr);
  }

  getMountedApp(activeKey: BufferKey): TEA.MountedApp | undefined {
    if (activeKey.kind === "overview") {
      return this.overviewEntry.state === "mounted"
        ? this.overviewEntry.mountedApp
        : undefined;
    }
    if (activeKey.kind === "archive") {
      return this.archiveEntry.state === "mounted"
        ? this.archiveEntry.mountedApp
        : undefined;
    }
    if (activeKey.kind === "archived-thread") return undefined;
    const entry = this.threadEntries.get(activeKey.threadId);
    return entry?.state === "mounted" ? entry.mountedApp : undefined;
  }

  /** Ensure the active view is ready and return its buffers. */
  async ensureActiveIsMounted(
    activeKey: BufferKey,
  ): Promise<{ displayBuffer: NvimBuffer; inputBuffer: NvimBuffer }> {
    if (activeKey.kind === "overview") {
      await this.ensureOverviewMounted();
      return this.getOverviewBuffers();
    }
    if (activeKey.kind === "archive") {
      await this.ensureArchiveMounted();
      return this.getArchiveBuffers();
    }
    if (activeKey.kind === "archived-thread") {
      return this.registerArchivedThread(activeKey.threadId);
    }
    if (!this.threadEntries.has(activeKey.threadId)) {
      await this.registerThread(activeKey.threadId);
    }
    await this.ensureMounted(activeKey.threadId);
    const entry = this.threadEntries.get(activeKey.threadId)!;
    return { displayBuffer: entry.buffer, inputBuffer: entry.inputBuffer };
  }

  async switchToThread(
    threadId: ThreadId,
    displayWindow: NvimWindow,
    inputWindow: NvimWindow,
  ): Promise<{ displayBuffer: NvimBuffer; inputBuffer: NvimBuffer }> {
    if (!this.threadEntries.has(threadId)) {
      await this.registerThread(threadId);
    }
    const entry = this.threadEntries.get(threadId)!;

    const mountedApp = await this.ensureMounted(threadId);
    await Promise.all([
      displayWindow.setBuffer(entry.buffer),
      inputWindow.setBuffer(entry.inputBuffer),
    ]);
    // Sync the view to current state, in case dispatches occurred while this app wasn't visible
    mountedApp.render();
    return { displayBuffer: entry.buffer, inputBuffer: entry.inputBuffer };
  }

  async switchToOverview(
    displayWindow: NvimWindow,
    inputWindow: NvimWindow,
  ): Promise<{ displayBuffer: NvimBuffer; inputBuffer: NvimBuffer }> {
    const { buffer, mountedApp } = await this.ensureOverviewMounted();
    await Promise.all([
      displayWindow.setBuffer(buffer),
      inputWindow.setBuffer(this.overviewEntry.inputBuffer),
    ]);

    // Sync the view to current state, in case dispatches occurred while this app wasn't visible
    mountedApp.render();
    return this.getOverviewBuffers();
  }

  async switchToArchive(
    displayWindow: NvimWindow,
    inputWindow: NvimWindow,
  ): Promise<{ displayBuffer: NvimBuffer; inputBuffer: NvimBuffer }> {
    const { buffer, mountedApp } = await this.ensureArchiveMounted();
    await Promise.all([
      displayWindow.setBuffer(buffer),
      inputWindow.setBuffer(this.sharedInputBuffer),
    ]);
    mountedApp.render();
    return this.getArchiveBuffers();
  }

  async switchToArchivedThread(
    threadId: ThreadId,
    displayWindow: NvimWindow,
    inputWindow: NvimWindow,
  ): Promise<{ displayBuffer: NvimBuffer; inputBuffer: NvimBuffer }> {
    const buffers = await this.registerArchivedThread(threadId);
    await Promise.all([
      displayWindow.setBuffer(buffers.displayBuffer),
      inputWindow.setBuffer(this.sharedInputBuffer),
    ]);
    return buffers;
  }

  private static async createDisplayBuffer(
    nvim: Nvim,
    name: string,
    listed: boolean,
  ): Promise<NvimBuffer> {
    const buffer = await NvimBuffer.create(listed, true, nvim);
    await buffer.setName(name);
    await buffer.setOption("bufhidden", "hide");
    await buffer.setOption("buftype", "nofile");
    await buffer.setOption("swapfile", false);
    await buffer.setDisplayKeymaps();
    return buffer;
  }

  private static async createReadOnlyInputBuffer(
    nvim: Nvim,
    name: string,
  ): Promise<NvimBuffer> {
    const buffer = await NvimBuffer.create(false, true, nvim);
    await buffer.setName(name);
    await buffer.setOption("bufhidden", "hide");
    await buffer.setOption("buftype", "nofile");
    await buffer.setOption("swapfile", false);
    await buffer.setOption("modifiable", false);
    return buffer;
  }

  private static async createInputBuffer(
    nvim: Nvim,
    name: string,
  ): Promise<NvimBuffer> {
    const buffer = await NvimBuffer.create(true, true, nvim);
    await buffer.setName(name);
    await buffer.setOption("bufhidden", "hide");
    await buffer.setOption("buftype", "nofile");
    await buffer.setOption("swapfile", false);
    await buffer.setOption("filetype", "markdown");
    await buffer.setSiderbarKeymaps();
    await buffer.setupPasteHandlers();

    await buffer.setLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
      lines: ["" as Line],
    });

    return buffer;
  }
}
