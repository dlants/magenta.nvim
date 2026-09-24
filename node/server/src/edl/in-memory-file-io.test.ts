import { describe, expect, it } from "vitest";
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
  it("round-trips non-UTF-8 binary bytes exactly", async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x80, 0xfe]);
    const io = new InMemoryFileIO({ "/img.jpg": bytes });
    expect((await io.readBinaryFile("/img.jpg")).equals(bytes)).toBe(true);
    io.writeBinaryFile("/b.bin", bytes);
    expect((await io.readBinaryFile("/b.bin")).equals(bytes)).toBe(true);
  });
  describe("statSync / readdirSync", () => {
    const io = new InMemoryFileIO({
      "/a/file.md": "x",
      "/a/nested/deep/agent.md": "y",
    });
    it("detects files", () => {
      const s = io.statSync("/a/file.md");
      expect(s.isFile()).toBe(true);
      expect(s.isDirectory()).toBe(false);
    });
    it("detects directories, including nested and trailing-slash paths", () => {
      for (const p of ["/a", "/a/", "/a/nested", "/a/nested/deep/"]) {
        const s = io.statSync(p);
        expect(s.isDirectory()).toBe(true);
        expect(s.isFile()).toBe(false);
      }
    });
    it("throws ENOENT for missing paths", () => {
      expect(() => io.statSync("/missing")).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
      expect(() => io.statSync("/a/fil")).toThrow("ENOENT");
    });
    it("lists immediate children", () => {
      expect(io.readdirSync("/a")).toEqual(["file.md", "nested"]);
      expect(io.readdirSync("/a/nested/")).toEqual(["deep"]);
      expect(io.readdirSync("/missing")).toEqual([]);
    });
  });
});
