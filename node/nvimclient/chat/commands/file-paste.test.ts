import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { Row0Indexed } from "../../nvim/window.ts";
import type { NvimDriver } from "../../test/driver.ts";
import { withDriver } from "../../test/preamble.ts";

async function inputText(driver: NvimDriver): Promise<string> {
  const inputBuffer = driver.getInputBuffer();
  const lines = await inputBuffer.getLines({
    start: 0 as Row0Indexed,
    end: -1 as Row0Indexed,
  });
  return lines.join("\n");
}

describe("drag-drop @file: paste", () => {
  it("wraps an existing file path dropped into the input buffer", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          await fs.writeFile(path.join(tmpDir, "dropped file.txt"), "content");
        },
      },
      async (driver, dirs) => {
        await driver.showSidebar();

        const absPath = path.join(dirs.tmpDir, "dropped file.txt");
        // Terminals deliver drag-drop paths with shell-escaped whitespace.
        const shellEscaped = absPath.replace(/ /g, "\\ ");

        const inputBuffer = driver.getInputBuffer();
        await driver.nvim.call("nvim_set_current_buf", [inputBuffer.id]);
        await driver.nvim.call("nvim_paste", [shellEscaped, false, -1]);

        expect(await inputText(driver)).toBe(`@file:\`${absPath}\``);
      },
    );
  });

  it("passes through non-existent paths unchanged", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      const inputBuffer = driver.getInputBuffer();
      await driver.nvim.call("nvim_set_current_buf", [inputBuffer.id]);
      await driver.nvim.call("nvim_paste", [
        "/this/does/not/exist.txt",
        false,
        -1,
      ]);
      expect(await inputText(driver)).toBe("/this/does/not/exist.txt");
    });
  });
});
