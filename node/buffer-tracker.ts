import type { Nvim } from "./nvim/nvim-node/index.ts";
import type { AbsFilePath } from "./utils/files.ts";
import { NvimBuffer, type BufNr } from "./nvim/buffer.ts";
import fs from "node:fs";

interface BufferSyncInfo {
  mtime: number; // File modification time when last synced
  changeTick: number; // Buffer changeTick when last synced
  bufnr: BufNr; // Buffer number
}

/**
 * Global tracker for buffer sync state
 * Tracks when buffers were last synced with their files on disk
 */
export class BufferTracker {
  private bufferSyncInfo: Record<AbsFilePath, BufferSyncInfo> = {};

  constructor(private nvim: Nvim) {}

  /**
   * Track when a buffer is synced with the file (on open or write)
   */
  public async trackBufferSync(
    absFilePath: AbsFilePath,
    bufnr: BufNr,
  ): Promise<void> {
    try {
      const stats = await fs.promises.stat(absFilePath);
      const buffer = new NvimBuffer(bufnr, this.nvim);
      const changeTick = await buffer.getChangeTick();

      this.bufferSyncInfo[absFilePath] = {
        mtime: stats.mtime.getTime(),
        changeTick,
        bufnr,
      };
    } catch (error) {
      this.nvim.logger.error(
        `Error tracking buffer sync for ${absFilePath}:`,
        error,
      );
    }
  }

  public async isBufferModifiedSinceSync(
    absFilePath: AbsFilePath,
    bufnr: BufNr,
  ): Promise<boolean> {
    const syncInfo = this.bufferSyncInfo[absFilePath];
    if (!syncInfo) {
      throw new Error(
        `Expected bufnr ${bufnr} to have buffer-tracker info but it did not.`,
      );
    }

    const buffer = new NvimBuffer(bufnr, this.nvim);
    const currentChangeTick = await buffer.getChangeTick();
    return currentChangeTick !== syncInfo.changeTick;
  }

  public getSyncInfo(absFilePath: AbsFilePath): BufferSyncInfo | undefined {
    return this.bufferSyncInfo[absFilePath] || undefined;
  }

  public clearFileTracking(absFilePath: AbsFilePath): void {
    delete this.bufferSyncInfo[absFilePath];
  }
}
