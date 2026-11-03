import type { DisplayBufferText } from "@magenta/server";
import type { Position0Indexed } from "../nvim/window.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { placedPos } from "./highlights.ts";
import type { MountedVDOM } from "./view.ts";

export const BINDING_KEYS = [
  "<CR>",
  "t",
  "dd",
  "=",
  "F",
  "d",
  "a",
  "r",
  "u",
  "<C-r>",
] as const;

export type BindingKey = (typeof BINDING_KEYS)[number];

/** Modes a binding key may be active in. Defaults to normal mode only. */
export const BINDING_MODES: Partial<
  Record<BindingKey, ReadonlyArray<"n" | "v">>
> = {
  F: ["n", "v"],
  d: ["v"],
  r: ["n", "v"],
};

/** Optional context passed from lua → tea when invoking a binding. The visual
 * variant of `F` includes the visual selection text. */
export type BindingRange = {
  start: Position0Indexed;
  /** Inclusive: the byte column of the last selected character. */
  end: Position0Indexed;
  linewise: boolean;
  /** The selected text, sliced from the display buffer lines. */
  text: DisplayBufferText;
};
export type VisualRange = Omit<BindingRange, "text">;
export type NodeExtent = {
  startPos: Position0Indexed;
  endPos: Position0Indexed;
};
/** What the caller (lua → onKey) supplies. `range` only exists for visual
 * selections. */
export type BindingCtx = {
  selection?: { lines: string[]; range?: BindingRange };
};
/** What a binding receives: the caller ctx plus the extent of the node that
 * owns the binding, attached by `getBinding`. */
export type BoundBindingCtx = BindingCtx & { node: NodeExtent };
export type Binding = (ctx: BoundBindingCtx) => void;
export type Bindings = Partial<{
  [key in BindingKey]: Binding;
}>;

export function getBinding(
  mountedNode: MountedVDOM,
  cursor: Position0Indexed,
  mode: "n" | "v",
  key: BindingKey,
): ((ctx?: BindingCtx) => void) | undefined {
  if (
    comparePos(cursor, mountedNode.startPos) === "lt" ||
    ["gt", "eq"].includes(comparePos(cursor, mountedNode.endPos))
  ) {
    return undefined;
  }

  const allowedModes = BINDING_MODES[key] ?? ["n"];
  if (!allowedModes.includes(mode)) {
    return undefined;
  }

  switch (mountedNode.type) {
    case "string":
      return (
        getHighlightBinding(mountedNode, cursor, mode, key) ??
        withNode(mountedNode, mountedNode.bindings?.[key])
      );
    case "node":
    case "array": {
      // Walk children to find the most specific (innermost) binding for this
      // key. If no child has it, fall back to this node's binding.
      for (const child of mountedNode.children) {
        const childBinding = getBinding(child, cursor, mode, key);
        if (childBinding) {
          return childBinding;
        }
      }
      const highlightBinding = getHighlightBinding(
        mountedNode,
        cursor,
        mode,
        key,
      );
      if (highlightBinding) return highlightBinding;
      return withNode(mountedNode, mountedNode.bindings?.[key]);
    }
    default:
      assertUnreachable(mountedNode);
  }
}

/** Normal-mode bindings of a highlight whose match contains the cursor. */
function getHighlightBinding(
  mountedNode: MountedVDOM,
  cursor: Position0Indexed,
  mode: "n" | "v",
  key: BindingKey,
): ((ctx?: BindingCtx) => void) | undefined {
  if (mode !== "n" || !mountedNode.highlightState) return undefined;
  for (const placed of mountedNode.highlightState.placed.values()) {
    const binding = placed.spec.bindings?.[key];
    if (!binding || placed.type !== "matched") continue;
    const extent = placedPos(mountedNode, placed);
    if (
      comparePos(cursor, extent.startPos) !== "lt" &&
      comparePos(cursor, extent.endPos) === "lt"
    ) {
      return (ctx) => binding({ ...ctx, node: extent });
    }
  }
  return undefined;
}

function withNode(
  mountedNode: MountedVDOM,
  binding: Binding | undefined,
): ((ctx?: BindingCtx) => void) | undefined {
  if (!binding) return undefined;
  const node = { startPos: mountedNode.startPos, endPos: mountedNode.endPos };
  return (ctx) => binding({ ...ctx, node });
}

export function isRangeWithinNode(
  range: Pick<BindingRange, "start" | "end">,
  node: NodeExtent,
): boolean {
  return (
    comparePos(range.start, node.startPos) !== "lt" &&
    comparePos(range.end, node.endPos) === "lt"
  );
}

/**
 * Compares two positions and returns "lt" if pos1 < pos2, "eq" if pos1 === pos2, "gt" if pos1 > pos2
 */
function comparePos(
  pos1: Position0Indexed,
  pos2: Position0Indexed,
): "lt" | "eq" | "gt" {
  if (pos1.row < pos2.row) {
    return "lt";
  } else if (pos1.row > pos2.row) {
    return "gt";
  }

  // Rows are equal, check columns
  if (pos1.col < pos2.col) {
    return "lt";
  } else if (pos1.col > pos2.col) {
    return "gt";
  }

  return "eq";
}
