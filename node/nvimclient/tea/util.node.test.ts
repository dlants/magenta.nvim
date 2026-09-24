import { describe, expect, it } from "vitest";
import type { ByteIdx, Position0Indexed } from "../nvim/window.ts";
import { calculatePosition, strWidthInBytes } from "./util.ts";
import { pos } from "./view.ts";

describe("tea/util.test.ts", () => {
  it("strWidthInBytes", () => {
    const symbols = ["", "a", "⚙️", "⏳", "⚠️", "👀", "✅"];
    const expectedWidths = [0, 1, 6, 3, 6, 4, 3];
    for (let idx = 0; idx < symbols.length; idx += 1) {
      expect(strWidthInBytes(symbols[idx]), symbols[idx]).toEqual(
        expectedWidths[idx],
      );
      // nvim measures line length in UTF-8 bytes
      expect(Buffer.byteLength(symbols[idx], "utf8")).toEqual(
        expectedWidths[idx],
      );
    }
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
});
