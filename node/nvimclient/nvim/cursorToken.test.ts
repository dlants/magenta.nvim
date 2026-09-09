import { describe, expect, it } from "vitest";
import { withNvimClient } from "../test/preamble.ts";
import { type Line, NvimBuffer } from "./buffer.ts";
import { getTokenAtCursor } from "./cursorToken.ts";
import { getCurrentWindow } from "./nvim.ts";
import type { ByteIdx, Row0Indexed, Row1Indexed } from "./window.ts";

async function setupLine(
  nvim: import("./nvim-node/index.ts").Nvim,
  line: string,
) {
  const buffer = await NvimBuffer.create(false, true, nvim);
  await buffer.setLines({
    start: 0 as Row0Indexed,
    end: -1 as Row0Indexed,
    lines: [line as Line],
  });
  const window = await getCurrentWindow(nvim);
  await window.setBuffer(buffer);
  return { buffer, window };
}

describe("nvim/cursorToken.test.ts", () => {
  it("returns an absolute path under the cursor", async () => {
    await withNvimClient(async (nvim) => {
      const { window } = await setupLine(nvim, "see /tmp/x.txt here");
      await window.setCursor({ row: 1 as Row1Indexed, col: 6 as ByteIdx });
      const token = await getTokenAtCursor(nvim, window);
      expect(token).toBe("/tmp/x.txt");
    });
  });

  it("returns a relative path under the cursor", async () => {
    await withNvimClient(async (nvim) => {
      const { window } = await setupLine(nvim, "read ./foo/bar.txt quickly");
      await window.setCursor({ row: 1 as Row1Indexed, col: 8 as ByteIdx });
      const token = await getTokenAtCursor(nvim, window);
      expect(token).toBe("./foo/bar.txt");
    });
  });

  it("returns a URL under the cursor via cWORD fallback", async () => {
    await withNvimClient(async (nvim) => {
      const { window } = await setupLine(nvim, "visit https://example.com now");
      await window.setCursor({ row: 1 as Row1Indexed, col: 10 as ByteIdx });
      const token = await getTokenAtCursor(nvim, window);
      expect(token).toBe("https://example.com");
    });
  });

  it("strips trailing punctuation from URL tokens", async () => {
    await withNvimClient(async (nvim) => {
      const { window } = await setupLine(nvim, "(https://example.com).");
      await window.setCursor({ row: 1 as Row1Indexed, col: 5 as ByteIdx });
      const token = await getTokenAtCursor(nvim, window);
      expect(token).toBe("https://example.com");
    });
  });

  it("extracts markdown link target regardless of cursor position in span", async () => {
    await withNvimClient(async (nvim) => {
      const line = "see [the file](./hello.txt) now";
      for (const col of [4, 9, 14, 20, 26]) {
        const { window } = await setupLine(nvim, line);
        await window.setCursor({
          row: 1 as Row1Indexed,
          col: col as ByteIdx,
        });
        const token = await getTokenAtCursor(nvim, window);
        expect(token, `col=${col}`).toBe("./hello.txt");
      }
    });
  });
});
