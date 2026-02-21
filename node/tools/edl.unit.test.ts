import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { EdlTool } from "./edl.ts";
import { FsFileIO } from "../edl/file-io.ts";
import type { ToolRequestId } from "./types.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { Msg as ThreadMsg } from "../chat/thread.ts";
import type { Msg } from "./edl.ts";
import type { NvimCwd, HomeDir } from "../utils/files.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { BufferTracker } from "../buffer-tracker.ts";
import type { EdlRegisters } from "../edl/index.ts";

describe("EdlTool unit tests", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "edl-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("edl edit dispatches context manager update", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    await fs.writeFile(filePath, "hello world\n", "utf-8");

    const myDispatch = vi.fn<(msg: Msg) => void>();
    const threadDispatch = vi.fn<Dispatch<ThreadMsg>>();
    const mockNvim = {
      logger: { error: vi.fn(), info: vi.fn() },
    } as unknown as Nvim;
    const mockBufferTracker = {
      isModified: vi.fn().mockReturnValue(false),
    } as unknown as BufferTracker;
    const edlRegisters: EdlRegisters = {
      registers: new Map(),
      nextSavedId: 1,
    };

    const script = `file \`${filePath}\`
narrow /hello/
replace <<END
goodbye
END`;

    new EdlTool(
      {
        id: "tool_1" as ToolRequestId,
        toolName: "edl" as const,
        input: { script },
      },
      {
        nvim: mockNvim,
        cwd: tmpDir as NvimCwd,
        homeDir: "/tmp/fake-home" as HomeDir,
        myDispatch,
        fileIO: new FsFileIO(),
        bufferTracker: mockBufferTracker,
        threadDispatch,
        edlRegisters,
      },
    );

    await vi.waitFor(
      () => {
        expect(myDispatch).toHaveBeenCalled();
      },
      { timeout: 5000 },
    );

    expect(threadDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "context-manager-msg",
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        msg: expect.objectContaining({
          type: "tool-applied",
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          tool: expect.objectContaining({
            type: "edl-edit",
            content: "goodbye world\n",
          }),
        }),
      }),
    );

    const fileContent = await fs.readFile(filePath, "utf-8");
    expect(fileContent).toBe("goodbye world\n");

    expect(myDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "finish",
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        result: expect.objectContaining({
          status: "ok",
        }),
      }),
    );
  });
});
