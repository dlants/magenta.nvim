import { describe, it, expect, vi } from "vitest";
import { ContextManager, type DiffUpdate } from "./context-manager";
import { InMemoryFileIO } from "../edl/in-memory-file-io";
import { FileCategory, type AbsFilePath, type RelFilePath } from "../utils/files";
import type { NvimCwd, HomeDir } from "../utils/files";
import type { Nvim } from "../nvim/nvim-node";
import type { MagentaOptions } from "../options";
import type { RootMsg } from "../root-msg";

function createTestContextManager(files: Record<string, string>) {
  const fileIO = new InMemoryFileIO(files);
  const dispatched: RootMsg[] = [];
  const mockNvim = {
    logger: {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    },
  } as unknown as Nvim;

  const cm = new ContextManager(
    () => {},
    {
      cwd: "/test" as NvimCwd,
      homeDir: "/home" as HomeDir,
      dispatch: (msg: RootMsg) => { dispatched.push(msg); },
      fileIO,
      nvim: mockNvim,
      options: {} as MagentaOptions,
    },
  );

  return { cm, fileIO, dispatched };
}

const TEST_PATH = "/test/file.txt" as AbsFilePath;
const TEST_REL = "file.txt" as RelFilePath;
const TEXT_FILE_TYPE = {
  category: FileCategory.TEXT,
  mimeType: "text/plain",
  extension: ".txt",
};

describe("ContextManager unit tests", () => {
  it("get_file sets agentView", async () => {
    const { cm } = createTestContextManager({
      [TEST_PATH]: "hello world",
    });

    cm.update({
      type: "tool-applied",
      absFilePath: TEST_PATH,
      tool: { type: "get-file", content: "hello world" },
      fileTypeInfo: TEXT_FILE_TYPE,
    });

    expect(cm.files[TEST_PATH].agentView).toEqual({
      type: "text",
      content: "hello world",
    });

    // No update needed since content hasn't changed
    const updates = await cm.getContextUpdate();
    expect(Object.keys(updates).length).toBe(0);
  });

  it("edl-edit sets agentView", async () => {
    const { cm } = createTestContextManager({
      [TEST_PATH]: "edited content",
    });

    cm.update({
      type: "tool-applied",
      absFilePath: TEST_PATH,
      tool: { type: "edl-edit", content: "edited content" },
      fileTypeInfo: TEXT_FILE_TYPE,
    });

    expect(cm.files[TEST_PATH].agentView).toEqual({
      type: "text",
      content: "edited content",
    });

    // No update needed since fileIO has same content
    const updates = await cm.getContextUpdate();
    expect(Object.keys(updates).length).toBe(0);
  });

  it("file updated after agentView set returns a diff", async () => {
    const { cm, fileIO } = createTestContextManager({
      [TEST_PATH]: "original content",
    });

    // Simulate get_file tool setting agentView
    cm.update({
      type: "tool-applied",
      absFilePath: TEST_PATH,
      tool: { type: "get-file", content: "original content" },
      fileTypeInfo: TEXT_FILE_TYPE,
    });

    // Simulate file being modified (e.g., by a formatter)
    await fileIO.writeFile(TEST_PATH, "formatted content");

    const updates = await cm.getContextUpdate();
    const update = updates[TEST_PATH];
    expect(update).toBeDefined();
    expect(update.update.status).toBe("ok");
    if (update.update.status !== "ok") throw new Error("Expected ok");
    expect(update.update.value.type).toBe("diff");

    const diff = update.update.value as DiffUpdate;
    expect(diff.patch).toContain("original content");
    expect(diff.patch).toContain("formatted content");
  });

  it("edl-edit followed by formatter change returns a diff", async () => {
    const { cm, fileIO } = createTestContextManager({
      [TEST_PATH]: "const x=1",
    });

    // EDL writes the file
    cm.update({
      type: "tool-applied",
      absFilePath: TEST_PATH,
      tool: { type: "edl-edit", content: "const x=1" },
      fileTypeInfo: TEXT_FILE_TYPE,
    });

    // Formatter rewrites it
    await fileIO.writeFile(TEST_PATH, "const x = 1;\n");

    const updates = await cm.getContextUpdate();
    const update = updates[TEST_PATH];
    expect(update).toBeDefined();
    expect(update.update.status).toBe("ok");
    if (update.update.status !== "ok") throw new Error("Expected ok");
    expect(update.update.value.type).toBe("diff");

    const diff = update.update.value as DiffUpdate;
    expect(diff.patch).toContain("const x = 1;");
  });

  it("no update when file content matches agentView", async () => {
    const { cm } = createTestContextManager({
      [TEST_PATH]: "same content",
    });

    cm.update({
      type: "tool-applied",
      absFilePath: TEST_PATH,
      tool: { type: "get-file", content: "same content" },
      fileTypeInfo: TEXT_FILE_TYPE,
    });

    const updates = await cm.getContextUpdate();
    expect(Object.keys(updates).length).toBe(0);
  });

  it("avoids redundant context update after edl tool application", async () => {
    const originalContent = "original line 1\noriginal line 2\n";
    const editedContent = "original line 1\nedited line 2\n";
    const { cm, fileIO } = createTestContextManager({
      [TEST_PATH]: originalContent,
    });

    // Add file and establish initial agentView
    cm.update({
      type: "add-file-context",
      absFilePath: TEST_PATH,
      relFilePath: TEST_REL,
      fileTypeInfo: TEXT_FILE_TYPE,
    });
    await cm.getContextUpdate();

    // EDL tool writes the file and sets agentView
    await fileIO.writeFile(TEST_PATH, editedContent);
    cm.update({
      type: "tool-applied",
      absFilePath: TEST_PATH,
      tool: { type: "edl-edit", content: editedContent },
      fileTypeInfo: TEXT_FILE_TYPE,
    });

    // Next context update should be empty — agent already knows the content
    const updates = await cm.getContextUpdate();
    expect(Object.keys(updates).length).toBe(0);
  });

  it("file deleted after agentView set returns file-deleted", async () => {
    const { cm, fileIO } = createTestContextManager({
      [TEST_PATH]: "some content",
    });

    cm.update({
      type: "tool-applied",
      absFilePath: TEST_PATH,
      tool: { type: "get-file", content: "some content" },
      fileTypeInfo: TEXT_FILE_TYPE,
    });

    // Delete the file
    fileIO.deleteFile(TEST_PATH);

    const updates = await cm.getContextUpdate();
    const update = updates[TEST_PATH];
    expect(update).toBeDefined();
    expect(update.update.status).toBe("ok");
    if (update.update.status !== "ok") throw new Error("Expected ok");
    expect(update.update.value.type).toBe("file-deleted");

    // File should be removed from context
    expect(cm.files[TEST_PATH]).toBeUndefined();
  });
});