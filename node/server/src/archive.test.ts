import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { v7 as uuidv7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteArchivedThread,
  listArchivedThreadIds,
  readArchivedThreadLog,
  readThreadMeta,
  threadCreatedAt,
} from "./archive.ts";
import type { ThreadId } from "./chat-types.ts";
import { threadConversationLogPath, threadMetaPath } from "./utils/files.ts";

const TEST_BASE_DIR = path.join(os.tmpdir(), "magenta-test-archive");

async function makeThreadDir(threadId: ThreadId, meta?: object): Promise<void> {
  const dir = path.join(TEST_BASE_DIR, "threads", threadId);
  await fs.mkdir(dir, { recursive: true });
  if (meta) {
    await fs.writeFile(
      threadMetaPath(threadId, TEST_BASE_DIR),
      JSON.stringify(meta),
    );
  }
}

describe("archive", () => {
  afterEach(async () => {
    await fs.rm(TEST_BASE_DIR, { recursive: true, force: true });
  });

  it("lists valid uuidv7 dirs newest-first and ignores junk", async () => {
    const older = uuidv7() as ThreadId;
    await new Promise((r) => setTimeout(r, 5));
    const newer = uuidv7() as ThreadId;
    await makeThreadDir(older);
    await makeThreadDir(newer);
    await fs.mkdir(path.join(TEST_BASE_DIR, "threads", "not-a-uuid"), {
      recursive: true,
    });

    const ids = await listArchivedThreadIds(TEST_BASE_DIR);
    expect(ids).toEqual([newer, older]);
  });

  it("returns an empty list when the threads dir is missing", async () => {
    expect(await listArchivedThreadIds(TEST_BASE_DIR)).toEqual([]);
  });

  it("decodes the uuidv7 creation time", () => {
    const before = Date.now();
    const id = uuidv7() as ThreadId;
    const after = Date.now();
    const decoded = threadCreatedAt(id).getTime();
    expect(decoded).toBeGreaterThanOrEqual(before - 1);
    expect(decoded).toBeLessThanOrEqual(after + 1);
  });

  it("reads meta and tolerates a missing sidecar", async () => {
    const withMeta = uuidv7() as ThreadId;
    const withoutMeta = uuidv7() as ThreadId;
    await makeThreadDir(withMeta, { title: "Hello", threadType: "root" });
    await makeThreadDir(withoutMeta);

    expect(await readThreadMeta(withMeta, TEST_BASE_DIR)).toEqual({
      title: "Hello",
      threadType: "root",
    });
    expect(await readThreadMeta(withoutMeta, TEST_BASE_DIR)).toEqual({});
  });

  it("returns {} for a malformed sidecar", async () => {
    const id = uuidv7() as ThreadId;
    await makeThreadDir(id);
    await fs.writeFile(threadMetaPath(id, TEST_BASE_DIR), "not json");
    expect(await readThreadMeta(id, TEST_BASE_DIR)).toEqual({});
  });

  it("drops an invalid threadType but keeps a valid title", async () => {
    const id = uuidv7() as ThreadId;
    await makeThreadDir(id);
    await fs.writeFile(
      threadMetaPath(id, TEST_BASE_DIR),
      JSON.stringify({ title: "Hi", threadType: "bogus" }),
    );
    expect(await readThreadMeta(id, TEST_BASE_DIR)).toEqual({ title: "Hi" });
  });

  it("reads a thread log in order, skipping garbage and missing files", async () => {
    const id = uuidv7() as ThreadId;
    await makeThreadDir(id);
    const lines = [
      JSON.stringify({
        type: "thread_start",
        threadId: id,
        timestamp: "t0",
        threadType: "root",
      }),
      JSON.stringify({ type: "message", timestamp: "t1", message: { a: 1 } }),
      "this is not json",
      JSON.stringify({ type: "message", timestamp: "t2", message: { a: 2 } }),
      JSON.stringify({ type: "title", timestamp: "t3", title: "Hi" }),
      JSON.stringify({ type: "compaction", timestamp: "t4", chunkCount: 3 }),
      "",
    ];
    await fs.writeFile(
      threadConversationLogPath(id, TEST_BASE_DIR),
      lines.join("\n"),
    );

    const entries = await readArchivedThreadLog(id, TEST_BASE_DIR);
    expect(entries.map((e) => e.type)).toEqual([
      "thread_start",
      "message",
      "message",
      "title",
      "compaction",
    ]);

    const missing = uuidv7() as ThreadId;
    expect(await readArchivedThreadLog(missing, TEST_BASE_DIR)).toEqual([]);
  });

  it("deletes a thread directory", async () => {
    const id = uuidv7() as ThreadId;
    await makeThreadDir(id, { title: "x" });
    await deleteArchivedThread(id, TEST_BASE_DIR);
    expect(await listArchivedThreadIds(TEST_BASE_DIR)).toEqual([]);
  });
});
