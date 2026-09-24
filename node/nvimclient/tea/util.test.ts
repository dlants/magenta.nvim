import { describe, expect, it } from "vitest";
import { type Line, NvimBuffer } from "../nvim/buffer.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import { withNvimClient } from "../test/preamble.ts";
import { replaceBetweenPositions, strWidthInBytes } from "./util.ts";
import { pos } from "./view.ts";

describe("tea/util.test.ts", () => {
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
