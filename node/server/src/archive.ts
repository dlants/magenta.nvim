import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isThreadId, type ThreadId, type ThreadType } from "./chat-types.ts";
import type { ThreadLogEntry } from "./thread-logger.ts";
import {
  MAGENTA_TEMP_DIR,
  threadConversationLogPath,
  threadMetaPath,
} from "./utils/files.ts";

const THREAD_TYPES: ReadonlySet<ThreadType> = new Set([
  "subagent",
  "compact",
  "root",
  "docker_root",
]);

function isThreadType(value: unknown): value is ThreadType {
  return typeof value === "string" && THREAD_TYPES.has(value as ThreadType);
}

function threadsDir(baseDir: string): string {
  return path.join(baseDir, "threads");
}

/**
 * Decode the creation time of a uuidv7 thread id. The first 48 bits of a
 * uuidv7 encode the milliseconds-since-epoch creation time, so this needs no
 * file I/O.
 */
export function threadCreatedAt(threadId: ThreadId): Date {
  const hex = threadId.replace(/-/g, "").slice(0, 12);
  return new Date(parseInt(hex, 16));
}

/**
 * List archived thread ids, newest-first. Only reads the directory listing
 * (never file contents): names that parse as uuidv7 are kept and sorted
 * descending, which — because uuidv7 is time-ordered — yields most-recent
 * first.
 */
export async function listArchivedThreadIds(
  baseDir: string = MAGENTA_TEMP_DIR,
): Promise<ThreadId[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(threadsDir(baseDir));
  } catch {
    return [];
  }
  return entries.filter(isThreadId).sort().reverse();
}

/**
 * Read a thread's `meta.json` sidecar. Best-effort: a missing or malformed
 * sidecar resolves to `{}` rather than throwing.
 */
export type ThreadMeta = {
  title?: string;
  threadType?: ThreadType;
  scriptName?: string;
  cwd?: string;
};

export type ArchiveEntry = {
  id: ThreadId;
  title?: string;
  scriptName?: string;
  cwd?: string;
};

/** Threads that are worth showing in the archive list. Subagent threads are
 * archived too (their logs are useful for debugging) but they'd swamp the list,
 * so only top-level threads and script-spawned threads are listed. */
function isListable(meta: ThreadMeta): boolean {
  if (meta.scriptName !== undefined) return true;
  return meta.threadType === "root" || meta.threadType === "docker_root";
}

const META_READ_CONCURRENCY = 64;

/**
 * List the archived threads worth displaying, newest-first, reading each
 * thread's `meta.json` to classify it. Threads with no sidecar are legacy or
 * partial writes and are skipped.
 */
export async function listArchivedThreads(
  baseDir: string = MAGENTA_TEMP_DIR,
): Promise<ArchiveEntry[]> {
  const ids = await listArchivedThreadIds(baseDir);
  const entries: ArchiveEntry[] = [];
  for (let i = 0; i < ids.length; i += META_READ_CONCURRENCY) {
    const chunk = ids.slice(i, i + META_READ_CONCURRENCY);
    const metas = await Promise.all(
      chunk.map((id) => readThreadMeta(id, baseDir)),
    );
    for (let j = 0; j < chunk.length; j++) {
      const meta = metas[j];
      if (!isListable(meta)) continue;
      entries.push({
        id: chunk[j],
        ...(meta.title !== undefined ? { title: meta.title } : {}),
        ...(meta.scriptName !== undefined
          ? { scriptName: meta.scriptName }
          : {}),
        ...(meta.cwd !== undefined ? { cwd: meta.cwd } : {}),
      });
    }
  }
  return entries;
}

export async function readThreadMeta(
  threadId: ThreadId,
  baseDir: string = MAGENTA_TEMP_DIR,
): Promise<ThreadMeta> {
  try {
    const contents = await fs.readFile(
      threadMetaPath(threadId, baseDir),
      "utf8",
    );
    const parsed = JSON.parse(contents) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    const result: ThreadMeta = {};
    if (typeof record.title === "string") result.title = record.title;
    if (typeof record.scriptName === "string")
      result.scriptName = record.scriptName;
    if (typeof record.cwd === "string") result.cwd = record.cwd;
    if (isThreadType(record.threadType)) result.threadType = record.threadType;
    return result;
  } catch {
    return {};
  }
}

const THREAD_LOG_ENTRY_TYPES: ReadonlySet<ThreadLogEntry["type"]> = new Set([
  "thread_start",
  "fork",
  "message",
  "compaction",
  "restart",
  "title",
]);

function isThreadLogEntry(value: unknown): value is ThreadLogEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string" &&
    THREAD_LOG_ENTRY_TYPES.has(
      (value as { type: string }).type as ThreadLogEntry["type"],
    )
  );
}

/**
 * Read and parse a thread's `conversation.jsonl` log into an ordered array of
 * `ThreadLogEntry`. Best-effort: a missing file resolves to `[]`, and any
 * individual line that fails to parse is skipped rather than throwing.
 */
export async function readArchivedThreadLog(
  threadId: ThreadId,
  baseDir: string = MAGENTA_TEMP_DIR,
): Promise<ThreadLogEntry[]> {
  let contents: string;
  try {
    contents = await fs.readFile(
      threadConversationLogPath(threadId, baseDir),
      "utf8",
    );
  } catch {
    return [];
  }
  const entries: ThreadLogEntry[] = [];
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // skip malformed lines
      continue;
    }
    if (isThreadLogEntry(parsed)) {
      entries.push(parsed);
    }
  }
  return entries;
}

/**
 * Delete a single thread's archive directory (recursively).
 */
export async function deleteArchivedThread(
  threadId: ThreadId,
  baseDir: string = MAGENTA_TEMP_DIR,
): Promise<void> {
  await fs.rm(path.join(threadsDir(baseDir), threadId), {
    recursive: true,
    force: true,
  });
}
