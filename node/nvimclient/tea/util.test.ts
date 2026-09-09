import { describe, expect, it } from "vitest";
import { type Line, NvimBuffer } from "../nvim/buffer.ts";
import type { ByteIdx, Position0Indexed, Row0Indexed } from "../nvim/window.ts";
import { withNvimClient } from "../test/preamble.ts";
import {
  calculatePosition,
  replaceBetweenPositions,
  strWidthInBytes,
} from "./util.ts";
import { pos } from "./view.ts";

describe("tea/util.test.ts", () => {
  it("strWidthInBytes", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      const symbols = ["", "a", "⚙️", "⏳", "⚠️", "👀", "✅"] as Line[];
      const expectedWidths = [0, 1, 6, 3, 6, 4, 3];
      for (let idx = 0; idx < symbols.length; idx += 1) {
        expect(strWidthInBytes(symbols[idx]), symbols[idx]).toEqual(
          expectedWidths[idx],
        );
      }

      await buffer.setLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
        lines: symbols,
      });

      await nvim.call("nvim_exec_lua", [
        `function getLineWidth(lineIdx) return #(vim.api.nvim_buf_get_lines(${buffer.id}, lineIdx, lineIdx + 1, false)[1]) end`,
        [],
      ]);

      for (let idx = 0; idx < symbols.length; idx += 1) {
        expect(
          await nvim.call("nvim_exec_lua", [`return getLineWidth(${idx})`, []]),
          `len("${symbols[idx]}")`,
        ).toEqual(expectedWidths[idx]);
      }
    });
  });

  it("calculatePosition", () => {
    expect(
      calculatePosition(pos(0, 0), Buffer.from(""), 0 as ByteIdx),
      "empty string",
    ).toEqual({ row: 0, col: 0 } as Position0Indexed);

    expect(
      calculatePosition(pos(1, 5), Buffer.from(""), 0 as ByteIdx),
      "empty string from non-0 pos",
    ).toEqual({ row: 1, col: 5 } as Position0Indexed);

    expect(
      calculatePosition(pos(1, 5), Buffer.from("abc"), 2 as ByteIdx),
      "move within the same string",
    ).toEqual({ row: 1, col: 7 } as Position0Indexed);

    expect(
      calculatePosition(pos(1, 5), Buffer.from("⚙️"), 6 as ByteIdx),
      "move within the same string, unicode",
    ).toEqual({ row: 1, col: 11 } as Position0Indexed);
    expect(
      calculatePosition(pos(1, 5), Buffer.from(`abc\n`), 4 as ByteIdx),
      "move to a new line",
    ).toEqual({ row: 2, col: 0 } as Position0Indexed);

    expect(
      calculatePosition(pos(1, 5), Buffer.from("⚙️\n"), 7 as ByteIdx),
      "move to a new line after unicode",
    ).toEqual({ row: 2, col: 0 } as Position0Indexed);

    expect(
      calculatePosition(pos(1, 5), Buffer.from("⚙️\nabc"), 10 as ByteIdx),
      "move to a new line and then a few characters after",
    ).toEqual({ row: 2, col: 3 } as Position0Indexed);
  });

  it("replacing a single line", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
        lines: ["abcdef"] as Line[],
      });

      await buffer.setOption("modifiable", false);
      await replaceBetweenPositions({
        buffer,
        startPos: pos(0, 0),
        endPos: pos(0, 3),
        lines: ["1"] as Line[],
        context: { nvim },
      });

      {
        const lines = await buffer.getLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
        });
        expect(lines.join("\n"), "replacing a single line string").toEqual(
          "1def",
        );
      }
    });
  });

  it("replacing unicode", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      const str = "⚙️";
      await buffer.setLines({
        lines: [str] as Line[],
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });

      await buffer.setOption("modifiable", false);
      await replaceBetweenPositions({
        buffer,
        startPos: pos(0, 0),
        endPos: pos(0, strWidthInBytes(str)),
        lines: ["✅"] as Line[],
        context: { nvim },
      });

      {
        const lines = await buffer.getLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
        });
        expect(lines.join("\n"), "replacing unicode").toEqual("✅");
      }
    });
  });

  it("replacing across multiple lines", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setLines({
        lines: ["abcdef", "hijklm"] as Line[],
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });

      await buffer.setOption("modifiable", false);
      await replaceBetweenPositions({
        buffer,
        startPos: pos(0, 3),
        endPos: pos(1, 3),
        lines: ["1", "2"] as Line[],
        context: { nvim },
      });

      {
        const lines = await buffer.getLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
        });
        expect(
          lines.join("\n"),
          "replacing with a shorter string shrinks the rest of the string",
        ).toEqual(`abc1\n2klm`);
      }
    });
  });
});
