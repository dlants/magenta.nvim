import type { SubagentConfig, ThreadId, ThreadType } from "../chat-types.ts";
import type { ThreadResult } from "../thread-api.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { FileIO } from "./file-io.ts";

export type DockerSpawnConfig = {
  containerName: string;
  imageName: string;
  workspacePath: string;
  hostDir: string;
  supervised: boolean;
};

export interface ThreadManager {
  spawnThread(opts: {
    parentThreadId: ThreadId;
    prompt: string;
    threadType: ThreadType;
    subagentConfig?: SubagentConfig;
    contextFiles?: UnresolvedFilePath[];
    dockerSpawnConfig?: DockerSpawnConfig;
    cwd?: string;
    /** Sandboxes the thread's file tools to an in-memory world (compaction). */
    fileIO?: FileIO;
    /** Seeds the thread's title, so it is identifiable in the thread tree
     * before it has said anything. */
    label?: string;
  }): Promise<ThreadId>;

  /** Delete a thread and its descendants. Any `awaitThreadResult` on them
   * settles `aborted`. */
  deleteThread(threadId: ThreadId): void;

  /** Resolves when the thread finishes — an accepted yield, or a teardown
   * that beat it. A promise rather than a poll plus a callback registry, so
   * the "did I miss the edge" guard every consumer used to need is gone. */
  awaitThreadResult(threadId: ThreadId): Promise<ThreadResult>;
}
