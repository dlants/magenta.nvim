# context

The goal is to migrate the PKB (Personal Knowledge Base) from storing embeddings in `.embed` JSON files to using SQLite with the sqlite-vec extension for vector similarity search.

**Relevant files:**

- `node/pkb/pkb.ts`: Main PKB class with `updateEmbeddings()` and `search()` methods - **primary file to modify**
- `node/pkb/embedding/types.ts`: Defines `ChunkData`, `EmbedFile`, `EmbeddingModel`, `Position` types
- `node/pkb/chunker.ts`: Text chunking logic (unchanged)
- `node/pkb/create-pkb.ts`: Factory function for creating PKB instances
- `node/pkb/pkb.spec.ts`: Tests for PKB class
- `package.json`: Dependencies

**Key types:**

```typescript
type Position = { line: number; col: number };
type ChunkData = {
  text: string;
  contextualizedText: string;
  start: Position;
  end: Position;
  embedding: { [modelName: string]: number[] };
  version: number;
};
type EmbedFile = { hash: string; file: string; chunks: ChunkData[] };
type SearchResult = { file: string; chunk: ChunkData; score: number };
```

**Database schema design:**

```sql
-- Track source files with mtime for fast change detection and hash for content verification
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  filename TEXT UNIQUE NOT NULL,
  mtime_ms INTEGER NOT NULL,  -- file modification time in milliseconds
  hash TEXT NOT NULL          -- content hash for when mtime changes but content doesn't
);

-- Store chunks with their text and position info
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  contextualized_text TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  start_col INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_col INTEGER NOT NULL,
  version INTEGER NOT NULL
);

-- Virtual table for vector search (sqlite-vec)
CREATE VIRTUAL TABLE vec_chunks USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  model_name TEXT NOT NULL,
  embedding float[N]  -- N depends on model dimensions
);
```

# implementation

- [x] Install dependencies
  - [x] `npm install better-sqlite3 sqlite-vec`
  - [x] `npm install -D @types/better-sqlite3`

- [x] Create `node/pkb/db.ts` - database initialization module
  - [x] Function to initialize database with schema (file-based, NOT `:memory:`)
  - [x] Database file stored at `<pkbPath>/pkb.db`
  - [x] Handle sqlite-vec extension loading (see example below)
  - [x] Export typed database wrapper

**sqlite-vec usage example:**

```typescript
import * as sqliteVec from "sqlite-vec";
import Database from "better-sqlite3";

const db = new Database("/path/to/pkb.db");
sqliteVec.load(db);

const { vec_version } = db
  .prepare("select vec_version() as vec_version;")
  .get();

console.log(`vec_version=${vec_version}`);
```

```typescript
import * as sqliteVec from "sqlite-vec";
import Database from "better-sqlite3";

const db = new Database(":memory:");
sqliteVec.load(db);

const { sqlite_version, vec_version } = db
  .prepare(
    "select sqlite_version() as sqlite_version, vec_version() as vec_version;",
  )
  .get();

console.log(`sqlite_version=${sqlite_version}, vec_version=${vec_version}`);

const items = [
  [1, [0.1, 0.1, 0.1, 0.1]],
  [2, [0.2, 0.2, 0.2, 0.2]],
  [3, [0.3, 0.3, 0.3, 0.3]],
  [4, [0.4, 0.4, 0.4, 0.4]],
  [5, [0.5, 0.5, 0.5, 0.5]],
];
const query = [0.3, 0.3, 0.3, 0.3];

db.exec("CREATE VIRTUAL TABLE vec_items USING vec0(embedding float[4])");

const insertStmt = db.prepare(
  "INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)",
);

const insertVectors = db.transaction((items) => {
  for (const [id, vector] of items) {
    insertStmt.run(BigInt(id), new Float32Array(vector));
  }
});

insertVectors(items);

const rows = db
  .prepare(
    `
  SELECT
    rowid,
    distance
  FROM vec_items
  WHERE embedding MATCH ?
  ORDER BY distance
  LIMIT 3
`,
  )
  .all(new Float32Array(query));

console.log(rows);
```

- [x] Update `node/pkb/embedding/types.ts`
  - [x] Remove `EmbedFile` type (no longer needed)
  - [x] Keep `ChunkData` for the `SearchResult` return type (simplified - removed embedding field)
  - [x] Check for type errors and iterate

- [x] Modify `node/pkb/pkb.ts` - convert to SQLite storage
  - [x] Add database initialization in constructor
  - [x] Store db path as `pkb.db` in the pkb directory
  - [x] Rewrite `updateEmbeddings()`:
    - [x] Use `fs.statSync().mtimeMs` to get file modification time
    - [x] Query `files` table - if mtime matches, skip; if mtime differs, compute hash
    - [x] If hash also matches, just update mtime and skip re-embedding
    - [x] Delete old chunks when content changes (cascade from files table)
    - [x] Insert new chunks and embeddings in a transaction
  - [x] Rewrite `search()`:
    - [x] Use sqlite-vec's KNN search instead of manual cosine similarity
    - [x] Join back to chunks table to get text/position data
  - [x] Remove helper methods for `.embed` file I/O
  - [x] Check for type errors and iterate

- [x] Update tests in `node/pkb/pkb.spec.ts`
  - [x] Tests should still pass with same interface
  - [x] May need to adjust setup/teardown for database file
  - [x] Run tests and iterate until they pass

- [x] Clean up
  - [x] Remove dead code related to `.embed` file handling
  - [x] Update any references that depend on `EmbedFile` type
  - [x] Final type check with `npx tsc --noEmit`
