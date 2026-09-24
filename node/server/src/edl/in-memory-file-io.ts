import type { FileIO } from "../capabilities/file-io.ts";

export class InMemoryFileIO implements FileIO {
  private files: Map<string, string | Buffer>;

  constructor(initialFiles: Record<string, string | Buffer>) {
    this.files = new Map(Object.entries(initialFiles));
  }

  readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      return Promise.reject(enoent("open", path));
    }
    return Promise.resolve(
      typeof content === "string" ? content : content.toString("utf-8"),
    );
  }

  async readBinaryFile(path: string): Promise<Buffer> {
    const content = this.files.get(path);
    if (content === undefined || typeof content === "string") {
      return Buffer.from(await this.readFile(path));
    }
    return content;
  }

  writeBinaryFile(path: string, content: Buffer): void {
    this.files.set(path, content);
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
    const content = this.files.get(path);
    if (content !== undefined) {
      const size =
        typeof content === "string"
          ? Buffer.byteLength(content)
          : content.length;
      return Promise.resolve({ mtimeMs: Date.now(), size });
    }
    return Promise.resolve(undefined);
  }

  deleteFile(path: string): void {
    this.files.delete(path);
  }
  getFileContents(path: string): string | undefined {
    const content = this.files.get(path);
    return typeof content === "string" ? content : content?.toString("utf-8");
  }
  async readdir(path: string): Promise<string[]> {
    return this.readdirSync(path);
  }

  readdirSync(path: string): string[] {
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

  readFileSync(path: string, _encoding: "utf8"): string {
    const content = this.getFileContents(path);
    if (content === undefined) {
      throw enoent("open", path);
    }
    return content;
  }

  statSync(path: string): { isFile(): boolean; isDirectory(): boolean } {
    const isFile = this.files.has(path);
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const isDirectory = [...this.files.keys()].some((k) =>
      k.startsWith(prefix),
    );
    if (!isFile && !isDirectory) {
      throw enoent("stat", path);
    }
    return { isFile: () => isFile, isDirectory: () => isDirectory };
  }
}

function enoent(op: string, path: string): NodeJS.ErrnoException {
  return Object.assign(
    new Error(`ENOENT: no such file or directory, ${op} '${path}'`),
    { code: "ENOENT" },
  );
}
