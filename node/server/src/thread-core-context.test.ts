import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FsFileIO } from "./capabilities/file-io.ts";
import type { GitState } from "./capabilities/git-client.ts";
import { InMemoryFileIO } from "./edl/in-memory-file-io.ts";
import {
  type NativeMessageIdx,
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
} from "./providers/provider-types.ts";
import { pendingMessage, resolveAsText } from "./submission/index.ts";
import { FileSupervisor } from "./supervisors/file-supervisor.ts";
import {
  awaitNextStream,
  cleanupArchive,
  createAgentWithMock,
  uniqueThreadId,
} from "./test-helpers.ts";
import { Thread, threadCloneContext } from "./thread.ts";
import {
  type AbsFilePath,
  FileCategory,
  type HomeDir,
  type NvimCwd,
  type RelFilePath,
  type UnresolvedFilePath,
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
  const onFileAdded = vi.fn();
  const create = vi.spyOn(FileSupervisor, "create");
  const { core: thread, mockClient } = createAgentWithMock(
    {
      cwd,
      homeDir,
      fileIO,
      contextDelivery: {
        initialGitState: git,
        pollIntervalMs: 60_000,
      },
      gitClient: { getState: async () => git },
    },
    uniqueThreadId("core-context"),
    undefined,
    undefined,
    { onFilesSent, onFileAdded },
  );
  const manager = thread.fileSupervisor;
  manager.addFileContext(file, "tracked.txt" as RelFilePath, {
    category: FileCategory.TEXT,
    mimeType: "text/plain",
    extension: "txt",
  });
  const destroy = vi.spyOn(manager, "destroy");
  const changed = vi.fn();
  manager.on("pendingUpdatesChanged", changed);
  thread.setTitle("context integration");
  async function request(target = thread, text = "continue") {
    const previous = mockClient.streams.at(-1);
    const sent = target.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text,
        },
      ],
    });
    const stream = await awaitNextStream(mockClient, previous);
    stream.streamText("done");
    stream.finishResponse("end_turn", { inputTokens: 1, outputTokens: 1 });
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
    create,
    destroy,
    changed,
    onFilesSent,
    onFileAdded,
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
  it("keeps fixed file notifications across reset and ignores retired emitters", async () => {
    const f = await fixture();
    try {
      await f.thread.reset({ seed: [], archive: { type: "none" } });
      expect(f.destroy).toHaveBeenCalledTimes(1);
      f.onFileAdded.mockClear();
      f.onFilesSent.mockClear();
      f.manager.emit("fileAdded", f.file);
      f.manager.emit("sent", {});
      expect(f.onFileAdded).not.toHaveBeenCalled();
      expect(f.onFilesSent).not.toHaveBeenCalled();
      const added = path.join(f.cwd, "added.txt") as AbsFilePath;
      await fs.writeFile(added, "new generation content");
      await f.thread.fileSupervisor.addFiles([
        added as string as UnresolvedFilePath,
      ]);
      expect(f.onFileAdded).toHaveBeenCalledWith(added);
      expect(await f.request()).toContain("new generation content");
      expect(f.onFilesSent).toHaveBeenCalledTimes(1);
      expect(f.thread.context.fileIO).toBe(f.fileIO);
    } finally {
      await f.cleanup();
    }
  });

  it("fork history uses destination file and git collaborators after the source is destroyed", async () => {
    const f = await fixture();
    let fork: Thread | undefined;
    try {
      await f.request();
      const fileIO = new InMemoryFileIO({ [f.file]: "destination content" });
      const gitClient = { getState: vi.fn(async () => undefined) };
      fork = await Thread.clone({
        sourceThread: f.thread,
        newId: uniqueThreadId("destination"),
        nativeMessageIdx: f.thread.inferenceManager.getNativeMessageIdx(),
        context: { ...threadCloneContext(f.thread.context), fileIO, gitClient },
        callbacks: { onUpdate: () => {}, resolve: resolveAsText },
      });
      await f.thread.destroy();
      expect(await f.request(fork)).toContain("destination content");
      expect(gitClient.getState).toHaveBeenCalled();
      expect(await f.fileIO.readFile(f.file)).toBe(
        "original tracked content\n",
      );
    } finally {
      if (fork) {
        await fork.destroy();
        await fork.awaitArchiveFlush();
        await cleanupArchive(fork.id);
      }
      await f.cleanup();
    }
  });

  it("core replacement preserves in-memory contents without sharing independent compact environments", async () => {
    const file = "/summary.md" as AbsFilePath;
    const fileIO = new InMemoryFileIO({ [file]: "original" });
    const otherIO = new InMemoryFileIO({ [file]: "independent" });
    const { core: first } = createAgentWithMock(
      { threadType: "compact", fileIO },
      uniqueThreadId("memory"),
    );
    const { core: other } = createAgentWithMock(
      { threadType: "compact", fileIO: otherIO },
      uniqueThreadId("memory-other"),
    );
    try {
      await fileIO.writeFile(file, "retained edit");
      const oldCore = first.core;
      await first.reset({ seed: [], archive: { type: "none" } });
      expect(first.core).not.toBe(oldCore);
      expect(first.context.fileIO).toBe(fileIO);
      expect(await fileIO.readFile(file)).toBe("retained edit");
      await first.destroy();
      expect(await fileIO.readFile(file)).toBe("retained edit");
      expect(await otherIO.readFile(file)).toBe("independent");
    } finally {
      for (const thread of [first, other]) {
        await thread.destroy();
        await thread.awaitArchiveFlush();
        await cleanupArchive(thread.id);
      }
    }
  });

  it("destroy during reset does not construct a replacement generation", async () => {
    const f = await fixture();
    try {
      const oldCore = f.thread.core;
      const constructions = f.create.mock.calls.length;
      const reset = f.thread.reset({ seed: [], archive: { type: "none" } });
      const rejected = expect(reset).rejects.toThrow("destroyed");
      await f.thread.destroy();
      await rejected;
      expect(f.thread.core).toBe(oldCore);
      expect(oldCore.isActive).toBe(false);
      expect(f.create).toHaveBeenCalledTimes(constructions);
      expect(f.destroy).toHaveBeenCalledTimes(1);
    } finally {
      await f.cleanup();
    }
  });

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
        f.thread.context.compactor = {
          run: async () => ({
            type: "complete",
            summary: "replacement summary",
            chunkCount: 1,
          }),
        };
        f.thread.callbacks.resolve = async () => ({
          compact: true,
          messages: [
            {
              type: "text",
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
              text: "resume",
            },
          ],
          reminders: [],
        });
        const sent = f.thread.submit({
          type: "raw",
          message: pendingMessage("@compact"),
        });
        const stream = await awaitNextStream(f.mockClient, previous);
        replacement = JSON.stringify(stream.messages);
        stream.finishResponse("end_turn");
        await sent;
      }
      expect(f.thread.core).not.toBe(oldCore);
      expect(oldCore.isActive).toBe(false);
      expect(f.thread.fileSupervisor).not.toBe(f.manager);
      expect(f.create).toHaveBeenCalledTimes(2);
      expect(f.destroy).toHaveBeenCalledTimes(1);
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
      f.thread.fileSupervisor.on("pendingUpdatesChanged", replacementChanged);
      await f.thread.fileSupervisor.refreshPendingUpdates();
      expect(replacementChanged).toHaveBeenCalled();
      await f.thread.destroy();
      expect(f.destroy).toHaveBeenCalledTimes(1);
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
          ...threadCloneContext(f.thread.context),
          contextDelivery: { pollIntervalMs: 60_000 },
        },
        callbacks: { onUpdate: () => {}, resolve: resolveAsText },
      });
      const manager = fork.fileSupervisor;
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
      expect(fork.fileSupervisor.files[f.file].agentView).toBeUndefined();
      await f.thread.destroy();
      await fs.writeFile(f.file, "fork after source destruction\n");
      expect(await f.request(fork)).toContain("fork after source destruction");
      fork.fileSupervisor.removeFileContext(f.file);
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
  it("rewinding before a git update makes the clone deliver it again", async () => {
    const f = await fixture();
    let fork: Thread | undefined;
    try {
      await f.request();
      const forkPoint = f.thread.inferenceManager.getNativeMessageIdx();
      f.setGit();
      expect(await f.request(f.thread, "observe changed git")).toContain(
        "replacement-branch",
      );
      fork = await Thread.clone({
        sourceThread: f.thread,
        newId: uniqueThreadId("git-rewind"),
        nativeMessageIdx: forkPoint,
        context: threadCloneContext(f.thread.context),
        callbacks: { onUpdate: () => {}, resolve: resolveAsText },
      });
      expect(await f.request(fork, "continue before git update")).toContain(
        "replacement-branch",
      );
    } finally {
      if (fork) {
        await fork.destroy();
        await fork.awaitArchiveFlush();
        await cleanupArchive(fork.id);
      }
      await f.cleanup();
    }
  });

  it("restores system-info delivery at the clone's effective index", async () => {
    const f = await fixture();
    const forks: Thread[] = [];
    try {
      await f.request();
      const head = Thread.clone({
        sourceThread: f.thread,
        newId: uniqueThreadId("system-info-head"),
        nativeMessageIdx: f.thread.inferenceManager.getNativeMessageIdx(),
        context: threadCloneContext(f.thread.context),
        callbacks: { onUpdate: () => {}, resolve: resolveAsText },
      });
      forks.push(head);
      const headText = await f.request(head, "continue at head");
      expect(headText.match(/<system-info>/g)).toHaveLength(1);

      const before = Thread.clone({
        sourceThread: f.thread,
        newId: uniqueThreadId("system-info-before"),
        nativeMessageIdx: -1 as NativeMessageIdx,
        context: threadCloneContext(f.thread.context),
        callbacks: { onUpdate: () => {}, resolve: resolveAsText },
      });
      forks.push(before);
      const beforeText = await f.request(before, "start before preamble");
      expect(beforeText.match(/<system-info>/g)).toHaveLength(1);
    } finally {
      for (const fork of forks) {
        await fork.destroy();
        await fork.awaitArchiveFlush();
        await cleanupArchive(fork.id);
      }
      await f.cleanup();
    }
  });

  it("a head fork retains standing and activated reminder history", async () => {
    const f = await fixture();
    let fork: Thread | undefined;
    try {
      f.thread.callbacks.resolve = async (message) => ({
        ...(await resolveAsText(message)),
        reminders: ["retain this reminder"],
      });
      const submitted = f.thread.submit(
        { type: "raw", message: pendingMessage("activate reminder") },
        "now",
      );
      const reminderStream = await f.mockClient.awaitStream();
      reminderStream.finishResponse("end_turn");
      await submitted;
      const sourceText = JSON.stringify(reminderStream.messages);
      expect(sourceText.match(/Remember the skills/g)).toHaveLength(1);
      const forkPoint = f.thread.inferenceManager.getNativeMessageIdx();

      fork = await Thread.clone({
        sourceThread: f.thread,
        newId: uniqueThreadId("reminder-head"),
        nativeMessageIdx: forkPoint,
        context: threadCloneContext(f.thread.context),
        callbacks: { onUpdate: () => {}, resolve: resolveAsText },
      });
      expect(fork.activeReminders).toEqual(new Set(["retain this reminder"]));
      const forkText = await f.request(fork, "continue at head");
      expect(forkText.match(/Remember the skills/g)).toHaveLength(1);
    } finally {
      if (fork) {
        await fork.destroy();
        await fork.awaitArchiveFlush();
        await cleanupArchive(fork.id);
      }
      await f.cleanup();
    }
  });

  it("a suspended request commits no context or reminder delivery", async () => {
    const f = await fixture();
    try {
      f.setGit();
      let suspend = true;
      f.thread.supervisors = [
        {
          onBeforeRequest: () =>
            Promise.resolve(
              suspend
                ? {
                    type: "suspend" as const,
                    reason: { kind: "stop" as const, message: "halt" },
                  }
                : { type: "none" as const },
            ),
        },
      ];

      expect(
        await f.thread.submit({
          type: "resolved",
          messages: [
            {
              type: "text",
              text: "start",
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
            },
          ],
        }),
      ).toEqual({
        type: "empty",
      });
      expect(f.mockClient.streams).toHaveLength(0);
      expect(f.manager.files[f.file].agentView).toBeUndefined();
      expect(f.thread.gitSupervisor?.gitTracker.getAgentView()?.branch).toBe(
        "initial-branch",
      );

      suspend = false;
      const sent = f.thread.submit({
        type: "resolved",
        messages: [
          {
            type: "text",
            text: "resume",
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          },
        ],
      });
      const stream = await f.mockClient.awaitStream();
      const text = JSON.stringify(stream.messages);
      expect(text).toContain("original tracked content");
      expect(text).toContain("replacement-branch");
      expect(text).toContain("<system-info>");
      expect(text).toContain("Remember the skills");
      stream.finishResponse("end_turn", { inputTokens: 1, outputTokens: 1 });
      await sent;
    } finally {
      await f.cleanup();
    }
  });

  it.each([
    false,
    true,
  ])("tip fork preserves delivery through its effective clone point (busy=%s)", async (busy) => {
    const f = await fixture();
    let fork: Thread | undefined;
    try {
      await f.request();
      await fs.writeFile(f.file, "pending external edit\n");
      await f.manager.refreshPendingUpdates();
      let sent: ReturnType<Thread["submit"]> | undefined;
      if (busy) {
        sent = f.thread.submit({
          type: "resolved",
          messages: [
            {
              type: "text",
              text: "in flight",
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
            },
          ],
        });
        await awaitNextStream(f.mockClient, f.mockClient.streams.at(-1));
      }
      fork = await Thread.clone({
        sourceThread: f.thread,
        newId: uniqueThreadId("tip-fork"),
        nativeMessageIdx: f.thread.inferenceManager.getNativeMessageIdx(),
        context: {
          ...threadCloneContext(f.thread.context),
          contextDelivery: { pollIntervalMs: 60_000 },
        },
        callbacks: { onUpdate: () => {}, resolve: resolveAsText },
      });
      const tracker = fork.fileSupervisor;
      expect(tracker).not.toBe(f.manager);
      expect(tracker.files[f.file].agentView).toEqual(
        f.manager.files[f.file].agentView,
      );
      expect(tracker.getPendingUpdates()).toEqual({});
      if (busy) {
        expect(await tracker.hasPendingContent()).toBe(false);
        await f.thread.abort();
        await sent;
      } else {
        expect(await tracker.hasPendingContent()).toBe(true);
        expect(tracker.getPendingUpdates()).toEqual(
          f.manager.getPendingUpdates(),
        );
        expect(tracker.getPendingUpdates()).not.toBe(
          f.manager.getPendingUpdates(),
        );
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
      const replacement = f.thread.fileSupervisor;
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
