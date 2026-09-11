import { describe, expect, it, vi } from "vitest";
import { InMemoryFileIO } from "../edl/in-memory-file-io.ts";
import type { ProviderImageContent } from "../providers/provider-types.ts";
import {
  type AbsFilePath,
  FileCategory,
  type HomeDir,
  type NvimCwd,
  type RelFilePath,
} from "../utils/files.ts";
import type { DiffUpdate, WholeFileUpdate } from "./file-supervisor.ts";
import { buildClonedFiles, FileSupervisor } from "./file-supervisor.ts";

vi.mock("../utils/pdf-pages.ts", () => ({
  getSummaryAsProviderContent: vi.fn().mockResolvedValue({
    status: "ok",
    value: [
      {
        type: "text",
        text: `PDF Document: /test/doc.pdf\nPages: 3\n\nUse get-file tool with a pdfPage parameter to access specific pages.`,
      },
    ],
  }),
}));

function createTestFileSupervisor(files: Record<string, string>) {
  const fileIO = new InMemoryFileIO(files);
  const mockLogger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };

  const cm = new FileSupervisor(
    mockLogger,
    fileIO,
    "/test" as NvimCwd,
    "/home" as HomeDir,
  );

  return { cm, fileIO, mockLogger };
}

const TEST_PATH = "/test/file.txt" as AbsFilePath;
const TEST_REL = "file.txt" as RelFilePath;
const TEXT_FILE_TYPE = {
  category: FileCategory.TEXT,
  mimeType: "text/plain",
  extension: ".txt",
};

describe("FileSupervisor unit tests", () => {
  it("full-history clones retain independent delivered baselines, not current disk content", async () => {
    const { cm, fileIO, mockLogger } = createTestFileSupervisor({
      [TEST_PATH]: "delivered content\n",
    });
    cm.addFileContext(TEST_PATH, TEST_REL, TEXT_FILE_TYPE);
    await cm.getContextUpdate();
    await fileIO.writeFile(TEST_PATH, "not delivered yet\n");
    await cm.refreshPendingUpdates();
    const clone = new FileSupervisor(
      mockLogger,
      fileIO,
      "/test" as NvimCwd,
      "/home" as HomeDir,
      buildClonedFiles(cm.files, "preserve"),
    );
    await clone.refreshPendingUpdates();
    expect(clone.files[TEST_PATH].agentView).toEqual({
      type: "text",
      content: "delivered content\n",
    });
    expect(clone.getPendingUpdates()).toEqual(cm.getPendingUpdates());
    expect(clone.getPendingUpdates()).not.toBe(cm.getPendingUpdates());
    await cm.getContextUpdate();
    const updates = await clone.getContextUpdate();
    expect(updates[TEST_PATH].update).toMatchObject({
      status: "ok",
      value: { type: "diff" },
    });
    const update = updates[TEST_PATH].update;
    if (update.status !== "ok" || update.value.type !== "diff")
      throw new Error("Expected diff");
    expect(update.value.patch).toContain("-delivered content");
    expect(update.value.patch).toContain("+not delivered yet");
    expect(await clone.getContextUpdate()).toEqual({});
  });

  it("truncated-history clones reseed delivered files", async () => {
    const { cm, fileIO, mockLogger } = createTestFileSupervisor({
      [TEST_PATH]: "delivered content",
    });
    cm.addFileContext(TEST_PATH, TEST_REL, TEXT_FILE_TYPE);
    await cm.getContextUpdate();
    const clone = new FileSupervisor(
      mockLogger,
      fileIO,
      "/test" as NvimCwd,
      "/home" as HomeDir,
      buildClonedFiles(cm.files, "reseed"),
    );
    expect(clone.files[TEST_PATH].agentView).toBeUndefined();
    expect((await clone.getContextUpdate())[TEST_PATH].update).toMatchObject({
      status: "ok",
      value: { type: "whole-file" },
    });
    expect(await cm.getContextUpdate()).toEqual({});
  });

  it("addFileContext is idempotent for already-tracked files", async () => {
    const { cm } = createTestFileSupervisor({
      [TEST_PATH]: "hello world",
    });

    cm.toolApplied(
      TEST_PATH,
      { type: "get-file", content: "hello world" },
      TEXT_FILE_TYPE,
    );

    expect(cm.files[TEST_PATH].agentView).toEqual({
      type: "text",
      content: "hello world",
    });

    const spy = vi.fn();
    cm.on("fileAdded", spy);

    cm.addFileContext(TEST_PATH, TEST_REL, TEXT_FILE_TYPE);

    expect(cm.files[TEST_PATH].agentView).toEqual({
      type: "text",
      content: "hello world",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("get_file sets agentView", async () => {
    const { cm } = createTestFileSupervisor({
      [TEST_PATH]: "hello world",
    });

    cm.toolApplied(
      TEST_PATH,
      { type: "get-file", content: "hello world" },
      TEXT_FILE_TYPE,
    );

    expect(cm.files[TEST_PATH].agentView).toEqual({
      type: "text",
      content: "hello world",
    });

    const updates = await cm.getContextUpdate();
    expect(Object.keys(updates).length).toBe(0);
  });

  it("edl-edit sets agentView", async () => {
    const { cm } = createTestFileSupervisor({
      [TEST_PATH]: "edited content",
    });

    cm.toolApplied(
      TEST_PATH,
      { type: "edl-edit", content: "edited content", previousContent: "" },
      TEXT_FILE_TYPE,
    );

    expect(cm.files[TEST_PATH].agentView).toEqual({
      type: "text",
      content: "edited content",
    });

    const updates = await cm.getContextUpdate();
    expect(Object.keys(updates).length).toBe(0);
  });

  it("file updated after agentView set returns a diff", async () => {
    const { cm, fileIO } = createTestFileSupervisor({
      [TEST_PATH]: "original content",
    });

    cm.toolApplied(
      TEST_PATH,
      { type: "get-file", content: "original content" },
      TEXT_FILE_TYPE,
    );

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
    const { cm, fileIO } = createTestFileSupervisor({
      [TEST_PATH]: "const x=1",
    });

    cm.toolApplied(
      TEST_PATH,
      { type: "edl-edit", content: "const x=1", previousContent: "" },
      TEXT_FILE_TYPE,
    );

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
    const { cm } = createTestFileSupervisor({
      [TEST_PATH]: "same content",
    });

    cm.toolApplied(
      TEST_PATH,
      { type: "get-file", content: "same content" },
      TEXT_FILE_TYPE,
    );

    const updates = await cm.getContextUpdate();
    expect(Object.keys(updates).length).toBe(0);
  });

  it("avoids redundant context update after edl tool application", async () => {
    const originalContent = "original line 1\noriginal line 2\n";
    const editedContent = "original line 1\nedited line 2\n";
    const { cm, fileIO } = createTestFileSupervisor({
      [TEST_PATH]: originalContent,
    });

    cm.addFileContext(TEST_PATH, TEST_REL, TEXT_FILE_TYPE);
    await cm.getContextUpdate();

    await fileIO.writeFile(TEST_PATH, editedContent);
    cm.toolApplied(
      TEST_PATH,
      { type: "edl-edit", content: editedContent, previousContent: "" },
      TEXT_FILE_TYPE,
    );

    const updates = await cm.getContextUpdate();
    expect(Object.keys(updates).length).toBe(0);
  });

  it("file deleted after agentView set returns file-deleted", async () => {
    const { cm, fileIO } = createTestFileSupervisor({
      [TEST_PATH]: "some content",
    });

    cm.toolApplied(
      TEST_PATH,
      { type: "get-file", content: "some content" },
      TEXT_FILE_TYPE,
    );

    fileIO.deleteFile(TEST_PATH);

    const updates = await cm.getContextUpdate();
    const update = updates[TEST_PATH];
    expect(update).toBeDefined();
    expect(update.update.status).toBe("ok");
    if (update.update.status !== "ok") throw new Error("Expected ok");
    expect(update.update.value.type).toBe("file-deleted");

    expect(cm.files[TEST_PATH]).toBeUndefined();
  });
});

describe("FileSupervisor - full file and diff updates", () => {
  it("returns full file contents on first getContextUpdate and no updates on second call when file hasn't changed", async () => {
    const fileContent =
      "Moonlight whispers through the trees\nSilver shadows dance with ease.";
    const { cm } = createTestFileSupervisor({
      [TEST_PATH]: fileContent,
    });

    cm.addFileContext(TEST_PATH, TEST_REL, TEXT_FILE_TYPE);

    const firstUpdates = await cm.getContextUpdate();
    expect(firstUpdates[TEST_PATH]).toBeDefined();

    const firstUpdate = firstUpdates[TEST_PATH];
    expect(firstUpdate.update.status).toBe("ok");

    const okResult = firstUpdate.update as Extract<
      typeof firstUpdate.update,
      { status: "ok" }
    >;
    expect(okResult.value.type).toBe("whole-file");
    expect(firstUpdate.absFilePath).toBe(TEST_PATH);

    const wholeFileUpdate = okResult.value as WholeFileUpdate;
    const textBlocks = wholeFileUpdate.content.filter(
      (item) => item.type === "text",
    );
    expect(textBlocks).toHaveLength(2);
    expect(textBlocks[0].text).toBe("File `file.txt`");
    expect(textBlocks[1].text).toContain(
      "Moonlight whispers through the trees",
    );

    const secondUpdates = await cm.getContextUpdate();
    expect(Object.keys(secondUpdates).length).toBe(0);
  });

  it("returns diff when file is edited on disk", async () => {
    const originalContent =
      "Moonlight whispers through the trees\nSilver shadows dance with ease.";
    const { cm, fileIO } = createTestFileSupervisor({
      [TEST_PATH]: originalContent,
    });

    cm.addFileContext(TEST_PATH, TEST_REL, TEXT_FILE_TYPE);
    await cm.getContextUpdate();

    const updatedContent =
      "Modified content directly on disk\nThis should be detected.";
    await fileIO.writeFile(TEST_PATH, updatedContent);

    const updates = await cm.getContextUpdate();
    expect(updates[TEST_PATH]).toBeDefined();

    const update = updates[TEST_PATH];
    expect(update.update.status).toBe("ok");
    if (update.update.status === "ok") {
      expect(update.update.value.type).toBe("diff");
      expect((update.update.value as DiffUpdate).patch).toContain(
        "Modified content",
      );
    }
  });

  it("removes deleted files from context during updates", async () => {
    const { cm, fileIO } = createTestFileSupervisor({
      [TEST_PATH]: "temporary content",
    });

    cm.addFileContext(TEST_PATH, TEST_REL, TEXT_FILE_TYPE);

    expect(cm.files[TEST_PATH]).toBeDefined();

    const firstUpdates = await cm.getContextUpdate();
    expect(firstUpdates[TEST_PATH]).toBeDefined();

    fileIO.deleteFile(TEST_PATH);

    const secondUpdates = await cm.getContextUpdate();

    expect(cm.files[TEST_PATH]).toBeUndefined();
    expect(secondUpdates[TEST_PATH]).toBeDefined();
    expect(secondUpdates[TEST_PATH].update.status).toBe("ok");
    if (secondUpdates[TEST_PATH].update.status === "ok") {
      expect(secondUpdates[TEST_PATH].update.value.type).toBe("file-deleted");
    }
  });
});

describe("FileSupervisor - binary file handling", () => {
  const IMAGE_PATH = "/test/test.jpg" as AbsFilePath;
  const IMAGE_REL = "test.jpg" as RelFilePath;
  const IMAGE_FILE_TYPE = {
    category: FileCategory.IMAGE,
    mimeType: "image/jpeg",
    extension: ".jpg",
  };

  it("adding a binary file sends the initial update and no updates on second call", async () => {
    const binaryContent = "fake-binary-image-data";
    const { cm } = createTestFileSupervisor({
      [IMAGE_PATH]: binaryContent,
    });

    cm.addFileContext(IMAGE_PATH, IMAGE_REL, IMAGE_FILE_TYPE);

    const firstUpdates = await cm.getContextUpdate();
    expect(firstUpdates[IMAGE_PATH]).toBeDefined();

    const firstUpdate = firstUpdates[IMAGE_PATH];
    expect(firstUpdate.update.status).toBe("ok");
    if (firstUpdate.update.status === "ok") {
      expect(firstUpdate.update.value.type).toBe("whole-file");
      expect(firstUpdate.absFilePath).toBe(IMAGE_PATH);
      expect(firstUpdate.relFilePath).toBe(IMAGE_REL);
      const imageContent = (firstUpdate.update.value as WholeFileUpdate)
        .content[0] as ProviderImageContent;
      expect(imageContent.type).toBe("image");
      expect(imageContent.source.media_type).toBe("image/jpeg");
      expect(imageContent.source.data).toBe(
        Buffer.from(binaryContent).toString("base64"),
      );
    }

    const secondUpdates = await cm.getContextUpdate();
    expect(Object.keys(secondUpdates).length).toBe(0);
  });

  it("contextUpdatesToContent includes image as a sibling image block", async () => {
    const binaryContent = "fake-binary-image-data";
    const { cm } = createTestFileSupervisor({
      [IMAGE_PATH]: binaryContent,
    });

    cm.addFileContext(IMAGE_PATH, IMAGE_REL, IMAGE_FILE_TYPE);

    const updates = await cm.getContextUpdate();
    const content = cm.contextUpdatesToContent(updates);

    expect(content.length).toBe(2);
    expect(content[0].type).toBe("text");
    const textBlock = content[0] as { type: "text"; text: string };
    expect(textBlock.text).toContain(IMAGE_REL);
    expect(textBlock.text).toContain("(image attachment)");
    expect(textBlock.text).not.toContain("(0 lines)");

    expect(content[1].type).toBe("image");
    const imageBlock = content[1] as ProviderImageContent;
    expect(imageBlock.source.media_type).toBe("image/jpeg");
    expect(imageBlock.source.data).toBe(
      Buffer.from(binaryContent).toString("base64"),
    );
  });

  it("removing a binary file on disk removes it from context and sends a delete message", async () => {
    const { cm, fileIO } = createTestFileSupervisor({
      [IMAGE_PATH]: "fake-binary-image-data",
    });

    cm.addFileContext(IMAGE_PATH, IMAGE_REL, IMAGE_FILE_TYPE);

    expect(cm.files[IMAGE_PATH]).toBeDefined();

    const firstUpdates = await cm.getContextUpdate();
    expect(firstUpdates[IMAGE_PATH]).toBeDefined();

    fileIO.deleteFile(IMAGE_PATH);

    const secondUpdates = await cm.getContextUpdate();

    expect(cm.files[IMAGE_PATH]).toBeUndefined();
    expect(secondUpdates[IMAGE_PATH]).toBeDefined();
    expect(secondUpdates[IMAGE_PATH].update.status).toBe("ok");
    if (secondUpdates[IMAGE_PATH].update.status === "ok") {
      expect(secondUpdates[IMAGE_PATH].update.value.type).toBe("file-deleted");
    }
  });
});

describe("FileSupervisor - large file summarization", () => {
  function buildLargeContent(targetChars: number): string {
    const lines: string[] = [];
    lines.push("interface UserAccount {");
    lines.push("  id: string;");
    lines.push("  email: string;");
    lines.push("}");
    let i = 0;
    let totalChars = 0;
    while (totalChars < targetChars) {
      lines.push(`function processAccount${i}(account: UserAccount): string {`);
      lines.push(`  const greeting = "Hello, " + account.email;`);
      lines.push(`  console.log("Processing account ${i}:", greeting);`);
      lines.push(`  return greeting;`);
      lines.push(`}`);
      lines.push("");
      i++;
      totalChars = lines.reduce((s, l) => s + l.length + 1, 0);
    }
    return lines.join("\n");
  }

  it("emits a summary whole-file update for an over-cap file", async () => {
    const largeContent = buildLargeContent(150_000);
    const { cm } = createTestFileSupervisor({
      [TEST_PATH]: largeContent,
    });

    cm.addFileContext(TEST_PATH, TEST_REL, TEXT_FILE_TYPE);

    const updates = await cm.getContextUpdate();
    const update = updates[TEST_PATH];
    expect(update).toBeDefined();
    expect(update.update.status).toBe("ok");
    if (update.update.status !== "ok") throw new Error("Expected ok");
    expect(update.update.value.type).toBe("whole-file");

    const wholeFile = update.update.value as WholeFileUpdate;
    const textBlocks = wholeFile.content.filter((c) => c.type === "text");
    expect(textBlocks).toHaveLength(2);
    expect(textBlocks[0].text).toBe("File `file.txt`");
    expect(textBlocks[1].text).toContain("[File too large for full context");
    expect(textBlocks[1].text).toContain("[File summary:");

    const totalChars = textBlocks.reduce((sum, b) => sum + b.text.length, 0);
    expect(totalChars).toBeLessThan(100_000);
    expect(cm.files[TEST_PATH].agentView).toEqual({ type: "summary" });
  });

  it("does not re-emit summary for an unchanged over-cap file", async () => {
    const largeContent = buildLargeContent(150_000);
    const { cm } = createTestFileSupervisor({
      [TEST_PATH]: largeContent,
    });

    cm.addFileContext(TEST_PATH, TEST_REL, TEXT_FILE_TYPE);

    await cm.getContextUpdate();
    const secondUpdates = await cm.getContextUpdate();
    expect(Object.keys(secondUpdates).length).toBe(0);
  });

  it("does not emit a diff when a summarized file is modified on disk", async () => {
    const largeContent = buildLargeContent(150_000);
    const { cm, fileIO } = createTestFileSupervisor({
      [TEST_PATH]: largeContent,
    });

    cm.addFileContext(TEST_PATH, TEST_REL, TEXT_FILE_TYPE);
    await cm.getContextUpdate();

    await fileIO.writeFile(TEST_PATH, `${largeContent}\nappended line`);

    const updates = await cm.getContextUpdate();
    expect(updates[TEST_PATH]).toBeUndefined();
    expect(cm.files[TEST_PATH].agentView).toEqual({ type: "summary" });
  });

  it("small files are not summarized", async () => {
    const { cm } = createTestFileSupervisor({
      [TEST_PATH]: "small content",
    });

    cm.addFileContext(TEST_PATH, TEST_REL, TEXT_FILE_TYPE);

    const updates = await cm.getContextUpdate();
    const update = updates[TEST_PATH];
    expect(update.update.status).toBe("ok");
    if (update.update.status !== "ok") throw new Error("Expected ok");
    expect(update.update.value.type).toBe("whole-file");
    const wholeFile = update.update.value as WholeFileUpdate;
    const textBlocks = wholeFile.content.filter((c) => c.type === "text");
    expect(textBlocks[1].text).toBe("small content");
    expect(cm.files[TEST_PATH].agentView).toEqual({
      type: "text",
      content: "small content",
    });
  });
});

describe("FileSupervisor - PDF file handling", () => {
  const PDF_PATH = "/test/doc.pdf" as AbsFilePath;
  const PDF_REL = "doc.pdf" as RelFilePath;
  const PDF_FILE_TYPE = {
    category: FileCategory.PDF,
    mimeType: "application/pdf",
    extension: ".pdf",
  };

  it("includes PDF file in context and sends summary in context updates", async () => {
    const { cm } = createTestFileSupervisor({
      [PDF_PATH]: "fake-pdf-content",
    });

    cm.addFileContext(PDF_PATH, PDF_REL, PDF_FILE_TYPE);

    const updates = await cm.getContextUpdate();
    expect(updates[PDF_PATH]).toBeDefined();

    const update = updates[PDF_PATH];
    expect(update.update.status).toBe("ok");
    if (update.update.status === "ok") {
      expect(update.update.value.type).toBe("whole-file");
      const wholeFile = update.update.value as WholeFileUpdate;
      expect(wholeFile.pdfSummary).toBe(true);
      const textContent = wholeFile.content.find((c) => c.type === "text");
      expect(textContent).toBeDefined();
      if (textContent && textContent.type === "text") {
        expect(textContent.text).toContain("PDF Document:");
        expect(textContent.text).toContain("Pages: 3");
      }
    }

    // agentView should be set to pdf with summary
    expect(cm.files[PDF_PATH].agentView).toEqual({
      type: "pdf",
      summary: true,
      pages: [],
      supportsPageExtraction: true,
    });

    // Second call should return no updates (summary already sent)
    const secondUpdates = await cm.getContextUpdate();
    expect(Object.keys(secondUpdates).length).toBe(0);
  });
});

describe("FileSupervisor - peekFileUpdate", () => {
  it("returns a diff without mutating agentView", async () => {
    const { cm, fileIO } = createTestFileSupervisor({
      [TEST_PATH]: "initial content",
    });

    cm.toolApplied(
      TEST_PATH,
      { type: "get-file", content: "initial content" },
      TEXT_FILE_TYPE,
    );
    expect(cm.files[TEST_PATH].agentView).toEqual({
      type: "text",
      content: "initial content",
    });

    await fileIO.writeFile(TEST_PATH, "modified content");

    const first = await cm.peekFileUpdate(TEST_PATH);
    expect(first).toBeDefined();
    expect(first?.update.status).toBe("ok");
    if (first?.update.status === "ok") {
      expect(first.update.value.type).toBe("diff");
    }
    expect(cm.files[TEST_PATH].agentView).toEqual({
      type: "text",
      content: "initial content",
    });

    const second = await cm.peekFileUpdate(TEST_PATH);
    expect(second).toBeDefined();
    expect(second?.update.status).toBe("ok");
    if (second?.update.status === "ok") {
      expect(second.update.value.type).toBe("diff");
    }
    expect(cm.files[TEST_PATH].agentView).toEqual({
      type: "text",
      content: "initial content",
    });
  });
});

describe("FileSupervisor - refreshPendingUpdates", () => {
  it("detects out-of-process change and emits event", async () => {
    const { cm, fileIO } = createTestFileSupervisor({
      [TEST_PATH]: "baseline",
    });

    let statCounter = 1000;
    fileIO.stat = () => Promise.resolve({ mtimeMs: statCounter, size: 8 });

    cm.toolApplied(
      TEST_PATH,
      { type: "get-file", content: "baseline" },
      TEXT_FILE_TYPE,
    );

    await new Promise((resolve) => setImmediate(resolve));
    await cm.refreshPendingUpdates();
    expect(Object.keys(cm.getPendingUpdates()).length).toBe(0);

    const spy = vi.fn();
    cm.on("pendingUpdatesChanged", spy);

    await fileIO.writeFile(TEST_PATH, "modified");
    statCounter += 100;
    await cm.refreshPendingUpdates();

    const pending = cm.getPendingUpdates();
    expect(pending[TEST_PATH]).toBeDefined();
    expect(pending[TEST_PATH].update.status).toBe("ok");
    if (pending[TEST_PATH].update.status === "ok") {
      expect(pending[TEST_PATH].update.value.type).toBe("diff");
    }
    expect(spy.mock.calls.length).toBe(1);
  });

  it("skips readFile when stat has not changed", async () => {
    const { cm, fileIO } = createTestFileSupervisor({
      [TEST_PATH]: "stable",
    });
    const fixedStat = { mtimeMs: 1000, size: 6 };
    fileIO.stat = vi.fn().mockResolvedValue(fixedStat);
    const readSpy = vi.spyOn(fileIO, "readFile");

    cm.toolApplied(
      TEST_PATH,
      { type: "get-file", content: "stable" },
      TEXT_FILE_TYPE,
    );

    await cm.refreshPendingUpdates();
    const countAfterFirst = readSpy.mock.calls.length;

    await cm.refreshPendingUpdates();
    expect(readSpy.mock.calls.length).toBe(countAfterFirst);
  });

  it("clears pending after a real send", async () => {
    const { cm, fileIO } = createTestFileSupervisor({
      [TEST_PATH]: "orig",
    });

    cm.toolApplied(
      TEST_PATH,
      { type: "get-file", content: "orig" },
      TEXT_FILE_TYPE,
    );

    await fileIO.writeFile(TEST_PATH, "orig and more");
    await cm.refreshPendingUpdates();
    expect(Object.keys(cm.getPendingUpdates()).length).toBe(1);

    await cm.getContextUpdate();

    expect(Object.keys(cm.getPendingUpdates()).length).toBe(0);
  });
});

describe("FileSupervisor - background poll", () => {
  it("does not fire after destroy", async () => {
    vi.useFakeTimers();
    try {
      const fileIO = new InMemoryFileIO({ [TEST_PATH]: "content" });
      const mockLogger = {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      };
      const cm = new FileSupervisor(
        mockLogger,
        fileIO,
        "/test" as NvimCwd,
        "/home" as HomeDir,
        {},
        100,
      );

      cm.toolApplied(
        TEST_PATH,
        { type: "get-file", content: "content" },
        TEXT_FILE_TYPE,
      );
      cm.start();

      const spy = vi.fn();
      cm.on("pendingUpdatesChanged", spy);

      cm.destroy();
      const baseline = spy.mock.calls.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(spy.mock.calls.length).toBe(baseline);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fires refresh periodically", async () => {
    vi.useFakeTimers();
    try {
      const fileIO = new InMemoryFileIO({ [TEST_PATH]: "initial" });
      let statCounter = 1000;
      fileIO.stat = () => Promise.resolve({ mtimeMs: statCounter, size: 8 });

      const mockLogger = {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      };
      const cm = new FileSupervisor(
        mockLogger,
        fileIO,
        "/test" as NvimCwd,
        "/home" as HomeDir,
        {},
        100,
      );

      cm.toolApplied(
        TEST_PATH,
        { type: "get-file", content: "initial" },
        TEXT_FILE_TYPE,
      );

      await vi.advanceTimersByTimeAsync(0);
      await cm.refreshPendingUpdates();

      const spy = vi.fn();
      cm.on("pendingUpdatesChanged", spy);

      await fileIO.writeFile(TEST_PATH, "changed");
      statCounter += 100;

      cm.start();
      await vi.advanceTimersByTimeAsync(300);

      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);

      cm.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("FileSupervisor conversation delivery lifetime", () => {
  it("reset retains membership but clears delivered state", async () => {
    const { cm } = createTestFileSupervisor({ [TEST_PATH]: "content" });
    cm.addFileContext(TEST_PATH, TEST_REL, TEXT_FILE_TYPE);
    await cm.getContextUpdate();
    expect(cm.files[TEST_PATH].agentView).toBeDefined();
    cm.reset();
    expect(Object.keys(cm.files)).toEqual([TEST_PATH]);
    expect(cm.files[TEST_PATH].agentView).toBeUndefined();
    expect(cm.getPendingUpdates()).toEqual({});
    expect((await cm.getContextUpdate())[TEST_PATH].update).toMatchObject({
      status: "ok",
      value: { type: "whole-file" },
    });
    cm.destroy();
  });

  it.each([
    "reset",
    "destroy",
  ] as const)("ignores a pending file read after %s", async (operation) => {
    const { cm, fileIO } = createTestFileSupervisor({
      [TEST_PATH]: "content",
    });
    cm.addFileContext(TEST_PATH, TEST_REL, TEXT_FILE_TYPE);
    await cm.refreshPendingUpdates();
    let finish!: (content: string) => void;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(fileIO, "readFile").mockImplementationOnce(() => {
      started();
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    const update = cm.getContextUpdate();
    await reading;
    cm[operation]();
    finish("stale content");
    expect(await update).toEqual({});
    expect(cm.files[TEST_PATH].agentView).toBeUndefined();
    cm.destroy();
  });

  it.each([
    "reset",
    "destroy",
  ] as const)("does not publish a stale poll after %s", async (operation) => {
    const { cm, fileIO } = createTestFileSupervisor({
      [TEST_PATH]: "content",
    });
    cm.toolApplied(
      TEST_PATH,
      { type: "get-file", content: "content" },
      TEXT_FILE_TYPE,
    );
    await cm.refreshPendingUpdates();
    let finish!: (stat: undefined) => void;
    vi.spyOn(fileIO, "stat").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const refresh = cm.refreshPendingUpdates();
    cm[operation]();
    const onPending = vi.fn();
    cm.on("pendingUpdatesChanged", onPending);
    finish(undefined);
    await refresh;
    expect(onPending).not.toHaveBeenCalled();
    expect(cm.getPendingUpdates()[TEST_PATH]?.update).not.toMatchObject({
      status: "ok",
      value: { type: "file-deleted" },
    });
    cm.destroy();
  });

  it("keeps a single timer across resets and stops it exactly once", () => {
    vi.useFakeTimers();
    try {
      const cm = new FileSupervisor(
        { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
        new InMemoryFileIO({}),
        "/test" as NvimCwd,
        "/home" as HomeDir,
        {},
        100,
      );
      cm.start();
      cm.start();
      cm.reset();
      cm.reset();
      cm.start();
      expect(vi.getTimerCount()).toBe(1);
      cm.destroy();
      cm.destroy();
      cm.start();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
