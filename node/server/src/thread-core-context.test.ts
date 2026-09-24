// biome-ignore-all lint/complexity/useLiteralKeys: White-box lifecycle tests deliberately access private implementation state.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FsFileIO } from "./capabilities/file-io.ts";
import type { GitState } from "./capabilities/git-client.ts";
import { TokenBudget } from "./compaction/token-budget.ts";
import { InMemoryFileIO } from "./edl/in-memory-file-io.ts";
import type { NativeMessageIdx } from "./providers/provider-types.ts";
import { pendingMessage } from "./submission/index.ts";
import { FileSupervisor } from "./supervisors/file-supervisor.ts";
import { PRE_HISTORY } from "./supervisors/history.ts";
import {
  awaitNextStream,
  cleanupArchive,
  cloneThread,
  compactorSlot,
  compactResolved,
  createAgentWithMock,
  getContextDeliveries,
  resetThread,
  type TestContextOverrides,
  uniqueThreadId,
} from "./test-helpers.ts";
import type { Thread } from "./thread.ts";
import { flushArchive } from "./thread-logger.ts";
import {
  type AbsFilePath,
  FileCategory,
  type HomeDir,
  type NvimCwd,
  type RelFilePath,
  type UnresolvedFilePath,
} from "./utils/files.ts";

async function fixture(overrides: TestContextOverrides = {}) {
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
  const create = vi.spyOn(FileSupervisor, "create");
  const { core: thread, mockClient } = createAgentWithMock(
    {
      cwd,
      homeDir,
      fileIO,
      initialGitState: git,
      gitClient: { getState: async () => git },
      ...overrides,
    },
    uniqueThreadId("core-context"),
  );
  const manager = thread["core"].fileSupervisor;
  manager.addFileContext(file, "tracked.txt" as RelFilePath, {
    category: FileCategory.TEXT,
    mimeType: "text/plain",
    extension: "txt",
  });
  const destroy = vi.spyOn(manager, "destroy");
  const changed = vi.fn();
  manager.callbacks = {
    ...manager.callbacks,
    onPendingUpdatesChanged: changed,
  };
  thread.setTitle("context integration");
  async function request(target = thread, text = "continue") {
    const previous = mockClient.streams.at(-1);
    const sent = target.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
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
    fileDeliveries: () =>
      getContextDeliveries(thread).filter((delivery) => delivery.files).length,
    request,
    setGit: () => {
      git = { ...git, branch: "replacement-branch", headSha: "222222222" };
    },
    async cleanup() {
      await thread.destroy();
      await flushArchive(thread);
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
      await resetThread(f.thread, { archive: { type: "none" } });
      expect(f.destroy).toHaveBeenCalledTimes(1);
      const retiredIdx = 0 as NativeMessageIdx;
      f.manager.callbacks.onFileAdded?.(f.file);
      f.manager.callbacks.onSent?.({}, retiredIdx);
      expect(f.fileDeliveries()).toBe(0);
      expect(f.thread.getContextDelivery(retiredIdx)).toBeUndefined();
      const added = path.join(f.cwd, "added.txt") as AbsFilePath;
      await fs.writeFile(added, "new generation content");
      await f.thread["core"].fileSupervisor.addFiles([
        added as string as UnresolvedFilePath,
      ]);
      expect(f.thread.contextFiles.files[added]).toBeDefined();
      expect(await f.request()).toContain("new generation content");
      expect(f.fileDeliveries()).toBe(1);
      expect(f.thread["context"].fileIO).toBe(f.fileIO);
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
      fork = await cloneThread({
        sourceThread: f.thread,
        newId: uniqueThreadId("destination"),
        nativeMessageIdx: f.thread["core"].manager.getNativeMessageIdx(),
        context: {
          ...f.thread["context"],
          fileIO,
          gitClient,
        },
        callbacks: { onUpdate: () => {} },
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
        await flushArchive(fork);
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
      const oldCore = first["core"];
      await resetThread(first, { archive: { type: "none" } });
      expect(first["core"]).not.toBe(oldCore);
      expect(first["context"].fileIO).toBe(fileIO);
      expect(await fileIO.readFile(file)).toBe("retained edit");
      await first.destroy();
      expect(await fileIO.readFile(file)).toBe("retained edit");
      expect(await otherIO.readFile(file)).toBe("independent");
    } finally {
      for (const thread of [first, other]) {
        await thread.destroy();
        await flushArchive(thread);
        await cleanupArchive(thread.id);
      }
    }
  });

  it("destroy during reset waits for the replacement and disposes it", async () => {
    const f = await fixture();
    try {
      const oldCore = f.thread["core"];
      const reset = resetThread(f.thread, { archive: { type: "none" } });
      await f.thread.destroy();
      const replacement = await reset;
      expect(replacement).not.toBe(oldCore);
      expect(oldCore.isActive).toBe(false);
      expect(replacement.isActive).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  it.each([
    "reset",
    "compaction",
  ] as const)("%s reseeds files and preamble with a fresh tracker without replaying delivered comments", async (operation) => {
    const f = await fixture({
      resolve: async () =>
        compactResolved([
          {
            type: "text",
            text: "resume",
          },
        ]),
    });
    try {
      const first = await f.request();
      expect(first).toContain("original tracked content");
      expect(first).toContain("<system-info>");
      const oldCore = f.thread["core"];
      f.setGit();
      await fs.writeFile(f.file, "replacement tracked content\n");
      let replacement: string;
      if (operation === "reset") {
        await resetThread(f.thread, { archive: { type: "none" } });
        replacement = await f.request(f.thread, "replacement summary");
      } else {
        const previous = f.mockClient.streams.at(-1);
        compactorSlot(f.thread).compactor = {
          run: async () => ({
            type: "complete",
            summary: "replacement summary",
            chunkCount: 1,
          }),
        };

        const sent = f.thread.submit({
          type: "raw",
          message: pendingMessage("@compact"),
        });
        const stream = await awaitNextStream(f.mockClient, previous);
        replacement = JSON.stringify(stream.messages);
        stream.finishResponse("end_turn");
        await sent;
      }
      expect(f.thread["core"]).not.toBe(oldCore);
      expect(oldCore.isActive).toBe(false);
      expect(f.thread["core"].fileSupervisor).not.toBe(f.manager);
      expect(f.create).toHaveBeenCalledTimes(2);
      expect(f.destroy).toHaveBeenCalledTimes(1);
      expect(replacement).toContain("replacement summary");
      expect(replacement).toContain("replacement tracked content");
      expect(replacement).not.toContain("original tracked content");
      expect(replacement).not.toContain("```diff");
      expect(replacement).toContain("replacement-branch");
      expect(replacement).toContain("<system-info>");
      expect(replacement).toContain("replacement-branch");
      expect(f.fileDeliveries()).toBe(1);
      f.changed.mockClear();
      await fs.writeFile(f.file, "a later tracked edit\n");
      const replacementChanged = vi.fn();
      const replacementSupervisor = f.thread["core"].fileSupervisor;
      replacementSupervisor.callbacks = {
        ...replacementSupervisor.callbacks,
        onPendingUpdatesChanged: replacementChanged,
      };
      await f.thread["core"].fileSupervisor.refreshPendingUpdates();
      expect(replacementChanged).toHaveBeenCalled();
      await f.thread.destroy();
      expect(f.destroy).toHaveBeenCalledTimes(1);
      f.changed.mockClear();
      f.manager.callbacks.onPendingUpdatesChanged?.();
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
      fork = await cloneThread({
        sourceThread: f.thread,
        newId: uniqueThreadId("context-fork"),
        nativeMessageIdx: forkPoint,
        context: {
          ...f.thread["context"],
        },
        callbacks: { onUpdate: () => {} },
      });
      const manager = fork["core"].fileSupervisor;
      fork.setTitle("fork context integration");
      expect(JSON.stringify(fork.getProviderMessages())).not.toContain(
        "source-only later request",
      );
      expect(manager.files[f.file].agentView).toBeUndefined();
      const sourceView = structuredClone(f.manager.files[f.file].agentView);
      const forkText = await f.request(fork);
      expect(forkText).toContain("source-only later content");
      expect(f.manager.files[f.file].agentView).toEqual(sourceView);
      await resetThread(fork, { archive: { type: "none" } });
      expect(f.manager.files[f.file].agentView).toEqual(sourceView);
      expect(
        fork["core"].fileSupervisor.files[f.file].agentView,
      ).toBeUndefined();
      await f.thread.destroy();
      await fs.writeFile(f.file, "fork after source destruction\n");
      expect(await f.request(fork)).toContain("fork after source destruction");
      fork["core"].fileSupervisor.removeFileContext(f.file);
      expect(f.manager.files[f.file]).toBeDefined();
    } finally {
      if (fork) {
        await fork.destroy();
        await flushArchive(fork);
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
      const forkPoint = f.thread["core"].manager.getNativeMessageIdx();
      f.setGit();
      expect(await f.request(f.thread, "observe changed git")).toContain(
        "replacement-branch",
      );
      fork = await cloneThread({
        sourceThread: f.thread,
        newId: uniqueThreadId("git-rewind"),
        nativeMessageIdx: forkPoint,
        context: f.thread["context"],
        callbacks: { onUpdate: () => {} },
      });
      expect(await f.request(fork, "continue before git update")).toContain(
        "replacement-branch",
      );
    } finally {
      if (fork) {
        await fork.destroy();
        await flushArchive(fork);
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
      const head = cloneThread({
        sourceThread: f.thread,
        newId: uniqueThreadId("system-info-head"),
        nativeMessageIdx: f.thread["core"].manager.getNativeMessageIdx(),
        context: f.thread["context"],
        callbacks: { onUpdate: () => {} },
      });
      forks.push(head);
      const headText = await f.request(head, "continue at head");
      expect(headText.match(/<system-info>/g)).toHaveLength(1);

      const before = cloneThread({
        sourceThread: f.thread,
        newId: uniqueThreadId("system-info-before"),
        nativeMessageIdx: -1 as NativeMessageIdx,
        context: f.thread["context"],
        callbacks: { onUpdate: () => {} },
      });
      forks.push(before);
      const beforeText = await f.request(before, "start before preamble");
      expect(beforeText.match(/<system-info>/g)).toHaveLength(1);
    } finally {
      for (const fork of forks) {
        await fork.destroy();
        await flushArchive(fork);
        await cleanupArchive(fork.id);
      }
      await f.cleanup();
    }
  });

  it("a head fork retains standing and activated reminder history", async () => {
    const f = await fixture({
      resolve: async (message) => ({
        type: "send",
        prompt: {
          content: [{ type: "text", text: message }],
          reminders: ["retain this reminder"],
        },
      }),
    });
    let fork: Thread | undefined;
    try {
      const submitted = f.thread.submit({
        type: "raw",
        message: pendingMessage("activate reminder"),
      });
      const reminderStream = await f.mockClient.awaitStream();
      reminderStream.finishResponse("end_turn");
      await submitted;
      const sourceText = JSON.stringify(reminderStream.messages);
      expect(sourceText.match(/Remember the skills/g)).toHaveLength(1);
      const forkPoint = f.thread["core"].manager.getNativeMessageIdx();

      fork = await cloneThread({
        sourceThread: f.thread,
        newId: uniqueThreadId("reminder-head"),
        nativeMessageIdx: forkPoint,
        context: f.thread["context"],
        callbacks: { onUpdate: () => {} },
      });
      expect(fork.activeReminders).toEqual(new Set(["retain this reminder"]));
      const forkText = await f.request(fork, "continue at head");
      expect(forkText.match(/Remember the skills/g)).toHaveLength(1);
    } finally {
      if (fork) {
        await fork.destroy();
        await flushArchive(fork);
        await cleanupArchive(fork.id);
      }
      await f.cleanup();
    }
  });

  it("context injected into a budget-stopped request is re-delivered by the fresh core", async () => {
    const f = await fixture({
      compaction: {
        compactor: {
          run: () =>
            Promise.resolve({
              type: "complete",
              summary: "SUMMARY TEXT",
              chunkCount: 1,
            }),
        },
        tokenBudget: TokenBudget.create({ threshold: 100, handoff: "go on" }),
      },
    });
    try {
      f.setGit();
      f.mockClient.mockInputTokenCountOnce = 200;
      const sent = f.thread.submit({
        type: "resolved",
        messages: [
          {
            type: "text",
            text: "start",
          },
        ],
      });
      const stream = await f.mockClient.awaitStream();
      const text = JSON.stringify(stream.messages);
      expect(text).toContain("SUMMARY TEXT");
      expect(text).toContain("original tracked content");
      expect(text).toContain("replacement-branch");
      expect(text).toContain("<system-info>");
      stream.finishResponse("end_turn", { inputTokens: 1, outputTokens: 1 });
      expect(await sent).toEqual({ type: "completed", stopReason: "end_turn" });
      expect(f.mockClient.streams).toHaveLength(1);
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
            },
          ],
        });
        await awaitNextStream(f.mockClient, f.mockClient.streams.at(-1));
      }
      fork = await cloneThread({
        sourceThread: f.thread,
        newId: uniqueThreadId("tip-fork"),
        nativeMessageIdx: f.thread["core"].manager.getNativeMessageIdx(),
        context: {
          ...f.thread["context"],
        },
        callbacks: { onUpdate: () => {} },
      });
      const tracker = fork["core"].fileSupervisor;
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
        await flushArchive(fork);
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
      const pending = f.manager.getContextUpdate(PRE_HISTORY);
      await reading;
      await resetThread(f.thread, { archive: { type: "none" } });
      const replacement = f.thread["core"].fileSupervisor;
      f.changed.mockClear();
      release("stale read content\n");
      expect(await pending).toEqual({});
      expect(f.manager.files[f.file].agentView).toEqual(originalView);
      expect(replacement.files[f.file].agentView).toBeUndefined();
      expect(f.changed).not.toHaveBeenCalled();
      expect(f.fileDeliveries()).toBe(0);
      read.mockRestore();
      expect(await f.request()).toContain("original tracked content");
    } finally {
      await f.cleanup();
    }
  });
});
