import { Buffer } from "neovim";
import { render } from "./render.ts";
import { update } from "./update.ts";
import { Bindings } from "./bindings.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { context } from "../context.ts";

export type ByteIdx = number & { __byteIdx: true };
export type Position = {
  row: ByteIdx;
  col: ByteIdx;
};

export function pos(row: number, col: number) {
  return { row, col } as Position;
}

export interface MountPoint {
  buffer: Buffer;
  startPos: Position;
  endPos: Position;
}

export type View<P> = (props: P) => VDOMNode;
export type StringVDOMNode = {
  type: "string";
  content: string;
  bindings?: Bindings;
};
export type ComponentVDOMNode = {
  type: "node";
  children: VDOMNode[];
  template: TemplateStringsArray;
  bindings?: Bindings;
};
export type ArrayVDOMNode = {
  type: "array";
  children: VDOMNode[];
  bindings?: Bindings;
};

export type VDOMNode = StringVDOMNode | ComponentVDOMNode | ArrayVDOMNode;

export type MountedStringNode = {
  type: "string";
  content: string;
  startPos: Position;
  endPos: Position;
  bindings?: Bindings;
};

export type MountedComponentNode = {
  type: "node";
  template: TemplateStringsArray;
  children: MountedVDOM[];
  startPos: Position;
  endPos: Position;
  bindings?: Bindings;
};

export type MountedArrayNode = {
  type: "array";
  children: MountedVDOM[];
  startPos: Position;
  endPos: Position;
  bindings?: Bindings;
};

export type MountedVDOM =
  | MountedStringNode
  | MountedComponentNode
  | MountedArrayNode;

export function prettyPrintMountedNode(node: MountedVDOM) {
  let body = "";
  switch (node.type) {
    case "string":
      body = JSON.stringify(node.content);
      break;
    case "node":
    case "array": {
      const childLines = node.children
        .map(prettyPrintMountedNode)
        .flatMap((c) => c.split("\n").map((s) => "  " + s));
      body = `children:\n` + childLines.join("\n");
      break;
    }
    default:
      assertUnreachable(node);
  }

  const bindings = node.bindings
    ? `{${Object.keys(node.bindings).join(", ")}}`
    : "";

  return `${prettyPrintPos(node.startPos)}-${prettyPrintPos(node.endPos)} (${node.type})  ${bindings} ${body}`;
}

function prettyPrintPos(pos: Position) {
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
      context.logger.trace(
        `before update: ${prettyPrintMountedNode(mountedNode)}`,
      );
      mountedNode = await update({
        currentRoot: mountedNode,
        nextRoot: next,
        mount,
      });
      context.logger.trace(`updated: ${prettyPrintMountedNode(mountedNode)}`);
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
