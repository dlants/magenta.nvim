import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  MAGENTA_EMBEDDING_VERSION,
  type EmbeddingModel,
  type ChunkData,
} from "./embedding/types.ts";
import { chunkText } from "./chunker.ts";
import type { ContextGenerator } from "./context-generator.ts";
import {
  initDatabase,
  ensureVecTable,
  getVecTableName,
  type PKBDatabase,
} from "./db.ts";

export type SearchResult = {
  file: string;
  chunk: ChunkData;
  score: number;
};

export type IndexLogEntry = {
  file: string;
  chunkCount: number;
  timestamp: Date;
};

const MAX_INDEX_LOG_ENTRIES = 20;

function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("md5").update(content).digest("hex");
}

export class PKB {
  public indexLog: IndexLogEntry[] = [];
  private db: PKBDatabase;
  private vecTableInitialized = false;

  constructor(
    private pkbPath: string,
    private embeddingModel: EmbeddingModel,
    private contextGenerator?: ContextGenerator,
  ) {
    this.db = initDatabase(pkbPath);
  }

  close(): void {
    this.db.close();
  }

  private ensureVecTableInitialized(): void {
    if (this.vecTableInitialized) return;

    ensureVecTable(
      this.db,
      this.embeddingModel.modelName,
      this.embeddingModel.dimensions,
    );
    this.vecTableInitialized = true;
  }

  async updateEmbeddings(): Promise<{ updated: string[]; skipped: string[] }> {
    const updated: string[] = [];
    const skipped: string[] = [];

    this.ensureVecTableInitialized();

    const files = fs.readdirSync(this.pkbPath);
    const mdFiles = files.filter((f) => f.endsWith(".md"));

    const getFileRecord = this.db.prepare<
      [string],
      { id: number; mtime_ms: number; hash: string }
    >("SELECT id, mtime_ms, hash FROM files WHERE filename = ?");

    const insertFile = this.db.prepare<[string, number, string]>(
      "INSERT INTO files (filename, mtime_ms, hash) VALUES (?, ?, ?)",
    );

    const updateFileMtime = this.db.prepare<[number, number]>(
      "UPDATE files SET mtime_ms = ? WHERE id = ?",
    );

    const updateFileHash = this.db.prepare<[number, string, number]>(
      "UPDATE files SET mtime_ms = ?, hash = ? WHERE id = ?",
    );

    const deleteFileChunks = this.db.prepare<[number]>(
      "DELETE FROM chunks WHERE file_id = ?",
    );

    const vecTableName = getVecTableName(this.embeddingModel.modelName);
    const deleteVec = this.db.prepare(
      `DELETE FROM ${vecTableName} WHERE chunk_id IN (SELECT id FROM chunks WHERE file_id = ?)`,
    );

    for (const mdFile of mdFiles) {
      const mdPath = path.join(this.pkbPath, mdFile);
      const stat = fs.statSync(mdPath);
      const currentMtime = stat.mtimeMs;

      const existingFile = getFileRecord.get(mdFile);

      if (existingFile) {
        if (existingFile.mtime_ms === currentMtime) {
          skipped.push(mdFile);
          continue;
        }

        const currentHash = computeFileHash(mdPath);
        if (existingFile.hash === currentHash) {
          updateFileMtime.run(currentMtime, existingFile.id);
          skipped.push(mdFile);
          continue;
        }

        deleteVec.run(existingFile.id);
        deleteFileChunks.run(existingFile.id);
        updateFileHash.run(currentMtime, currentHash, existingFile.id);

        await this.embedFile(mdPath, mdFile, existingFile.id);
        updated.push(mdFile);
      } else {
        const currentHash = computeFileHash(mdPath);
        const result = insertFile.run(mdFile, currentMtime, currentHash);
        const fileId = Number(result.lastInsertRowid);

        await this.embedFile(mdPath, mdFile, fileId);
        updated.push(mdFile);
      }
    }

    return { updated, skipped };
  }

  private async embedFile(
    mdPath: string,
    mdFile: string,
    fileId: number,
  ): Promise<void> {
    const content = fs.readFileSync(mdPath, "utf-8");
    const chunks = chunkText(content);

    const contextualizedTexts: string[] = [];
    for (const chunk of chunks) {
      if (this.contextGenerator) {
        const context = await this.contextGenerator.generateContext(
          content,
          chunk.text,
        );
        contextualizedTexts.push(`${context}\n\n${chunk.text}`);
      } else {
        contextualizedTexts.push(chunk.text);
      }
    }

    const embeddings =
      await this.embeddingModel.embedChunks(contextualizedTexts);

    const vecTableName = getVecTableName(this.embeddingModel.modelName);
    const insertChunk = this.db.prepare(
      `INSERT INTO chunks (file_id, text, contextualized_text, start_line, start_col, end_line, end_col, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertVec = this.db.prepare(
      `INSERT INTO ${vecTableName} (chunk_id, embedding) VALUES (?, ?)`,
    );

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const result = insertChunk.run(
        fileId,
        chunk.text,
        contextualizedTexts[i],
        chunk.start.line,
        chunk.start.col,
        chunk.end.line,
        chunk.end.col,
        MAGENTA_EMBEDDING_VERSION,
      );
      const chunkId = Number(result.lastInsertRowid);
      insertVec.run(BigInt(chunkId), new Float32Array(embeddings[i]));
    }

    this.indexLog.push({
      file: mdFile,
      chunkCount: chunks.length,
      timestamp: new Date(),
    });

    if (this.indexLog.length > MAX_INDEX_LOG_ENTRIES) {
      this.indexLog = this.indexLog.slice(-MAX_INDEX_LOG_ENTRIES);
    }
  }

  async search(query: string, topK: number = 10): Promise<SearchResult[]> {
    this.ensureVecTableInitialized();

    const queryEmbedding = await this.embeddingModel.embedQuery(query);
    const vecTableName = getVecTableName(this.embeddingModel.modelName);

    const results = this.db
      .prepare<
        unknown[],
        {
          filename: string;
          text: string;
          contextualized_text: string;
          start_line: number;
          start_col: number;
          end_line: number;
          end_col: number;
          version: number;
          distance: number;
        }
      >(
        `SELECT
          f.filename,
          c.text,
          c.contextualized_text,
          c.start_line,
          c.start_col,
          c.end_line,
          c.end_col,
          c.version,
          v.distance
        FROM ${vecTableName} v
        JOIN chunks c ON c.id = v.chunk_id
        JOIN files f ON f.id = c.file_id
        WHERE v.embedding MATCH ? AND v.k = ?
        ORDER BY v.distance`,
      )
      .all(new Float32Array(queryEmbedding), topK);

    return results.map((row) => ({
      file: row.filename,
      chunk: {
        text: row.text,
        contextualizedText: row.contextualized_text,
        start: { line: row.start_line, col: row.start_col },
        end: { line: row.end_line, col: row.end_col },
        version: row.version,
      },
      score: 1 - row.distance,
    }));
  }
}
