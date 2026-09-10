import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FsFileIO } from "./capabilities/file-io.ts";
import type { GitState } from "./capabilities/git-client.ts";
import { runSubmission } from "./compaction/index.ts";
import { type BufNr, CommentStore } from "./context/comment-store.ts";
import {
  ContextManager,
  cloneContextManager,
} from "./context/context-manager.ts";
import type { MockStream } from "./providers/mock-anthropic-client.ts";
import { resolveAsText } from "./submission/index.ts";
import {
  awaitNextStream,
  cleanupArchive,
  createAgentWithMock,
  noopLogger,
  uniqueThreadId,
} from "./test-helpers.ts";
import { Thread } from "./thread.ts";
import {
  type AbsFilePath,
  FileCategory,
  type HomeDir,
  type NvimCwd,
  type RelFilePath,
} from "./utils/files.ts";

async function fixture() {
  const cwd = (await fs.mkdtemp(
    path.join(os.tmpdir(), "thread-context-"),
  )) as NvimCwd;
  const homeDir = cwd as unknown as HomeDir;
  const file = path.join(cwd, "tracked.txt") as AbsFilePath;
  await fs.writeFile(file, "original tracked content\n");
  const fileIO = new FsFileIO();
  const manager = new ContextManager(
    noopLogger,
    fileIO,
    cwd,
    homeDir,
    {},
    60_000,
  );
  manager.addFileContext(file, "tracked.txt" as RelFilePath, {
    category: FileCategory.TEXT,
    mimeType: "text/plain",
    extension: "txt",
  });
  const store = new CommentStore();
  const comment = store.addComment(
    { bufferLabel: "tracked.txt", bufnr: 1 as BufNr, state: "stale" },
    "already delivered comment",
  );
  let git: GitState = {
    repoRoot: cwd,
    branch: "initial-branch",
    headSha: "111111111",
    headSubject: "initial commit",
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
  };
  const onFilesSent = vi.fn();
  const start = vi.spyOn(manager, "start");
  const stop = vi.spyOn(manager, "stop");
  const changed = vi.fn();
  manager.on("pendingUpdatesChanged", changed);
  const { core: thread, mockClient } = createAgentWithMock(
    {
      cwd,
      homeDir,
      fileIO,
      contextTracker: manager,
      contextDelivery: { manager, initialGitState: git, onFilesSent },
      commentStore: store,
      gitClient: { getState: async () => git },
    },
    uniqueThreadId("core-context"),
  );
  thread.setTitle("context integration");
  let previous: MockStream | undefined;
  async function request(target = thread, text = "continue") {
    const sent = target.send([{ type: "user", text }]);
    const stream = await awaitNextStream(mockClient, previous);
    previous = stream;
    stream.finishResponse("end_turn");
    await sent;
    return JSON.stringify(stream.messages);
  }
  return {
    cwd,
    homeDir,
    file,
    fileIO,
    manager,
    store,
    comment,
    thread,
    mockClient,
    start,
    stop,
    changed,
    onFilesSent,
    request,
    setGit: () => {
      git = { ...git, branch: "replacement-branch", headSha: "222222222" };
    },
    async cleanup() {
      await thread.destroy();
      await thread.awaitArchiveFlush();
      await cleanupArchive(thread.id);
      await fs.rm(cwd, { recursive: true, force: true });
    },
  };
}

describe("Thread-owned context delivery", () => {
  it.each([
    "reset",
    "compaction",
  ] as const)("%s reseeds files and preamble without restarting tracking or replaying delivered comments", async (operation) => {
    const f = await fixture();
    try {
      const first = await f.request();
      expect(first).toContain("original tracked content");
      expect(first).toContain("already delivered comment");
      expect(first).toContain("<system-info>");
      expect(f.store.hasPendingUpdates()).toBe(false);
      const oldCore = f.thread.core;
      const oldDelivery = f.manager.delivery;
      f.setGit();
      await fs.writeFile(f.file, "replacement tracked content\n");
      f.store.addUserMessage(f.comment, "pending comment survives replacement");
      let replacement: string;
      if (operation === "reset") {
        await f.thread.reset({
          seed: [{ type: "user", text: "replacement summary" }],
          archive: { type: "none" },
        });
        replacement = await f.request();
      } else {
        const previous = f.mockClient.streams.at(-1);
        const sent = runSubmission({
          thread: f.thread,
          compactor: {
            run: async () => ({
              type: "complete",
              summary: "replacement summary",
              chunkCount: 1,
            }),
          },
          start: async () => ({
            type: "suspended",
            reason: { kind: "compact", nextPrompt: "resume" },
          }),
        });
        const stream = await awaitNextStream(f.mockClient, previous);
        replacement = JSON.stringify(stream.messages);
        stream.finishResponse("end_turn");
        await sent;
      }
      expect(f.thread.core).not.toBe(oldCore);
      expect(oldCore.isActive).toBe(false);
      expect(f.thread.context.contextTracker).toBe(f.manager);
      expect(f.thread.core.fileSupervisor?.contextManager).toBe(f.manager);
      expect(f.manager.delivery).not.toBe(oldDelivery);
      expect(f.start).toHaveBeenCalledTimes(1);
      expect(f.stop).not.toHaveBeenCalled();
      expect(replacement).toContain("replacement summary");
      expect(replacement).toContain("replacement tracked content");
      expect(replacement).not.toContain("original tracked content");
      expect(replacement).not.toContain("```diff");
      expect(replacement).toContain("replacement-branch");
      expect(replacement).toContain("<system-info>");
      expect(replacement).not.toContain("already delivered comment");
      expect(replacement).toContain("pending comment survives replacement");
      expect(f.store.comments[f.comment].messages).toHaveLength(2);
      expect(f.store.hasPendingUpdates()).toBe(false);
      expect(f.onFilesSent).toHaveBeenCalledTimes(2);
      f.changed.mockClear();
      await fs.writeFile(f.file, "a later tracked edit\n");
      await f.manager.refreshPendingUpdates();
      expect(f.changed).toHaveBeenCalled();
      await f.thread.destroy();
      expect(f.stop).toHaveBeenCalledTimes(1);
      f.changed.mockClear();
      f.manager.emit("pendingUpdatesChanged");
      expect(f.changed).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });

  it("a truncated fork reseeds tracked files independently and can outlive its source", async () => {
    const f = await fixture();
    let fork: Thread | undefined;
    try {
      f.manager.removeFileContext(f.file);
      await f.request();
      const forkPoint =
        f.thread.getProviderMessages()[0].content[0].nativeMessageIdx;
      f.manager.addFileContext(f.file, "tracked.txt" as RelFilePath, {
        category: FileCategory.TEXT,
        mimeType: "text/plain",
        extension: "txt",
      });
      await fs.writeFile(f.file, "source-only later content\n");
      await f.request(f.thread, "source-only later request");
      const manager = await cloneContextManager(f.manager, {
        logger: noopLogger,
        fileIO: f.fileIO,
        cwd: f.cwd,
        homeDir: f.homeDir,
        pollIntervalMs: 60_000,
      });
      fork = await Thread.clone({
        sourceThread: f.thread,
        newId: uniqueThreadId("context-fork"),
        nativeMessageIdx: forkPoint,
        context: {
          ...f.thread.context,
          contextTracker: manager,
          contextDelivery: { manager },
          commentStore: new CommentStore(),
        },
        callbacks: { onUpdate: () => {}, resolve: resolveAsText },
      });
      fork.setTitle("fork context integration");
      expect(JSON.stringify(fork.getProviderMessages())).not.toContain(
        "source-only later request",
      );
      expect(manager.files[f.file].agentView).toBeUndefined();
      const sourceView = structuredClone(f.manager.files[f.file].agentView);
      const forkText = await f.request(fork);
      expect(forkText).toContain("source-only later content");
      expect(f.manager.files[f.file].agentView).toEqual(sourceView);
      await fork.reset({ seed: [], archive: { type: "none" } });
      expect(f.manager.files[f.file].agentView).toEqual(sourceView);
      expect(manager.files[f.file].agentView).toBeUndefined();
      await f.thread.destroy();
      await fs.writeFile(f.file, "fork after source destruction\n");
      expect(await f.request(fork)).toContain("fork after source destruction");
      manager.removeFileContext(f.file);
      expect(f.manager.files[f.file]).toBeDefined();
    } finally {
      if (fork) {
        await fork.destroy();
        await fork.awaitArchiveFlush();
        await cleanupArchive(fork.id);
      }
      await f.cleanup();
    }
  });
});
