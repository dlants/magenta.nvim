import type { CommentId } from "@magenta/core";
import { type BufNr, NvimBuffer } from "../nvim/buffer.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { NvimWindow, type Row0Indexed, type WindowId } from "../nvim/window.ts";
import type { CommentController } from "./comment-controller.ts";

/** How many messages stay rendered while the input is open. Bounds the height
 * of the extent + transcript + input unit, and keeps the most recent reply
 * next to the cursor. */
export const INPUT_TRANSCRIPT_MESSAGES = 3;
const MAX_INPUT_HEIGHT = 15;
const MAX_INPUT_WIDTH = 80;

let inputCounter = 0;

/**
 * The authoring float: a scratch buffer anchored under the commented lines,
 * so what you are responding to stays on screen while you type. Submitting
 * appends to the comment through the controller; cancelling leaves no trace.
 */
export class CommentInput {
  private closed = false;

  private constructor(
    private nvim: Nvim,
    private controller: CommentController,
    public readonly target: {
      bufnr: BufNr;
      winid: WindowId;
      rows: { start: Row0Indexed; end: Row0Indexed };
    },
    public readonly buffer: NvimBuffer,
    public readonly window: NvimWindow,
    /** Set when this input is a follow-up on an existing comment. */
    public readonly commentId: CommentId | undefined,
  ) {}

  static async open({
    nvim,
    controller,
    bufnr,
    winid,
    rows,
  }: {
    nvim: Nvim;
    controller: CommentController;
    bufnr: BufNr;
    winid: WindowId;
    rows: { start: Row0Indexed; end: Row0Indexed };
  }): Promise<CommentInput> {
    const commentId = await controller.inRange(bufnr, rows);

    let anchorRow = rows.end;
    let virtLines = 0;
    if (commentId) {
      await controller.setTranscriptCap(commentId, INPUT_TRANSCRIPT_MESSAGES);
      virtLines = controller.virtLineCount(commentId);
      const extent = (await controller.extentsInBuffer(bufnr)).find(
        (e) => e.id === commentId,
      );
      if (extent) {
        anchorRow = extent.extent.endRow;
      }
    } else {
      await controller.setPreview({
        bufnr,
        extent: { startRow: rows.start, endRow: rows.end },
      });
    }

    const winWidth = await nvim.call("nvim_win_get_width", [winid]);
    const width = Math.max(20, Math.min(MAX_INPUT_WIDTH, winWidth - 2));

    // The commented extent, its transcript, the input and its border are one
    // unit — scroll the target window first so the whole thing is on screen.
    const unitHeight = rows.end - rows.start + 1 + virtLines + 1 + 2;
    await nvim.call("nvim_exec_lua", [
      `require("magenta.keymaps").fit_comment_input(...)`,
      [winid, anchorRow, unitHeight],
    ]);

    const buffer = await NvimBuffer.create(false, true, nvim);
    await buffer.setName(`magenta-comment://${++inputCounter}`);
    await buffer.setOption("buftype", "acwrite");
    await buffer.setOption("bufhidden", "wipe");
    await buffer.setOption("filetype", "markdown");

    const floatWinId = (await nvim.call("nvim_open_win", [
      buffer.id,
      true,
      {
        relative: "win",
        win: winid,
        bufpos: [anchorRow, 0],
        // clear the anchor line itself plus everything already rendered
        // beneath it, so the input reads as the next message rather than
        // covering the first one.
        row: 1 + virtLines,
        col: 0,
        width,
        height: 1,
        border: "rounded",
        style: "minimal",
        title: commentId ? ` reply to ${commentId} ` : " new comment ",
      },
    ])) as WindowId;

    const window = new NvimWindow(floatWinId, nvim);
    await nvim.call("nvim_exec_lua", [
      `require("magenta.keymaps").setup_comment_input(...)`,
      [buffer.id, floatWinId, winid, MAX_INPUT_HEIGHT, nvim.channelId],
    ]);
    await nvim.call("nvim_exec2", [
      `call win_execute(${floatWinId}, 'startinsert')`,
      {},
    ]);

    return new CommentInput(
      nvim,
      controller,
      { bufnr, winid, rows },
      buffer,
      window,
      commentId,
    );
  }

  /** The comment id the submitted text landed on, or undefined when the
   * input produced nothing. */
  async submit(): Promise<CommentId | undefined> {
    const lines = await this.buffer.getLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
    });
    const text = lines.join("\n").trim();
    await this.close();
    if (text === "") {
      return undefined;
    }
    return this.controller.addComment({
      bufnr: this.target.bufnr,
      rows: this.target.rows,
      text,
    });
  }

  async cancel(): Promise<void> {
    await this.close();
  }

  private async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    if (await this.window.valid()) {
      await this.window.close(true);
    }
    if (await this.buffer.isValid()) {
      await this.buffer.delete({ force: true });
    }
    if (await new NvimWindow(this.target.winid, this.nvim).valid()) {
      await this.nvim.call("nvim_set_current_win", [this.target.winid]);
    }

    if (this.commentId) {
      await this.controller.setTranscriptCap(this.commentId, undefined);
    } else {
      await this.controller.setPreview(undefined);
    }
  }
}
