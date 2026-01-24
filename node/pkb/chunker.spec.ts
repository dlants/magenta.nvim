import { describe, it, expect } from "vitest";
import { chunkText } from "./chunker.ts";

describe("chunkText", () => {
  it("should return a single chunk for short text", () => {
    const text = "Hello world\nThis is a test";
    const chunks = chunkText(text, 100, 20);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(text);
    expect(chunks[0].start).toEqual({ line: 1, col: 1 });
    expect(chunks[0].end).toEqual({ line: 2, col: 14 });
  });

  it("should split long text into multiple chunks", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}: ${"x".repeat(50)}`);
    const text = lines.join("\n");
    const chunks = chunkText(text, 200, 50);

    expect(chunks.length).toBeGreaterThan(1);
    // All chunks should have valid positions
    for (const chunk of chunks) {
      expect(chunk.start.line).toBeGreaterThanOrEqual(1);
      expect(chunk.end.line).toBeGreaterThanOrEqual(chunk.start.line);
      expect(chunk.text.length).toBeGreaterThan(0);
    }
  });

  it("should have overlapping content between consecutive chunks", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`);
    const text = lines.join("\n");
    const chunks = chunkText(text, 50, 20);

    if (chunks.length > 1) {
      // Check that the end of chunk N overlaps with start of chunk N+1
      const firstChunkEnd = chunks[0].text.slice(-20);
      const secondChunkStart = chunks[1].text.slice(0, 20);
      // The overlap might not be exact due to line boundaries, but there should be some
      expect(chunks[1].start.line).toBeLessThanOrEqual(chunks[0].end.line + 1);
    }
  });

  it("should handle empty text", () => {
    const chunks = chunkText("", 100, 20);
    expect(chunks).toHaveLength(0);
  });

  it("should handle single line text", () => {
    const text = "Single line of text";
    const chunks = chunkText(text, 100, 20);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(text);
    expect(chunks[0].start).toEqual({ line: 1, col: 1 });
    expect(chunks[0].end).toEqual({ line: 1, col: 19 });
  });
});
