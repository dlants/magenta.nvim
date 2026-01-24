import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import * as path from "path";

export type PKBDatabase = ReturnType<typeof Database>;

export function initDatabase(pkbPath: string): PKBDatabase {
  const dbPath = path.join(pkbPath, "pkb.db");
  const db = new Database(dbPath);

  sqliteVec.load(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY,
      filename TEXT NOT NULL,
      model_name TEXT NOT NULL,
      embedding_version INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      hash TEXT NOT NULL,
      UNIQUE(filename, model_name, embedding_version)
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      contextualized_text TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      start_col INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      end_col INTEGER NOT NULL
    );
  `);

  db.pragma("foreign_keys = ON");

  return db;
}

export function ensureVecTable(
  db: PKBDatabase,
  modelName: string,
  embeddingVersion: number,
  dimensions: number,
): void {
  const tableName = getVecTableName(modelName, embeddingVersion);
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[${dimensions}])`,
  );
}

export function getVecTableName(modelName: string, embeddingVersion: number): string {
  const sanitized = modelName.replace(/[^a-zA-Z0-9_]/g, "_");
  return `vec_${sanitized}_v${embeddingVersion}`;
}
