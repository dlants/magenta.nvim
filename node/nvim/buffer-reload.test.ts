import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolName, ToolRequestId } from "@magenta/core";
import { describe, expect, it, test } from "vitest";
import { pos } from "../tea/view.ts";
import type { NvimDriver } from "../test/driver.ts";
import { withDriver, withNvimClient } from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";
import type { AbsFilePath } from "../utils/files.ts";
import { type BufNr, type Line, NvimBuffer } from "./buffer.ts";
import type { Row0Indexed } from "./window.ts";

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
        start: mark!.startPos.row as Row0Indexed,
        end: (mark!.startPos.row + 1) as Row0Indexed,
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
          start: mark!.startPos.row as Row0Indexed,
          end: (mark!.startPos.row + 1) as Row0Indexed,
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
