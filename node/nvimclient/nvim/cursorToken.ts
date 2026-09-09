import type { Nvim } from "./nvim-node/index.ts";
import type { NvimWindow } from "./window.ts";

const URL_REGEX = /^(https?|ftp|file|ssh):\/\//;
const MARKDOWN_LINK_REGEX = /\[([^\]]*)\]\(([^)\s]+)\)/g;

/**
 * Resolve what target (file path or URL) is under the cursor in the given window.
 *
 * Detection order:
 *  1. Markdown link `[label](target)` — if cursor is inside the span, return target.
 *  2. `<cWORD>` (whitespace-delimited) — if it looks like a URL, return it
 *     (with trailing punctuation stripped). `<cWORD>` is used because default
 *     `'isfname'` excludes `:`, so `<cfile>` can't hold a full URL.
 *  3. `<cfile>` — honors `'isfname'`, expands `~`/`\$VAR`, strips trailing
 *     punctuation, collapses `\\ ` → ` `.
 *  4. Empty string if nothing resolves.
 */
export async function getTokenAtCursor(
  nvim: Nvim,
  window: NvimWindow,
): Promise<string> {
  const result = (await nvim.call("nvim_exec_lua", [
    `\
local args = {...}
local win_id = args[1]
return vim.api.nvim_win_call(win_id, function()
  local cfile = vim.fn.expand("<cfile>")
  local cword = vim.fn.expand("<cWORD>")
  local line = vim.api.nvim_get_current_line()
  local col = vim.api.nvim_win_get_cursor(0)[2]
  return { cfile = cfile, cword = cword, line = line, col = col }
end)`,
    [window.id],
  ])) as { cfile: string; cword: string; line: string; col: number };

  const { line, col } = result;

  const regex = new RegExp(MARKDOWN_LINK_REGEX.source, "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (col >= start && col < end) {
      nvim.logger.debug(
        `getTokenAtCursor: returning markdown link target ${JSON.stringify(match[2])}`,
      );
      return match[2];
    }
  }

  const strippedCword = result.cword.replace(/[,.;:!?)\]>}]+$/, "");
  if (URL_REGEX.test(strippedCword)) {
    return strippedCword;
  }

  return result.cfile;
}
