import { context } from "../context.ts";
import { WIDTH } from "../sidebar.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { ReplaceToolRequest } from "./replace.ts";
import type { InsertToolUseRequest } from "./insert.ts";
import { diffthis, getAllWindows } from "../nvim/nvim.ts";
import { NvimBuffer, type Line } from "../nvim/buffer.ts";
import { type WindowId } from "../nvim/window.ts";

type Msg = {
  type: "error";
  message: string;
};

/** Helper to bring up an editing interface for the given file path.
 */
export async function displayDiffs(
  filePath: string,
  edits: (ReplaceToolRequest | InsertToolUseRequest)[],
  dispatch: Dispatch<Msg>,
) {
  const { nvim } = context;
  nvim.logger?.debug(
    `Attempting to displayDiff for edits ${JSON.stringify(edits, null, 2)}`,
  );

  // first, check to see if any windows *other than* the magenta plugin windows are open, and close them.
  const windows = await getAllWindows();
  const magentaWindows = [];
  for (const window of windows) {
    if (await window.getVar("magenta")) {
      // save these so we can reset their width later
      magentaWindows.push(window);
      continue;
    }

    // Close other windows
    await window.close();
  }

  // next, bring up the target buffer and the new content in a side-by-side diff
  const fileBuffer = await NvimBuffer.bufadd(filePath);
  const fileWindowId = (await nvim.call("nvim_open_win", [
    fileBuffer.id,
    true,
    {
      win: -1, // global split
      split: "right",
      width: WIDTH,
      style: "minimal",
    },
  ])) as WindowId;

  await diffthis();

  const lines = await fileBuffer.getLines({
    start: 0,
    end: -1,
  });
  let content: string = lines.join("\n");

  for (const edit of edits) {
    switch (edit.name) {
      case "insert": {
        const insertLocation =
          content.indexOf(edit.input.insertAfter) +
          edit.input.insertAfter.length;
        content =
          content.slice(0, insertLocation) +
          edit.input.content +
          content.slice(insertLocation);
        break;
      }

      case "replace": {
        const replaceStart = content.indexOf(edit.input.match);
        const replaceEnd = replaceStart + edit.input.match.length;

        if (replaceStart == -1) {
          dispatch({
            type: "error",
            message: `Unable to find match parameter ${edit.input.match} in file ${filePath}`,
          });
          continue;
        }

        content =
          content.slice(0, replaceStart) +
          edit.input.replace +
          content.slice(replaceEnd);

        break;
      }

      default:
        assertUnreachable(edit);
    }
  }

  const scratchBuffer = await NvimBuffer.create(false, true);
  await scratchBuffer.setLines({
    start: 0,
    end: -1,
    lines: content.split("\n") as Line[],
  });

  (await nvim.call("nvim_open_win", [
    scratchBuffer.id,
    true,
    {
      win: fileWindowId, // global split
      split: "left",
      width: WIDTH,
      style: "minimal",
    },
  ])) as WindowId;
  await diffthis();

  // now that both diff buffers are open, adjust the magenta window width again
  for (const window of magentaWindows) {
    window.setWidth(WIDTH);
  }
}