import * as fs from "node:fs/promises";
import type { FileIO } from "@magenta/core";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { NvimBuffer, type Line } from "../nvim/buffer.ts";
import type { BufferTracker } from "../buffer-tracker.ts";
import { getBufferIfOpen } from "../utils/buffers.ts";
import {
  resolveFilePath,
  type AbsFilePath,
  type NvimCwd,
  type HomeDir,
} from "../utils/files.ts";
import type { Row0Indexed } from "../nvim/window.ts";

export class BufferAwareFileIO implements FileIO {
  constructor(
    private context: {
      nvim: Nvim;
      bufferTracker: BufferTracker;
      cwd: NvimCwd;
      homeDir: HomeDir;
    },
  ) {}

  private resolvePath(path: string): AbsFilePath {
    return resolveFilePath(
      this.context.cwd,
      path as Parameters<typeof resolveFilePath>[1],
      this.context.homeDir,
    );
  }

  private async findOpenBuffer(
    absPath: AbsFilePath,
  ): Promise<NvimBuffer | undefined> {
    const result = await getBufferIfOpen({
      unresolvedPath: absPath,
      context: this.context,
    });
    if (result.status === "ok") {
      return result.buffer;
    }
    return undefined;
  }

  async readBinaryFile(path: string): Promise<Buffer> {
    const absPath = this.resolvePath(path);
    return fs.readFile(absPath);
  }
  async readFile(path: string): Promise<string> {
    const absPath = this.resolvePath(path);

    const syncInfo = this.context.bufferTracker.getSyncInfo(absPath);
    if (syncInfo) {
      const buffer = new NvimBuffer(syncInfo.bufnr, this.context.nvim);
      const currentChangeTick = await buffer.getChangeTick();
      const bufferChanged = syncInfo.changeTick !== currentChangeTick;

      let fileChanged = false;
      try {
        const stats = await fs.stat(absPath);
        const diskMtime = stats.mtime.getTime();
        fileChanged = syncInfo.mtime < diskMtime;
      } catch {
        // If we can't stat, treat as unchanged
      }

      if (bufferChanged && fileChanged) {
        throw new Error(
          `Both the buffer ${syncInfo.bufnr} and the file on disk for ${absPath} have changed. Cannot determine which version to use.`,
        );
      }

      if (fileChanged && !bufferChanged) {
        await buffer.attemptEdit();
        await this.context.bufferTracker.trackBufferSync(
          absPath,
          syncInfo.bufnr,
        );
      }

      const lines = await buffer.getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });
      return lines.join("\n");
    }

    return fs.readFile(absPath, "utf-8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    const absPath = this.resolvePath(path);
    const buffer = await this.findOpenBuffer(absPath);

    if (buffer) {
      const lines = content.split("\n") as Line[];
      // nvim always adds a trailing newline on save, so strip the empty element from split
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }
      await buffer.setLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
        lines,
      });
      await buffer.attemptWrite();
      await this.context.bufferTracker.trackBufferSync(absPath, buffer.id);
    } else {
      await fs.writeFile(absPath, content, "utf-8");
    }
  }

  async fileExists(path: string): Promise<boolean> {
    const absPath = this.resolvePath(path);
    try {
      await fs.access(absPath);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string): Promise<void> {
    const absPath = this.resolvePath(path);
    await fs.mkdir(absPath, { recursive: true });
  }
  async stat(
    path: string,
  ): Promise<{ mtimeMs: number; size: number } | undefined> {
    const absPath = this.resolvePath(path);
    try {
      const stats = await fs.stat(absPath);
      return { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
      return undefined;
    }
  }
}
