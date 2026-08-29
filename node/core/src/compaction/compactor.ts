import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThreadId } from "../chat-types.ts";
import {
  CHARS_PER_TOKEN,
  chunkMessages,
  renderThreadToMarkdown,
  TARGET_CHUNK_TOKENS,
  TOLERANCE_TOKENS,
} from "../compact-renderer.ts";
import { InMemoryFileIO } from "../edl/in-memory-file-io.ts";
import { Emitter } from "../emitter.ts";
import type { ProviderMessage } from "../providers/provider-types.ts";
import type { Thread } from "../thread.ts";
import type { CompactionOutcome, Compactor } from "./index.ts";

const COMPACT_PROMPT_TEMPLATE = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "compact-system-prompt.md",
  ),
  "utf-8",
);

/** Identifies a run across its state transitions, so the view can key its
 * expand/collapse state on something that does not move when the list of runs
 * is filtered or appended to. */
export type CompactionRunId = number & { __compactionRunId: true };

/** One compaction, from the view's perspective. Each chunk is a real child
 * thread, so the ids are all the view needs to let the user walk into one. */
export type CompactionRunState = { id: CompactionRunId } & (
  | {
      type: "running";
      chunkIndex: number;
      totalChunks: number;
      threadIds: ReadonlyArray<ThreadId>;
    }
  | { type: "done"; threadIds: ReadonlyArray<ThreadId>; summary: string }
  | { type: "error"; threadIds: ReadonlyArray<ThreadId>; message: string }
  /** a chunk thread was deleted, or the parent was destroyed */
  | { type: "aborted"; threadIds: ReadonlyArray<ThreadId> }
);

export type ThreadCompactorEvents = {
  transition: [CompactionRunState];
};

/** Compacts a thread by handing each chunk of its transcript to an ordinary
 * `compact` child thread. Everything a compaction needs — streaming display,
 * tool execution, abort, permissions, recovery by hand — therefore comes from
 * the thread machinery rather than from a private state machine. */
export class ThreadCompactor
  extends Emitter<ThreadCompactorEvents>
  implements Compactor
{
  /** The current run last. The view renders these. */
  readonly runs: CompactionRunState[] = [];
  private nextRunId = 0;

  constructor(private thread: Thread) {
    super();
  }

  get current(): Extract<CompactionRunState, { type: "running" }> | undefined {
    const last = this.runs[this.runs.length - 1];
    return last?.type === "running" ? last : undefined;
  }

  async run(
    messages: ReadonlyArray<ProviderMessage>,
    nextPrompt: string | undefined,
  ): Promise<CompactionOutcome> {
    this.discard();

    const chunks = this.chunk(messages);
    if (chunks.length === 0) {
      return { type: "error", message: "nothing to compact" };
    }

    const id = this.nextRunId++ as CompactionRunId;
    const threadIds: ThreadId[] = [];
    this.runs.push({
      id,
      type: "running",
      chunkIndex: 0,
      totalChunks: chunks.length,
      threadIds: [],
    });
    this.emit("transition", this.runs[this.runs.length - 1]!);

    let summary = "";
    for (const [chunkIndex, chunk] of chunks.entries()) {
      const run: Extract<CompactionRunState, { type: "running" }> = {
        id,
        type: "running",
        chunkIndex,
        totalChunks: chunks.length,
        threadIds: [...threadIds],
      };
      this.update(id, run);

      const fileIO = new InMemoryFileIO({
        "/summary.md": summary,
        "/chunk.md": chunk,
      });
      const threadId = await this.thread.context.threadManager.spawnThread({
        parentThreadId: this.thread.id,
        threadType: "compact",
        prompt: buildChunkPrompt({
          chunk,
          chunkIndex,
          totalChunks: chunks.length,
          summary,
          nextPrompt,
        }),
        subagentConfig: { fastModel: true },
        fileIO,
        label: `compact ${chunkIndex + 1}/${chunks.length}`,
      });
      threadIds.push(threadId);
      this.update(id, { ...run, threadIds: [...threadIds] });

      const result =
        await this.thread.context.threadManager.awaitThreadResult(threadId);
      if (!this.isCurrent(id)) return { type: "aborted" };
      if (result.type === "aborted") {
        this.update(id, { id, type: "aborted", threadIds: [...threadIds] });
        return { type: "aborted" };
      }
      summary = fileIO.getFileContents("/summary.md") ?? "";
    }

    if (summary.trim() === "") {
      const message = "the compaction finished but /summary.md is empty";
      this.update(id, {
        id,
        type: "error",
        threadIds: [...threadIds],
        message,
      });
      return { type: "error", message };
    }

    this.update(id, {
      id,
      type: "done",
      threadIds: [...threadIds],
      summary,
    });
    return { type: "complete", summary, chunkCount: chunks.length };
  }

  /** Abandon the run in flight, deleting the child threads it spawned. The
   * `awaitThreadResult` it is parked on settles `aborted` as a result. */
  discard(): void {
    const current = this.current;
    if (!current) return;
    this.update(current.id, {
      id: current.id,
      type: "aborted",
      threadIds: [...current.threadIds],
    });
    for (const threadId of current.threadIds) {
      this.thread.context.threadManager.deleteThread(threadId);
    }
  }

  /** A run that is no longer the last one has been superseded by a fresh
   * `run()`; its remaining steps must not write state. */
  private isCurrent(id: CompactionRunId): boolean {
    const last = this.runs[this.runs.length - 1];
    return last?.id === id && last.type === "running";
  }

  private update(id: CompactionRunId, next: CompactionRunState): void {
    const last = this.runs[this.runs.length - 1];
    if (!last || last.id !== id) return;
    this.runs[this.runs.length - 1] = next;
    this.emit("transition", next);
  }

  private chunk(messages: ReadonlyArray<ProviderMessage>): string[] {
    const { markdown, messageBoundaries } = renderThreadToMarkdown(messages);
    return chunkMessages(
      markdown,
      messageBoundaries,
      TARGET_CHUNK_TOKENS * CHARS_PER_TOKEN,
      TOLERANCE_TOKENS * CHARS_PER_TOKEN,
    );
  }
}

function buildChunkPrompt({
  chunk,
  chunkIndex,
  totalChunks,
  summary,
  nextPrompt,
}: {
  chunk: string;
  chunkIndex: number;
  totalChunks: number;
  summary: string;
  nextPrompt: string | undefined;
}): string {
  const status = [`This is chunk ${chunkIndex + 1} of ${totalChunks}.`];
  if (chunkIndex === 0) {
    status.push(
      "The file /summary.md is currently empty. Write the initial summary.",
    );
  } else {
    status.push(
      "Fold the essential information from the new chunk into the existing /summary.md. Do NOT rewrite the summary from scratch.",
    );
  }
  if (chunkIndex === totalChunks - 1) {
    status.push(
      "This is the LAST chunk. Make sure the summary is complete and well-organized.",
    );
  }
  status.push(
    "When /summary.md is up to date, call yield_to_parent to hand it back.",
  );

  return COMPACT_PROMPT_TEMPLATE.replace(
    "{{summary}}",
    summary === "" ? "(currently empty)" : summary,
  )
    .replace("{{chunk}}", chunk)
    .replace("{{status}}", status.join(" "))
    .replace(
      "{{next_prompt}}",
      nextPrompt ?? "Continue from where you left off.",
    );
}
