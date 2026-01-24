import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type {
  EmbeddingModel,
  EmbedFile,
  ChunkData,
} from "./embedding/types.ts";
import { chunkText } from "./chunker.ts";

export type SearchResult = {
  file: string;
  chunk: ChunkData;
  score: number;
};

function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("md5").update(content).digest("hex");
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Vectors must have the same length");
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class PKB {
  constructor(
    private pkbPath: string,
    private embeddingModel: EmbeddingModel,
  ) {}

  private getEmbedFilePath(mdFile: string): string {
    const baseName = path.basename(mdFile, ".md");
    return path.join(this.pkbPath, `${baseName}.embed`);
  }

  private loadEmbedFile(embedPath: string): EmbedFile | undefined {
    if (!fs.existsSync(embedPath)) {
      return undefined;
    }
    const content = fs.readFileSync(embedPath, "utf-8");
    return JSON.parse(content) as EmbedFile;
  }

  private saveEmbedFile(embedPath: string, embedFile: EmbedFile): void {
    fs.writeFileSync(embedPath, JSON.stringify(embedFile, null, 2));
  }

  async updateEmbeddings(): Promise<{ updated: string[]; skipped: string[] }> {
    const updated: string[] = [];
    const skipped: string[] = [];

    const files = fs.readdirSync(this.pkbPath);
    const mdFiles = files.filter((f) => f.endsWith(".md"));

    for (const mdFile of mdFiles) {
      const mdPath = path.join(this.pkbPath, mdFile);
      const embedPath = this.getEmbedFilePath(mdFile);

      const currentHash = computeFileHash(mdPath);
      const existingEmbed = this.loadEmbedFile(embedPath);

      if (existingEmbed && existingEmbed.hash === currentHash) {
        // Check if we have embeddings for the current model
        const hasCurrentModelEmbedding = existingEmbed.chunks.every(
          (chunk) => chunk.embedding[this.embeddingModel.modelName],
        );

        if (hasCurrentModelEmbedding) {
          skipped.push(mdFile);
          continue;
        }
      }

      // Need to re-embed
      const content = fs.readFileSync(mdPath, "utf-8");
      const chunks = chunkText(content);

      const chunkTexts = chunks.map((c) => c.text);
      const embeddings = await this.embeddingModel.embedChunks(chunkTexts);

      const chunkData: ChunkData[] = chunks.map((chunk, i) => ({
        text: chunk.text,
        start: chunk.start,
        end: chunk.end,
        embedding: {
          [this.embeddingModel.modelName]: embeddings[i],
        },
      }));

      const embedFile: EmbedFile = {
        hash: currentHash,
        file: mdFile,
        chunks: chunkData,
      };

      this.saveEmbedFile(embedPath, embedFile);
      updated.push(mdFile);
    }

    return { updated, skipped };
  }

  async search(query: string, topK: number = 10): Promise<SearchResult[]> {
    const queryEmbedding = await this.embeddingModel.embedQuery(query);

    const allResults: SearchResult[] = [];

    const files = fs.readdirSync(this.pkbPath);
    const embedFiles = files.filter((f) => f.endsWith(".embed"));

    for (const embedFileName of embedFiles) {
      const embedPath = path.join(this.pkbPath, embedFileName);
      const embedFile = this.loadEmbedFile(embedPath);

      if (!embedFile) continue;

      for (const chunk of embedFile.chunks) {
        const chunkEmbedding = chunk.embedding[this.embeddingModel.modelName];
        if (!chunkEmbedding) continue;

        const score = cosineSimilarity(queryEmbedding, chunkEmbedding);
        allResults.push({
          file: embedFile.file,
          chunk,
          score,
        });
      }
    }

    // Sort by score descending and return top K
    allResults.sort((a, b) => b.score - a.score);
    return allResults.slice(0, topK);
  }
}
