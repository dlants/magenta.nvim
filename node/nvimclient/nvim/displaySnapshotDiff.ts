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
 * Compare `snapshot` with recorded `content` (or the live file when omitted) in a
 * neovim diffsplit. Non-magenta windows are closed first, and magenta window
 * widths are restored afterwards.
 */
export async function displaySnapshotDiff({
  filePath,
  snapshot,
  content,
  nvim,
  cwd,
  homeDir,
  getDisplayWidth,
}: {
  filePath: UnresolvedFilePath | AbsFilePath;
  snapshot: string;
  content?: string;
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

  const fileBuffer =
    content === undefined
      ? await NvimBuffer.bufadd(absFilePath, nvim)
      : await NvimBuffer.create(false, true, nvim);
  if (content !== undefined) {
    await fileBuffer.setOption("bufhidden", "wipe");
    await fileBuffer.setLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
      lines: content.split("\n") as Line[],
    });
    await fileBuffer.setName(`${absFilePath}_after`);
    await fileBuffer.setOption("modifiable", false);
  }
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
  await scratchBuffer.setOption("modifiable", false);
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
