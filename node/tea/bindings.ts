import type { Position0Indexed } from "../nvim/window.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { MountedVDOM } from "./view.ts";

export const BINDING_KEYS = ["<CR>", "t", "dd", "=", "F"] as const;

export type BindingKey = (typeof BINDING_KEYS)[number];

/** Modes a binding key may be active in. Defaults to normal mode only. */
export const BINDING_MODES: Partial<
  Record<BindingKey, ReadonlyArray<"n" | "v">>
> = {
  F: ["n", "v"],
};

/** Optional context passed from lua → tea when invoking a binding. The visual
 * variant of `F` includes the visual selection text. */
export type BindingCtx = {
  selection?: string[];
};

export type Bindings = Partial<{
  [key in BindingKey]: (ctx?: BindingCtx) => void;
}>;

export function getBindings(
  mountedNode: MountedVDOM,
  cursor: Position0Indexed,
): Bindings | undefined {
  if (
    comparePos(cursor, mountedNode.startPos) === "lt" ||
    ["gt", "eq"].includes(comparePos(cursor, mountedNode.endPos))
  ) {
    return undefined;
  }

  switch (mountedNode.type) {
    case "string":
      return mountedNode.bindings;
    case "node":
    case "array": {
      // most specific binding wins
      for (const child of mountedNode.children) {
        const childBindings = getBindings(child, cursor);
        if (childBindings) {
          return childBindings;
        }
      }
      return mountedNode.bindings;
    }
    default:
      assertUnreachable(mountedNode);
  }
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
