import type { ThreadId } from "@magenta/core";
import { withTimeout } from "../utils/async.ts";
import type { AbsFilePath, UnresolvedFilePath } from "../utils/files.ts";
import type { ExtmarkId, ExtmarkOptions } from "./extmarks.ts";
import type { Nvim } from "./nvim-node/index.ts";
import type {
  Position0Indexed,
  Position1Indexed,
  Row0Indexed,
} from "./window.ts";

export type Line = string & { __line: true };
export type BufNr = number & { __bufnr: true };
export type Mode = "n" | "i" | "v";

/**
 * Branded type for Neovim namespace IDs.
 */
export type NamespaceId = number & { __namespaceId: true };

/**
 * Well-known namespace for magenta highlighting system.
 * This ensures all magenta highlights are grouped together and can be cleared as a unit.
 */
export const MAGENTA_HIGHLIGHT_NAMESPACE = "magenta-highlights";

/**
 * Long-lived namespace holding comment anchor extmarks. Deliberately disjoint
 * from `magenta-highlights`, which the TEA render loop bulk-clears.
 */
export const MAGENTA_COMMENT_ANCHOR_NAMESPACE = "magenta-comment-anchors";

/**
 * Namespace holding the disposable comment rendering (sign, extent highlight,
 * virtual lines). Cleared and re-stamped by the comment controller only.
 */
export const MAGENTA_COMMENT_NAMESPACE = "magenta-comments";

/** The namespaces magenta owns. Keeps a typo from silently creating a fresh,
 * invisible namespace. */
export type MagentaNamespace =
  | typeof MAGENTA_HIGHLIGHT_NAMESPACE
  | typeof MAGENTA_COMMENT_ANCHOR_NAMESPACE
  | typeof MAGENTA_COMMENT_NAMESPACE;

export class NvimBuffer {
  constructor(
    public readonly id: BufNr,
    private nvim: Nvim,
  ) {}

  getOption(option: string) {
    return this.nvim.call("nvim_buf_get_option", [this.id, option]);
  }

  setOption(option: string, value: unknown) {
    return this.nvim.call("nvim_buf_set_option", [this.id, option, value]);
  }

  getChangeTick() {
    return this.nvim.call("nvim_buf_get_changedtick", [
      this.id,
    ]) as unknown as Promise<number>;
  }

  setLines({
    start,
    end,
    lines,
  }: {
    start: Row0Indexed;
    end: Row0Indexed;
    lines: Line[];
  }) {
    return this.nvim.call("nvim_buf_set_lines", [
      this.id,
      start,
      end,
      false,
      lines,
    ]);
  }

  async getLines({
    start,
    end,
  }: {
    start: Row0Indexed;
    end: Row0Indexed;
  }): Promise<Line[]> {
    // Ensure buffer is loaded before getting lines
    // unloaded buffers return no lines, see https://github.com/neovim/neovim/pull/8660
    await this.nvim.call("nvim_eval", [`bufload(${this.id})`]);

    const lines = await this.nvim.call("nvim_buf_get_lines", [
      this.id,
      start,
      end,
      false,
    ]);
    return lines as Line[];
  }

  async getText({
    startPos,
    endPos,
  }: {
    startPos: Position0Indexed;
    endPos: Position0Indexed;
  }): Promise<Line[]> {
    const lines = await this.nvim.call("nvim_buf_get_text", [
      this.id,
      startPos.row,
      startPos.col,
      endPos.row,
      endPos.col,
      {},
    ]);
    return lines as Line[];
  }

  setText({
    startPos,
    endPos,
    lines,
  }: {
    startPos: Position0Indexed;
    endPos: Position0Indexed;
    lines: Line[];
  }): Promise<void> {
    return this.nvim.call("nvim_buf_set_text", [
      this.id,
      startPos.row,
      startPos.col,
      endPos.row,
      endPos.col,
      lines,
    ]);
  }

  setMark({ mark, pos }: { mark: string; pos: Position1Indexed }) {
    return this.nvim.call("nvim_buf_set_mark", [
      this.id,
      mark,
      pos.row,
      pos.col,
      {},
    ]);
  }

  setSiderbarKeymaps() {
    return this.nvim.call("nvim_exec_lua", [
      `require("magenta.keymaps").set_sidebar_buffer_keymaps(${this.id})`,
      [],
    ]);
  }

  setupPasteHandlers() {
    return this.nvim.call("nvim_exec_lua", [
      `require("magenta.keymaps").set_paste_handlers(${this.id}, ${this.nvim.channelId})`,
      [],
    ]);
  }

  setDisplayKeymaps() {
    return this.nvim.call("nvim_exec_lua", [
      `require("magenta.keymaps").set_display_buffer_keymaps(${this.id})`,
      [],
    ]);
  }

  setArchivedThreadKeymap(threadId: ThreadId, logPath: AbsFilePath) {
    return this.nvim.call("nvim_exec_lua", [
      `require("magenta.keymaps").setArchiveBufferKeymap(...)`,
      [this.id, this.nvim.channelId, threadId, logPath],
    ]);
  }

  getName(): Promise<UnresolvedFilePath> {
    return this.nvim.call("nvim_buf_get_name", [
      this.id,
    ]) as Promise<UnresolvedFilePath>;
  }

  setName(name: string) {
    // nvim_buf_set_name uses `:file` semantics: renaming a buffer that already
    // has a name leaves behind a new empty buffer holding the OLD name. These
    // orphans accumulate and cause E95 ("Buffer with this name already exists")
    // when a later setName targets a name that another buffer still holds. Wipe
    // any buffer already holding the target name *before* renaming (so the
    // rename can't fail with E95), then wipe orphans left holding the old name.
    return this.nvim.call("nvim_exec_lua", [
      `\
local bufId, name = ...
-- nvim_buf_set_name stores the name resolved to an absolute path, so match
-- against the resolved form rather than the raw argument.
local resolved = vim.fn.fnamemodify(name, ":p")
for _, other in ipairs(vim.api.nvim_list_bufs()) do
  if other ~= bufId then
    local otherName = vim.api.nvim_buf_get_name(other)
    if otherName == name or otherName == resolved then
      pcall(vim.api.nvim_buf_delete, other, { force = true })
    end
  end
end
local oldName = vim.api.nvim_buf_get_name(bufId)
vim.api.nvim_buf_set_name(bufId, name)
if oldName ~= "" then
  for _, orphan in ipairs(vim.api.nvim_list_bufs()) do
    if orphan ~= bufId and vim.api.nvim_buf_get_name(orphan) == oldName then
      pcall(vim.api.nvim_buf_delete, orphan, { force = true })
    end
  end
end`,
      [this.id, name],
    ]);
  }

  /**
   * Reload this buffer from its file on disk by applying the on-disk content as
   * a minimal diff. Unlike `:edit`, this preserves extmark anchoring (marks move
   * with the text rather than being stranded at their old row) and keeps undo
   * history, so an agent edit can be undone in a single `u`.
   *
   * No-op if the buffer has unsaved changes.
   */
  async reloadFromDisk() {
    return withTimeout(
      this.nvim.call("nvim_exec_lua", [
        `\
local bufnr = ...
if not vim.api.nvim_buf_is_loaded(bufnr) then return end
if vim.bo[bufnr].modified then return end

local path = vim.api.nvim_buf_get_name(bufnr)
local f = io.open(path, "rb")
if not f then return end
local content = f:read("*a") or ""
f:close()

local hasEol = content == "" or content:sub(-1) == "\\n"
if hasEol then
  content = content:sub(1, -2)
end
local new = vim.split(content, "\\n", { plain = true })

local old = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
local hunks = vim.diff(
  table.concat(old, "\\n") .. "\\n",
  table.concat(new, "\\n") .. "\\n",
  { result_type = "indices" }
)

-- apply back-to-front so earlier hunk indices stay valid
for i = #hunks, 1, -1 do
  local startA, countA, startB, countB = unpack(hunks[i])
  -- countA == 0 is a pure insertion after line startA
  local from = countA == 0 and startA or startA - 1
  local replacement = {}
  for j = startB, startB + countB - 1 do
    replacement[#replacement + 1] = new[j]
  end
  vim.api.nvim_buf_set_lines(bufnr, from, from + countA, false, replacement)
end

vim.bo[bufnr].fixendofline = hasEol
vim.bo[bufnr].endofline = hasEol
-- the buffer now matches disk by construction
vim.bo[bufnr].modified = false`,
        [this.id],
      ]),
      1000,
    );
  }

  static async create(listed: boolean, scratch: boolean, nvim: Nvim) {
    const bufNr = (await nvim.call("nvim_create_buf", [
      listed,
      scratch,
    ])) as BufNr;
    return new NvimBuffer(bufNr, nvim);
  }

  delete(options?: { force?: boolean; unload?: boolean }) {
    return this.nvim.call("nvim_buf_delete", [this.id, options || {}]);
  }

  isValid(): Promise<boolean> {
    return this.nvim.call("nvim_buf_is_valid", [this.id]);
  }

  static async bufadd(absolutePath: AbsFilePath, nvim: Nvim) {
    const bufNr = (await nvim.call("nvim_eval", [
      `bufadd("${absolutePath}")`,
    ])) as BufNr;
    await nvim.call("nvim_eval", [`bufload(${bufNr})`]);
    return new NvimBuffer(bufNr, nvim);
  }

  // Extmark methods

  /**
   * Set an extmark in this buffer with the given options.
   * Returns the extmark ID for later updates or deletion.
   */
  async setExtmark({
    startPos,
    endPos,
    options,
    namespace,
  }: {
    startPos: Position0Indexed;
    endPos: Position0Indexed;
    options: ExtmarkOptions;
    namespace?: MagentaNamespace;
  }): Promise<ExtmarkId> {
    const namespaceId = await this.getNamespace(namespace);

    // Prepare extmark options with end position
    const extmarkOpts = {
      ...options,
      end_row: endPos.row,
      end_col: endPos.col,
    };

    const extmarkId = await this.nvim.call("nvim_buf_set_extmark", [
      this.id,
      namespaceId,
      startPos.row,
      startPos.col,
      extmarkOpts,
    ]);

    return extmarkId as ExtmarkId;
  }

  /**
   * Delete a specific extmark from this buffer.
   */
  async deleteExtmark(
    extmarkId: ExtmarkId,
    namespace?: MagentaNamespace,
  ): Promise<void> {
    const namespaceId = await this.getNamespace(namespace);
    await this.nvim.call("nvim_buf_del_extmark", [
      this.id,
      namespaceId,
      extmarkId,
    ]);
  }

  /**
   * Clear all extmarks in the magenta highlight namespace for this buffer.
   * This is useful for bulk cleanup when unmounting views or clearing highlights.
   */
  async clearAllExtmarks(namespace?: MagentaNamespace): Promise<void> {
    const namespaceId = await this.getNamespace(namespace);

    // Clear all extmarks in the namespace for this buffer
    await this.nvim.call("nvim_buf_clear_namespace", [
      this.id,
      namespaceId,
      0, // start line
      -1, // end line (-1 means end of buffer)
    ]);
  }

  /**
   * Update an existing extmark with new options and/or position.
   * This is more efficient than deleting and recreating for position/style changes.
   */
  async updateExtmark({
    extmarkId,
    startPos,
    endPos,
    options,
    namespace,
  }: {
    extmarkId: ExtmarkId;
    startPos: Position0Indexed;
    endPos: Position0Indexed;
    options: ExtmarkOptions;
    namespace?: MagentaNamespace;
  }): Promise<ExtmarkId> {
    const namespaceId = await this.getNamespace(namespace);

    // Prepare extmark options with end position and existing ID
    const extmarkOpts = {
      ...options,
      id: extmarkId,
      end_row: endPos.row,
      end_col: endPos.col,
    };

    const updatedId = await this.nvim.call("nvim_buf_set_extmark", [
      this.id,
      namespaceId,
      startPos.row,
      startPos.col,
      extmarkOpts,
    ]);

    return updatedId as ExtmarkId;
  }

  /**
   * Get all extmarks in the magenta namespace for this buffer.
   * Returns an array of extmark information including ID, position, and options.
   */
  async getExtmarks(namespace?: MagentaNamespace): Promise<
    Array<{
      id: ExtmarkId;
      startPos: Position0Indexed;
      endPos: Position0Indexed;
      options: ExtmarkOptions;
    }>
  > {
    const namespaceId = await this.getNamespace(namespace);

    // Get all extmarks in the namespace
    const extmarks = await this.nvim.call("nvim_buf_get_extmarks", [
      this.id,
      namespaceId,
      0, // start position
      -1, // end position (-1 means end of buffer)
      { details: true }, // include details like end position and options
    ]);

    return (extmarks as unknown[][]).map((extmarkData) =>
      this.parseExtmarkData(extmarkData),
    );
  }

  /**
   * Get a specific extmark by its ID from the magenta namespace.
   * Returns undefined if the extmark doesn't exist.
   */
  async getExtmarkById(
    extmarkId: ExtmarkId,
    namespace?: MagentaNamespace,
  ): Promise<
    | {
        id: ExtmarkId;
        startPos: Position0Indexed;
        endPos: Position0Indexed;
        options: ExtmarkOptions;
      }
    | undefined
  > {
    const namespaceId = await this.getNamespace(namespace);

    try {
      // Get the specific extmark by ID
      const extmarksResult = await this.nvim.call("nvim_buf_get_extmarks", [
        this.id,
        namespaceId,
        extmarkId, // start from this specific extmark ID
        extmarkId, // end at this specific extmark ID
        { details: true, limit: 1 }, // include details and limit to 1 result
      ]);

      const extmarksArray = extmarksResult as unknown[][];
      if (extmarksArray.length === 0) {
        return undefined;
      }

      return this.parseExtmarkData(extmarksArray[0]);
    } catch {
      // If the extmark doesn't exist, nvim_buf_get_extmarks may throw
      return undefined;
    }
  }

  /**
   * Parse raw extmark data from nvim_buf_get_extmarks into our structured format.
   */
  private parseExtmarkData(extmarkData: unknown[]): {
    id: ExtmarkId;
    startPos: Position0Indexed;
    endPos: Position0Indexed;
    options: ExtmarkOptions;
  } {
    const [id, startRow, startCol, details] = extmarkData;
    return {
      id: id as ExtmarkId,
      startPos: { row: startRow, col: startCol } as Position0Indexed,
      endPos: {
        row: (details as { end_row: unknown }).end_row || startRow,
        col: (details as { end_col: unknown }).end_col || startCol,
      } as Position0Indexed,
      options: details as ExtmarkOptions,
    };
  }

  /**
   * Create or get the magenta highlighting namespace.
   * Uses a well-known namespace name for consistency across views.
   */
  async getMagentaNamespace(): Promise<NamespaceId> {
    return this.getNamespace();
  }

  /**
   * Create or get a neovim namespace, defaulting to the shared magenta
   * highlight namespace.
   */
  async getNamespace(
    name: MagentaNamespace = MAGENTA_HIGHLIGHT_NAMESPACE,
  ): Promise<NamespaceId> {
    const namespaceId = await this.nvim.call("nvim_create_namespace", [name]);
    return namespaceId as NamespaceId;
  }
}
