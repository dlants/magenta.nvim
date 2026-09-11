import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FsFileIO } from "./capabilities/file-io.ts";
import type { GitState } from "./capabilities/git-client.ts";
import { runSubmission } from "./compaction/index.ts";
import type { MockStream } from "./providers/mock-anthropic-client.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./providers/provider-types.ts";
import { resolveAsText } from "./submission/index.ts";
import { FileSupervisor } from "./supervisors/file-supervisor.ts";
import {
  awaitNextStream,
  cleanupArchive,
  createAgentWithMock,
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
  const start = vi.spyOn(FileSupervisor.prototype, "start");
  const { core: thread, mockClient } = createAgentWithMock(
    {
      cwd,
      homeDir,
      fileIO,
      contextDelivery: {
        initialGitState: git,
        onFilesSent,
        pollIntervalMs: 60_000,
      },
      gitClient: { getState: async () => git },
    },
    uniqueThreadId("core-context"),
  );
  const manager = thread.core.fileSupervisor;
  manager.addFileContext(file, "tracked.txt" as RelFilePath, {
    category: FileCategory.TEXT,
    mimeType: "text/plain",
    extension: "txt",
  });
  const stop = vi.spyOn(manager, "stop");
  const changed = vi.fn();
  manager.on("pendingUpdatesChanged", changed);
  thread.setTitle("context integration");
  let previous: MockStream | undefined;
  async function request(target = thread, text = "continue") {
    const sent = target.send([
      { type: "text", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX, text },
    ]);
    const stream = await awaitNextStream(mockClient, previous);
    previous = stream;
    stream.streamText("done");
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
      vi.restoreAllMocks();
    },
  };
}

describe("Thread-owned context delivery", () => {
  it.each([
    "reset",
    "compaction",
  ] as const)("%s reseeds files and preamble with a fresh tracker without replaying delivered comments", async (operation) => {
    const f = await fixture();
    try {
      const first = await f.request();
      expect(first).toContain("original tracked content");
      expect(first).toContain("<system-info>");
      const oldCore = f.thread.core;
      f.setGit();
      await fs.writeFile(f.file, "replacement tracked content\n");
      let replacement: string;
      if (operation === "reset") {
        await f.thread.reset({
          seed: [
            {
              type: "text",
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
              text: "replacement summary",
            },
          ],
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
      expect(f.thread.core.fileSupervisor).not.toBe(f.manager);
      expect(f.start).toHaveBeenCalledTimes(2);
      expect(f.stop).toHaveBeenCalledTimes(1);
      expect(replacement).toContain("replacement summary");
      expect(replacement).toContain("replacement tracked content");
      expect(replacement).not.toContain("original tracked content");
      expect(replacement).not.toContain("```diff");
      expect(replacement).toContain("replacement-branch");
      expect(replacement).toContain("<system-info>");
      expect(replacement).toContain("replacement-branch");
      expect(f.onFilesSent).toHaveBeenCalledTimes(2);
      f.changed.mockClear();
      await fs.writeFile(f.file, "a later tracked edit\n");
      const replacementChanged = vi.fn();
      f.thread.core.fileSupervisor.on(
        "pendingUpdatesChanged",
        replacementChanged,
      );
      await f.thread.core.fileSupervisor.refreshPendingUpdates();
      expect(replacementChanged).toHaveBeenCalled();
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
      fork = await Thread.clone({
        sourceThread: f.thread,
        newId: uniqueThreadId("context-fork"),
        nativeMessageIdx: forkPoint,
        context: {
          ...f.thread.context,
          contextDelivery: { pollIntervalMs: 60_000 },
        },
        callbacks: { onUpdate: () => {}, resolve: resolveAsText },
      });
      const manager = fork.core.fileSupervisor;
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
      expect(fork.core.fileSupervisor.files[f.file].agentView).toBeUndefined();
      await f.thread.destroy();
      await fs.writeFile(f.file, "fork after source destruction\n");
      expect(await f.request(fork)).toContain("fork after source destruction");
      fork.core.fileSupervisor.removeFileContext(f.file);
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
  it.each([
    false,
    true,
  ])("tip fork preserves delivery only while idle (busy=%s)", async (busy) => {
    const f = await fixture();
    let fork: Thread | undefined;
    try {
      await f.request();
      await fs.writeFile(f.file, "pending external edit\n");
      await f.manager.refreshPendingUpdates();
      let sent: ReturnType<Thread["send"]> | undefined;
      if (busy) {
        sent = f.thread.send([
          {
            type: "text",
            text: "in flight",
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          },
        ]);
        await awaitNextStream(f.mockClient, f.mockClient.streams.at(-1));
      }
      fork = await Thread.clone({
        sourceThread: f.thread,
        newId: uniqueThreadId("tip-fork"),
        nativeMessageIdx: f.thread.inferenceManager.getNativeMessageIdx(),
        context: {
          ...f.thread.context,
          contextDelivery: { pollIntervalMs: 60_000 },
        },
        callbacks: { onUpdate: () => {}, resolve: resolveAsText },
      });
      const tracker = fork.core.fileSupervisor;
      expect(tracker).not.toBe(f.manager);
      if (busy) {
        expect(tracker.files[f.file].agentView).toBeUndefined();
        await f.thread.abort();
        await sent;
      } else {
        expect(tracker.files[f.file].agentView).toEqual(
          f.manager.files[f.file].agentView,
        );
        expect(tracker.getPendingUpdates()).toEqual(
          f.manager.getPendingUpdates(),
        );
        expect(tracker.getPendingUpdates()).not.toBe(
          f.manager.getPendingUpdates(),
        );
        expect(await tracker.hasPendingContent()).toBe(true);
      }
    } finally {
      if (fork) {
        await fork.destroy();
        await fork.awaitArchiveFlush();
        await cleanupArchive(fork.id);
      }
      await f.cleanup();
    }
  });

  it("reset retires a pending file read before it can mutate or notify the replacement", async () => {
    const f = await fixture();
    try {
      await f.request();
      const originalView = structuredClone(f.manager.files[f.file].agentView);
      let release!: (content: string) => void;
      let entered!: () => void;
      const reading = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const read = vi
        .spyOn(f.fileIO, "readFile")
        .mockImplementationOnce(async () => {
          entered();
          return new Promise<string>((resolve) => {
            release = resolve;
          });
        });
      const pending = f.manager.getContextUpdate();
      await reading;
      await f.thread.reset({ seed: [], archive: { type: "none" } });
      const replacement = f.thread.core.fileSupervisor;
      f.changed.mockClear();
      release("stale read content\n");
      expect(await pending).toEqual({});
      expect(f.manager.files[f.file].agentView).toEqual(originalView);
      expect(replacement.files[f.file].agentView).toBeUndefined();
      expect(f.changed).not.toHaveBeenCalled();
      expect(f.onFilesSent).toHaveBeenCalledTimes(1);
      read.mockRestore();
      expect(await f.request()).toContain("original tracked content");
    } finally {
      await f.cleanup();
    }
  });
});
