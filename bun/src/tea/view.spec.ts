import { extractMountTree, NeovimTestHelper } from "../../test/preamble.ts";
import { d, mountView, pos } from "./view.ts";
import * as assert from "assert";
import { test } from "node:test";
import { NvimBuffer, type Line } from "../nvim/buffer.ts";

await test.describe("Neovim Plugin Tests", async () => {
  let helper: NeovimTestHelper;

  test.before(() => {
    helper = new NeovimTestHelper();
  });

  test.beforeEach(async () => {
    await helper.startNvim();
  });

  test.afterEach(() => {
    helper.stopNvim();
  });

  await test("basic rendering & update", async () => {
    const buffer = await NvimBuffer.create(false, true);
    await buffer.setLines({ start: 0, end: 0, lines: [""] as Line[] });

    await buffer.setOption("modifiable", false);

    const view = (props: { helloTo: string }) => d`hello, ${props.helloTo}!`;
    const mountedView = await mountView({
      view,
      props: { helloTo: "world" },
      mount: {
        buffer,
        startPos: pos(0, 0),
        endPos: pos(0, 0),
      },
    });

    const lines = await buffer.getLines({
      start: 0,
      end: 1,
    });

    assert.equal(lines[0], "hello, world!");

    assert.deepStrictEqual(
      await extractMountTree(mountedView._getMountedNode()),
      {
        type: "node",
        endPos: {
          col: 13,
          row: 0,
        },
        startPos: {
          col: 0,
          row: 0,
        },
        children: [
          {
            content: "hello, ",
            startPos: {
              col: 0,
              row: 0,
            },
            endPos: {
              col: 7,
              row: 0,
            },
            type: "string",
          },
          {
            content: "world",
            startPos: {
              col: 7,
              row: 0,
            },
            endPos: {
              col: 12,
              row: 0,
            },
            type: "string",
          },
          {
            content: "!",
            startPos: {
              col: 12,
              row: 0,
            },
            endPos: {
              col: 13,
              row: 0,
            },
            type: "string",
          },
        ],
      },
    );

    await mountedView.render({ helloTo: "nvim" });
    {
      const lines = await buffer.getLines({
        start: 0,
        end: 1,
      });

      assert.equal(lines[0], "hello, nvim!");
    }

    assert.deepStrictEqual(
      await extractMountTree(mountedView._getMountedNode()),
      {
        type: "node",
        endPos: {
          col: 12,
          row: 0,
        },
        startPos: {
          col: 0,
          row: 0,
        },
        children: [
          {
            content: "hello, ",
            startPos: {
              col: 0,
              row: 0,
            },
            endPos: {
              col: 7,
              row: 0,
            },
            type: "string",
          },
          {
            content: "nvim",
            startPos: {
              col: 7,
              row: 0,
            },
            endPos: {
              col: 11,
              row: 0,
            },
            type: "string",
          },
          {
            content: "!",
            startPos: {
              col: 11,
              row: 0,
            },
            endPos: {
              col: 12,
              row: 0,
            },
            type: "string",
          },
        ],
      },
    );
  });
});