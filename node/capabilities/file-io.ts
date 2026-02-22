import * as fs from "node:fs/promises";

export interface FileIO {
  readFile(path: string): Promise<string>;
  readBinaryFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  stat(path: string): Promise<{ mtimeMs: number } | undefined>;
}

export class FsFileIO implements FileIO {
  async readFile(path: string): Promise<string> {
    return fs.readFile(path, "utf-8");
  }
  async readBinaryFile(path: string): Promise<Buffer> {
    return fs.readFile(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await fs.writeFile(path, content, "utf-8");
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string): Promise<void> {
    await fs.mkdir(path, { recursive: true });
  }
  async stat(path: string): Promise<{ mtimeMs: number } | undefined> {
    try {
      const stats = await fs.stat(path);
      return { mtimeMs: stats.mtimeMs };
    } catch {
      return undefined;
    }
  }
}
