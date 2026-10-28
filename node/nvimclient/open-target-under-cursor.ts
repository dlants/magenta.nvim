import * as fs from "node:fs/promises";
import { getTokenAtCursor } from "./nvim/cursorToken.ts";
import { getCurrentWindow } from "./nvim/nvim.ts";
import type { Nvim } from "./nvim/nvim-node/index.ts";
import {
  findOrCreateNonMagentaWindow,
  openFileInNonMagentaWindow,
} from "./nvim/openFileInNonMagentaWindow.ts";
import { openUrl } from "./nvim/openUrl.ts";
import type { MagentaOptions } from "./options.ts";
import {
  type AbsFilePath,
  type HomeDir,
  resolveFilePath,
  type UnresolvedFilePath,
} from "./utils/files.ts";

const URL_REGEX = /^(https?|ftp|file|ssh):\/\//;

/**
 * Fallback handler for `<CR>` in the magenta display buffer when no
 * `withBindings` covers the cursor position.
 *
 * Resolves the token under the cursor (URL or file path) and opens it:
 *  - URL  -> `vim.ui.open(...)` via `openUrl`.
 *  - file -> `openFileInNonMagentaWindow`, after confirming the path
 *    exists and is a regular file.
 *  - directory -> `:edit` in a non-magenta window (lets oil/netrw handle it).
 *  - otherwise no-op (logged at debug level).
 */
export async function openTargetUnderCursor(context: {
  nvim: Nvim;
  cwd: AbsFilePath;
  homeDir: HomeDir;
  options: MagentaOptions;
}): Promise<void> {
  const window = await getCurrentWindow(context.nvim);
  const token = (await getTokenAtCursor(context.nvim, window)).trim();
  if (!token) {
    return;
  }

  if (URL_REGEX.test(token)) {
    await openUrl(token, context.nvim);
    return;
  }

  try {
    const absPath = resolveFilePath(
      context.cwd,
      token as UnresolvedFilePath,
      context.homeDir,
    );
    const stat = await fs.stat(absPath);
    if (stat.isDirectory()) {
      // `:edit` (rather than bufadd + setBuffer) so directory handlers like oil/netrw take over.
      const targetWindow = await findOrCreateNonMagentaWindow(context);
      await context.nvim.call("nvim_set_current_win", [targetWindow.id]);
      await context.nvim.call("nvim_exec2", [
        `edit ${await context.nvim.call("nvim_call_function", ["fnameescape", [absPath]])}`,
        {},
      ]);
      return;
    }
    if (!stat.isFile()) {
      context.nvim.logger.debug(
        `openTargetUnderCursor: ${absPath} is not a regular file or directory`,
      );
      return;
    }
    await openFileInNonMagentaWindow(token as UnresolvedFilePath, context);
  } catch (e) {
    context.nvim.logger.debug(
      `openTargetUnderCursor: no openable target for ${JSON.stringify(token)}: ${(e as Error).message}`,
    );
  }
}
