import type { SubagentConfig, ThreadId, ThreadType } from "../chat-types.ts";
import type { ThreadResult } from "../thread-api.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";

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
  }): Promise<ThreadId>;

  /** Resolves when the thread finishes — an accepted yield, or a teardown
   * that beat it. A promise rather than a poll plus a callback registry, so
   * the "did I miss the edge" guard every consumer used to need is gone. */
  awaitThreadResult(threadId: ThreadId): Promise<ThreadResult>;
}
