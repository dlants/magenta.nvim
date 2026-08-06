import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadId } from "./chat-types.ts";
import type { Logger } from "./logger.ts";
import type { ProviderMessage } from "./providers/provider-types.ts";
import { ThreadLogger } from "./thread-logger.ts";
import {
  MAGENTA_TEMP_DIR,
  threadConversationLogPath,
  threadMetaPath,
} from "./utils/files.ts";

const TEST_BASE_DIR = path.join(os.tmpdir(), "magenta-test-thread-logger");

function makeLogger(): { logger: Logger; errors: unknown[][] } {
  const errors: unknown[][] = [];
  const logger: Logger = {
    info: () => {},
    warn: () => {},
    error: (...args: unknown[]) => errors.push(args),
    debug: () => {},
  };
  return { logger, errors };
}

function msg(text: string): ProviderMessage {
  return {
    role: "user",
    content: [{ type: "text", text, nativeMessageIdx: 0 as never }],
  };
}

describe("ThreadLogger", () => {
  const threadIds: ThreadId[] = [];

  function freshThreadId(): ThreadId {
    const id = `test-${Math.random().toString(36).slice(2)}` as ThreadId;
    threadIds.push(id);
    return id;
  }

  afterEach(async () => {
    for (const id of threadIds) {
      await fs.rm(path.dirname(threadConversationLogPath(id, TEST_BASE_DIR)), {
        recursive: true,
        force: true,
      });
    }
    threadIds.length = 0;
  });

  it("produces the {baseDir}/threads/{threadId}/conversation.jsonl path", () => {
    const threadId = "abc123" as ThreadId;
    expect(threadConversationLogPath(threadId)).toBe(
      `${MAGENTA_TEMP_DIR}/threads/abc123/conversation.jsonl`,
    );
    expect(threadConversationLogPath(threadId, "/base")).toBe(
      "/base/threads/abc123/conversation.jsonl",
    );
  });

  it("persists the title to the sidecar and appends title entries to the JSONL", async () => {
    const threadId = freshThreadId();
    const { logger } = makeLogger();
    const messages: ProviderMessage[] = [];
    const tl = new ThreadLogger(
      threadId,
      "root",
      () => messages,
      () => messages.length,
      logger,
      { baseDir: TEST_BASE_DIR },
    );

    tl.recordTitle("Hello");
    tl.recordTitle("Hello 2");
    await tl.flushed();

    const meta = JSON.parse(
      await fs.readFile(threadMetaPath(threadId, TEST_BASE_DIR), "utf8"),
    ) as { title: string; threadType: string };
    expect(meta).toEqual({ title: "Hello 2", threadType: "root" });

    const lines = (
      await fs.readFile(
        threadConversationLogPath(threadId, TEST_BASE_DIR),
        "utf8",
      )
    )
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { type: string; title?: string });
    const titles = lines.filter((l) => l.type === "title");
    expect(titles.map((t) => t.title)).toEqual(["Hello", "Hello 2"]);
  });

  it("withholds the streaming message on update and persists all on turn end, idempotently", async () => {
    const threadId = freshThreadId();
    const { logger } = makeLogger();
    const messages: ProviderMessage[] = [msg("a"), msg("b"), msg("c")];
    const tl = new ThreadLogger(
      threadId,
      "root",
      () => messages,
      () => messages.length,
      logger,
      { baseDir: TEST_BASE_DIR },
    );

    tl.onUpdate();
    await tl.flushed();

    async function messageTexts(): Promise<string[]> {
      const lines = (
        await fs.readFile(
          threadConversationLogPath(threadId, TEST_BASE_DIR),
          "utf8",
        )
      )
        .split("\n")
        .filter((l) => l.length > 0)
        .map(
          (l) =>
            JSON.parse(l) as {
              type: string;
              message?: { content: { text?: string }[] };
            },
        );
      return lines
        .filter((l) => l.type === "message")
        .map((l) => l.message?.content?.[0]?.text ?? "");
    }

    // onUpdate withholds the final (still-streaming) message: only a, b land.
    expect(await messageTexts()).toEqual(["a", "b"]);

    // Repeated onUpdate is idempotent by cursor: no duplicates.
    tl.onUpdate();
    await tl.flushed();
    expect(await messageTexts()).toEqual(["a", "b"]);

    // onTurnEnded persists the withheld final message with no duplicates.
    tl.onTurnEnded();
    await tl.flushed();
    expect(await messageTexts()).toEqual(["a", "b", "c"]);

    // Repeated onTurnEnded stays idempotent.
    tl.onTurnEnded();
    await tl.flushed();
    expect(await messageTexts()).toEqual(["a", "b", "c"]);
  });

  it("routes meta sidecar write errors to the logger", async () => {
    const threadId = freshThreadId();
    const { logger, errors } = makeLogger();
    const messages: ProviderMessage[] = [];
    const tl = new ThreadLogger(
      threadId,
      "root",
      () => messages,
      () => messages.length,
      logger,
      { baseDir: TEST_BASE_DIR },
    );
    await tl.flushed();

    // Replace the thread dir with a file so the meta.json write fails.
    const dir = path.dirname(
      threadConversationLogPath(threadId, TEST_BASE_DIR),
    );
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await fs.writeFile(dir, "not a dir");

    expect(() => tl.recordTitle("boom")).not.toThrow();
    await tl.flushed();
    expect(errors.length).toBeGreaterThan(0);

    await fs.rm(dir, { force: true });
  });

  it("does not throw and routes fs errors to the logger", async () => {
    const threadId = freshThreadId();
    const { logger, errors } = makeLogger();
    const messages: ProviderMessage[] = [];
    const tl = new ThreadLogger(
      threadId,
      "root",
      () => messages,
      () => messages.length,
      logger,
      { baseDir: TEST_BASE_DIR },
    );
    await tl.flushed();

    // Replace the thread dir with a file so subsequent appends fail.
    const dir = path.dirname(
      threadConversationLogPath(threadId, TEST_BASE_DIR),
    );
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await fs.writeFile(dir, "not a dir");

    messages.push(msg("a"));
    expect(() => tl.onTurnEnded()).not.toThrow();
    await tl.flushed();
    expect(errors.length).toBeGreaterThan(0);

    await fs.rm(dir, { force: true });
  });
});
