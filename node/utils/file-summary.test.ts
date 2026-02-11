import { describe, it, expect } from "vitest";
import {
  tokenize,
  buildFrequencyTable,
  chunkFile,
  computeScopeSize,
  scoreChunk,
  selectChunks,
  summarizeFile,
  formatSummary,
} from "./file-summary.ts";
import type { Chunk } from "./file-summary.ts";

describe("tokenize", () => {
  it("returns empty array for empty string", () => {
    expect(tokenize("")).toEqual([]);
  });

  it("returns empty array for punctuation-only string", () => {
    expect(tokenize("!@#$%^&*()")).toEqual([]);
  });

  it("extracts alphanumeric tokens including underscores", () => {
    expect(tokenize("hello world")).toEqual(["hello", "world"]);
    expect(tokenize("foo_bar123")).toEqual(["foo_bar123"]);
    expect(tokenize("const x = 42;")).toEqual(["const", "x", "42"]);
  });

  it("handles unicode: extracts only ASCII alphanumeric tokens", () => {
    expect(tokenize("café résumé")).toEqual(["caf", "r", "sum"]);
    expect(tokenize("变量name = 值")).toEqual(["name"]);
  });

  it("handles mixed punctuation and words", () => {
    expect(tokenize("a.b.c(d, e)")).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("buildFrequencyTable", () => {
  it("counts token occurrences", () => {
    const freq = buildFrequencyTable(["a", "b", "a", "c", "a"]);
    expect(freq.get("a")).toBe(3);
    expect(freq.get("b")).toBe(1);
    expect(freq.get("c")).toBe(1);
  });

  it("returns empty map for empty input", () => {
    expect(buildFrequencyTable([]).size).toBe(0);
  });
});

describe("chunkFile", () => {
  it("creates one chunk per line for normal multi-line files", () => {
    const content = "line one\nline two\nline three";
    const chunks = chunkFile(content);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({
      text: "line one",
      line: 1,
      col: 0,
      tokens: buildFrequencyTable(["line", "one"]),
    });
    expect(chunks[1]).toEqual({
      text: "line two",
      line: 2,
      col: 0,
      tokens: buildFrequencyTable(["line", "two"]),
    });
    expect(chunks[2]).toEqual({
      text: "line three",
      line: 3,
      col: 0,
      tokens: buildFrequencyTable(["line", "three"]),
    });
  });

  it("splits long lines into sub-chunks at word boundaries", () => {
    // Create a line longer than 200 chars with spaces roughly every 10 chars
    const words = [];
    for (let i = 0; i < 30; i++) {
      words.push("abcdefgh");
    }
    const longLine = words.join(" "); // 30*8 + 29 spaces = 269 chars
    expect(longLine.length).toBeGreaterThan(200);

    const chunks = chunkFile(longLine);
    expect(chunks.length).toBeGreaterThan(1);

    // All chunks should reference line 1
    for (const chunk of chunks) {
      expect(chunk.line).toBe(1);
    }

    // First chunk should start at col 0
    expect(chunks[0].col).toBe(0);

    // Subsequent chunks should have col > 0
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].col).toBeGreaterThan(0);
    }

    // Concatenating all chunk texts should reconstruct the original line
    const reconstructed = chunks.map((c) => c.text).join("");
    expect(reconstructed).toBe(longLine);
  });

  it("handles lines exactly at the 200-char boundary", () => {
    const line = "a".repeat(200);
    const chunks = chunkFile(line);
    // 200 chars <= MAX_CHUNK_CHARS (200), so one chunk
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(line);
  });

  it("handles lines just over 200 chars", () => {
    const line = "a ".repeat(101); // 202 chars with trailing space
    const chunks = chunkFile(line.trimEnd()); // 201 chars
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("handles empty content", () => {
    const chunks = chunkFile("");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({
      text: "",
      line: 1,
      col: 0,
      tokens: buildFrequencyTable([]),
    });
  });
});

describe("computeScopeSize", () => {
  it("counts indented lines below the target", () => {
    const lines = [
      "function foo() {",
      "  const x = 1;",
      "  const y = 2;",
      "  return x + y;",
      "}",
    ];
    // Line 0 ("function foo() {") has indent 0
    // Lines 1-3 have indent 2 (deeper), line 4 has indent 0 (same level -> stop)
    expect(computeScopeSize(lines, 0)).toBe(3);
  });

  it("returns 0 for leaf statements (no deeper indentation follows)", () => {
    const lines = ["  const x = 1;", "  const y = 2;"];
    // Line 0 has indent 2, line 1 has indent 2 (same level -> stop)
    expect(computeScopeSize(lines, 0)).toBe(0);
  });

  it("skips blank lines when counting scope", () => {
    const lines = [
      "class Foo {",
      "  method() {",
      "",
      "    return 1;",
      "  }",
      "}",
    ];
    // Line 0 ("class Foo {") has indent 0
    // Line 1 indent 2 (deeper), line 2 blank (skip), line 3 indent 4 (deeper),
    // line 4 indent 2 (deeper), line 5 indent 0 (same -> stop)
    expect(computeScopeSize(lines, 0)).toBe(3);
  });

  it("handles flat imports (no deeper indentation)", () => {
    const lines = [
      "import { a } from 'a';",
      "import { b } from 'b';",
      "import { c } from 'c';",
    ];
    // All at indent 0, so scope size of any line is 0
    expect(computeScopeSize(lines, 0)).toBe(0);
    expect(computeScopeSize(lines, 1)).toBe(0);
  });

  it("handles last line of file", () => {
    const lines = ["only line"];
    expect(computeScopeSize(lines, 0)).toBe(0);
  });
});

describe("scoreChunk", () => {
  it("returns 0 for chunks with no tokens", () => {
    const chunk: Chunk = {
      text: "",
      line: 1,
      col: 0,
      tokens: buildFrequencyTable([]),
    };
    const freq = new Map<string, number>();
    expect(scoreChunk(chunk, freq, 10, 0, new Set())).toBe(0);
  });

  it("scope headers outscore leaf statements", () => {
    // A "header" chunk at indent 0 with large scope
    const headerChunk: Chunk = {
      text: "function processData() {",
      line: 1,
      col: 0,
      tokens: buildFrequencyTable(["function", "processData"]),
    };
    // A "leaf" chunk at indent 4 with no scope
    const leafChunk: Chunk = {
      text: "    return result;",
      line: 5,
      col: 0,
      tokens: buildFrequencyTable(["return", "result"]),
    };

    const freq = buildFrequencyTable([
      "function",
      "processData",
      "return",
      "result",
      "const",
      "x",
      "const",
      "y",
    ]);
    const totalTokens = 8;
    const seenTokens = new Set<string>();

    const headerScore = scoreChunk(
      headerChunk,
      freq,
      totalTokens,
      10,
      seenTokens,
    );
    const leafScore = scoreChunk(leafChunk, freq, totalTokens, 0, seenTokens);

    expect(headerScore).toBeGreaterThan(leafScore);
  });

  it("top-level items outscore deeply-indented ones with same tokens", () => {
    const tokens = ["return", "value"];
    const freq = buildFrequencyTable(tokens);

    const topLevel: Chunk = {
      text: "return value;",
      line: 1,
      col: 0,
      tokens: buildFrequencyTable(tokens),
    };
    const indented: Chunk = {
      text: "        return value;",
      line: 5,
      col: 0,
      tokens: buildFrequencyTable(tokens),
    };

    const seenTokens = new Set<string>();
    const topScore = scoreChunk(topLevel, freq, 2, 0, seenTokens);
    // Reset seen tokens so both get same first-occurrence bonus
    const seenTokens2 = new Set<string>();
    const indentedScore = scoreChunk(indented, freq, 2, 0, seenTokens2);

    // indentWeight for topLevel: 1/(1+0) = 1
    // indentWeight for indented: 1/(1+8) = 1/9
    expect(topScore).toBeGreaterThan(indentedScore);
  });

  it("first-occurrence bonus increases score", () => {
    const chunk: Chunk = {
      text: "unique_token",
      line: 1,
      col: 0,
      tokens: buildFrequencyTable(["unique_token"]),
    };
    const freq = new Map([["unique_token", 1]]);

    const withBonus = scoreChunk(chunk, freq, 10, 0, new Set());
    const withoutBonus = scoreChunk(
      chunk,
      freq,
      10,
      0,
      new Set(["unique_token"]),
    );

    // First occurrence gets 2x multiplier on self-information
    expect(withBonus).toBeGreaterThan(withoutBonus);
    // Specifically, with 1 token, the ratio should be exactly 2
    expect(withBonus / withoutBonus).toBeCloseTo(2);
  });
});

describe("selectChunks", () => {
  it("always includes the first chunk", () => {
    const chunks: Chunk[] = [
      {
        text: "first",
        line: 1,
        col: 0,
        tokens: buildFrequencyTable(["first"]),
      },
      {
        text: "second",
        line: 2,
        col: 0,
        tokens: buildFrequencyTable(["second"]),
      },
    ];
    const scores = [0, 100]; // first chunk has lowest score
    const selected = selectChunks(chunks, scores, 100);
    expect(selected.map((c) => c.text)).toContain("first");
  });

  it("selects by score descending within budget", () => {
    const chunks: Chunk[] = [
      { text: "aaaa", line: 1, col: 0, tokens: buildFrequencyTable(["aaaa"]) }, // 4 chars
      { text: "bb", line: 2, col: 0, tokens: buildFrequencyTable(["bb"]) }, // 2 chars
      {
        text: "cccccc",
        line: 3,
        col: 0,
        tokens: buildFrequencyTable(["cccccc"]),
      }, // 6 chars
      { text: "dd", line: 4, col: 0, tokens: buildFrequencyTable(["dd"]) }, // 2 chars
    ];
    const scores = [1, 10, 5, 20]; // dd > bb > cccccc > aaaa

    // Budget = 10: first chunk "aaaa" (4) + "dd" (2) + "bb" (2) + attempt "cccccc" (6) would be 14 > 10, skip
    const selected = selectChunks(chunks, scores, 10);
    expect(selected.map((c) => c.text)).toEqual(["aaaa", "bb", "dd"]);
  });

  it("returns chunks in file order", () => {
    const chunks: Chunk[] = [
      { text: "a", line: 1, col: 0, tokens: buildFrequencyTable(["a"]) },
      { text: "b", line: 2, col: 0, tokens: buildFrequencyTable(["b"]) },
      { text: "c", line: 3, col: 0, tokens: buildFrequencyTable(["c"]) },
    ];
    const scores = [1, 100, 50];
    const selected = selectChunks(chunks, scores, 1000);
    // Should be in file order: a, b, c
    expect(selected.map((c) => c.line)).toEqual([1, 2, 3]);
  });

  it("returns empty for empty input", () => {
    expect(selectChunks([], [], 1000)).toEqual([]);
  });

  it("respects budget strictly", () => {
    const chunks: Chunk[] = [
      {
        text: "hello",
        line: 1,
        col: 0,
        tokens: buildFrequencyTable(["hello"]),
      }, // 5 chars
      {
        text: "world",
        line: 2,
        col: 0,
        tokens: buildFrequencyTable(["world"]),
      }, // 5 chars
    ];
    const scores = [1, 100];
    // Budget of 5: first chunk "hello" (5) fills budget, "world" (5) would exceed
    const selected = selectChunks(chunks, scores, 5);
    expect(selected).toHaveLength(1);
    expect(selected[0].text).toBe("hello");
  });
});

describe("summarizeFile", () => {
  it("returns all chunks when content fits within budget", () => {
    const content = "line one\nline two\nline three";
    const summary = summarizeFile(content, { charBudget: 10000 });
    expect(summary.totalLines).toBe(3);
    expect(summary.totalChars).toBe(content.length);
    expect(summary.selectedChunks).toHaveLength(3);
  });

  it("returns empty selectedChunks for empty content", () => {
    // empty string splits to [""] which is 1 chunk, and totalChars=0 <= budget
    const summary = summarizeFile("");
    expect(summary.totalLines).toBe(1);
    expect(summary.totalChars).toBe(0);
    // chunkFile("") returns one chunk with empty text
    expect(summary.selectedChunks).toHaveLength(1);
  });

  it("selects subset when content exceeds budget", () => {
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`line ${i}: some content here that is moderately long`);
    }
    const content = lines.join("\n");
    const budget = Math.floor(content.length * 0.3);
    const summary = summarizeFile(content, { charBudget: budget });

    expect(summary.totalLines).toBe(100);
    expect(summary.selectedChunks.length).toBeLessThan(100);
    expect(summary.selectedChunks.length).toBeGreaterThan(0);

    // First chunk should always be included
    expect(summary.selectedChunks[0].line).toBe(1);

    // Total selected chars should be within budget
    const totalSelectedChars = summary.selectedChunks.reduce(
      (sum, c) => sum + c.text.length,
      0,
    );
    expect(totalSelectedChars).toBeLessThanOrEqual(budget);
  });

  describe("realistic TypeScript file", () => {
    const tsContent = `import { readFile, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { Logger } from "./logger";
import { Config } from "./config";

export interface ProcessOptions {
  verbose: boolean;
  outputDir: string;
  maxRetries: number;
}

export class DataProcessor {
  private logger: Logger;
  private config: Config;
  private cache: Map<string, string>;

  constructor(config: Config) {
    this.config = config;
    this.logger = new Logger(config.logLevel);
    this.cache = new Map();
  }

  async processFile(filePath: string): Promise<string> {
    const cached = this.cache.get(filePath);
    if (cached) {
      this.logger.debug("Cache hit for " + filePath);
      return cached;
    }
    const content = await readFile(filePath, "utf-8");
    const result = this.transform(content);
    this.cache.set(filePath, result);
    return result;
  }

  private transform(content: string): string {
    const lines = content.split("\\n");
    const filtered = lines.filter((line) => line.trim().length > 0);
    const mapped = filtered.map((line) => line.toUpperCase());
    return mapped.join("\\n");
  }

  async batchProcess(files: string[]): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    for (const file of files) {
      const result = await this.processFile(file);
      results.set(file, result);
    }
    this.logger.info("Processed " + files.length + " files");
    return results;
  }
}

export function createProcessor(configPath: string): DataProcessor {
  const config = new Config(configPath);
  return new DataProcessor(config);
}

export async function processAll(dir: string, options: ProcessOptions): Promise<void> {
  const processor = createProcessor(join(dir, "config.json"));
  const files = await readDir(dir);
  await processor.batchProcess(files);
  if (options.verbose) {
    console.log("Done processing", dir);
  }
}`;

    it("selects class/function headers over body statements with tight budget", () => {
      const budget = Math.floor(tsContent.length * 0.3);
      const summary = summarizeFile(tsContent, { charBudget: budget });

      const selectedText = summary.selectedChunks.map((c) => c.text).join("\n");

      // Structural elements should be selected:
      // class declaration should appear
      expect(selectedText).toContain("export class DataProcessor");

      // Some method signatures should appear
      const hasMethodSignature =
        selectedText.includes("processFile") ||
        selectedText.includes("transform") ||
        selectedText.includes("batchProcess");
      expect(hasMethodSignature).toBe(true);

      // The standalone function declarations should be represented
      const hasFunctionDecl =
        selectedText.includes("createProcessor") ||
        selectedText.includes("processAll");
      expect(hasFunctionDecl).toBe(true);
    });

    it("includes first chunk (first import line)", () => {
      const budget = Math.floor(tsContent.length * 0.3);
      const summary = summarizeFile(tsContent, { charBudget: budget });

      expect(summary.selectedChunks[0].line).toBe(1);
      expect(summary.selectedChunks[0].text).toContain("import");
    });
  });

  describe("log-like file", () => {
    it("selects some lines from flat log entries", () => {
      const logLines = [];
      for (let i = 0; i < 20; i++) {
        const ts = `2024-01-${String(i + 1).padStart(2, "0")}T10:00:00Z`;
        logLines.push(
          `${ts} INFO processed request_${i} status=200 duration=${i * 10}ms`,
        );
      }
      const content = logLines.join("\n");

      // Set budget to ~40% of content
      const budget = Math.floor(content.length * 0.4);
      const summary = summarizeFile(content, { charBudget: budget });

      expect(summary.selectedChunks.length).toBeGreaterThan(0);
      expect(summary.selectedChunks.length).toBeLessThan(20);

      // First chunk always included
      expect(summary.selectedChunks[0].line).toBe(1);

      // All selected chunks should be valid log lines
      for (const chunk of summary.selectedChunks) {
        expect(chunk.text).toMatch(/^\d{4}-\d{2}-\d{2}/);
      }
    });
  });
});

describe("formatSummary", () => {
  it("formats empty file", () => {
    const result = formatSummary({
      totalLines: 0,
      totalChars: 0,
      selectedChunks: [],
    });
    expect(result).toBe("[File summary: 0 lines, 0 chars (empty)]");
  });

  it("includes header with line and char counts", () => {
    const result = formatSummary({
      totalLines: 100,
      totalChars: 5000,
      selectedChunks: [
        {
          text: "first line",
          line: 1,
          col: 0,
          tokens: buildFrequencyTable(["first", "line"]),
        },
      ],
    });
    expect(result).toContain(
      "[File summary: 100 lines, 5000 chars. Showing 1 key segments]",
    );
  });

  it("shows gap summaries between non-adjacent chunks", () => {
    const result = formatSummary({
      totalLines: 20,
      totalChars: 500,
      selectedChunks: [
        {
          text: "line one",
          line: 1,
          col: 0,
          tokens: buildFrequencyTable(["line", "one"]),
        },
        {
          text: "line ten",
          line: 10,
          col: 0,
          tokens: buildFrequencyTable(["line", "ten"]),
        },
      ],
    });
    expect(result).toContain("... (8 lines omitted) ...");
  });

  it("shows trailing gap", () => {
    const result = formatSummary({
      totalLines: 50,
      totalChars: 1000,
      selectedChunks: [
        {
          text: "first",
          line: 1,
          col: 0,
          tokens: buildFrequencyTable(["first"]),
        },
      ],
    });
    expect(result).toContain("... (49 lines omitted) ...");
  });

  it("formats line numbers with padding", () => {
    const result = formatSummary({
      totalLines: 1000,
      totalChars: 50000,
      selectedChunks: [
        {
          text: "start",
          line: 1,
          col: 0,
          tokens: buildFrequencyTable(["start"]),
        },
        {
          text: "middle",
          line: 500,
          col: 0,
          tokens: buildFrequencyTable(["middle"]),
        },
      ],
    });
    // totalLines=1000 -> lineNumWidth = 4
    expect(result).toContain("   1| start");
    expect(result).toContain(" 500| middle");
  });

  it("includes col marker for sub-chunks", () => {
    const result = formatSummary({
      totalLines: 10,
      totalChars: 500,
      selectedChunks: [
        {
          text: "start of long line",
          line: 1,
          col: 0,
          tokens: buildFrequencyTable(["start", "of", "long", "line"]),
        },
        {
          text: "continuation",
          line: 1,
          col: 100,
          tokens: buildFrequencyTable(["continuation"]),
        },
      ],
    });
    // col 0 -> no col marker
    expect(result).toContain(" 1| start of long line");
    // col 100 -> col marker
    expect(result).toContain(" 1:100| continuation");
  });

  it("no gap between consecutive lines", () => {
    const result = formatSummary({
      totalLines: 3,
      totalChars: 30,
      selectedChunks: [
        {
          text: "line one",
          line: 1,
          col: 0,
          tokens: buildFrequencyTable(["line", "one"]),
        },
        {
          text: "line two",
          line: 2,
          col: 0,
          tokens: buildFrequencyTable(["line", "two"]),
        },
        {
          text: "line three",
          line: 3,
          col: 0,
          tokens: buildFrequencyTable(["line", "three"]),
        },
      ],
    });
    expect(result).not.toContain("omitted");
  });
});
