import { describe, expect, it } from "vitest";
import { type Line, NvimBuffer } from "../nvim/buffer.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import { extractMountTree, withNvimClient } from "../test/preamble.ts";
import {
  d,
  mountView,
  pos,
  withError,
  withExtmark,
  withInfo,
  withWarning,
} from "./view.ts";

describe("tea/render.test.ts", () => {
  it("rendering empty string", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const view = () => d`1${""}2`;
      const mountedView = await mountView({
        view,
        props: {},
        mount: {
          nvim,
          buffer,
          startPos: pos(0, 0),
          endPos: pos(0, 0),
        },
      });

      const lines = await buffer.getLines({
        start: 0 as Row0Indexed,
        end: 1 as Row0Indexed,
      });

      expect(lines[0]).toEqual("12" as Line);

      expect(
        await extractMountTree(mountedView._getMountedNode()),
      ).toMatchSnapshot();
    });
  });

  it("rendering multi-line interpolation", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const multiLineValue = `first line
second line
third line`;
      const view = () => d`before${multiLineValue}after`;
      const mountedView = await mountView({
        view,
        props: {},
        mount: {
          nvim,
          buffer,
          startPos: pos(0, 0),
          endPos: pos(0, 0),
        },
      });

      const lines = await buffer.getLines({
        start: 0 as Row0Indexed,
        end: 4 as Row0Indexed,
      });

      expect(lines).toEqual([
        "beforefirst line",
        "second line",
        "third lineafter",
      ] as Line[]);

      expect(
        await extractMountTree(mountedView._getMountedNode()),
      ).toMatchSnapshot();
    });
  });

  it("rendering multi-line template with interpolation", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const name = "world";
      const view = () => d`
      Hello
        ${name}
      Goodbye
    `;
      const mountedView = await mountView({
        view,
        props: {},
        mount: {
          nvim,
          buffer,
          startPos: pos(0, 0),
          endPos: pos(0, 0),
        },
      });

      const lines = await buffer.getLines({
        start: 0 as Row0Indexed,
        end: 5 as Row0Indexed,
      });

      expect(lines).toEqual([
        "",
        "      Hello",
        "        world",
        "      Goodbye",
        "    ",
      ] as Line[]);

      expect(
        await extractMountTree(mountedView._getMountedNode()),
      ).toMatchSnapshot();
    });
  });

  it("rendering nested interpolation", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const inner = d`(inner)`;
      const view = () => d`outer${inner}end`;
      const mountedView = await mountView({
        view,
        props: {},
        mount: {
          nvim,
          buffer,
          startPos: pos(0, 0),
          endPos: pos(0, 0),
        },
      });

      const lines = await buffer.getLines({
        start: 0 as Row0Indexed,
        end: 1 as Row0Indexed,
      });

      expect(lines[0]).toEqual("outer(inner)end" as Line);

      expect(
        await extractMountTree(mountedView._getMountedNode()),
      ).toMatchSnapshot();
    });
  });

  it("rendering empty array", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const view = ({ arr }: { arr: string[] }) =>
        d`${arr.map((c) => d`${c}`)}`;
      const mountedView = await mountView({
        view,
        props: { arr: [] },
        mount: {
          nvim,
          buffer,
          startPos: pos(0, 0),
          endPos: pos(0, 0),
        },
      });

      const lines = await buffer.getLines({
        start: 0 as Row0Indexed,
        end: 1 as Row0Indexed,
      });

      expect(lines[0]).toEqual("" as Line);

      expect(
        await extractMountTree(mountedView._getMountedNode()),
      ).toMatchSnapshot();
    });
  });

  it("rendering array", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const view = ({ arr }: { arr: string[] }) =>
        d`${arr.map((c) => d`${c}`)}`;
      const mountedView = await mountView({
        view,
        props: { arr: ["1", "\n", "2"] },
        mount: {
          nvim,
          buffer,
          startPos: pos(0, 0),
          endPos: pos(0, 0),
        },
      });

      const lines = await buffer.getLines({
        start: 0 as Row0Indexed,
        end: 2 as Row0Indexed,
      });

      expect(lines).toEqual(["1", "2"] as Line[]);

      expect(
        await extractMountTree(mountedView._getMountedNode()),
      ).toMatchSnapshot();
    });
  });

  it("rendering with basic highlights", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const view = () =>
        d`${withError(d`Error text`)} and ${withWarning(d`Warning text`)}`;
      const mountedView = await mountView({
        view,
        props: {},
        mount: {
          nvim,
          buffer,
          startPos: pos(0, 0),
          endPos: pos(0, 0),
        },
      });

      const lines = await buffer.getLines({
        start: 0 as Row0Indexed,
        end: 1 as Row0Indexed,
      });

      expect(lines[0]).toEqual("Error text and Warning text" as Line);

      // Check that extmarks were created
      const mountedNode = mountedView._getMountedNode();
      expect(mountedNode.type).toBe("node");

      // Should have extmarks on error and warning nodes
      const errorNode = (
        mountedNode as Extract<typeof mountedNode, { type: "node" }>
      ).children[0];
      const warningNode = (
        mountedNode as Extract<typeof mountedNode, { type: "node" }>
      ).children[2];

      expect(errorNode.extmarkOptions).toEqual({ hl_group: "ErrorMsg" });
      expect(errorNode.extmarkId).toBeDefined();
      expect(errorNode.extmarkId).not.toBe(-1);

      expect(warningNode.extmarkOptions).toEqual({ hl_group: "WarningMsg" });
      expect(warningNode.extmarkId).toBeDefined();
      expect(warningNode.extmarkId).not.toBe(-1);

      // Check actual extmarks in buffer
      const extmarks = await buffer.getExtmarks();
      expect(extmarks, "Should have 2 extmarks in buffer").toHaveLength(2);

      const errorExtmark = extmarks.find((e) => e.id === errorNode.extmarkId);
      const warningExtmark = extmarks.find(
        (e) => e.id === warningNode.extmarkId,
      );

      expect(
        errorExtmark,
        "Error extmark should exist in buffer",
      ).toBeDefined();
      expect(
        errorExtmark!.startPos,
        "Error extmark should start at beginning",
      ).toEqual(pos(0, 0));
      expect(
        errorExtmark!.endPos,
        "Error extmark should end at position 10",
      ).toEqual(pos(0, 10));
      expect(
        errorExtmark!.options.hl_group,
        "Error extmark should have ErrorMsg highlight",
      ).toBe("ErrorMsg");

      expect(
        warningExtmark,
        "Warning extmark should exist in buffer",
      ).toBeDefined();
      expect(
        warningExtmark!.startPos,
        "Warning extmark should start at position 15",
      ).toEqual(pos(0, 15));
      expect(
        warningExtmark!.endPos,
        "Warning extmark should end at position 27",
      ).toEqual(pos(0, 27));
      expect(
        warningExtmark!.options.hl_group,
        "Warning extmark should have WarningMsg highlight",
      ).toBe("WarningMsg");
    });
  });

  it("rendering with custom extmark options", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const view = () =>
        d`${withExtmark(d`Highlighted text`, {
          hl_group: "String",
          priority: 200,
          sign_text: "!!",
          sign_hl_group: "ErrorMsg",
        })}`;

      const mountedView = await mountView({
        view,
        props: {},
        mount: {
          nvim,
          buffer,
          startPos: pos(0, 0),
          endPos: pos(0, 0),
        },
      });

      const lines = await buffer.getLines({
        start: 0 as Row0Indexed,
        end: 1 as Row0Indexed,
      });

      expect(lines[0]).toEqual("Highlighted text" as Line);

      // Check that extmark was created with correct options
      const mountedNode = mountedView._getMountedNode();
      expect(mountedNode.type).toBe("node");

      const highlightedNode = (
        mountedNode as Extract<typeof mountedNode, { type: "node" }>
      ).children[0];
      expect(highlightedNode.extmarkOptions).toEqual({
        hl_group: "String",
        priority: 200,
        sign_text: "!!",
        sign_hl_group: "ErrorMsg",
      });
      expect(highlightedNode.extmarkId).toBeDefined();
      expect(highlightedNode.extmarkId).not.toBe(-1);

      // Check actual extmark in buffer
      const extmarks = await buffer.getExtmarks();
      expect(extmarks, "Should have 1 extmark in buffer").toHaveLength(1);

      const highlightExtmark = extmarks[0];
      expect(highlightExtmark.id, "Extmark ID should match node ID").toBe(
        highlightedNode.extmarkId,
      );
      expect(
        highlightExtmark.startPos,
        "Extmark should start at beginning",
      ).toEqual(pos(0, 0));
      expect(
        highlightExtmark.endPos,
        "Extmark should end at position 16",
      ).toEqual(pos(0, 16));
      expect(
        highlightExtmark.options.hl_group,
        "Extmark should have String highlight",
      ).toBe("String");
      expect(
        highlightExtmark.options.priority,
        "Extmark should have priority 200",
      ).toBe(200);
      expect(
        highlightExtmark.options.sign_text,
        "Extmark should have sign text",
      ).toBe("!!");
      expect(
        highlightExtmark.options.sign_hl_group,
        "Extmark should have ErrorMsg sign highlight",
      ).toBe("ErrorMsg");
    });
  });

  it("rendering nested highlights", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const view = () => withError(d`Error: ${withWarning(d`warning`)} inside`);
      const mountedView = await mountView({
        view,
        props: {},
        mount: {
          nvim,
          buffer,
          startPos: pos(0, 0),
          endPos: pos(0, 0),
        },
      });

      const lines = await buffer.getLines({
        start: 0 as Row0Indexed,
        end: 1 as Row0Indexed,
      });

      expect(lines[0]).toEqual("Error: warning inside" as Line);

      // Check that both parent and child extmarks were created
      const mountedNode = mountedView._getMountedNode();
      expect(mountedNode.extmarkOptions).toEqual({ hl_group: "ErrorMsg" });
      expect(mountedNode.extmarkId).toBeDefined();
      expect(mountedNode.extmarkId).not.toBe(-1);

      expect(mountedNode.type).toBe("node");
      const warningNode = (
        mountedNode as Extract<typeof mountedNode, { type: "node" }>
      ).children[1];
      expect(warningNode.extmarkOptions).toEqual({ hl_group: "WarningMsg" });
      expect(warningNode.extmarkId).toBeDefined();
      expect(warningNode.extmarkId).not.toBe(-1);
    });
  });

  it("rendering empty content with highlights should not create extmarks", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const view = () => d`${withError(d``)}end`;
      const mountedView = await mountView({
        view,
        props: {},
        mount: {
          nvim,
          buffer,
          startPos: pos(0, 0),
          endPos: pos(0, 0),
        },
      });

      const lines = await buffer.getLines({
        start: 0 as Row0Indexed,
        end: 1 as Row0Indexed,
      });

      expect(lines[0]).toEqual("end" as Line);

      // Empty content should not create extmarks
      const mountedNode = mountedView._getMountedNode();
      expect(mountedNode.type).toBe("node");

      const emptyNode = (
        mountedNode as Extract<typeof mountedNode, { type: "node" }>
      ).children[0];
      expect(emptyNode.extmarkId).toBeUndefined();
    });
  });

  describe("extmark boundary tests", () => {
    it("string node extmark boundaries", async () => {
      await withNvimClient(async (nvim) => {
        const buffer = await NvimBuffer.create(false, true, nvim);
        await buffer.setOption("modifiable", false);

        const view = () => d`prefix${withError(d`error text`)}suffix`;
        const mountedView = await mountView({
          view,
          props: {},
          mount: {
            nvim,
            buffer,
            startPos: pos(0, 0),
            endPos: pos(0, 0),
          },
        });

        const mountedNode = mountedView._getMountedNode();
        expect(mountedNode.type).toBe("node");

        const errorNode = (
          mountedNode as Extract<typeof mountedNode, { type: "node" }>
        ).children[1];
        expect(errorNode.startPos).toEqual(pos(0, 6)); // after "prefix"
        expect(errorNode.endPos).toEqual(pos(0, 16)); // after "error text"
        expect(errorNode.extmarkId).toBeDefined();

        // Check actual extmark in buffer
        const extmarks = await buffer.getExtmarks();
        expect(extmarks, "Should have 1 extmark in buffer").toHaveLength(1);

        const errorExtmark = extmarks[0];
        expect(errorExtmark.id, "Extmark ID should match node ID").toBe(
          errorNode.extmarkId,
        );
        expect(
          errorExtmark.startPos,
          "Extmark should start at position 6",
        ).toEqual(pos(0, 6));
        expect(
          errorExtmark.endPos,
          "Extmark should end at position 16",
        ).toEqual(pos(0, 16));
        expect(
          errorExtmark.options.hl_group,
          "Extmark should have ErrorMsg highlight",
        ).toBe("ErrorMsg");
      });
    });

    it("node extmark boundaries with multiple children", async () => {
      await withNvimClient(async (nvim) => {
        const buffer = await NvimBuffer.create(false, true, nvim);
        await buffer.setOption("modifiable", false);

        const view = () => withError(d`Error: ${d`inner`} text`);
        const mountedView = await mountView({
          view,
          props: {},
          mount: {
            nvim,
            buffer,
            startPos: pos(0, 0),
            endPos: pos(0, 0),
          },
        });

        const mountedNode = mountedView._getMountedNode();
        expect(mountedNode.startPos).toEqual(pos(0, 0));
        expect(mountedNode.endPos).toEqual(pos(0, 17)); // entire "Error: inner text"
        expect(mountedNode.extmarkId).toBeDefined();
      });
    });

    it("array extmark boundaries", async () => {
      await withNvimClient(async (nvim) => {
        const buffer = await NvimBuffer.create(false, true, nvim);
        await buffer.setOption("modifiable", false);

        const items = ["first", "second", "third"];
        const view = () => {
          const arrayNode = {
            type: "array" as const,
            children: items.map((item) => d`${item} `),
          };
          return d`${withError(arrayNode)}`;
        };
        const mountedView = await mountView({
          view,
          props: {},
          mount: {
            nvim,
            buffer,
            startPos: pos(0, 0),
            endPos: pos(0, 0),
          },
        });

        const mountedNode = mountedView._getMountedNode();
        expect(mountedNode.type).toBe("node");

        const arrayNode = (
          mountedNode as Extract<typeof mountedNode, { type: "node" }>
        ).children[0];
        expect(arrayNode.type).toBe("array");
        expect(arrayNode.startPos).toEqual(pos(0, 0));
        expect(arrayNode.endPos).toEqual(pos(0, 19));
        expect(arrayNode.extmarkId).toBeDefined();

        // Check actual extmark in buffer
        const extmarks = await buffer.getExtmarks();
        expect(extmarks, "Should have 1 extmark in buffer").toHaveLength(1);

        const arrayExtmark = extmarks[0];
        expect(arrayExtmark.id, "Array extmark ID should match node ID").toBe(
          arrayNode.extmarkId,
        );
        expect(
          arrayExtmark.startPos,
          "Array extmark should start at beginning",
        ).toEqual(pos(0, 0));
        expect(
          arrayExtmark.endPos,
          "Array extmark should end at position 19",
        ).toEqual(pos(0, 19));
        expect(
          arrayExtmark.options.hl_group,
          "Array extmark should have ErrorMsg highlight",
        ).toBe("ErrorMsg");
      });
    });

    it("multiline extmark boundaries", async () => {
      await withNvimClient(async (nvim) => {
        const buffer = await NvimBuffer.create(false, true, nvim);
        await buffer.setOption("modifiable", false);

        const view = () => d`${withError(d`line1\nline2\nline3`)}`;
        const mountedView = await mountView({
          view,
          props: {},
          mount: {
            nvim,
            buffer,
            startPos: pos(0, 0),
            endPos: pos(0, 0),
          },
        });

        const mountedNode = mountedView._getMountedNode();
        expect(mountedNode.type).toBe("node");

        const errorNode = (
          mountedNode as Extract<typeof mountedNode, { type: "node" }>
        ).children[0];
        expect(errorNode.startPos).toEqual(pos(0, 0));
        expect(errorNode.endPos).toEqual(pos(2, 5)); // end of "line3"
        expect(errorNode.extmarkId).toBeDefined();

        // Check actual extmark in buffer
        const extmarks = await buffer.getExtmarks();
        expect(extmarks, "Should have 1 extmark in buffer").toHaveLength(1);

        const errorExtmark = extmarks[0];
        expect(
          errorExtmark.id,
          "Multiline extmark ID should match node ID",
        ).toBe(errorNode.extmarkId);
        expect(
          errorExtmark.startPos,
          "Multiline extmark should start at beginning",
        ).toEqual(pos(0, 0));
        expect(
          errorExtmark.endPos,
          "Multiline extmark should end at line 2, position 5",
        ).toEqual(pos(2, 5));
        expect(
          errorExtmark.options.hl_group,
          "Multiline extmark should have ErrorMsg highlight",
        ).toBe("ErrorMsg");
      });
    });
  });

  describe("nested extmark tests", () => {
    it("deeply nested extmarks", async () => {
      await withNvimClient(async (nvim) => {
        const buffer = await NvimBuffer.create(false, true, nvim);
        await buffer.setOption("modifiable", false);

        const view = () =>
          withError(
            d`Error: ${withWarning(d`Warning: ${withInfo(d`Info message`)}`)}`,
          );

        const mountedView = await mountView({
          view,
          props: {},
          mount: {
            nvim,
            buffer,
            startPos: pos(0, 0),
            endPos: pos(0, 0),
          },
        });

        const lines = await buffer.getLines({
          start: 0 as Row0Indexed,
          end: 1 as Row0Indexed,
        });

        expect(lines[0]).toEqual("Error: Warning: Info message" as Line);

        // Check all three extmarks were created
        const outerNode = mountedView._getMountedNode();
        expect(outerNode.extmarkOptions).toEqual({ hl_group: "ErrorMsg" });
        expect(outerNode.extmarkId).toBeDefined();
        expect(outerNode.startPos).toEqual(pos(0, 0));
        expect(outerNode.endPos).toEqual(pos(0, 28));

        expect(outerNode.type).toBe("node");
        const warningNode = (
          outerNode as Extract<typeof outerNode, { type: "node" }>
        ).children[1];
        expect(warningNode.extmarkOptions).toEqual({
          hl_group: "WarningMsg",
        });
        expect(warningNode.extmarkId).toBeDefined();
        expect(warningNode.startPos).toEqual(pos(0, 7));
        expect(warningNode.endPos).toEqual(pos(0, 28));

        expect(warningNode.type).toBe("node");
        const infoNode = (
          warningNode as Extract<typeof warningNode, { type: "node" }>
        ).children[1];
        expect(infoNode.extmarkOptions).toEqual({ hl_group: "Directory" });
        expect(infoNode.extmarkId).toBeDefined();
        expect(infoNode.startPos).toEqual(pos(0, 16));
        expect(infoNode.endPos).toEqual(pos(0, 28));

        // Check actual extmarks in buffer
        const extmarks = await buffer.getExtmarks();
        expect(
          extmarks,
          "Should have 3 nested extmarks in buffer",
        ).toHaveLength(3);

        const outerExtmark = extmarks.find((e) => e.id === outerNode.extmarkId);
        const warningExtmark = extmarks.find(
          (e) => e.id === warningNode.extmarkId,
        );
        const infoExtmark = extmarks.find((e) => e.id === infoNode.extmarkId);

        expect(outerExtmark, "Outer error extmark should exist").toBeDefined();
        expect(
          outerExtmark!.startPos,
          "Outer extmark should start at beginning",
        ).toEqual(pos(0, 0));
        expect(
          outerExtmark!.endPos,
          "Outer extmark should end at position 28",
        ).toEqual(pos(0, 28));
        expect(
          outerExtmark!.options.hl_group,
          "Outer extmark should have ErrorMsg highlight",
        ).toBe("ErrorMsg");

        expect(warningExtmark, "Warning extmark should exist").toBeDefined();
        expect(
          warningExtmark!.startPos,
          "Warning extmark should start at position 7",
        ).toEqual(pos(0, 7));
        expect(
          warningExtmark!.endPos,
          "Warning extmark should end at position 28",
        ).toEqual(pos(0, 28));
        expect(
          warningExtmark!.options.hl_group,
          "Warning extmark should have WarningMsg highlight",
        ).toBe("WarningMsg");

        expect(infoExtmark, "Info extmark should exist").toBeDefined();
        expect(
          infoExtmark!.startPos,
          "Info extmark should start at position 16",
        ).toEqual(pos(0, 16));
        expect(
          infoExtmark!.endPos,
          "Info extmark should end at position 28",
        ).toEqual(pos(0, 28));
        expect(
          infoExtmark!.options.hl_group,
          "Info extmark should have Directory highlight",
        ).toBe("Directory");
      });
    });

    it("overlapping extmarks at same level", async () => {
      await withNvimClient(async (nvim) => {
        const buffer = await NvimBuffer.create(false, true, nvim);
        await buffer.setOption("modifiable", false);

        const view = () =>
          d`${withError(d`error`)} and ${withWarning(d`warning`)}`;
        const mountedView = await mountView({
          view,
          props: {},
          mount: {
            nvim,
            buffer,
            startPos: pos(0, 0),
            endPos: pos(0, 0),
          },
        });

        const lines = await buffer.getLines({
          start: 0 as Row0Indexed,
          end: 1 as Row0Indexed,
        });

        expect(lines[0]).toEqual("error and warning" as Line);

        const mountedNode = mountedView._getMountedNode();
        expect(mountedNode.type).toBe("node");

        const errorNode = (
          mountedNode as Extract<typeof mountedNode, { type: "node" }>
        ).children[0];
        const warningNode = (
          mountedNode as Extract<typeof mountedNode, { type: "node" }>
        ).children[2];

        expect(errorNode.extmarkOptions).toEqual({ hl_group: "ErrorMsg" });
        expect(errorNode.extmarkId).toBeDefined();
        expect(errorNode.startPos).toEqual(pos(0, 0));
        expect(errorNode.endPos).toEqual(pos(0, 5));

        expect(warningNode.extmarkOptions).toEqual({
          hl_group: "WarningMsg",
        });
        expect(warningNode.extmarkId).toBeDefined();
        expect(warningNode.startPos).toEqual(pos(0, 10));
        expect(warningNode.endPos).toEqual(pos(0, 17));

        // Check actual extmarks in buffer
        const extmarks = await buffer.getExtmarks();
        expect(
          extmarks,
          "Should have 2 overlapping extmarks in buffer",
        ).toHaveLength(2);

        const errorExtmark = extmarks.find((e) => e.id === errorNode.extmarkId);
        const warningExtmark = extmarks.find(
          (e) => e.id === warningNode.extmarkId,
        );

        expect(errorExtmark, "Error extmark should exist").toBeDefined();
        expect(
          errorExtmark!.startPos,
          "Error extmark should start at beginning",
        ).toEqual(pos(0, 0));
        expect(
          errorExtmark!.endPos,
          "Error extmark should end at position 5",
        ).toEqual(pos(0, 5));
        expect(
          errorExtmark!.options.hl_group,
          "Error extmark should have ErrorMsg highlight",
        ).toBe("ErrorMsg");

        expect(warningExtmark, "Warning extmark should exist").toBeDefined();
        expect(
          warningExtmark!.startPos,
          "Warning extmark should start at position 10",
        ).toEqual(pos(0, 10));
        expect(
          warningExtmark!.endPos,
          "Warning extmark should end at position 17",
        ).toEqual(pos(0, 17));
        expect(
          warningExtmark!.options.hl_group,
          "Warning extmark should have WarningMsg highlight",
        ).toBe("WarningMsg");
      });
    });

    it("extmarks with arrays", async () => {
      await withNvimClient(async (nvim) => {
        const buffer = await NvimBuffer.create(false, true, nvim);
        await buffer.setOption("modifiable", false);

        const items = ["item1", "item2", "item3"];
        const view = () => {
          const arrayNode = {
            type: "array" as const,
            children: items.map((item) => withWarning(d`${item} `)),
          };
          return d`${withError(arrayNode)}`;
        };
        const mountedView = await mountView({
          view,
          props: {},
          mount: {
            nvim,
            buffer,
            startPos: pos(0, 0),
            endPos: pos(0, 0),
          },
        });

        const lines = await buffer.getLines({
          start: 0 as Row0Indexed,
          end: 1 as Row0Indexed,
        });

        expect(lines[0]).toEqual("item1 item2 item3 " as Line);

        const mountedNode = mountedView._getMountedNode();
        expect(mountedNode.type).toBe("node");

        const arrayNode = (
          mountedNode as Extract<typeof mountedNode, { type: "node" }>
        ).children[0];

        // Outer error extmark should span the entire array
        expect(arrayNode.extmarkOptions, "arrayNode.extmarkOptions").toEqual({
          hl_group: "ErrorMsg",
        });
        expect(arrayNode.extmarkId, "arrayNode.extmarkId").toBeDefined();
        expect(arrayNode.startPos, "arrayNode.startPos").toEqual(pos(0, 0));
        expect(arrayNode.endPos, "arrayNode.endPos").toEqual(pos(0, 18));

        // Each item should have its own warning extmark
        expect(arrayNode.type).toBe("array");
        const item1Node = (
          arrayNode as Extract<typeof arrayNode, { type: "array" }>
        ).children[0];
        const item2Node = (
          arrayNode as Extract<typeof arrayNode, { type: "array" }>
        ).children[1];
        const item3Node = (
          arrayNode as Extract<typeof arrayNode, { type: "array" }>
        ).children[2];

        expect(item1Node.extmarkOptions).toEqual({
          hl_group: "WarningMsg",
        });
        expect(item1Node.extmarkId).toBeDefined();
        expect(item1Node.startPos).toEqual(pos(0, 0));
        expect(item1Node.endPos).toEqual(pos(0, 6));

        expect(item2Node.extmarkOptions).toEqual({
          hl_group: "WarningMsg",
        });
        expect(item2Node.extmarkId).toBeDefined();
        expect(item2Node.startPos).toEqual(pos(0, 6));
        expect(item2Node.endPos).toEqual(pos(0, 12));

        expect(item3Node.extmarkOptions).toEqual({
          hl_group: "WarningMsg",
        });
        expect(item3Node.extmarkId).toBeDefined();
        expect(item3Node.startPos).toEqual(pos(0, 12));
        expect(item3Node.endPos).toEqual(pos(0, 18));

        // Check actual extmarks in buffer (4 total: 1 array + 3 items)
        const extmarks = await buffer.getExtmarks();
        expect(
          extmarks,
          "Should have 4 extmarks in buffer (1 array + 3 items)",
        ).toHaveLength(4);

        const arrayExtmark = extmarks.find((e) => e.id === arrayNode.extmarkId);
        const item1Extmark = extmarks.find((e) => e.id === item1Node.extmarkId);
        const item2Extmark = extmarks.find((e) => e.id === item2Node.extmarkId);
        const item3Extmark = extmarks.find((e) => e.id === item3Node.extmarkId);

        expect(arrayExtmark, "Array extmark should exist").toBeDefined();
        expect(
          arrayExtmark!.startPos,
          "Array extmark should start at beginning",
        ).toEqual(pos(0, 0));
        expect(
          arrayExtmark!.endPos,
          "Array extmark should end at position 19",
        ).toEqual(pos(0, 18));
        expect(
          arrayExtmark!.options.hl_group,
          "Array extmark should have ErrorMsg highlight",
        ).toBe("ErrorMsg");

        expect(item1Extmark, "Item1 extmark should exist").toBeDefined();
        expect(
          item1Extmark!.startPos,
          "Item1 extmark should start at beginning",
        ).toEqual(pos(0, 0));
        expect(
          item1Extmark!.endPos,
          "Item1 extmark should end at position 6",
        ).toEqual(pos(0, 6));
        expect(
          item1Extmark!.options.hl_group,
          "Item1 extmark should have WarningMsg highlight",
        ).toBe("WarningMsg");

        expect(item2Extmark, "Item2 extmark should exist").toBeDefined();
        expect(
          item2Extmark!.startPos,
          "Item2 extmark should start at position 6",
        ).toEqual(pos(0, 6));
        expect(
          item2Extmark!.endPos,
          "Item2 extmark should end at position 12",
        ).toEqual(pos(0, 12));
        expect(
          item2Extmark!.options.hl_group,
          "Item2 extmark should have WarningMsg highlight",
        ).toBe("WarningMsg");

        expect(item3Extmark, "Item3 extmark should exist").toBeDefined();
        expect(
          item3Extmark!.startPos,
          "Item3 extmark should start at position 12",
        ).toEqual(pos(0, 12));
        expect(
          item3Extmark!.endPos,
          "Item3 extmark should end at position 18",
        ).toEqual(pos(0, 18));
        expect(
          item3Extmark!.options.hl_group,
          "Item3 extmark should have WarningMsg highlight",
        ).toBe("WarningMsg");
      });
    });

    it("extmarks with custom priorities", async () => {
      await withNvimClient(async (nvim) => {
        const buffer = await NvimBuffer.create(false, true, nvim);
        await buffer.setOption("modifiable", false);

        const view = () =>
          withExtmark(
            d`${withExtmark(d`nested`, { hl_group: "String", priority: 300 })}`,
            { hl_group: "ErrorMsg", priority: 100 },
          );

        const mountedView = await mountView({
          view,
          props: {},
          mount: {
            nvim,
            buffer,
            startPos: pos(0, 0),
            endPos: pos(0, 0),
          },
        });

        const outerNode = mountedView._getMountedNode();
        expect(outerNode.extmarkOptions).toEqual({
          hl_group: "ErrorMsg",
          priority: 100,
        });
        expect(outerNode.extmarkId).toBeDefined();

        expect(outerNode.type).toBe("node");
        const innerNode = (
          outerNode as Extract<typeof outerNode, { type: "node" }>
        ).children[0];
        expect(innerNode.extmarkOptions).toEqual({
          hl_group: "String",
          priority: 300,
        });
        expect(innerNode.extmarkId).toBeDefined();

        // Check actual extmarks in buffer
        const extmarks = await buffer.getExtmarks();
        expect(
          extmarks,
          "Should have 2 extmarks with custom priorities",
        ).toHaveLength(2);

        const outerExtmark = extmarks.find((e) => e.id === outerNode.extmarkId);
        const innerExtmark = extmarks.find((e) => e.id === innerNode.extmarkId);

        expect(outerExtmark, "Outer extmark should exist").toBeDefined();
        expect(
          outerExtmark!.startPos,
          "Outer extmark should start at beginning",
        ).toEqual(pos(0, 0));
        expect(
          outerExtmark!.endPos,
          "Outer extmark should end at position 6",
        ).toEqual(pos(0, 6));
        expect(
          outerExtmark!.options.hl_group,
          "Outer extmark should have ErrorMsg highlight",
        ).toBe("ErrorMsg");
        expect(
          outerExtmark!.options.priority,
          "Outer extmark should have priority 100",
        ).toBe(100);

        expect(innerExtmark, "Inner extmark should exist").toBeDefined();
        expect(
          innerExtmark!.startPos,
          "Inner extmark should start at beginning",
        ).toEqual(pos(0, 0));
        expect(
          innerExtmark!.endPos,
          "Inner extmark should end at position 6",
        ).toEqual(pos(0, 6));
        expect(
          innerExtmark!.options.hl_group,
          "Inner extmark should have String highlight",
        ).toBe("String");
        expect(
          innerExtmark!.options.priority,
          "Inner extmark should have priority 300",
        ).toBe(300);
      });
    });
  });
});
