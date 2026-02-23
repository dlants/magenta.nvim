import { describe, expect, it } from "vitest";
import { Document } from "./document.ts";

describe("Document", () => {
  describe("constructor and basic getters", () => {
    it("stores content", () => {
      const doc = new Document("hello");
      expect(doc.content).toBe("hello");
    });

    it("counts lines for single line", () => {
      const doc = new Document("hello");
      expect(doc.lineCount).toBe(1);
    });

    it("counts lines for multiple lines", () => {
      const doc = new Document("a\nb\nc");
      expect(doc.lineCount).toBe(3);
    });

    it("counts trailing newline as extra line", () => {
      const doc = new Document("a\nb\n");
      expect(doc.lineCount).toBe(3);
    });

    it("handles empty content", () => {
      const doc = new Document("");
      expect(doc.lineCount).toBe(1);
      expect(doc.content).toBe("");
    });
  });

  describe("posToOffset", () => {
    it("converts first position", () => {
      const doc = new Document("hello\nworld");
      expect(doc.posToOffset({ line: 1, col: 0 })).toBe(0);
    });

    it("converts position within first line", () => {
      const doc = new Document("hello\nworld");
      expect(doc.posToOffset({ line: 1, col: 3 })).toBe(3);
    });

    it("converts position on second line", () => {
      const doc = new Document("hello\nworld");
      expect(doc.posToOffset({ line: 2, col: 0 })).toBe(6);
    });

    it("converts position within second line", () => {
      const doc = new Document("hello\nworld");
      expect(doc.posToOffset({ line: 2, col: 2 })).toBe(8);
    });

    it("throws for line 0", () => {
      const doc = new Document("hello");
      expect(() => doc.posToOffset({ line: 0, col: 0 })).toThrow(
        "out of range",
      );
    });

    it("throws for line beyond end", () => {
      const doc = new Document("hello");
      expect(() => doc.posToOffset({ line: 2, col: 0 })).toThrow(
        "out of range",
      );
    });
  });

  describe("offsetToPos", () => {
    it("converts offset 0", () => {
      const doc = new Document("hello\nworld");
      expect(doc.offsetToPos(0)).toEqual({ line: 1, col: 0 });
    });

    it("converts offset within first line", () => {
      const doc = new Document("hello\nworld");
      expect(doc.offsetToPos(3)).toEqual({ line: 1, col: 3 });
    });

    it("converts offset at start of second line", () => {
      const doc = new Document("hello\nworld");
      expect(doc.offsetToPos(6)).toEqual({ line: 2, col: 0 });
    });

    it("converts offset within second line", () => {
      const doc = new Document("hello\nworld");
      expect(doc.offsetToPos(8)).toEqual({ line: 2, col: 2 });
    });

    it("roundtrips with posToOffset", () => {
      const doc = new Document("line one\nline two\nline three");
      const pos = { line: 3, col: 4 };
      const offset = doc.posToOffset(pos);
      expect(doc.offsetToPos(offset)).toEqual(pos);
    });
  });

  describe("lineRange", () => {
    it("returns range for first line", () => {
      const doc = new Document("hello\nworld");
      const range = doc.lineRange(1);
      expect(doc.getText(range)).toBe("hello");
    });

    it("returns range for last line without trailing newline", () => {
      const doc = new Document("hello\nworld");
      const range = doc.lineRange(2);
      expect(doc.getText(range)).toBe("world");
    });

    it("returns range for middle line", () => {
      const doc = new Document("aaa\nbbb\nccc");
      const range = doc.lineRange(2);
      expect(doc.getText(range)).toBe("bbb");
    });

    it("throws for line out of range", () => {
      const doc = new Document("hello");
      expect(() => doc.lineRange(0)).toThrow("out of range");
      expect(() => doc.lineRange(2)).toThrow("out of range");
    });
  });

  describe("fullRange", () => {
    it("covers entire content", () => {
      const doc = new Document("hello\nworld");
      const range = doc.fullRange();
      expect(range).toEqual({ start: 0, end: 11 });
      expect(doc.getText(range)).toBe("hello\nworld");
    });

    it("works for empty content", () => {
      const doc = new Document("");
      const range = doc.fullRange();
      expect(range).toEqual({ start: 0, end: 0 });
      expect(doc.getText(range)).toBe("");
    });
  });

  describe("getText", () => {
    it("extracts a substring", () => {
      const doc = new Document("hello world");
      expect(doc.getText({ start: 6, end: 11 })).toBe("world");
    });

    it("returns empty for zero-width range", () => {
      const doc = new Document("hello");
      expect(doc.getText({ start: 3, end: 3 })).toBe("");
    });
  });

  describe("splice", () => {
    it("replaces text in the middle", () => {
      const doc = new Document("hello world");
      doc.splice({ start: 5, end: 11 }, " there");
      expect(doc.content).toBe("hello there");
    });

    it("inserts text (zero-width range)", () => {
      const doc = new Document("helloworld");
      doc.splice({ start: 5, end: 5 }, " ");
      expect(doc.content).toBe("hello world");
    });

    it("deletes text (empty replacement)", () => {
      const doc = new Document("hello world");
      doc.splice({ start: 5, end: 6 }, "");
      expect(doc.content).toBe("helloworld");
    });

    it("updates line count after adding lines", () => {
      const doc = new Document("hello");
      expect(doc.lineCount).toBe(1);
      doc.splice({ start: 5, end: 5 }, "\nworld");
      expect(doc.lineCount).toBe(2);
      expect(doc.content).toBe("hello\nworld");
    });

    it("updates line count after removing lines", () => {
      const doc = new Document("a\nb\nc");
      expect(doc.lineCount).toBe(3);
      doc.splice({ start: 1, end: 3 }, "");
      expect(doc.content).toBe("a\nc");
      expect(doc.lineCount).toBe(2);
    });

    it("keeps posToOffset consistent after splice", () => {
      const doc = new Document("aaa\nbbb\nccc");
      doc.splice({ start: 4, end: 7 }, "XX");
      expect(doc.content).toBe("aaa\nXX\nccc");
      expect(doc.posToOffset({ line: 3, col: 0 })).toBe(7);
    });
  });
});
