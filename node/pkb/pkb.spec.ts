import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { PKB } from "./pkb.ts";
import type { EmbeddingModel, Embedding } from "./embedding/types.ts";

class MockEmbeddingModel implements EmbeddingModel {
  modelName = "mock-embedding";
  dimensions = 10;

  async embedChunk(chunk: string): Promise<Embedding> {
    return this.textToEmbedding(chunk);
  }

  async embedQuery(query: string): Promise<Embedding> {
    return this.textToEmbedding(query);
  }

  async embedChunks(chunks: string[]): Promise<Embedding[]> {
    return chunks.map((c) => this.textToEmbedding(c));
  }

  private textToEmbedding(text: string): Embedding {
    const embedding = new Array(10).fill(0);
    for (let i = 0; i < text.length; i++) {
      embedding[i % 10] += text.charCodeAt(i) / 1000;
    }
    const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    return embedding.map((v) => v / norm);
  }
}

async function scanAndProcessAll(pkb: PKB): Promise<{
  queued: string[];
  skipped: string[];
  processed: string[];
}> {
  const { queued, skipped } = pkb.scanForChanges();
  const processed: string[] = [];

  let result = await pkb.processNextInQueue();
  while (result.status === "processed") {
    processed.push(result.filename);
    result = await pkb.processNextInQueue();
  }

  return { queued, skipped, processed };
}

describe("PKB", () => {
  let tempDir: string;
  let pkb: PKB;
  let mockModel: MockEmbeddingModel;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pkb-test-"));
    // Initialize as git repo for hash-object to work
    const { execSync } = require("child_process");
    execSync("git init", { cwd: tempDir });

    mockModel = new MockEmbeddingModel();
    pkb = new PKB(tempDir, mockModel);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should index new markdown files", async () => {
    const mdContent = "# Test Document\n\nThis is test content.";
    fs.writeFileSync(path.join(tempDir, "test.md"), mdContent);

    const result = await scanAndProcessAll(pkb);

    expect(result.queued).toContain("test.md");
    expect(result.processed).toContain("test.md");
    expect(result.skipped).toHaveLength(0);

    const dbPath = path.join(tempDir, "pkb.db");
    expect(fs.existsSync(dbPath)).toBe(true);

    const searchResults = await pkb.search("test content", 5);
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults[0].file).toBe("test.md");
  });

  it("should skip files that haven't changed", async () => {
    const mdContent = "# Test Document\n\nThis is test content.";
    fs.writeFileSync(path.join(tempDir, "test.md"), mdContent);

    await scanAndProcessAll(pkb);

    const result = await scanAndProcessAll(pkb);

    expect(result.queued).toHaveLength(0);
    expect(result.skipped).toContain("test.md");
  });

  it("should re-embed when file content changes", async () => {
    fs.writeFileSync(path.join(tempDir, "test.md"), "Original content");
    await scanAndProcessAll(pkb);

    fs.writeFileSync(path.join(tempDir, "test.md"), "Modified content");

    const result = await scanAndProcessAll(pkb);

    expect(result.queued).toContain("test.md");
    expect(result.processed).toContain("test.md");
    expect(result.skipped).toHaveLength(0);
  });

  it("should search and return relevant chunks", async () => {
    fs.writeFileSync(
      path.join(tempDir, "doc1.md"),
      "# Apples\n\nApples are red fruits that grow on trees.",
    );
    fs.writeFileSync(
      path.join(tempDir, "doc2.md"),
      "# Oranges\n\nOranges are orange colored citrus fruits.",
    );

    await scanAndProcessAll(pkb);

    const results = await pkb.search("apple fruit", 5);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].file).toBeDefined();
    expect(results[0].chunk.text).toBeDefined();
  });

  it("should return empty results for empty PKB", async () => {
    const results = await pkb.search("anything", 5);
    expect(results).toHaveLength(0);
  });
});
