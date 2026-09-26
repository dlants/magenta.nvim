import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import type { ThreadId } from "../chat-types.ts";
import { PRE_HISTORY } from "../supervisors/history.ts";
import { type Harness, withHarness } from "../test/harness.ts";
import { created, getFileSupervisor } from "../test-helpers.ts";
import type { Thread } from "../thread.ts";
import type { ToolName, ToolRequestId } from "../tool-types.ts";
import { pollUntil } from "../utils/async.ts";
import {
  type AbsFilePath,
  detectFileTypeViaFileIO,
  relativePath,
} from "../utils/files.ts";

const JPEG = fs.readFileSync(
  path.join(import.meta.dirname, "../test/fixtures/test.jpg"),
);
const POEM = "/project/poem.txt";
const hierarchy = {
  "/project/nested/dir/file.txt": "leaf content",
  "/project/nested/context.md": "nested context",
};
const hierarchyOptions = { hierarchyContextFileNames: ["context.md"] };

async function addFile(h: Harness, thread: Thread, abs: string) {
  const info = await detectFileTypeViaFileIO(abs as AbsFilePath, h.fileIO);
  if (!info) throw new Error(`no such file ${abs}`);
  thread.contextFiles.addFileContext(
    abs as AbsFilePath,
    relativePath(h.host.cwd, abs as AbsFilePath, h.host.homeDir),
    info,
  );
}

function relPaths(thread: Thread): string[] {
  return Object.values(thread.contextFiles.files).map(
    (f) => f.relFilePath as string,
  );
}

function waitForPaths(thread: Thread, expected: string[]) {
  return pollUntil(() => {
    const paths = relPaths(thread);
    for (const p of expected) {
      if (!paths.includes(p)) throw new Error(`${p} not yet tracked`);
    }
    return paths;
  });
}

it("returns diff when file is edited on disk", () =>
  withHarness({ files: { [POEM]: "line one\nline two\n" } }, async (h) => {
    const { thread } = await h.createRoot();
    await addFile(h, thread, POEM);
    const supervisor = getFileSupervisor(thread);
    await supervisor.getContextUpdate(PRE_HISTORY);
    await h.fileIO.writeFile(POEM, "Edited moonlight\nline two\n");
    const update = (await supervisor.getContextUpdate(PRE_HISTORY))[
      POEM as AbsFilePath
    ];
    expect(update?.absFilePath).toBe(POEM);
    expect(update?.update).toMatchObject({
      status: "ok",
      value: {
        type: "diff",
        patch: expect.stringContaining("Edited moonlight") as string,
      },
    });
  }));

it("handles file deletion during tracking", () =>
  withHarness({ files: { "/project/temp.txt": "tracked" } }, async (h) => {
    const { thread } = await h.createRoot();
    await addFile(h, thread, "/project/temp.txt");
    const supervisor = getFileSupervisor(thread);
    const first = await supervisor.getContextUpdate(PRE_HISTORY);
    expect(first["/project/temp.txt" as AbsFilePath]).toBeDefined();
    await h.fileIO.deleteFile("/project/temp.txt");
    const second = await supervisor.getContextUpdate(PRE_HISTORY);
    expect(supervisor.files["/project/temp.txt" as AbsFilePath]).toBe(
      undefined,
    );
    expect(second["/project/temp.txt" as AbsFilePath]?.update).toMatchObject({
      status: "ok",
      value: { type: "file-deleted" },
    });
  }));

it("issuing a getFile request adds the file to the context but doesn't send its contents twice", () =>
  withHarness({}, async (h) => {
    await h.fileIO.writeBinaryFile("/project/test.jpg", JPEG);
    const { thread } = await h.createRoot();
    expect(thread.contextFiles.files).toEqual({});
    void h.send(thread, "Please analyze the image test.jpg");
    (await h.nextStream()).respond({
      stopReason: "tool_use",
      text: "I'll analyze the image",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "img_request" as ToolRequestId,
            toolName: "get_files" as ToolName,
            input: { files: [{ filePath: "test.jpg" }] },
          },
        },
      ],
    });
    await h.nextStream();
    const flattened = thread
      .getProviderMessages()
      .flatMap((msg) =>
        msg.content.map(
          (c) => `${msg.role};${c.type};${c.type === "text" ? c.text : ""}`,
        ),
      );
    expect(flattened).toEqual([
      "user;system_info;",
      "user;system_reminder;",
      "user;text;Please analyze the image test.jpg",
      "assistant;text;I'll analyze the image",
      "assistant;tool_use;",
      "user;tool_result;",
      "user;system_reminder;",
    ]);
    expect(
      thread.contextFiles.files["/project/test.jpg" as AbsFilePath]
        ?.fileTypeInfo.category,
    ).toBe("image");
  }));

it("image in context is sent as an image block on first message", () =>
  withHarness({}, async (h) => {
    await h.fileIO.writeBinaryFile("/project/test.jpg", JPEG);
    const { thread } = await h.createRoot();
    await addFile(h, thread, "/project/test.jpg");
    void h.send(thread, "describe this image");
    const stream = await h.nextStream();
    const content = stream.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((c) => c.type === "text" || c.type === "image");
    const update = content.find(
      (c) => c.type === "text" && c.text.includes("<context_update>"),
    );
    expect(update).toMatchObject({
      text: expect.stringContaining("test.jpg (image attachment)") as string,
    });
    expect(JSON.stringify(update)).not.toContain("(0 lines)");
    expect(content.find((c) => c.type === "image")).toMatchObject({
      source: { media_type: "image/jpeg" },
    });
  }));

it("autoContext is delivered in the first message", () =>
  withHarness(
    {
      files: { "/project/test-auto-context.md": "auto content" },
      options: { autoContext: ["test-auto-context.md"] },
    },
    async (h) => {
      const { thread } = await h.createRoot();
      expect(relPaths(thread)).toEqual(["test-auto-context.md"]);
      void h.send(thread, "hello");
      const stream = await h.nextStream();
      expect(JSON.stringify(stream.messages)).toContain("auto content");
    },
  ));

it("autoContext loads home context.md before project context.md", () =>
  withHarness(
    {
      files: {
        "/home/.magenta/context.md": "HOME_CONTEXT_CONTENT",
        "/project/test-auto-context.md": "PROJECT_CONTEXT_CONTENT",
      },
      options: {
        autoContext: ["~/.magenta/context.md", "test-auto-context.md"],
      },
    },
    async (h) => {
      const { thread } = await h.createRoot();
      void h.send(thread, "hello");
      const text = JSON.stringify((await h.nextStream()).messages);
      const homeIdx = text.indexOf("HOME_CONTEXT_CONTENT");
      const projectIdx = text.indexOf("PROJECT_CONTEXT_CONTENT");
      expect(homeIdx).toBeGreaterThan(-1);
      expect(projectIdx).toBeGreaterThan(homeIdx);
    },
  ));

it("large context files are summarized", () =>
  withHarness(
    {
      files: {
        "/project/huge.txt": Array.from(
          { length: 4000 },
          (_, i) => `line ${i}: ${"x".repeat(40)}`,
        ).join("\n"),
      },
    },
    async (h) => {
      const { thread } = await h.createRoot();
      await addFile(h, thread, "/project/huge.txt");
      void h.send(thread, "describe this file");
      const text = JSON.stringify((await h.nextStream()).messages);
      expect(text).toContain("[File too large for full context");
      expect(text).toContain("[File summary:");
      expect(
        thread.contextFiles.files["/project/huge.txt" as AbsFilePath]?.agentView
          ?.type,
      ).toBe("summary");
    },
  ));

it("user's @file: adds parent context.md", () =>
  withHarness({ files: hierarchy, options: hierarchyOptions }, async (h) => {
    const { thread } = await h.createRoot();
    void h.send(thread, "@file:nested/dir/file.txt");
    await waitForPaths(thread, ["nested/dir/file.txt", "nested/context.md"]);
  }));

it("agent's get_file adds parent context.md", () =>
  withHarness({ files: hierarchy, options: hierarchyOptions }, async (h) => {
    const { thread } = await h.createRoot();
    void h.send(thread, "Please read the leaf file");
    (await h.nextStream()).respond({
      stopReason: "tool_use",
      text: "Reading file",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "get_leaf" as ToolRequestId,
            toolName: "get_files" as ToolName,
            input: { files: [{ filePath: "nested/dir/file.txt" }] },
          },
        },
      ],
    });
    await waitForPaths(thread, ["nested/dir/file.txt", "nested/context.md"]);
  }));

it("subagent spawn triggers discovery for contextFiles", () =>
  withHarness({ files: hierarchy, options: hierarchyOptions }, async (h) => {
    const { id, thread } = await h.createRoot();
    void h.send(thread, "Use spawn_subagents");
    (await h.nextStream()).respond({
      stopReason: "tool_use",
      text: "Spawning",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "spawn_test" as ToolRequestId,
            toolName: "spawn_subagents" as ToolName,
            input: {
              agents: [
                {
                  prompt: "Subagent task with leaf",
                  contextFiles: ["nested/dir/file.txt"],
                },
              ],
            },
          },
        },
      ],
    });
    await h.streamWithText("Subagent task with leaf");
    const childId = h.session.listThreads().find((r) => r.parentThreadId === id)
      ?.id as ThreadId;
    await waitForPaths(h.thread(childId), [
      "nested/dir/file.txt",
      "nested/context.md",
    ]);
  }));

it("initialFiles (autoContext) triggers discovery", () =>
  withHarness(
    {
      files: hierarchy,
      options: { ...hierarchyOptions, autoContext: ["nested/dir/file.txt"] },
    },
    async (h) => {
      const { thread } = await h.createRoot();
      await waitForPaths(thread, ["nested/dir/file.txt", "nested/context.md"]);
    },
  ));

it("forked thread inherits parent's discovered context files", () =>
  withHarness({ files: hierarchy, options: hierarchyOptions }, async (h) => {
    const { id, thread } = await h.createRoot();
    await addFile(h, thread, "/project/nested/dir/file.txt");
    await waitForPaths(thread, ["nested/context.md"]);
    const fork = h.thread(await created(h.session.forkThread(id)));
    expect(relPaths(fork)).toEqual(
      expect.arrayContaining(["nested/dir/file.txt", "nested/context.md"]),
    );
  }));

it("discovery cascade is idempotent - no duplicate fileAdded events", () =>
  withHarness(
    {
      files: {
        "/project/a/b/c/leaf.txt": "leaf",
        "/project/a/b/context.md": "B context",
        "/project/a/context.md": "A context",
      },
      options: hierarchyOptions,
    },
    async (h) => {
      const { thread } = await h.createRoot();
      const supervisor = getFileSupervisor(thread);
      const added: string[] = [];
      supervisor.callbacks = {
        ...supervisor.callbacks,
        onFileAdded: (p) => {
          added.push(p);
        },
      };
      await addFile(h, thread, "/project/a/b/c/leaf.txt");
      await waitForPaths(thread, [
        "a/b/c/leaf.txt",
        "a/b/context.md",
        "a/context.md",
      ]);
      expect(new Set(added).size).toBe(added.length);
    },
  ));

it("hierarchyContextFileNames: [] disables discovery", () =>
  withHarness(
    { files: hierarchy, options: { hierarchyContextFileNames: [] } },
    async (h) => {
      const { thread } = await h.createRoot();
      await addFile(h, thread, "/project/nested/dir/file.txt");
      await new Promise((r) => setTimeout(r, 20));
      expect(relPaths(thread)).toEqual(["nested/dir/file.txt"]);
    },
  ));
