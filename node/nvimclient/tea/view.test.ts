import * as assert from "node:assert";
import { describe, it } from "vitest";
import { type Line, NvimBuffer } from "../nvim/buffer.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import { extractMountTree, withNvimClient } from "../test/preamble.ts";
import { d, mountView, pos } from "./view.ts";

describe("Neovim Plugin Tests", () => {
  it("basic rendering & update", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setLines({
        start: 0 as Row0Indexed,
        end: 0 as Row0Indexed,
        lines: [""] as Line[],
      });

      await buffer.setOption("modifiable", false);

      const view = (props: { helloTo: string }) => d`hello, ${props.helloTo}!`;
      const mountedView = await mountView({
        view,
        props: { helloTo: "world" },
        mount: {
          nvim,
          buffer,
          startPos: pos(0 as Row0Indexed, 0),
          endPos: pos(0 as Row0Indexed, 0),
        },
      });

      const lines = await buffer.getLines({
        start: 0 as Row0Indexed,
        end: 1 as Row0Indexed,
      });

      assert.equal(lines[0], "hello, world!");

      assert.deepStrictEqual(
        await extractMountTree(mountedView._getMountedNode()),
        {
          type: "node",
          endPos: {
            col: 13,
            row: 0 as Row0Indexed,
          },
          startPos: {
            col: 0,
            row: 0 as Row0Indexed,
          },
          children: [
            {
              content: "hello, ",
              startPos: {
                col: 0,
                row: 0 as Row0Indexed,
              },
              endPos: {
                col: 7,
                row: 0 as Row0Indexed,
              },
              type: "string",
            },
            {
              content: "world",
              startPos: {
                col: 7,
                row: 0 as Row0Indexed,
              },
              endPos: {
                col: 12,
                row: 0 as Row0Indexed,
              },
              type: "string",
            },
            {
              content: "!",
              startPos: {
                col: 12,
                row: 0 as Row0Indexed,
              },
              endPos: {
                col: 13,
                row: 0 as Row0Indexed,
              },
              type: "string",
            },
          ],
        },
      );

      await mountedView.render({ helloTo: "nvim" });
      {
        const lines = await buffer.getLines({
          start: 0 as Row0Indexed,
          end: 1 as Row0Indexed,
        });

        assert.equal(lines[0], "hello, nvim!");
      }

      assert.deepStrictEqual(
        await extractMountTree(mountedView._getMountedNode()),
        {
          type: "node",
          endPos: {
            col: 12,
            row: 0 as Row0Indexed,
          },
          startPos: {
            col: 0,
            row: 0 as Row0Indexed,
          },
          children: [
            {
              content: "hello, ",
              startPos: {
                col: 0,
                row: 0 as Row0Indexed,
              },
              endPos: {
                col: 7,
                row: 0 as Row0Indexed,
              },
              type: "string",
            },
            {
              content: "nvim",
              startPos: {
                col: 7,
                row: 0 as Row0Indexed,
              },
              endPos: {
                col: 11,
                row: 0 as Row0Indexed,
              },
              type: "string",
            },
            {
              content: "!",
              startPos: {
                col: 11,
                row: 0 as Row0Indexed,
              },
              endPos: {
                col: 12,
                row: 0 as Row0Indexed,
              },
              type: "string",
            },
          ],
        },
      );
    });
  });
});
