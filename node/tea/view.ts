import { render } from "./render.ts";
import { update } from "./update.ts";
import { type Bindings } from "./bindings.ts";
import { type ExtmarkOptions, type ExtmarkId } from "../nvim/extmarks.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { NvimBuffer } from "../nvim/buffer.ts";
import { type Position0Indexed } from "../nvim/window.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";

export function pos(row: number, col: number) {
  return { row, col } as Position0Indexed;
}

export interface MountPoint {
  nvim: Nvim;
  buffer: NvimBuffer;
  startPos: Position0Indexed;
  endPos: Position0Indexed;
}

export type View<P> = (props: P) => VDOMNode;
export type StringVDOMNode = {
  type: "string";
  content: string;
  bindings?: Bindings | undefined;
  extmarkOptions?: ExtmarkOptions;
};
export type ComponentVDOMNode = {
  type: "node";
  children: VDOMNode[];
  template: TemplateStringsArray;
  bindings?: Bindings;
  extmarkOptions?: ExtmarkOptions;
};
export type ArrayVDOMNode = {
  type: "array";
  children: VDOMNode[];
  bindings?: Bindings;
  extmarkOptions?: ExtmarkOptions;
};

export type VDOMNode = StringVDOMNode | ComponentVDOMNode | ArrayVDOMNode;

export type MountedStringNode = {
  type: "string";
  content: string;
  startPos: Position0Indexed;
  endPos: Position0Indexed;
  bindings?: Bindings | undefined;
  extmarkOptions?: ExtmarkOptions;
  extmarkId?: ExtmarkId;
};

export type MountedComponentNode = {
  type: "node";
  template: TemplateStringsArray;
  children: MountedVDOM[];
  startPos: Position0Indexed;
  endPos: Position0Indexed;
  bindings?: Bindings | undefined;
  extmarkOptions?: ExtmarkOptions;
  extmarkId?: ExtmarkId;
};

export type MountedArrayNode = {
  type: "array";
  children: MountedVDOM[];
  startPos: Position0Indexed;
  endPos: Position0Indexed;
  bindings?: Bindings | undefined;
  extmarkOptions?: ExtmarkOptions;
  extmarkId?: ExtmarkId;
};

export type MountedVDOM =
  | MountedStringNode
  | MountedComponentNode
  | MountedArrayNode;

export function prettyPrintMountedNode(root: MountedVDOM) {
  const stack: { node: MountedVDOM; indent: number }[] = [
    { node: root, indent: 0 },
  ];
  const output: string[] = [];
  while (stack.length) {
    const { node, indent } = stack.pop()!;

    let body = "";
    switch (node.type) {
      case "string":
        body = JSON.stringify(node.content);
        break;
      case "node":
      case "array": {
        for (
          let childIdx = node.children.length - 1;
          childIdx >= 0;
          childIdx--
        ) {
          stack.push({ node: node.children[childIdx], indent: indent + 2 });
        }
        break;
      }
      default:
        assertUnreachable(node);
    }

    const bindings = node.bindings
      ? `{${Object.keys(node.bindings).join(", ")}}`
      : "";

    output.push(
      `${" ".repeat(indent)}${prettyPrintPos(node.startPos)}-${prettyPrintPos(node.endPos)} (${node.type})  ${bindings} ${body}`,
    );
  }

  return output.join("\n");
}

function prettyPrintPos(pos: Position0Indexed) {
  return `[${pos.row}, ${pos.col}]`;
}

export type MountedView<P> = {
  render(props: P): Promise<void>;
  unmount(): void;
  /** for testing */
  _getMountedNode(): MountedVDOM;
};

export async function mountView<P>({
  view,
  mount,
  props,
}: {
  view: View<P>;
  mount: MountPoint;
  props: P;
}): Promise<MountedView<P>> {
  let mountedNode = await render({ vdom: view(props), mount });

  return {
    async render(props) {
      const next = view(props);
      try {
        mountedNode = await update({
          currentRoot: mountedNode,
          nextRoot: next,
          mount,
        });
      } catch (e) {
        // Check if the buffer/mount point is still valid
        const isBufferValid = await mount.buffer.isValid();
        if (!isBufferValid) {
          // Buffer is no longer valid, ignore the error
          return;
        }
        // Buffer is still valid, re-throw the error
        throw e;
      }
    },
    unmount() {
      // TODO
    },
    _getMountedNode: () => mountedNode,
  };
}

export function d(
  template: TemplateStringsArray,
  ...values: (VDOMNode[] | VDOMNode | string)[]
): VDOMNode {
  const children: VDOMNode[] = [];
  if (template[0].length) {
    children.push({ type: "string", content: template[0] });
  }
  for (let i = 0; i < values.length; i++) {
    if (typeof values[i] == "string") {
      children.push({ type: "string", content: values[i] as string });
    } else if (Array.isArray(values[i])) {
      children.push({ type: "array", children: values[i] as VDOMNode[] });
    } else {
      children.push(values[i] as VDOMNode);
    }
    if (template[i + 1].length > 0) {
      children.push({ type: "string", content: template[i + 1] });
    }
  }

  return { type: "node", children: children, template: template };
}

/** Replace the bindings for this node
 */
export function withBindings(node: VDOMNode, bindings: Bindings) {
  return {
    ...node,
    bindings,
  };
}

export function withExtmark(
  node: VDOMNode,
  extmarkOptions: ExtmarkOptions | undefined,
) {
  return {
    ...node,
    ...(extmarkOptions ? { extmarkOptions } : {}),
  };
}

export function withError(node: VDOMNode) {
  return withExtmark(node, { hl_group: "ErrorMsg" });
}

export function withWarning(node: VDOMNode) {
  return withExtmark(node, { hl_group: "WarningMsg" });
}

export function withInfo(node: VDOMNode) {
  return withExtmark(node, { hl_group: "Directory" });
}

export function withSuccess(node: VDOMNode) {
  return withExtmark(node, { hl_group: "String" });
}

export function withMuted(node: VDOMNode) {
  return withExtmark(node, { hl_group: "Comment" });
}

export function withEmphasis(node: VDOMNode) {
  return withExtmark(node, { hl_group: "Bold" });
}

export function withCode(node: VDOMNode) {
  return withExtmark(node, { hl_group: "@markup.raw.markdown" });
}

export function withInlineCode(node: VDOMNode) {
  return withExtmark(node, { hl_group: "@markup.raw.markdown_inline" });
}
