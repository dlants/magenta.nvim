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
      return mountedNode.bindings?.[key];
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
      return mountedNode.bindings?.[key];
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
