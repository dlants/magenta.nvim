import { type MountedVDOM } from "./view.ts";
import { type Position0Indexed } from "../nvim/window.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";

export const BINDING_KEYS = ["<CR>", "d", "e", "r"] as const;

export type BindingKey = (typeof BINDING_KEYS)[number];
export type Bindings = Partial<{
  [key in BindingKey]: () => void;
}>;

export function getBindings(
  mountedNode: MountedVDOM,
  cursor: Position0Indexed,
): Bindings | undefined {
  if (
    compare(cursor, mountedNode.startPos) > 0 ||
    compare(cursor, mountedNode.endPos) < 0
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

/** returns a positive number if pos2 is greater than pos1, 0 if equal, -1 if pos2 is less than pos1
 */
function compare(pos1: Position0Indexed, pos2: Position0Indexed): number {
  const rowDiff = pos2.row - pos1.row;
  if (rowDiff != 0) {
    return rowDiff;
  }

  return pos2.col - pos1.col;
}
