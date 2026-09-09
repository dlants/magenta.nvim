import type { FileIO } from "../capabilities/file-io.ts";

export class InMemoryFileIO implements FileIO {
  private files: Map<string, string>;

  constructor(initialFiles: Record<string, string>) {
    this.files = new Map(Object.entries(initialFiles));
  }

  readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      const err = new Error(
        `ENOENT: no such file or directory, open '${path}'`,
      );
      (err as NodeJS.ErrnoException).code = "ENOENT";
      return Promise.reject(err);
    }
    return Promise.resolve(content);
  }

  async readBinaryFile(path: string): Promise<Buffer> {
    const content = await this.readFile(path);
    return Buffer.from(content);
  }

  writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    return Promise.resolve();
  }

  writeFileSync(path: string, content: string) {
    this.files.set(path, content);
  }

  fileExists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }

  mkdir(_path: string): Promise<void> {
    return Promise.resolve();
  }

  stat(path: string): Promise<{ mtimeMs: number; size: number } | undefined> {
    if (this.files.has(path)) {
      return Promise.resolve({ mtimeMs: Date.now(), size: 0 });
    }
    return Promise.resolve(undefined);
  }

  deleteFile(path: string): void {
    this.files.delete(path);
  }
  getFileContents(path: string): string | undefined {
    return this.files.get(path);
  }
  async readdir(path: string): Promise<string[]> {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const children = new Set<string>();

    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        // Get the part after the prefix
        const remaining = key.slice(prefix.length);
        // Get the first component (directory or file name)
        const firstComponent = remaining.split("/")[0];
        if (firstComponent) {
          children.add(firstComponent);
        }
      }
    }

    return Array.from(children).sort();
  }

  async isDirectory(path: string): Promise<boolean> {
    const prefix = path.endsWith("/") ? path : `${path}/`;

    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        return true;
      }
    }

    return false;
  }
}
