import type { ThreadId, ThreadType } from "../chat-types.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { Result } from "../utils/result.ts";

export interface ThreadManager {
  spawnThread(opts: {
    parentThreadId: ThreadId;
    prompt: string;
    threadType: ThreadType;
    contextFiles?: UnresolvedFilePath[];
  }): Promise<ThreadId>;

  waitForThread(threadId: ThreadId): Promise<Result<string>>;

  yieldResult(threadId: ThreadId, result: Result<string>): void;
}
