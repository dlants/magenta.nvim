import type { CommentId, CommentUpdateEntry } from "@magenta/core";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { d, type VDOMNode, withBindings, withInlineCode } from "../tea/view.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { COMMENT_SIGN } from "./comment-render.ts";

function locationLabel(entry: CommentUpdateEntry): string {
  const { location } = entry;
  if (location.state === "stale") {
    return `${location.bufferLabel} (range deleted)`;
  }
  const { start, end } = location.lines;
  return start === end
    ? `${location.bufferLabel}:${start}`
    : `${location.bufferLabel}:${start}-${end}`;
}

function statusLabel(entry: CommentUpdateEntry): string {
  switch (entry.status) {
    case "new-messages":
      return entry.messages.length === 1
        ? "1 new message"
        : `${entry.messages.length} new messages`;
    case "deleted":
      return "deleted";
    case "buffer-unloaded":
      return "closed";
    default:
      return assertUnreachable(entry);
  }
}

/** Put the cursor on a comment's buffer and line, preferring a window that
 * already shows it. Comments live in buffers that may not be file-backed, so
 * this goes by bufnr rather than by path. */
export async function jumpToComment(
  nvim: Nvim,
  entry: CommentUpdateEntry,
): Promise<void> {
  const { location } = entry;
  await nvim.call("nvim_exec_lua", [
    `local bufnr, line = ...
if not vim.api.nvim_buf_is_valid(bufnr) then return end
local win = vim.fn.bufwinid(bufnr)
if win == -1 then
  for _, w in ipairs(vim.api.nvim_list_wins()) do
    local name = vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(w))
    if not name:match("^magenta://") then
      win = w
      break
    end
  end
  if win == -1 then return end
  vim.api.nvim_win_set_buf(win, bufnr)
end
vim.api.nvim_set_current_win(win)
if line then
  local count = vim.api.nvim_buf_line_count(bufnr)
  vim.api.nvim_win_set_cursor(win, { math.min(line, count), 0 })
end`,
    [
      location.bufnr,
      // `null` (not `undefined`) so it crosses the RPC boundary as lua `nil`.
      location.state === "anchored" ? location.lines.start : null,
    ],
  ]);
}

/**
 * The `💬` ledger: one collapsible line per comment entry that rode out with
 * this message. The agent-facing `<comment_update>` text is never shown; this
 * is what the user sees instead.
 */
export function renderCommentUpdate(
  entries: CommentUpdateEntry[] | undefined,
  view: {
    expanded: { [commentId: CommentId]: boolean };
    onToggle: (commentId: CommentId) => void;
    onJump: (entry: CommentUpdateEntry) => void;
  },
): VDOMNode {
  if (!entries || entries.length === 0) {
    return d``;
  }
  return d`${entries.map((entry) => {
    const line = withBindings(
      d`${COMMENT_SIGN} ${withInlineCode(d`\`${locationLabel(entry)}\``)} [ ${statusLabel(entry)} ]\n`,
      {
        "=": () => view.onToggle(entry.commentId),
        "<CR>": () => view.onJump(entry),
      },
    );
    if (entry.status !== "new-messages" || !view.expanded[entry.commentId]) {
      return line;
    }
    const body = entry.messages.map((message) => d`  ${message.text}\n`);
    return d`${line}${body}`;
  })}`;
}
