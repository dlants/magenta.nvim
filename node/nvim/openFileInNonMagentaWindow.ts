import type { Nvim } from "./nvim-node/index.ts";
import { getAllWindows } from "../nvim/nvim.ts";
import { NvimBuffer } from "../nvim/buffer.ts";
import type { WindowId } from "../nvim/window.ts";
import type { MagentaOptions } from "../options.ts";
import {
  resolveFilePath,
  type AbsFilePath,
  type HomeDir,
  type NvimCwd,
  type UnresolvedFilePath,
} from "../utils/files.ts";

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
    const windows = await getAllWindows(context.nvim);
    const nonMagentaWindows = [];
    const magentaWindows = [];

    // Find all non-magenta windows and magenta windows
    for (const window of windows) {
      const isMagenta = await window.getVar("magenta");
      if (!isMagenta) {
        nonMagentaWindows.push(window);
      } else {
        magentaWindows.push(window);
      }
    }

    let targetWindowId: WindowId | null = null;

    // if there are non-magenta windows, use one of those
    if (nonMagentaWindows.length > 0) {
      targetWindowId = nonMagentaWindows[0].id;
    }

    const absFilePath = resolveFilePath(context.cwd, filePath, context.homeDir);
    // Open the buffer in the target window or create a new window if needed
    const fileBuffer = await NvimBuffer.bufadd(absFilePath, context.nvim);

    if (targetWindowId) {
      // Open in the existing window
      await context.nvim.call("nvim_win_set_buf", [
        targetWindowId,
        fileBuffer.id,
      ]);
    } else if (nonMagentaWindows.length === 0 && magentaWindows.length > 0) {
      // Use the configured sidebarPosition from options
      const sidebarPosition = context.options.sidebarPosition;
      // Open on the opposite side
      const newWindowSide = sidebarPosition === "left" ? "right" : "left";

      // Open a new window on the appropriate side
      await context.nvim.call("nvim_open_win", [
        fileBuffer.id,
        true, // Enter the window
        {
          win: -1, // Global split
          split: newWindowSide,
        },
      ]);
    } else {
      // No suitable window found, create a new one
      await context.nvim.call("nvim_command", [`split ${absFilePath}`]);
    }
  } catch (error) {
    context.nvim.logger.error(
      `Error opening file ${filePath}: ${(error as Error).message}`,
    );
  }
}
