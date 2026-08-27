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
import {
  ContextManager,
  cloneContextManager,
  type FileUpdates,
} from "./context-manager.ts";
import { FileContextSupervisor } from "./file-context-supervisor.ts";

const TEST_PATH = "/test/file.txt" as AbsFilePath;
const TEXT_FILE_TYPE = {
  category: FileCategory.TEXT,
  mimeType: "text/plain",
  extension: ".txt",
};
const TEST_REL = "file.txt" as RelFilePath;
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
  const contextManager = new ContextManager(
    logger,
    fileIO,
    "/test" as NvimCwd,
    "/home" as HomeDir,
  );
  const onSent = vi.fn<(updates: FileUpdates) => void>();
  return {
    fileIO,
    contextManager,
    onSent,
    supervisor: new FileContextSupervisor({ contextManager, onSent }),
  };
}

describe("FileContextSupervisor", () => {
  it("injects a dirty tracked file once", async () => {
    const { supervisor, contextManager, fileIO, onSent } = setup({
      [TEST_PATH]: "original content",
    });
    supervisor.onToolApplied(
      TEST_PATH,
      { type: "get-file", content: "original content" },
      TEXT_FILE_TYPE,
    );
    expect(contextManager.files[TEST_PATH]).toBeDefined();

    await fileIO.writeFile(TEST_PATH, "formatted content");
    const action = await supervisor.onBeforeRequest({
      kind: "submission",
      inputTokenCount: 0,
    });
    if (action.type !== "inject") throw new Error("expected inject");
    const block = action.content[0];
    if (block.type !== "text") throw new Error("expected text");
    expect(block.text).toContain("formatted content");
    expect(onSent).toHaveBeenCalledTimes(1);

    expect(
      (
        await supervisor.onBeforeRequest({
          kind: "submission",
          inputTokenCount: 0,
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
          kind: "submission",
          inputTokenCount: 0,
        })
      ).type,
    ).toBe("none");
    expect(onSent).not.toHaveBeenCalled();
  });

  it("preserves image updates as non-text injected content", async () => {
    const { supervisor, contextManager } = setup({
      [IMAGE_PATH]: "fake-binary-image-data",
    });
    contextManager.addFileContext(IMAGE_PATH, IMAGE_REL, IMAGE_FILE_TYPE);

    const action = await supervisor.onBeforeRequest({
      kind: "submission",
      inputTokenCount: 0,
    });
    if (action.type !== "inject") throw new Error("expected inject");
    expect(action.content.map((c) => c.type)).toEqual(["text", "image"]);
    const image = action.content[1];
    if (image.type !== "image") throw new Error("expected image");
    expect(image.source.media_type).toBe("image/jpeg");
  });

  it("stays silent on a stop that issues no request", async () => {
    const { supervisor, contextManager, onSent } = setup({
      [TEST_PATH]: "hello",
    });
    contextManager.addFileContext(TEST_PATH, TEST_REL, TEXT_FILE_TYPE);
    const action = await supervisor.onBeforeRequest({
      kind: "turn-end",
      stopReason: "end_turn",
      inputTokenCount: 0,
    });
    expect(action).toEqual({ type: "none" });
    expect(onSent).not.toHaveBeenCalled();
  });

  it("destroy stops the poller", () => {
    const { supervisor, contextManager } = setup({ [TEST_PATH]: "hello" });
    contextManager.start();
    supervisor.destroy();
    expect(
      (contextManager as unknown as { pollTimer: unknown }).pollTimer,
    ).toBeUndefined();
  });

  it("clone re-reads text files so the fork's first update is empty", async () => {
    const { supervisor, fileIO } = setup({ [TEST_PATH]: "original content" });
    supervisor.onToolApplied(
      TEST_PATH,
      { type: "get-file", content: "original content" },
      TEXT_FILE_TYPE,
    );
    await fileIO.writeFile(TEST_PATH, "changed on disk");

    const clone = new FileContextSupervisor({
      contextManager: await cloneContextManager(supervisor.contextManager, {
        logger,
        fileIO,
        cwd: "/test" as NvimCwd,
        homeDir: "/home" as HomeDir,
      }),
      onSent: () => {},
    });
    expect(clone.contextManager).not.toBe(supervisor.contextManager);
    expect(clone.contextManager.files[TEST_PATH]).toBeDefined();
    expect(
      (await clone.onBeforeRequest({ kind: "submission", inputTokenCount: 0 }))
        .type,
    ).toBe("none");

    // The source still owes the agent the on-disk change.
    expect(
      (
        await supervisor.onBeforeRequest({
          kind: "submission",
          inputTokenCount: 0,
        })
      ).type,
    ).toBe("inject");
    clone.destroy();
    supervisor.destroy();
  });
});
