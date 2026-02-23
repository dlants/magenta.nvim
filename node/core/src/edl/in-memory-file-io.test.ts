import { describe, it, expect } from "vitest";
import { InMemoryFileIO } from "./in-memory-file-io.ts";

describe("InMemoryFileIO", () => {
  it("should read an initial file", async () => {
    const io = new InMemoryFileIO({ "/test.md": "hello world" });
    expect(await io.readFile("/test.md")).toBe("hello world");
  });

  it("should throw ENOENT for missing files", async () => {
    const io = new InMemoryFileIO({});
    await expect(io.readFile("/missing.md")).rejects.toThrow("ENOENT");
  });

  it("should write and read back a file", async () => {
    const io = new InMemoryFileIO({});
    await io.writeFile("/new.md", "content");
    expect(await io.readFile("/new.md")).toBe("content");
  });

  it("should overwrite existing files", async () => {
    const io = new InMemoryFileIO({ "/test.md": "original" });
    await io.writeFile("/test.md", "updated");
    expect(await io.readFile("/test.md")).toBe("updated");
  });

  it("should check file existence", async () => {
    const io = new InMemoryFileIO({ "/exists.md": "yes" });
    expect(await io.fileExists("/exists.md")).toBe(true);
    expect(await io.fileExists("/nope.md")).toBe(false);
  });

  it("should return stat for existing files", async () => {
    const io = new InMemoryFileIO({ "/test.md": "data" });
    const stat = await io.stat("/test.md");
    expect(stat).toBeDefined();
    expect(stat!.mtimeMs).toBeGreaterThan(0);
  });

  it("should return undefined stat for missing files", async () => {
    const io = new InMemoryFileIO({});
    expect(await io.stat("/missing.md")).toBeUndefined();
  });

  it("should read binary files as Buffer", async () => {
    const io = new InMemoryFileIO({ "/test.md": "hello" });
    const buf = await io.readBinaryFile("/test.md");
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString()).toBe("hello");
  });

  it("mkdir should be a no-op", async () => {
    const io = new InMemoryFileIO({});
    await expect(io.mkdir("/some/dir")).resolves.toBeUndefined();
  });

  it("getFileContents should return synchronously", () => {
    const io = new InMemoryFileIO({ "/test.md": "sync content" });
    expect(io.getFileContents("/test.md")).toBe("sync content");
    expect(io.getFileContents("/missing.md")).toBeUndefined();
  });
});
