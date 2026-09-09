import type { NvimCwd } from "../utils/files.ts";
import { type BufNr, NvimBuffer } from "./buffer.ts";
import type { Nvim } from "./nvim-node/index.ts";
import {
  NvimWindow,
  type Position1IndexedCol1Indexed,
  type WindowId,
} from "./window.ts";

export function getOption(option: string, nvim: Nvim) {
  return nvim.call("nvim_get_option", [option]);
}

export async function getCurrentWindow(nvim: Nvim) {
  const winId = (await nvim.call("nvim_get_current_win", [])) as WindowId;
  return new NvimWindow(winId, nvim);
}

export async function getCurrentBuffer(nvim: Nvim) {
  const bufnr = (await nvim.call("nvim_get_current_buf", [])) as BufNr;
  return new NvimBuffer(bufnr, nvim);
}

export async function getAllBuffers(nvim: Nvim) {
  const bufs = (await nvim.call("nvim_list_bufs", [])) as BufNr[];
  return bufs.map((bufnr) => new NvimBuffer(bufnr, nvim));
}

export async function getAllWindows(nvim: Nvim) {
  const winIds = (await nvim.call("nvim_list_wins", [])) as WindowId[];
  return winIds.map((winId) => new NvimWindow(winId, nvim));
}

export async function getcwd(nvim: Nvim): Promise<NvimCwd> {
  const res = await nvim.call("nvim_exec2", [
    "echo getcwd()",
    { output: true },
  ]);
  if (typeof res.output !== "string") {
    throw new Error(`Unable to get cwd`);
  }
  return res.output as NvimCwd;
}

export async function mode(nvim: Nvim) {
  const res = await nvim.call("nvim_exec2", ["echo mode()", { output: true }]);
  if (typeof res.output !== "string") {
    throw new Error(`Unable to get mode`);
  }
  return res.output;
}

export async function getpos(
  nvim: Nvim,
  str: string,
): Promise<Position1IndexedCol1Indexed> {
  const res = await nvim.call("nvim_exec2", [
    `echo getpos("${str}")`,
    { output: true },
  ]);
  if (typeof res.output !== "string") {
    throw new Error(`Unable to getpos`);
  }
  const posStr = res.output;

  const [_, row, col] = posStr
    .replace(/[[\]]/g, "")
    .split(",")
    .map((n) => parseInt(n.trim(), 10));

  return {
    row,
    col,
  } as Position1IndexedCol1Indexed;
}

export function diffthis(nvim: Nvim) {
  return nvim.call("nvim_command", ["diffthis"]);
}

export interface QuickfixEntry {
  bufnr: number;
  lnum: number;
  col: number;
  text: string;
  type?: string;
  filename?: string;
  valid?: number;
}

export async function getQuickfixList(nvim: Nvim): Promise<QuickfixEntry[]> {
  const qflist = await nvim.call("nvim_exec2", [
    "echo json_encode(getqflist())",
    { output: true },
  ]);
  if (typeof qflist.output !== "string") {
    throw new Error("Unable to get quickfix list");
  }
  return JSON.parse(qflist.output) as QuickfixEntry[];
}

export async function quickfixListToString(
  entries: QuickfixEntry[],
  nvim: Nvim,
): Promise<string> {
  const lines: string[] = [];

  for (const entry of entries) {
    let filename: string;
    if (entry.filename) {
      filename = entry.filename;
    } else if (entry.bufnr > 0) {
      // Get the filename from buffer number
      const bufname = await nvim.call("nvim_buf_get_name", [entry.bufnr]);
      filename = bufname ? bufname : `buffer ${entry.bufnr}`;
    } else {
      filename = `buffer ${entry.bufnr}`;
    }

    const line = entry.lnum > 0 ? `:${entry.lnum}` : "";
    const col = entry.col > 0 ? `:${entry.col}` : "";
    lines.push(`${filename}${line}${col}: ${entry.text}`);
  }

  return lines.join("\n");
}

/** Capture the scroll/cursor view (winsaveview) of every window currently
 * displaying `bufId`. Returns an opaque value to pass back to restoreWinViews.
 * No-op (empty result) when the buffer is not visible in any window. */
export async function saveWinViews(nvim: Nvim, bufId: BufNr): Promise<unknown> {
  return nvim.call("nvim_exec_lua", [
    `
local bufid = ...
local res = {}
local lastline = vim.api.nvim_buf_line_count(bufid)
for _, win in ipairs(vim.fn.win_findbuf(bufid)) do
  local v = vim.api.nvim_win_call(win, function() return vim.fn.winsaveview() end)
  table.insert(res, { win = win, view = v, atBottom = (v.lnum >= lastline) })
end
return res
`,
    [bufId],
  ]);
}

/** Restore views captured by saveWinViews, but only for windows that are still
 * valid and still display `bufId` (so we don't clobber a window the user moved
 * to a different buffer). */
export async function restoreWinViews(
  nvim: Nvim,
  bufId: BufNr,
  saved: unknown,
): Promise<void> {
  await nvim.call("nvim_exec_lua", [
    `
local bufid, saved = ...
for _, item in ipairs(saved) do
  if vim.api.nvim_win_is_valid(item.win) and vim.api.nvim_win_get_buf(item.win) == bufid then
    vim.api.nvim_win_call(item.win, function()
      if item.atBottom then
        -- cursor was pinned to the last line: follow the new bottom as content streams in
        vim.cmd("normal! G")
      else
        vim.fn.winrestview(item.view)
      end
    end)
  end
end
`,
    [bufId, saved],
  ]);
}

export async function notify(nvim: Nvim, message: string) {
  const luaScript = `
      vim.notify(
        [[${message}]],
        vim.log.levels.INFO
      )
    `;

  return nvim.call("nvim_exec_lua", [luaScript, []]);
}

export function notifyErr(nvim: Nvim, err: Error | string, ...rest: unknown[]) {
  return nvim.call("nvim_notify", [
    `Unexpected error:
${err instanceof Error ? err.message : JSON.stringify(err)}
${err instanceof Error ? err.stack : ""}
${rest.length ? JSON.stringify(rest) : ""}`,
    3,
    {},
  ]);
}
