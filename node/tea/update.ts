import type { ByteIdx, Row0Indexed } from "../nvim/window.ts";
import { render } from "./render.ts";
import { replaceBetweenPositions } from "./util.ts";
import {
  type ArrayVDOMNode,
  type ComponentVDOMNode,
  type MountedVDOM,
  type MountPoint,
  type StringVDOMNode,
  type VDOMNode,
} from "./view.ts";

// a number in the coordinate system of the buffer before the update
type CurrentByteIdx = ByteIdx & { __current: true };
type CurrentRow = Row0Indexed & { __current: true };

type NextByteIdx = ByteIdx & { __next: true };
type NextRow = Row0Indexed & { __next: true };
type CurrentPosition = {
  row: CurrentRow;
  col: CurrentByteIdx;
};

type NextPosition = {
  row: NextRow;
  col: NextByteIdx;
};

type CurrentMountedVDOM = Omit<MountedVDOM, "startPos" | "endPos"> & {
  startPos: CurrentPosition;
  endPos: CurrentPosition;
};

type NextMountedVDOM = Omit<MountedVDOM, "startPos" | "endPos"> & {
  startPos: NextPosition;
  endPos: NextPosition;
};

export async function update({
  currentRoot,
  nextRoot,
  mount,
}: {
  currentRoot: MountedVDOM;
  nextRoot: VDOMNode;
  mount: MountPoint;
}): Promise<MountedVDOM> {
  // keep track of the edits that have happened in the doc so far, so we can apply them to future nodes.
  const accumulatedEdit: {
    deltaRow: number;
    deltaCol: number;
    /** In the new file, as we're editing, keep track of the last edit row that the edit has happened on, and how
     * the columns in that row have shifted.
     */
    lastEditRow: NextRow;
  } = {
    deltaRow: 0,
    deltaCol: 0,
    lastEditRow: 0 as NextRow,
  };

  function updatePos(curPos: CurrentPosition) {
    const pos = { ...curPos } as unknown as NextPosition;
    pos.row = (pos.row + accumulatedEdit.deltaRow) as NextRow;
    if (pos.row == accumulatedEdit.lastEditRow) {
      pos.col = (pos.col + accumulatedEdit.deltaCol) as NextByteIdx;
    }
    return pos;
  }

  function updateNodePos(node: CurrentMountedVDOM): NextMountedVDOM {
    return {
      ...node,
      startPos: updatePos(node.startPos),
      endPos: updatePos(node.endPos),
    };
  }

  async function replaceNode(
    current: CurrentMountedVDOM,
    next: VDOMNode,
  ): Promise<NextMountedVDOM> {
    // udpate the node pos based on previous edits, to see where the content of this node is now, part-way
    // through the update
    const nextPos = updateNodePos(current);

    const rendered = (await render({
      vdom: next,
      mount: {
        ...mount,
        startPos: nextPos.startPos,
        endPos: nextPos.endPos,
      },
    })) as unknown as NextMountedVDOM;

    const oldEndPos = nextPos.endPos;
    const newEndPos = rendered.endPos;

    accumulatedEdit.deltaRow += newEndPos.row - oldEndPos.row;
    if (rendered.endPos.row == accumulatedEdit.lastEditRow) {
      // this view is all in a single line, so we just need to update the column
      accumulatedEdit.deltaCol += newEndPos.col - oldEndPos.col;
    } else {
      // things on the last line will shift based on the previous and new ending column of this view
      accumulatedEdit.deltaCol = newEndPos.col - oldEndPos.col;
    }

    accumulatedEdit.lastEditRow = newEndPos.row;

    return rendered;
  }

  async function insertNode(
    node: VDOMNode,
    pos: NextPosition,
  ): Promise<NextMountedVDOM> {
    const rendered = (await render({
      vdom: node,
      mount: {
        ...mount,
        startPos: pos,
        endPos: pos,
      },
    })) as unknown as NextMountedVDOM;

    const oldEndPos = pos;
    const newEndPos = rendered.endPos;

    accumulatedEdit.deltaRow += newEndPos.row - oldEndPos.row;
    if (accumulatedEdit.lastEditRow == newEndPos.row) {
      // this is a single-line edit. We just need to adjust the column
      accumulatedEdit.deltaCol += newEndPos.col - oldEndPos.col;
    } else {
      // things on the last row will shift based on the previous and new end columns
      accumulatedEdit.deltaCol = newEndPos.col - oldEndPos.col;
    }

    accumulatedEdit.lastEditRow = newEndPos.row;
    return rendered;
  }

  async function deleteNodes({
    startPos,
    endPos,
  }: {
    startPos: NextPosition;
    endPos: NextPosition;
  }) {
    // remove all the nodes between the end of the last child and where the remaining children would go.
    await replaceBetweenPositions({
      ...mount,
      startPos,
      endPos,
      lines: [],
      context: { nvim: mount.nvim },
    });
    accumulatedEdit.deltaRow += startPos.row - endPos.row;
    if (accumulatedEdit.lastEditRow == endPos.row) {
      accumulatedEdit.deltaCol += startPos.col - endPos.col;
    } else {
      accumulatedEdit.deltaCol = startPos.col - endPos.col;
    }
  }

  async function visitNode(
    current: MountedVDOM,
    next: VDOMNode,
  ): Promise<NextMountedVDOM> {
    if (current.type != next.type) {
      return await replaceNode(current as unknown as CurrentMountedVDOM, next);
    }

    switch (current.type) {
      case "string":
        if (current.content == (next as StringVDOMNode).content) {
          const updatedNode = updateNodePos(
            current as unknown as CurrentMountedVDOM,
          );
          updatedNode.bindings = next.bindings;
          return updatedNode;
        } else {
          return await replaceNode(
            current as unknown as CurrentMountedVDOM,
            next,
          );
        }

      case "node": {
        const nextNode = next as ComponentVDOMNode;
        // have to update startPos before processing the children since we assume that positions are always processed
        // in document order!
        const startPos = updatePos(current.startPos as CurrentPosition);
        const nextChildren = [];
        if (current.template == nextNode.template) {
          if (current.children.length != nextNode.children.length) {
            throw new Error(
              `Expected VDOM components with the same template to have the same number of children.`,
            );
          }

          for (let i = 0; i < current.children.length; i += 1) {
            const currentChild = current.children[i];
            const nextChild = nextNode.children[i];
            nextChildren.push(await visitNode(currentChild, nextChild));
          }

          const nextMountedNode = {
            ...current,
            children: nextChildren,
            startPos,
            endPos: nextChildren.length
              ? nextChildren[nextChildren.length - 1].endPos
              : updatePos(current.endPos as CurrentPosition),
            bindings: next.bindings,
          };
          return nextMountedNode;
        } else {
          return await replaceNode(
            current as unknown as CurrentMountedVDOM,
            next,
          );
        }
      }

      case "array": {
        const nextNode = next as ArrayVDOMNode;
        // have to update startPos before processing the children since we assume that positions are always processed
        // in document order!
        const startPos = updatePos(current.startPos as CurrentPosition);
        const nextChildren = [];
        for (
          let i = 0;
          i < Math.min(current.children.length, nextNode.children.length);
          i += 1
        ) {
          const currentChild = current.children[i];
          const nextChild = nextNode.children[i];
          nextChildren.push(await visitNode(currentChild, nextChild));
        }

        let nextChildrenEndPos = nextChildren.length
          ? nextChildren[nextChildren.length - 1].endPos
          : startPos;

        if (current.children.length > nextNode.children.length) {
          const oldChildrenEndPos = updatePos(
            current.children[current.children.length - 1]
              .endPos as CurrentPosition,
          );
          // remove all the nodes between the end of the last child and where the remaining children would go.
          await deleteNodes({
            startPos: nextChildrenEndPos,
            endPos: oldChildrenEndPos,
          });
        }

        if (nextNode.children.length > current.children.length) {
          // append new array nodes
          for (
            let childIdx = current.children.length;
            childIdx < nextNode.children.length;
            childIdx += 1
          ) {
            const insertPos: NextPosition = nextChildren.length
              ? nextChildren[nextChildren.length - 1].endPos
              : nextChildrenEndPos;
            nextChildren.push(
              await insertNode(nextNode.children[childIdx], insertPos),
            );
          }
          nextChildrenEndPos = nextChildren[nextChildren.length - 1].endPos;
        }

        const nextMountedNode = {
          ...current,
          children: nextChildren,
          startPos,
          endPos: nextChildrenEndPos,
          bindings: next.bindings,
        };
        return nextMountedNode;
      }
    }
  }

  return (await visitNode(currentRoot, nextRoot)) as unknown as MountedVDOM;
}
