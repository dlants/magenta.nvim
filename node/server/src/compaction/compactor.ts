import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThreadManager } from "../capabilities/thread-manager.ts";
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
import { ABORT_MARKER_TEXT } from "../providers/inference-shared.ts";
import type {
  AgentInput,
  ProviderMessage,
} from "../providers/provider-types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { CompactionOutcome, Compactor } from "./index.ts";

const COMPACT_PROMPT_TEMPLATE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "compact-system-prompt.md"),
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
      totalChunks: number;
      /** chunk threads that have already yielded, in order */
      completedThreadIds: ReadonlyArray<ThreadId>;
      /** the chunk thread doing the work right now — a running compaction
       * always has one, so the view has no empty case to defend against */
      activeThreadId: ThreadId;
    }
  | { type: "done"; threadIds: ReadonlyArray<ThreadId>; summary: string }
  | { type: "error"; threadIds: ReadonlyArray<ThreadId>; message: string }
  /** a chunk thread was deleted, or the parent was destroyed */
  | { type: "aborted"; threadIds: ReadonlyArray<ThreadId> }
);

/** Every chunk thread a run has spawned, in order. */
export function compactionRunThreadIds(
  run: CompactionRunState,
): ReadonlyArray<ThreadId> {
  return run.type === "running"
    ? [...run.completedThreadIds, run.activeThreadId]
    : run.threadIds;
}

/** How far a running compaction has got. */
export function compactionRunChunkIndex(
  run: Extract<CompactionRunState, { type: "running" }>,
): number {
  return run.completedThreadIds.length;
}

export type ThreadCompactorDeps = {
  parentThreadId: ThreadId;
  threadManager: ThreadManager;
};

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
  private activeRunId: CompactionRunId | undefined;

  constructor(private readonly deps: ThreadCompactorDeps) {
    super();
  }

  get current(): Extract<CompactionRunState, { type: "running" }> | undefined {
    const last = this.runs[this.runs.length - 1];
    return last?.type === "running" ? last : undefined;
  }

  async run(
    messages: ReadonlyArray<ProviderMessage>,
    next: ReadonlyArray<AgentInput>,
    signal: AbortSignal,
  ): Promise<CompactionOutcome> {
    this.discard();

    const { history, carried } = splitPendingTurn(messages);
    next = [...next, ...carried];
    if (history.length === 0) return { type: "carried", next: [...next] };
    const chunks = this.chunk(history);
    if (chunks.length === 0) {
      return { type: "error", message: "nothing to compact" };
    }

    const id = this.nextRunId++ as CompactionRunId;
    this.activeRunId = id;
    const onAbort = () => this.discardRun(id);
    signal.addEventListener("abort", onAbort, { once: true });
    const completed: ThreadId[] = [];
    let started = false;
    let summary = "";

    try {
      for (const [chunkIndex, chunk] of chunks.entries()) {
        if (signal.aborted || !this.isCurrent(id)) {
          this.discardRun(id);
          return { type: "aborted" };
        }

        const fileIO = new InMemoryFileIO({
          "/summary.md": summary,
          "/chunk.md": chunk,
        });
        const threadId = await this.deps.threadManager.spawnThread({
          parentThreadId: this.deps.parentThreadId,
          threadType: "compact",
          prompt: buildChunkPrompt({
            chunk,
            chunkIndex,
            totalChunks: chunks.length,
            summary,
            next,
          }),
          subagentConfig: { fastModel: true },
          fileIO,
          label: `compact ${chunkIndex + 1}/${chunks.length}`,
        });

        if (signal.aborted || !this.isCurrent(id)) {
          this.deps.threadManager.deleteThread(threadId);
          this.discardRun(id);
          return { type: "aborted" };
        }
        const running: CompactionRunState = {
          id,
          type: "running",
          totalChunks: chunks.length,
          completedThreadIds: [...completed],
          activeThreadId: threadId,
        };
        if (started) {
          this.update(id, running);
        } else {
          this.runs.push(running);
          this.emit("transition", running);
          started = true;
        }

        if (!this.isCurrent(id)) return { type: "aborted" };
        const result =
          await this.deps.threadManager.awaitThreadResult(threadId);
        if (signal.aborted || !this.isCurrent(id)) {
          this.discardRun(id);
          return { type: "aborted" };
        }
        if (result.type === "aborted") {
          this.update(id, {
            id,
            type: "aborted",
            threadIds: [...completed, threadId],
          });
          return { type: "aborted" };
        }

        completed.push(threadId);
        summary = fileIO.getFileContents("/summary.md") ?? "";
      }

      if (summary.trim() === "") {
        const message = "the compaction finished but /summary.md is empty";
        this.update(id, {
          id,
          type: "error",
          threadIds: [...completed],
          message,
        });
        return { type: "error", message };
      }

      this.update(id, {
        id,
        type: "done",
        threadIds: [...completed],
        summary,
      });
      return {
        type: "complete",
        summary: { text: summary, chunkCount: chunks.length },
        next: [...next],
      };
    } catch (error) {
      const wasCurrent = this.isCurrent(id);
      this.discardRun(id);
      if (signal.aborted || !wasCurrent) {
        return { type: "aborted" };
      }
      return {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** Abandon the run in flight, deleting the child threads it spawned. The
   * `awaitThreadResult` it is parked on settles `aborted` as a result. */
  discard(): void {
    this.activeRunId = undefined;
    const current = this.current;
    if (!current) return;
    const threadIds = compactionRunThreadIds(current);
    this.update(current.id, {
      id: current.id,
      type: "aborted",
      threadIds,
    });
    for (const threadId of threadIds) {
      this.deps.threadManager.deleteThread(threadId);
    }
  }

  /** A run that is no longer the last one has been superseded by a fresh
   * `run()`; its remaining steps must not write state. */
  private isCurrent(id: CompactionRunId): boolean {
    return this.activeRunId === id;
  }

  private discardRun(id: CompactionRunId): void {
    if (this.isCurrent(id)) this.discard();
  }

  private update(id: CompactionRunId, next: CompactionRunState): void {
    const last = this.runs[this.runs.length - 1];
    if (!last || last.id !== id) return;
    this.runs[this.runs.length - 1] = next;
    if (next.type !== "running" && this.activeRunId === id) {
      this.activeRunId = undefined;
    }
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
  next,
}: {
  chunk: string;
  chunkIndex: number;
  totalChunks: number;
  summary: string;
  next: ReadonlyArray<AgentInput>;
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
    .replace("{{next_prompt}}", () => renderNext(next));
}
/** The chunk prompt only needs to know what comes next, so non-text input
 * is named rather than inlined. */
/** Input appended ahead of a budget stop is already in the log but has not
 * been answered, so it is carried past the compaction rather than summarized.
 * Supervisor context is re-derived by the fresh core, and the abort marker is
 * not something the user said. A tool_result tail is mid-loop, not a turn. */
function splitPendingTurn(messages: ReadonlyArray<ProviderMessage>): {
  history: ReadonlyArray<ProviderMessage>;
  carried: AgentInput[];
} {
  let start = messages.length;
  while (start > 0 && messages[start - 1].role === "user") start--;
  const tail = messages.slice(start);
  if (
    tail.some((message) =>
      message.content.some((block) => block.type === "tool_result"),
    )
  )
    return { history: messages, carried: [] };
  const carried: AgentInput[] = [];
  for (const message of tail)
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          if (block.text !== ABORT_MARKER_TEXT)
            carried.push({ type: "text", text: block.text });
          break;
        case "image":
          carried.push({ type: "image", source: block.source });
          break;
        case "document":
          carried.push({
            type: "document",
            source: block.source,
            ...(block.title !== undefined ? { title: block.title } : {}),
          });
          break;
      }
    }
  return { history: messages.slice(0, start), carried };
}

function renderNext(next: ReadonlyArray<AgentInput>): string {
  const parts = next.map((input) => {
    switch (input.type) {
      case "text":
        return input.text;
      case "image":
        return "[image]";
      case "document":
        return `[document: ${input.title ?? "untitled"}]`;
      default:
        return assertUnreachable(input);
    }
  });
  return parts.join("\n").trim() || "Continue from where you left off.";
}
