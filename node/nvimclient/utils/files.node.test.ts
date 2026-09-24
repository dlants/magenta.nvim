import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  categorizeFileType,
  detectFileType,
  FileCategory,
  isLikelyTextFile,
  validateFileSize,
} from "./files.ts";

const cwd = path.join(import.meta.dirname, "../test/fixtures");

describe("categorizeFileType", () => {
  it("should categorize text MIME types correctly", () => {
    expect(categorizeFileType("text/plain")).toBe(FileCategory.TEXT);
    expect(categorizeFileType("text/html")).toBe(FileCategory.TEXT);
    expect(categorizeFileType("text/css")).toBe(FileCategory.TEXT);
  });

  it("should categorize code MIME types correctly", () => {
    expect(categorizeFileType("application/javascript")).toBe(
      FileCategory.TEXT,
    );
    expect(categorizeFileType("application/json")).toBe(FileCategory.TEXT);
    expect(categorizeFileType("application/xml")).toBe(FileCategory.TEXT);
  });

  it("should categorize image MIME types correctly", () => {
    expect(categorizeFileType("image/jpeg")).toBe(FileCategory.IMAGE);
    expect(categorizeFileType("image/png")).toBe(FileCategory.IMAGE);
    expect(categorizeFileType("image/gif")).toBe(FileCategory.IMAGE);
    expect(categorizeFileType("image/webp")).toBe(FileCategory.IMAGE);
  });

  it("should categorize PDF MIME type correctly", () => {
    expect(categorizeFileType("application/pdf")).toBe(FileCategory.PDF);
  });

  it("should categorize unsupported MIME types correctly", () => {
    expect(categorizeFileType("video/mp4")).toBe(FileCategory.UNSUPPORTED);
    expect(categorizeFileType("application/octet-stream")).toBe(
      FileCategory.UNSUPPORTED,
    );
    expect(categorizeFileType("image/tiff")).toBe(FileCategory.UNSUPPORTED);
  });
});

describe("isLikelyTextFile", () => {
  it("should detect text files by extension", async () => {
    const textFile = path.join(cwd, "poem.txt");
    expect(await isLikelyTextFile(textFile)).toBe(true);
  });

  it("should detect code files by extension", async () => {
    const tsFile = path.join(cwd, "test.ts");
    expect(await isLikelyTextFile(tsFile)).toBe(true);
  });

  it("should detect binary files by content", async () => {
    const binaryFile = path.join(cwd, "test.bin");
    expect(await isLikelyTextFile(binaryFile)).toBe(false);
  });
});

describe("detectFileType", () => {
  it("should detect text files correctly", async () => {
    const textFile = path.join(cwd, "poem.txt");
    const result = await detectFileType(textFile);

    if (!result) throw new Error("expected a detected file type");
    expect(result.category).toBe(FileCategory.TEXT);
    expect(result.mimeType).toBe("text/plain");
    expect(result.extension).toBe(".txt");
  });

  it("should detect TypeScript files correctly", async () => {
    const tsFile = path.join(cwd, "test.ts");
    const result = await detectFileType(tsFile);

    if (!result) throw new Error("expected a detected file type");
    expect(result.category).toBe(FileCategory.TEXT);
    // TypeScript files may be detected as text/plain if no magic number is found
    expect(result.mimeType).toMatch(/^(application\/typescript|text\/plain)$/);
    expect(result.extension).toBe(".ts");
  });

  it("should detect JSON files correctly", async () => {
    const jsonFile = path.join(cwd, "tsconfig.json");
    const result = await detectFileType(jsonFile);

    if (!result) throw new Error("expected a detected file type");
    expect(result.category).toBe(FileCategory.TEXT);
    expect(result.mimeType).toBe("application/json");
    expect(result.extension).toBe(".json");
  });

  it("should detect JPEG images correctly", async () => {
    const jpegFile = path.join(cwd, "test.jpg");
    const result = await detectFileType(jpegFile);

    if (!result) throw new Error("expected a detected file type");
    expect(result.category).toBe(FileCategory.IMAGE);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.extension).toBe(".jpg");
  });

  it("should detect PDF files correctly", async () => {
    const pdfFile = path.join(cwd, "test.pdf");
    const result = await detectFileType(pdfFile);

    if (!result) throw new Error("expected a detected file type");
    expect(result.category).toBe(FileCategory.PDF);
    expect(result.mimeType).toBe("application/pdf");
    expect(result.extension).toBe(".pdf");
  });

  it("should detect binary files as unsupported", async () => {
    const binaryFile = path.join(cwd, "test.bin");
    const result = await detectFileType(binaryFile);

    if (!result) throw new Error("expected a detected file type");
    expect(result.category).toBe(FileCategory.UNSUPPORTED);
  });

  it("should return undefined for non-existent files", async () => {
    const nonExistentFile = path.join(cwd, "nonexistent.txt");
    const result = await detectFileType(nonExistentFile);

    expect(result).toBeUndefined();
  });
});

describe("validateFileSize", () => {
  it("should always allow text files regardless of size", async () => {
    const textFile = path.join(cwd, "poem.txt");
    const result = await validateFileSize(textFile, FileCategory.TEXT);

    expect(result.isValid).toBe(true);
    expect(result.actualSize).toBeGreaterThan(0);
    expect(result.maxSize).toBe(Infinity);
  });

  it("should allow large text files (tree-sitter handles them)", async () => {
    const largeFile = path.join(
      os.tmpdir(),
      `magenta-large-${process.pid}.txt`,
    );

    // Create a large file - should still be valid
    const content = "x".repeat(2 * 1024 * 1024); // 2MB
    await fs.writeFile(largeFile, content);

    const result = await validateFileSize(largeFile, FileCategory.TEXT);

    expect(result.isValid).toBe(true);
    expect(result.maxSize).toBe(Infinity);

    // Cleanup
    await fs.unlink(largeFile);
  });
});
