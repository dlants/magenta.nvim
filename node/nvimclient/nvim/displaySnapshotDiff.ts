import { type Line, NvimBuffer } from "../nvim/buffer.ts";
import { diffthis, getAllWindows } from "../nvim/nvim.ts";
import type { Row0Indexed, WindowId } from "../nvim/window.ts";
import {
  type AbsFilePath,
  type HomeDir,
  type NvimCwd,
  resolveFilePath,
  type UnresolvedFilePath,
} from "../utils/files.ts";
import type { Nvim } from "./nvim-node/index.ts";

/**
 * Open the given file and a scratch buffer holding `snapshot` side-by-side in a
 * neovim diffsplit. Non-magenta windows are closed first, and magenta window
 * widths are restored afterwards.
 */
export async function displaySnapshotDiff({
  filePath,
  snapshot,
  nvim,
  cwd,
  homeDir,
  getDisplayWidth,
}: {
  filePath: UnresolvedFilePath | AbsFilePath;
  snapshot: string;
  nvim: Nvim;
  cwd: NvimCwd;
  homeDir: HomeDir;
  getDisplayWidth: () => number;
}) {
  const absFilePath = resolveFilePath(cwd, filePath, homeDir);

  // Close any non-magenta windows, preserving magenta windows so we can restore
  // their widths afterwards.
  const windows = await getAllWindows(nvim);
  const magentaWindows = [];
  for (const window of windows) {
    if (await window.getVar("magenta")) {
      magentaWindows.push(window);
      continue;
    }
    await window.close();
  }

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

  const scratchBuffer = await NvimBuffer.create(false, true, nvim);
  await scratchBuffer.setOption("bufhidden", "wipe");
  await scratchBuffer.setLines({
    start: 0 as Row0Indexed,
    end: -1 as Row0Indexed,
    lines: snapshot.split("\n") as Line[],
  });
  await scratchBuffer.setName(`${absFilePath}_snapshot`);
  await nvim.call("nvim_open_win", [
    scratchBuffer.id,
    true,
    {
      win: fileWindowId,
      split: "left",
    },
  ]);
  await diffthis(nvim);

  for (const window of magentaWindows) {
    await window.setWidth(getDisplayWidth());
  }
}
