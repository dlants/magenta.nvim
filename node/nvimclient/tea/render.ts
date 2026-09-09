import type { Line } from "../nvim/buffer.ts";
import type { ExtmarkId, ExtmarkOptions } from "../nvim/extmarks.ts";
import type { ByteIdx } from "../nvim/window.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Bindings } from "./bindings.ts";
import { calculatePosition, replaceBetweenPositions } from "./util.ts";
import type { MountedVDOM, MountPoint, VDOMNode } from "./view.ts";

export async function render({
  vdom,
  mount,
}: {
  vdom: VDOMNode;
  mount: MountPoint;
}): Promise<MountedVDOM> {
  type NodePosition =
    | {
        type: "string";
        content: string;
        start: ByteIdx;
        end: ByteIdx;
        bindings?: Bindings | undefined;
        extmarkOptions?: ExtmarkOptions | undefined;
      }
    | {
        type: "node";
        template: TemplateStringsArray;
        children: NodePosition[];
        start: ByteIdx;
        end: ByteIdx;
        bindings?: Bindings | undefined;
        extmarkOptions?: ExtmarkOptions | undefined;
      }
    | {
        type: "array";
        children: NodePosition[];
        start: ByteIdx;
        end: ByteIdx;
        bindings?: Bindings | undefined;
        extmarkOptions?: ExtmarkOptions | undefined;
      };

  // First pass: build the complete string and create tree structure with positions
  const contents: string[] = [];
  let currentByteWidth: ByteIdx = 0 as ByteIdx;

  function traverse(node: VDOMNode): NodePosition {
    switch (node.type) {
      case "string": {
        const start = currentByteWidth;
        contents.push(node.content);
        currentByteWidth = (currentByteWidth +
          Buffer.byteLength(node.content, "utf8")) as ByteIdx;

        return {
          type: "string",
          content: node.content,
          start,
          end: currentByteWidth,
          bindings: node.bindings,
          extmarkOptions: node.extmarkOptions,
        };
      }
      case "node": {
        const start = currentByteWidth;
        const children = node.children.map(traverse);
        return {
          type: "node",
          template: node.template,
          children,
          start,
          end: currentByteWidth,
          bindings: node.bindings,
          extmarkOptions: node.extmarkOptions,
        };
      }
      case "array": {
        const start = currentByteWidth;
        const children = node.children.map(traverse);
        return {
          type: "array",
          children,
          start,
          end: currentByteWidth,
          bindings: node.bindings,
          extmarkOptions: node.extmarkOptions,
        };
      }
      default: {
        assertUnreachable(node);
      }
    }
  }

  const positionTree = traverse(vdom);

  const content = contents.join("");
  await replaceBetweenPositions({
    ...mount,
    context: { nvim: mount.nvim },
    lines: content.split("\n") as Line[],
  });

  const mountPos = mount.startPos;
  const contentBuf = Buffer.from(content, "utf-8");

  async function assignPositions(node: NodePosition): Promise<MountedVDOM> {
    const startPos = calculatePosition(mountPos, contentBuf, node.start);
    const endPos = calculatePosition(mountPos, contentBuf, node.end);

    // Set extmark if options are provided and there's actual content
    let extmarkId: ExtmarkId | undefined;
    if (node.extmarkOptions && node.start < node.end) {
      extmarkId = await mount.buffer.setExtmark({
        startPos,
        endPos,
        options: node.extmarkOptions,
      });
    }

    switch (node.type) {
      case "string":
        return {
          type: "string",
          content: node.content,
          startPos,
          endPos,
          bindings: node.bindings,
          ...(node.extmarkOptions && { extmarkOptions: node.extmarkOptions }),
          ...(extmarkId && { extmarkId }),
        };
      case "node": {
        const children = await Promise.all(node.children.map(assignPositions));
        return {
          type: "node",
          template: node.template,
          children,
          startPos,
          endPos,
          bindings: node.bindings,
          ...(node.extmarkOptions && { extmarkOptions: node.extmarkOptions }),
          ...(extmarkId && { extmarkId }),
        };
      }
      case "array": {
        const children = await Promise.all(node.children.map(assignPositions));
        return {
          type: "array",
          children,
          startPos,
          endPos,
          bindings: node.bindings,
          ...(node.extmarkOptions && { extmarkOptions: node.extmarkOptions }),
          ...(extmarkId && { extmarkId }),
        };
      }
      default:
        assertUnreachable(node);
    }
  }

  return await assignPositions(positionTree);
}
