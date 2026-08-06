import { type Line, NvimBuffer } from "../nvim/buffer.ts";
import { getAllWindows } from "../nvim/nvim.ts";
import { NvimWindow, type Row0Indexed, type WindowId } from "../nvim/window.ts";
import type { MagentaOptions } from "../options.ts";
import {
  type AbsFilePath,
  type HomeDir,
  type NvimCwd,
  resolveFilePath,
  type UnresolvedFilePath,
} from "../utils/files.ts";
import type { Nvim } from "./nvim-node/index.ts";

/** Find an existing non-magenta window, or create one on the opposite side of the sidebar. */
export async function findOrCreateNonMagentaWindow(context: {
  nvim: Nvim;
  options: MagentaOptions;
}): Promise<NvimWindow> {
  const windows = await getAllWindows(context.nvim);
  const nonMagentaWindows: NvimWindow[] = [];
  const magentaWindows: NvimWindow[] = [];

  for (const window of windows) {
    const isMagenta = await window.getVar("magenta");
    if (!isMagenta) {
      nonMagentaWindows.push(window);
    } else {
      magentaWindows.push(window);
    }
  }

  if (nonMagentaWindows.length > 0) {
    return nonMagentaWindows[0];
  }

  // No non-magenta windows exist — create one on the opposite side of the sidebar
  const emptyBuf = await NvimBuffer.create(false, true, context.nvim);
  const sidebarPosition = context.options.sidebarPosition;
  const newWindowSide = sidebarPosition === "left" ? "right" : "left";

  const newWinId = (await context.nvim.call("nvim_open_win", [
    emptyBuf.id,
    true,
    {
      win: -1,
      split: newWindowSide,
    },
  ])) as WindowId;

  const newWindow = new NvimWindow(newWinId, context.nvim);
  return newWindow;
}

export async function openScratchInNonMagentaWindow(
  lines: string[],
  name: string,
  context: {
    nvim: Nvim;
    options: MagentaOptions;
  },
): Promise<void> {
  try {
    const buffer = await NvimBuffer.create(false, true, context.nvim);
    await buffer.setLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
      lines: lines.map((line) => line as Line),
    });
    await buffer.setOption("filetype", "markdown");
    await buffer.setOption("modifiable", false);
    await buffer.setName(name);
    const targetWindow = await findOrCreateNonMagentaWindow(context);
    await targetWindow.setBuffer(buffer);
  } catch (error) {
    context.nvim.logger.error(
      `Error opening scratch buffer ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function openFileInNonMagentaWindow(
  filePath: UnresolvedFilePath | AbsFilePath,
  context: {
    nvim: Nvim;
    cwd: NvimCwd;
    homeDir: HomeDir;
    options: MagentaOptions;
  },
): Promise<void> {
  try {
    const absFilePath = resolveFilePath(context.cwd, filePath, context.homeDir);
    const fileBuffer = await NvimBuffer.bufadd(absFilePath, context.nvim);
    const targetWindow = await findOrCreateNonMagentaWindow(context);
    await targetWindow.setBuffer(fileBuffer);
  } catch (error) {
    context.nvim.logger.error(
      `Error opening file ${filePath}: ${(error as Error).message}`,
    );
  }
}
