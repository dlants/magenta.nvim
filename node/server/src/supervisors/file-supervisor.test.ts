import { describe, expect, it, vi } from "vitest";
import { InMemoryFileIO } from "../edl/in-memory-file-io.ts";
import type { Logger } from "../logger.ts";
import type { NativeMessageIdx } from "../providers/provider-types.ts";
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
  });
  supervisor.callbacks = { ...supervisor.callbacks, onSent: onSent };
  return { fileIO, onSent, supervisor };
}

describe("FileSupervisor", () => {
  it("injects a dirty tracked file once", async () => {
    const { supervisor, fileIO, onSent } = setup({
      [TEST_PATH]: "original content",
    });
    supervisor.onToolApplied({
      absFilePath: TEST_PATH,
      tool: { type: "get-file", content: "original content" },
      fileTypeInfo: TEXT_FILE_TYPE,
      nativeMessageIdx: 0 as NativeMessageIdx,
    });
    expect(supervisor.files[TEST_PATH]).toBeDefined();

    await fileIO.writeFile(TEST_PATH, "formatted content");
    const action = await supervisor.onBeforeRequest({
      outputTokenCount: 0,
      nativeMessageIdx: 0 as NativeMessageIdx,
    });
    if (action.type !== "inject") throw new Error("expected inject");
    const block = action.content[0];
    if (block.type !== "text") throw new Error("expected text");
    expect(block.text).toContain("formatted content");
    expect(onSent).toHaveBeenCalledTimes(1);

    expect(
      (
        await supervisor.onBeforeRequest({
          outputTokenCount: 0,
          nativeMessageIdx: 0 as NativeMessageIdx,
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
          outputTokenCount: 0,
          nativeMessageIdx: 0 as NativeMessageIdx,
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
      outputTokenCount: 0,
      nativeMessageIdx: 0 as NativeMessageIdx,
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
      expect(vi.getTimerCount()).toBe(1);
      supervisor.destroy();
      supervisor.destroy();
      expect(vi.getTimerCount()).toBe(0);
      supervisor.onToolApplied({
        absFilePath: TEST_PATH,
        tool: { type: "get-file", content: "hello" },
        fileTypeInfo: TEXT_FILE_TYPE,
        nativeMessageIdx: 0 as NativeMessageIdx,
      });
      expect(supervisor.files[TEST_PATH]).toBeUndefined();
      expect(await supervisor.hasPendingContent()).toBe(false);
      expect(
        await supervisor.onBeforeRequest({
          outputTokenCount: 0,
          nativeMessageIdx: 0 as NativeMessageIdx,
        }),
      ).toEqual({ type: "none" });
      expect(onSent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clone reseeds delivery because fork history may be truncated", async () => {
    const { supervisor, fileIO } = setup({ [TEST_PATH]: "original content" });
    supervisor.onToolApplied({
      absFilePath: TEST_PATH,
      tool: { type: "get-file", content: "original content" },
      fileTypeInfo: TEXT_FILE_TYPE,
      nativeMessageIdx: 0 as NativeMessageIdx,
    });
    await fileIO.writeFile(TEST_PATH, "changed on disk");

    const clone = FileSupervisor.clone({
      source: supervisor,
      history: { type: "reseed" },
    });
    expect(clone).not.toBe(supervisor);
    expect(clone.files[TEST_PATH]).toBeDefined();
    expect(
      (
        await clone.onBeforeRequest({
          outputTokenCount: 0,
          nativeMessageIdx: 0 as NativeMessageIdx,
        })
      ).type,
    ).toBe("inject");

    // The source still owes the agent the on-disk change.
    expect(
      (
        await supervisor.onBeforeRequest({
          outputTokenCount: 0,
          nativeMessageIdx: 0 as NativeMessageIdx,
        })
      ).type,
    ).toBe("inject");
    clone.destroy();
    supervisor.destroy();
  });
});

describe("FileSupervisor conversation lifetime", () => {
  it("does not send stale updates after disposal and reseeds the replacement", async () => {
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
      outputTokenCount: 0,
      nativeMessageIdx: 0 as NativeMessageIdx,
    });
    await reading;
    supervisor.destroy();
    const clone = FileSupervisor.clone({
      source: supervisor,
      history: { type: "reseed" },
    });
    clone.callbacks = { ...clone.callbacks, onSent: onSent };
    finish("stale");
    expect(await request).toEqual({ type: "none" });
    expect(onSent).not.toHaveBeenCalled();
    expect(supervisor.files[TEST_PATH].agentView).toBeUndefined();
    expect(await clone.hasPendingContent()).toBe(true);
    expect(
      (
        await clone.onBeforeRequest({
          outputTokenCount: 0,
          nativeMessageIdx: 0 as NativeMessageIdx,
        })
      ).type,
    ).toBe("inject");
    expect(onSent).toHaveBeenCalledTimes(1);
    clone.destroy();
  });

  it("retains tool-applied PDF history inclusively without sharing pages", () => {
    const pdf = "/test/doc.pdf" as AbsFilePath;
    const pdfType = {
      category: FileCategory.PDF,
      mimeType: "application/pdf",
      extension: ".pdf",
    };
    const { supervisor } = setup({ [pdf]: "pdf" });
    supervisor.toolApplied(
      pdf,
      { type: "get-file-pdf", content: { type: "page", pdfPage: 1 } },
      pdfType,
      3 as NativeMessageIdx,
    );
    const clone = FileSupervisor.clone({
      source: supervisor,
      history: { type: "truncate", nativeMessageIdx: 3 as NativeMessageIdx },
    });
    clone.toolApplied(
      pdf,
      { type: "get-file-pdf", content: { type: "page", pdfPage: 2 } },
      pdfType,
      4 as NativeMessageIdx,
    );
    expect(supervisor.files[pdf].agentView).toMatchObject({ pages: [1] });
    expect(clone.files[pdf].agentView).toMatchObject({ pages: [1, 2] });
    supervisor.destroy();
    clone.destroy();
  });
});
