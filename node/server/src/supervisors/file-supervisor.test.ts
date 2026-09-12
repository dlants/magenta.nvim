import { describe, expect, it, vi } from "vitest";
import { InMemoryFileIO } from "../edl/in-memory-file-io.ts";
import type { Logger } from "../logger.ts";
import {
  type AbsFilePath,
  FileCategory,
  type HomeDir,
  type NvimCwd,
  type RelFilePath,
} from "../utils/files.ts";
import { FileSupervisor, type FileUpdates } from "./file-supervisor.ts";

const TEST_PATH = "/test/file.txt" as AbsFilePath;
const TEXT_FILE_TYPE = {
  category: FileCategory.TEXT,
  mimeType: "text/plain",
  extension: ".txt",
};
const IMAGE_PATH = "/test/test.jpg" as AbsFilePath;
const IMAGE_REL = "test.jpg" as RelFilePath;
const IMAGE_FILE_TYPE = {
  category: FileCategory.IMAGE,
  mimeType: "image/jpeg",
  extension: ".jpg",
};

const logger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function setup(files: Record<string, string>) {
  const fileIO = new InMemoryFileIO(files);
  const onSent = vi.fn<(updates: FileUpdates) => void>();
  const supervisor = FileSupervisor.create({
    logger,
    fileIO,
    cwd: "/test" as NvimCwd,
    homeDir: "/home" as HomeDir,
    initialFiles: {},
    onSent,
  });
  return { fileIO, onSent, supervisor };
}

describe("FileSupervisor", () => {
  it("injects a dirty tracked file once", async () => {
    const { supervisor, fileIO, onSent } = setup({
      [TEST_PATH]: "original content",
    });
    supervisor.onToolApplied(
      TEST_PATH,
      { type: "get-file", content: "original content" },
      TEXT_FILE_TYPE,
    );
    expect(supervisor.files[TEST_PATH]).toBeDefined();

    await fileIO.writeFile(TEST_PATH, "formatted content");
    const action = await supervisor.onBeforeRequest({
      inputTokenCount: 0,
      outputTokenCount: 0,
    });
    if (action.type !== "inject") throw new Error("expected inject");
    const block = action.content[0];
    if (block.type !== "text") throw new Error("expected text");
    expect(block.text).toContain("formatted content");
    expect(onSent).toHaveBeenCalledTimes(1);

    expect(
      (
        await supervisor.onBeforeRequest({
          inputTokenCount: 0,
          outputTokenCount: 0,
        })
      ).type,
    ).toBe("none");
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it("yields nothing when nothing is tracked", async () => {
    const { supervisor, onSent } = setup({ [TEST_PATH]: "hi" });
    expect(
      (
        await supervisor.onBeforeRequest({
          inputTokenCount: 0,
          outputTokenCount: 0,
        })
      ).type,
    ).toBe("none");
    expect(onSent).not.toHaveBeenCalled();
  });

  it("preserves image updates as non-text injected content", async () => {
    const { supervisor } = setup({
      [IMAGE_PATH]: "fake-binary-image-data",
    });
    supervisor.addFileContext(IMAGE_PATH, IMAGE_REL, IMAGE_FILE_TYPE);

    const action = await supervisor.onBeforeRequest({
      inputTokenCount: 0,
      outputTokenCount: 0,
    });
    if (action.type !== "inject") throw new Error("expected inject");
    expect(action.content.map((c) => c.type)).toEqual(["text", "image"]);
    const image = action.content[1];
    if (image.type !== "image") throw new Error("expected image");
    expect(image.source.media_type).toBe("image/jpeg");
  });

  it("destroy stops polling and ignores tool callbacks and requests", async () => {
    vi.useFakeTimers();
    try {
      const { supervisor, onSent } = setup({ [TEST_PATH]: "hello" });
      supervisor.start();
      expect(vi.getTimerCount()).toBe(1);
      supervisor.destroy();
      supervisor.destroy();
      expect(vi.getTimerCount()).toBe(0);
      supervisor.onToolApplied(
        TEST_PATH,
        { type: "get-file", content: "hello" },
        TEXT_FILE_TYPE,
      );
      expect(supervisor.files[TEST_PATH]).toBeUndefined();
      expect(await supervisor.hasPendingContent()).toBe(false);
      expect(
        await supervisor.onBeforeRequest({
          inputTokenCount: 0,
          outputTokenCount: 0,
        }),
      ).toEqual({ type: "none" });
      expect(onSent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clone reseeds delivery because fork history may be truncated", async () => {
    const { supervisor, fileIO } = setup({ [TEST_PATH]: "original content" });
    supervisor.onToolApplied(
      TEST_PATH,
      { type: "get-file", content: "original content" },
      TEXT_FILE_TYPE,
    );
    await fileIO.writeFile(TEST_PATH, "changed on disk");

    const clone = FileSupervisor.clone({
      source: supervisor,
      delivery: "reseed",
    });
    expect(clone).not.toBe(supervisor);
    expect(clone.files[TEST_PATH]).toBeDefined();
    expect(
      (
        await clone.onBeforeRequest({
          inputTokenCount: 0,
          outputTokenCount: 0,
        })
      ).type,
    ).toBe("inject");

    // The source still owes the agent the on-disk change.
    expect(
      (
        await supervisor.onBeforeRequest({
          inputTokenCount: 0,
          outputTokenCount: 0,
        })
      ).type,
    ).toBe("inject");
    clone.destroy();
    supervisor.destroy();
  });
});

describe("FileSupervisor conversation lifetime", () => {
  it("does not send stale updates after reset and reseeds the next request", async () => {
    const { supervisor, fileIO, onSent } = setup({
      [TEST_PATH]: "content",
    });
    supervisor.addFileContext(
      TEST_PATH,
      "file.txt" as RelFilePath,
      TEXT_FILE_TYPE,
    );
    await supervisor.refreshPendingUpdates();
    let finish!: (text: string) => void;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(fileIO, "readFile").mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const request = supervisor.onBeforeRequest({
      inputTokenCount: 0,
      outputTokenCount: 0,
    });
    await reading;
    supervisor.reset();
    finish("stale");
    expect(await request).toEqual({ type: "none" });
    expect(onSent).not.toHaveBeenCalled();
    expect(supervisor.files[TEST_PATH].agentView).toBeUndefined();
    expect(await supervisor.hasPendingContent()).toBe(true);
    expect(
      (
        await supervisor.onBeforeRequest({
          inputTokenCount: 0,
          outputTokenCount: 0,
        })
      ).type,
    ).toBe("inject");
    expect(onSent).toHaveBeenCalledTimes(1);
    supervisor.destroy();
  });

  it("forks reseed binary and PDF delivery and isolate mutable PDF pages", async () => {
    const pdf = "/test/doc.pdf" as AbsFilePath;
    const pdfType = {
      category: FileCategory.PDF,
      mimeType: "application/pdf",
      extension: ".pdf",
    };
    const { supervisor } = setup({
      [pdf]: "pdf",
      [IMAGE_PATH]: "image",
    });
    supervisor.toolApplied(
      pdf,
      { type: "get-file-pdf", content: { type: "page", pdfPage: 1 } },
      pdfType,
    );
    supervisor.toolApplied(
      IMAGE_PATH,
      { type: "get-file-binary", mtime: 1 },
      IMAGE_FILE_TYPE,
    );
    const clone = FileSupervisor.clone({
      source: supervisor,
      delivery: "reseed",
    });
    expect(clone.files[pdf].agentView).toBeUndefined();
    expect(clone.files[IMAGE_PATH].agentView).toBeUndefined();
    clone.toolApplied(
      pdf,
      { type: "get-file-pdf", content: { type: "page", pdfPage: 2 } },
      pdfType,
    );
    expect(supervisor.files[pdf].agentView).toMatchObject({ pages: [1] });
    expect(clone.files[pdf].agentView).toMatchObject({ pages: [2] });
    supervisor.destroy();
    clone.destroy();
  });
});
