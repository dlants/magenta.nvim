import type { Nvim } from "./nvim-node/index.ts";
import type {
  Position0Indexed,
  Position1Indexed,
  Row0Indexed,
} from "./window.ts";
import { withTimeout } from "../utils/async.ts";
import type { AbsFilePath, UnresolvedFilePath } from "../utils/files.ts";
import type { ExtmarkId, ExtmarkOptions } from "./extmarks.ts";

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

  setDisplayKeymaps() {
    return this.nvim.call("nvim_exec_lua", [
      `require("magenta.keymaps").set_display_buffer_keymaps(${this.id})`,
      [],
    ]);
  }

  setInlineKeymaps(targetBufnr: BufNr) {
    return this.nvim.call("nvim_exec_lua", [
      `require("magenta.keymaps").set_inline_buffer_keymaps(${this.id}, ${targetBufnr})`,
      [],
    ]);
  }

  getName(): Promise<UnresolvedFilePath> {
    return this.nvim.call("nvim_buf_get_name", [
      this.id,
    ]) as Promise<UnresolvedFilePath>;
  }

  setName(name: string) {
    return this.nvim.call("nvim_buf_set_name", [this.id, name]);
  }

  async attemptWrite() {
    // TODO: this is really gross. Unfortunately when write fails in this context, for
    // some reason we never hear back from this promise.
    // This is brittle, since if the file takes longer than the timeout to write, we may
    // incorrectly assume that it failed to write. However, this should be rare. The extra
    // 1s delay is also not ideal, but we should be doing this rarely - only when responding
    // to a tool call. As such it should be ok for now, and I really just want to move on from
    // this issue.
    // See https://github.com/neovim/neovim/discussions/33804 for further discussion
    return withTimeout(
      this.nvim.call("nvim_exec_lua", [
        `\
vim.api.nvim_buf_call(${this.id}, function()
  -- silent to avoid blocking on unable to write (which would typically alert the user)
  vim.cmd("silent! write")
end)`,
        [],
      ]),
      1000,
    );
  }

  async attemptEdit() {
    // TODO: this is really gross. Unfortunately when write fails in this context, for
    // some reason we never hear back from this promise.
    // This is brittle, since if the file takes longer than the timeout to write, we may
    // incorrectly assume that it failed to write. However, this should be rare. The extra
    // 1s delay is also not ideal, but we should be doing this rarely - only when responding
    // to a tool call. As such it should be ok for now, and I really just want to move on from
    // this issue.
    // See https://github.com/neovim/neovim/discussions/33804 for further discussion
    return withTimeout(
      this.nvim.call("nvim_exec_lua", [
        `\
vim.api.nvim_buf_call(${this.id}, function()
  -- silent to avoid blocking on unable to write (which would typically alert the user)
  vim.cmd("silent! edit")
end)`,
        [],
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
  }: {
    startPos: Position0Indexed;
    endPos: Position0Indexed;
    options: ExtmarkOptions;
  }): Promise<ExtmarkId> {
    const namespaceId = await this.getMagentaNamespace();

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
  async deleteExtmark(extmarkId: ExtmarkId): Promise<void> {
    const namespaceId = await this.getMagentaNamespace();
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
  async clearAllExtmarks(): Promise<void> {
    const namespaceId = await this.getMagentaNamespace();

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
  }: {
    extmarkId: ExtmarkId;
    startPos: Position0Indexed;
    endPos: Position0Indexed;
    options: ExtmarkOptions;
  }): Promise<ExtmarkId> {
    const namespaceId = await this.getMagentaNamespace();

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
  async getExtmarks(): Promise<
    Array<{
      id: ExtmarkId;
      startPos: Position0Indexed;
      endPos: Position0Indexed;
      options: ExtmarkOptions;
    }>
  > {
    const namespaceId = await this.getMagentaNamespace();

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
  async getExtmarkById(extmarkId: ExtmarkId): Promise<
    | {
        id: ExtmarkId;
        startPos: Position0Indexed;
        endPos: Position0Indexed;
        options: ExtmarkOptions;
      }
    | undefined
  > {
    const namespaceId = await this.getMagentaNamespace();

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
    const namespaceId = await this.nvim.call("nvim_create_namespace", [
      MAGENTA_HIGHLIGHT_NAMESPACE,
    ]);
    return namespaceId as NamespaceId;
  }
}
