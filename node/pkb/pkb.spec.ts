import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { PKB } from "./pkb.ts";
import type { EmbeddingModel, Embedding } from "./embedding/types.ts";

class MockEmbeddingModel implements EmbeddingModel {
  modelName = "mock-embedding";

  async embedChunk(chunk: string): Promise<Embedding> {
    // Return a deterministic embedding based on chunk content
    return this.textToEmbedding(chunk);
  }

  async embedQuery(query: string): Promise<Embedding> {
    return this.textToEmbedding(query);
  }

  async embedChunks(chunks: string[]): Promise<Embedding[]> {
    return chunks.map((c) => this.textToEmbedding(c));
  }

  private textToEmbedding(text: string): Embedding {
    // Create a simple deterministic embedding from text
    // Just use character codes normalized
    const embedding = new Array(10).fill(0);
    for (let i = 0; i < text.length; i++) {
      embedding[i % 10] += text.charCodeAt(i) / 1000;
    }
    // Normalize
    const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    return embedding.map((v) => v / norm);
  }
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

  it("should update embeddings for new markdown files", async () => {
    const mdContent = "# Test Document\n\nThis is test content.";
    fs.writeFileSync(path.join(tempDir, "test.md"), mdContent);

    const result = await pkb.updateEmbeddings();

    expect(result.updated).toContain("test.md");
    expect(result.skipped).toHaveLength(0);

    // Check embed file was created
    const embedPath = path.join(tempDir, "test.embed");
    expect(fs.existsSync(embedPath)).toBe(true);

    const embedFile = JSON.parse(fs.readFileSync(embedPath, "utf-8"));
    expect(embedFile.file).toBe("test.md");
    expect(embedFile.chunks.length).toBeGreaterThan(0);
    expect(embedFile.chunks[0].embedding[mockModel.modelName]).toBeDefined();
  });

  it("should skip files that haven't changed", async () => {
    const mdContent = "# Test Document\n\nThis is test content.";
    fs.writeFileSync(path.join(tempDir, "test.md"), mdContent);

    // First run
    await pkb.updateEmbeddings();

    // Second run should skip
    const result = await pkb.updateEmbeddings();

    expect(result.updated).toHaveLength(0);
    expect(result.skipped).toContain("test.md");
  });

  it("should re-embed when file content changes", async () => {
    fs.writeFileSync(path.join(tempDir, "test.md"), "Original content");
    await pkb.updateEmbeddings();

    // Modify the file
    fs.writeFileSync(path.join(tempDir, "test.md"), "Modified content");

    const result = await pkb.updateEmbeddings();

    expect(result.updated).toContain("test.md");
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

    await pkb.updateEmbeddings();

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
