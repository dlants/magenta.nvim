import { describe, expect, it, vi } from "vitest";
import { NvimBuffer } from "../nvim/buffer.ts";
import { getCurrentWindow } from "../nvim/nvim.ts";
import type { ByteIdx, Row0Indexed, Row1Indexed } from "../nvim/window.ts";
import { withNvimClient } from "../test/preamble.ts";
import { createApp } from "./tea.ts";
import { d, pos, withBindings } from "./view.ts";

describe("tea/on-unhandled-key.test.ts", () => {
  it("fires onUnhandledKey only when no binding covers the cursor", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const window = await getCurrentWindow(nvim);
      await window.setBuffer(buffer);

      const boundSpy = vi.fn();
      const unhandledSpy = vi.fn();

      const app = createApp({
        nvim,
        initialModel: {},
        View: () =>
          d`plain ${withBindings(d`[btn]`, { "<CR>": boundSpy })} tail`,
        onUnhandledKey: (args) => {
          unhandledSpy(args);
        },
      });

      const mounted = await app.mount({
        nvim,
        buffer,
        startPos: pos(0, 0),
        endPos: pos(0, 0),
      });

      // Cursor on "[btn]" — find the column.
      // Buffer content: "plain [btn] tail"
      //                  0123456789012345
      await window.setCursor({
        row: 1 as Row1Indexed,
        col: 7 as ByteIdx,
      });
      await mounted.onKey("<CR>");
      expect(boundSpy).toHaveBeenCalledTimes(1);
      expect(unhandledSpy).not.toHaveBeenCalled();

      // Cursor on plain text ("plain" at col 0)
      await window.setCursor({
        row: 1 as Row1Indexed,
        col: 0 as ByteIdx,
      });
      await mounted.onKey("<CR>");
      expect(boundSpy).toHaveBeenCalledTimes(1);
      expect(unhandledSpy).toHaveBeenCalledTimes(1);
      expect(unhandledSpy.mock.calls[0][0].key).toBe("<CR>");
      expect(unhandledSpy.mock.calls[0][0].row).toBe(0 as Row0Indexed);
      expect(unhandledSpy.mock.calls[0][0].col).toBe(0);
      expect(unhandledSpy.mock.calls[0][0].buffer.id).toBe(buffer.id);

      mounted.unmount();
      app.destroy();
    });
  });
});
