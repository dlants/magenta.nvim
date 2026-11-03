import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolName, ToolRequestId } from "@magenta/server";
import { describe, expect, it, test } from "vitest";
import { pos } from "../tea/view.ts";
import type { NvimDriver } from "../test/driver.ts";
import { withDriver, withNvimClient } from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";
import type { AbsFilePath } from "../utils/files.ts";
import { type BufNr, type Line, NvimBuffer } from "./buffer.ts";
import type { Row0Indexed } from "./window.ts";

function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected value to be defined");
  return value;
}

describe("NvimBuffer.reloadFromDisk", () => {
  it("moves extmarks with the text when a line is inserted above", async () => {
    await withNvimClient(async (nvim) => {
      const file = path.join(
        await fs.mkdtemp("/tmp/magenta-reload-"),
        "file.txt",
      );
      await fs.writeFile(file, "one\ntwo\nthree\n");

      const buffer = await NvimBuffer.bufadd(file as AbsFilePath, nvim);
      const extmarkId = await buffer.setExtmark({
        startPos: pos(1, 0),
        endPos: pos(1, 3),
        options: { hl_group: "ErrorMsg" },
      });

      await fs.writeFile(file, "zero\none\ntwo\nthree\n");
      await buffer.reloadFromDisk();

      const mark = await buffer.getExtmarkById(extmarkId);
      expect(mark).toBeDefined();
      const markedLine = await buffer.getLines({
        start: defined(mark).startPos.row as Row0Indexed,
        end: (defined(mark).startPos.row + 1) as Row0Indexed,
      });
      expect(markedLine).toEqual(["two"]);
    });
  });

  it("matches disk content and leaves the buffer unmodified", async () => {
    await withNvimClient(async (nvim) => {
      const file = path.join(
        await fs.mkdtemp("/tmp/magenta-reload-"),
        "file.txt",
      );
      await fs.writeFile(file, "one\ntwo\n");
      const buffer = await NvimBuffer.bufadd(file as AbsFilePath, nvim);

      await fs.writeFile(file, "one\ntwo modified\nthree\n");
      await buffer.reloadFromDisk();

      const lines = await buffer.getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });
      expect(lines).toEqual(["one", "two modified", "three"]);
      expect(await buffer.getOption("modified")).toBe(false);
    });
  });

  it("preserves a missing trailing newline", async () => {
    await withNvimClient(async (nvim) => {
      const file = path.join(
        await fs.mkdtemp("/tmp/magenta-reload-"),
        "file.txt",
      );
      await fs.writeFile(file, "one\ntwo\n");
      const buffer = await NvimBuffer.bufadd(file as AbsFilePath, nvim);

      await fs.writeFile(file, "one\ntwo\nthree");
      await buffer.reloadFromDisk();

      // 'endofline' false is what makes a later :write reproduce the file
      // byte-for-byte, without the trailing newline vim would otherwise add.
      expect(await buffer.getOption("endofline")).toBe(false);
      expect(await buffer.getOption("fixendofline")).toBe(false);
      expect(
        await buffer.getLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
        }),
      ).toEqual(["one", "two", "three"]);
    });
  });

  it("applies multiple hunks, including a pure deletion", async () => {
    await withNvimClient(async (nvim) => {
      const file = path.join(
        await fs.mkdtemp("/tmp/magenta-reload-"),
        "file.txt",
      );
      await fs.writeFile(file, "a\nb\nc\nd\ne\n");
      const buffer = await NvimBuffer.bufadd(file as AbsFilePath, nvim);

      // b,c -> X (change), and f appended (insertion): two hunks at different offsets
      await fs.writeFile(file, "a\nX\nd\ne\nf\n");
      await buffer.reloadFromDisk();

      expect(
        await buffer.getLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
        }),
      ).toEqual(["a", "X", "d", "e", "f"]);
      expect(await buffer.getOption("modified")).toBe(false);
    });
  });

  it("handles a pure deletion hunk", async () => {
    await withNvimClient(async (nvim) => {
      const file = path.join(
        await fs.mkdtemp("/tmp/magenta-reload-"),
        "file.txt",
      );
      await fs.writeFile(file, "a\nb\nc\n");
      const buffer = await NvimBuffer.bufadd(file as AbsFilePath, nvim);

      await fs.writeFile(file, "a\nc\n");
      await buffer.reloadFromDisk();

      expect(
        await buffer.getLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
        }),
      ).toEqual(["a", "c"]);
    });
  });

  it("handles truncation to an empty file", async () => {
    await withNvimClient(async (nvim) => {
      const file = path.join(
        await fs.mkdtemp("/tmp/magenta-reload-"),
        "file.txt",
      );
      await fs.writeFile(file, "one\ntwo\n");
      const buffer = await NvimBuffer.bufadd(file as AbsFilePath, nvim);

      await fs.writeFile(file, "");
      await buffer.reloadFromDisk();

      expect(
        await buffer.getLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
        }),
      ).toEqual([""]);
      expect(await buffer.getOption("modified")).toBe(false);
    });
  });

  it("is a no-op when the file no longer exists", async () => {
    await withNvimClient(async (nvim) => {
      const file = path.join(
        await fs.mkdtemp("/tmp/magenta-reload-"),
        "file.txt",
      );
      await fs.writeFile(file, "one\ntwo\n");
      const buffer = await NvimBuffer.bufadd(file as AbsFilePath, nvim);
      await buffer.getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });

      await fs.rm(file);
      await buffer.reloadFromDisk();

      expect(
        await buffer.getLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
        }),
      ).toEqual(["one", "two"]);
    });
  });

  it("leaves a modified buffer untouched", async () => {
    await withNvimClient(async (nvim) => {
      const file = path.join(
        await fs.mkdtemp("/tmp/magenta-reload-"),
        "file.txt",
      );
      await fs.writeFile(file, "one\ntwo\n");
      const buffer = await NvimBuffer.bufadd(file as AbsFilePath, nvim);
      await buffer.setLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
        lines: ["user edit"] as Line[],
      });

      await fs.writeFile(file, "from disk\n");
      await buffer.reloadFromDisk();

      const lines = await buffer.getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });
      expect(lines).toEqual(["user edit"]);
    });
  });
});

describe("agent edits to open buffers", () => {
  async function runEdlScript(driver: NvimDriver, script: string) {
    await driver.showSidebar();
    await driver.inputMagentaText("edit the file");
    await driver.send();
    const stream = await driver.mockAnthropic.awaitPendingStream();
    stream.respond({
      stopReason: "tool_use",
      text: "editing",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "tool_1" as ToolRequestId,
            toolName: "edl" as ToolName,
            input: { script },
          },
        },
      ],
    });
  }

  test("an extmark still covers the same text after an agent edit above it", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          await fs.writeFile(
            path.join(tmpDir, "test.txt"),
            "one\ntwo\nthree\n",
          );
        },
      },
      async (driver, dirs) => {
        const filePath = path.join(dirs.tmpDir, "test.txt");
        await driver.editFile(filePath);
        const bufnr = (await driver.nvim.call(
          "nvim_get_current_buf",
          [],
        )) as BufNr;
        const buffer = new NvimBuffer(bufnr, driver.nvim);
        const extmarkId = await buffer.setExtmark({
          startPos: pos(1, 0),
          endPos: pos(1, 3),
          options: { hl_group: "ErrorMsg" },
        });

        await runEdlScript(
          driver,
          `file \`${filePath}\`
select /one/
insert_before <<INS
zero
INS`,
        );

        await pollUntil(async () => {
          const lines = await buffer.getLines({
            start: 0 as Row0Indexed,
            end: -1 as Row0Indexed,
          });
          if (lines[0] !== "zero") {
            throw new Error(
              `buffer not reloaded yet: ${JSON.stringify(lines)}`,
            );
          }
        });

        const mark = await buffer.getExtmarkById(extmarkId);
        const markedLine = await buffer.getLines({
          start: defined(mark).startPos.row as Row0Indexed,
          end: (defined(mark).startPos.row + 1) as Row0Indexed,
        });
        expect(markedLine).toEqual(["two"]);
        expect(await buffer.getOption("modified")).toBe(false);
      },
    );
  });

  test("an agent edit is undone in a single undo", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          await fs.writeFile(
            path.join(tmpDir, "test.txt"),
            "one\ntwo\nthree\n",
          );
        },
      },
      async (driver, dirs) => {
        const filePath = path.join(dirs.tmpDir, "test.txt");
        await driver.editFile(filePath);
        const bufnr = (await driver.nvim.call(
          "nvim_get_current_buf",
          [],
        )) as BufNr;
        const buffer = new NvimBuffer(bufnr, driver.nvim);

        await runEdlScript(
          driver,
          `file \`${filePath}\`
select /two/
replace "TWO"`,
        );

        await pollUntil(async () => {
          const lines = await buffer.getLines({
            start: 0 as Row0Indexed,
            end: -1 as Row0Indexed,
          });
          if (lines[1] !== "TWO") {
            throw new Error(
              `buffer not reloaded yet: ${JSON.stringify(lines)}`,
            );
          }
        });

        await driver.nvim.call("nvim_exec_lua", [
          `vim.api.nvim_buf_call(..., function() vim.cmd("undo") end)`,
          [bufnr],
        ]);
        const lines = await buffer.getLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
        });
        expect(lines).toEqual(["one", "two", "three"]);
      },
    );
  });

  test("a buffer with unsaved user changes is left untouched", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          await fs.writeFile(path.join(tmpDir, "test.txt"), "one\ntwo\n");
        },
      },
      async (driver, dirs) => {
        const filePath = path.join(dirs.tmpDir, "test.txt");
        await driver.editFile(filePath);
        const bufnr = (await driver.nvim.call(
          "nvim_get_current_buf",
          [],
        )) as BufNr;
        const buffer = new NvimBuffer(bufnr, driver.nvim);
        await buffer.setLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
          lines: ["user edit"] as Line[],
        });

        await runEdlScript(
          driver,
          `file \`${filePath}\`
select /two/
replace "TWO"`,
        );

        await driver.assertDisplayBufferContains("edl");
        const lines = await buffer.getLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
        });
        expect(lines).toEqual(["user edit"]);
      },
    );
  });
});
describe("autoreload watcher", () => {
  async function lua<T>(
    driver: NvimDriver,
    code: string,
    args: unknown[] = [],
  ) {
    return (await driver.nvim.call("nvim_exec_lua", [code, args])) as T;
  }
  async function openWatched(driver: NvimDriver, filePath: string) {
    await lua(driver, `require("magenta.autoreload").setup()`);
    await driver.editFile(filePath);
    const bufnr = (await driver.nvim.call("nvim_get_current_buf", [])) as BufNr;
    // let the initial async stat settle so it doesn't race test writes
    await new Promise((r) => setTimeout(r, 50));
    return { bufnr, buffer: new NvimBuffer(bufnr, driver.nvim) };
  }
  async function allLines(buffer: NvimBuffer) {
    return buffer.getLines({ start: 0 as Row0Indexed, end: -1 as Row0Indexed });
  }
  async function waitForLines(buffer: NvimBuffer, expected: string[]) {
    await pollUntil(async () => {
      const lines = await allLines(buffer);
      if (JSON.stringify(lines) !== JSON.stringify(expected)) {
        throw new Error(`buffer: ${JSON.stringify(lines)}`);
      }
    });
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const setupFiles = async (tmpDir: string) => {
    await fs.writeFile(path.join(tmpDir, "test.txt"), "one\ntwo\nthree\n");
  };

  test("reload applies explicit content without reading disk", async () => {
    await withDriver({ setupFiles }, async (driver, dirs) => {
      const { bufnr, buffer } = await openWatched(
        driver,
        path.join(dirs.tmpDir, "test.txt"),
      );
      await lua(driver, `require("magenta.autoreload").teardown()`);
      await lua(driver, `require("magenta.autoreload").reload(...)`, [
        bufnr,
        "one\nTWO\nthree\n",
      ]);
      expect(await allLines(buffer)).toEqual(["one", "TWO", "three"]);
    });
  });

  test("external write reloads a clean buffer, undoable, keeping extmarks", async () => {
    await withDriver({ setupFiles }, async (driver, dirs) => {
      const filePath = path.join(dirs.tmpDir, "test.txt");
      const { bufnr, buffer } = await openWatched(driver, filePath);
      const extmarkId = await buffer.setExtmark({
        startPos: pos(2, 0),
        endPos: pos(2, 5),
        options: { hl_group: "ErrorMsg" },
      });
      await fs.writeFile(filePath, "zero\none\ntwo\nthree\n");
      await waitForLines(buffer, ["zero", "one", "two", "three"]);
      const mark = await buffer.getExtmarkById(extmarkId);
      expect(defined(mark).startPos.row).toBe(3);
      expect(await buffer.getOption("modified")).toBe(false);
      await lua(
        driver,
        `vim.api.nvim_buf_call(..., function() vim.cmd("undo") end)`,
        [bufnr],
      );
      expect(await allLines(buffer)).toEqual(["one", "two", "three"]);
    });
  });

  test("rename-replace reloads and the watcher survives", async () => {
    await withDriver({ setupFiles }, async (driver, dirs) => {
      const filePath = path.join(dirs.tmpDir, "test.txt");
      const { buffer } = await openWatched(driver, filePath);
      const tmp = path.join(dirs.tmpDir, "test.txt.tmp");
      await fs.writeFile(tmp, "renamed\n");
      await fs.rename(tmp, filePath);
      await waitForLines(buffer, ["renamed"]);
      await fs.writeFile(filePath, "again\n");
      await waitForLines(buffer, ["again"]);
    });
  });

  test("modified buffer is left untouched", async () => {
    await withDriver({ setupFiles }, async (driver, dirs) => {
      const filePath = path.join(dirs.tmpDir, "test.txt");
      const { buffer } = await openWatched(driver, filePath);
      await buffer.setLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
        lines: ["user edit"] as Line[],
      });
      await fs.writeFile(filePath, "from disk\n");
      await sleep(400);
      expect(await allLines(buffer)).toEqual(["user edit"]);
      expect(await buffer.getOption("modified")).toBe(true);
    });
  });

  test("hidden buffer is marked stale and reloads when shown", async () => {
    await withDriver({ setupFiles }, async (driver, dirs) => {
      const filePath = path.join(dirs.tmpDir, "test.txt");
      const { bufnr, buffer } = await openWatched(driver, filePath);
      await driver.nvim.call("nvim_command", ["set hidden | enew"]);
      await fs.writeFile(filePath, "changed\n");
      await pollUntil(async () => {
        const stale = await lua<boolean>(
          driver,
          `return vim.b[...].magentaStale == true`,
          [bufnr],
        );
        if (!stale) throw new Error("not stale yet");
      });
      expect(await allLines(buffer)).toEqual(["one", "two", "three"]);
      await driver.nvim.call("nvim_command", [`buffer ${bufnr}`]);
      await waitForLines(buffer, ["changed"]);
      expect(
        await lua<boolean>(driver, `return vim.b[...].magentaStale == nil`, [
          bufnr,
        ]),
      ).toBe(true);
    });
  });

  test("wiping the buffer releases its directory watcher", async () => {
    await withDriver({ setupFiles }, async (driver, dirs) => {
      const { bufnr } = await openWatched(
        driver,
        path.join(dirs.tmpDir, "test.txt"),
      );
      expect(await lua<number>(driver, countDirs)).toBe(1);
      await driver.nvim.call("nvim_command", [`bwipeout! ${bufnr}`]);
      expect(await lua<number>(driver, countDirs)).toBe(0);
    });
  });

  const countDirs = `local n = 0 for _ in pairs(require("magenta.autoreload")._dirs) do n = n + 1 end return n`;

  test("buffers sharing a directory are refcounted", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          await fs.writeFile(path.join(tmpDir, "a.txt"), "a\n");
          await fs.writeFile(path.join(tmpDir, "b.txt"), "b\n");
        },
      },
      async (driver, dirs) => {
        const a = await openWatched(driver, path.join(dirs.tmpDir, "a.txt"));
        await driver.editFile(path.join(dirs.tmpDir, "b.txt"));
        const bBufnr = (await driver.nvim.call(
          "nvim_get_current_buf",
          [],
        )) as BufNr;
        const b = new NvimBuffer(bBufnr, driver.nvim);
        await sleep(50);
        expect(await lua<number>(driver, countDirs)).toBe(1);
        await driver.nvim.call("nvim_command", [`bwipeout! ${a.bufnr}`]);
        expect(await lua<number>(driver, countDirs)).toBe(1);
        await fs.writeFile(path.join(dirs.tmpDir, "b.txt"), "b2\n");
        await waitForLines(b, ["b2"]);
        await driver.nvim.call("nvim_command", [`bwipeout! ${bBufnr}`]);
        expect(await lua<number>(driver, countDirs)).toBe(0);
      },
    );
  });

  test("renaming the buffer moves its watcher to the new directory", async () => {
    await withDriver({ setupFiles }, async (driver, dirs) => {
      const { bufnr, buffer } = await openWatched(
        driver,
        path.join(dirs.tmpDir, "test.txt"),
      );
      const subDir = path.join(dirs.tmpDir, "sub");
      await fs.mkdir(subDir);
      const newPath = path.join(subDir, "moved.txt");
      await driver.nvim.call("nvim_command", [`saveas ${newPath}`]);
      await sleep(50);
      const watched = await lua<string[]>(
        driver,
        `local r = {} for d in pairs(require("magenta.autoreload")._dirs) do r[#r + 1] = d end return r`,
      );
      expect(watched.map((d) => path.basename(d))).toEqual(["sub"]);
      expect(
        (await driver.nvim.call("nvim_get_current_buf", [])) as BufNr,
      ).toBe(bufnr);
      await fs.writeFile(newPath, "moved content\n");
      await waitForLines(buffer, ["moved content"]);
    });
  });

  test("deleted file leaves the buffer alone and recreation reloads", async () => {
    await withDriver({ setupFiles }, async (driver, dirs) => {
      const filePath = path.join(dirs.tmpDir, "test.txt");
      const { buffer } = await openWatched(driver, filePath);
      await fs.rm(filePath);
      await sleep(400);
      expect(await allLines(buffer)).toEqual(["one", "two", "three"]);
      await fs.writeFile(filePath, "recreated\n");
      await waitForLines(buffer, ["recreated"]);
    });
  });

  test("user :w does not add a reload undo entry", async () => {
    await withDriver({ setupFiles }, async (driver, dirs) => {
      const filePath = path.join(dirs.tmpDir, "test.txt");
      const { bufnr, buffer } = await openWatched(driver, filePath);
      await buffer.setLines({
        start: 0 as Row0Indexed,
        end: 1 as Row0Indexed,
        lines: ["ONE"] as Line[],
      });
      const seq = `return vim.api.nvim_buf_call(..., function() return vim.fn.undotree().seq_last end)`;
      await lua(
        driver,
        `vim.api.nvim_buf_call(..., function() vim.cmd("write") end)`,
        [bufnr],
      );
      const before = await lua<number>(driver, seq, [bufnr]);
      await sleep(400);
      expect(await lua<number>(driver, seq, [bufnr])).toBe(before);
      expect(await allLines(buffer)).toEqual(["ONE", "two", "three"]);
    });
  });
  test("autoReloadBuffers = false disables watching", async () => {
    await withDriver({ setupFiles }, async (driver, dirs) => {
      await lua(
        driver,
        `require("magenta.options").set_options({ autoReloadBuffers = false })`,
      );
      const { buffer } = await openWatched(
        driver,
        path.join(dirs.tmpDir, "test.txt"),
      );
      expect(await lua<number>(driver, countDirs)).toBe(0);
      await fs.writeFile(path.join(dirs.tmpDir, "test.txt"), "changed\n");
      await sleep(300);
      expect(await allLines(buffer)).toEqual(["one", "two", "three"]);
    });
  });
  test("a bash_command sed -i updates an open clean buffer", async () => {
    await withDriver({ setupFiles }, async (driver, dirs) => {
      const filePath = path.join(dirs.tmpDir, "test.txt");
      const { buffer } = await openWatched(driver, filePath);
      await driver.showSidebar();
      await driver.inputMagentaText("replace two");
      await driver.send();
      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "ok",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "sed-edit" as ToolRequestId,
              toolName: "bash_command" as ToolName,
              input: {
                description: "edit",
                command: `sed -i.bak 's/two/TWO/' ${filePath}`,
              },
            },
          },
        ],
      });
      await waitForLines(buffer, ["one", "TWO", "three"]);
    });
  });
});
