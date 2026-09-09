import { describe, expect, it } from "vitest";
import { withNvimClient } from "../../test/preamble.ts";

describe("src/attach.test.ts", () => {
  it("nvim_buf_set_lines with a large file", async () => {
    await withNvimClient(async (nvim) => {
      const lines: string[] = [];
      for (let line = 0; line < 500; line += 1) {
        lines.push("x".repeat(100));
      }
      await nvim.call("nvim_buf_set_lines", [0, 0, -1, false, lines]);
      const roundtripLines = await nvim.call("nvim_buf_get_lines", [
        0,
        0,
        -1,
        false,
      ]);
      expect(roundtripLines).toEqual(lines);
    });
  });
});
