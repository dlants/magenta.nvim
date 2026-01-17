import { diffthis, getAllWindows } from "../nvim/nvim.ts";
import { NvimBuffer, type Line } from "../nvim/buffer.ts";
import { type WindowId, type Row0Indexed } from "../nvim/window.ts";
import type { Nvim } from "../nvim/nvim-node";
import { type FileSnapshots, type Turn } from "./file-snapshots.ts";
import {
  resolveFilePath,
  type NvimCwd,
  type UnresolvedFilePath,
} from "../utils/files.ts";

export async function displaySnapshotDiff({
  unresolvedFilePath,
  turn,
  nvim,
  cwd,
  fileSnapshots,
  getDisplayWidth,
}: {
  unresolvedFilePath: UnresolvedFilePath;
  turn?: Turn;
  nvim: Nvim;
  cwd: NvimCwd;
  fileSnapshots: FileSnapshots;
  getDisplayWidth: () => number;
}) {
  const absFilePath = resolveFilePath(cwd, unresolvedFilePath);

  const snapshot = fileSnapshots.getSnapshot(absFilePath, turn);
  if (snapshot == undefined) {
    // No need to call dispatchError as this may be used in contexts outside of a tool request
    nvim.logger.error(
      `No snapshot found for file ${unresolvedFilePath} for turn ${turn ?? "current"}`,
    );
    return;
  }

  // first, check to see if any windows *other than* the magenta plugin windows are open, and close them.
  const windows = await getAllWindows(nvim);
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
  const fileBuffer = await NvimBuffer.bufadd(absFilePath, nvim);
  const fileWindowId = (await nvim.call("nvim_open_win", [
    fileBuffer.id,
    true,
    {
      win: -1, // global split
      split: "right",
    },
  ])) as WindowId;

  await diffthis(nvim);

  // Create a scratch buffer for the snapshot content
  const scratchBuffer = await NvimBuffer.create(false, true, nvim);

  await scratchBuffer.setOption("bufhidden", "wipe");
  await scratchBuffer.setLines({
    start: 0 as Row0Indexed,
    end: -1 as Row0Indexed,
    lines: snapshot.content.split("\n") as Line[],
  });

  await scratchBuffer.setName(
    `${unresolvedFilePath}_turn${turn ?? "current"}_snapshot`,
  );
  await nvim.call("nvim_open_win", [
    scratchBuffer.id,
    true,
    {
      win: fileWindowId, // global split
      split: "left",
    },
  ]);

  await diffthis(nvim);

  // now that both diff buffers are open, adjust the magenta window width again
  for (const window of magentaWindows) {
    await window.setWidth(getDisplayWidth());
  }
}
