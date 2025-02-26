import type { Nvim } from "nvim-node";
import { NvimBuffer, type BufNr } from "./buffer.ts";

export type Row0Indexed = number & { __row0Indexed: true };
export type Row1Indexed = number & { __row1Indexed: true };
export type ByteIdx = number & { __byteIdx: true };
export type ByteIdx1Indexed = number & { __byteIdx1Indexed: true };

/** A coordinate in a js string, which are utf-16 encoded by default. This is the coordinate that lsp clients typically expect.
 */
export type StringIdx = number & { __charIdx: true };

export type PositionString = {
  row: Row0Indexed;
  col: StringIdx;
};

export type Position1Indexed = {
  row: Row1Indexed;
  col: ByteIdx;
};

export type Position1IndexedCol1Indexed = {
  row: Row1Indexed;
  col: ByteIdx1Indexed;
};

export type Position0Indexed = {
  row: Row0Indexed;
  col: ByteIdx;
};

export function pos0to1(pos: Position0Indexed): Position1Indexed {
  return {
    row: pos.row + 1,
    col: pos.col,
  } as Position1Indexed;
}

export function pos1to0(pos: Position1Indexed): Position0Indexed {
  return {
    row: pos.row - 1,
    col: pos.col,
  } as Position0Indexed;
}

export function pos1col1to0(
  pos: Position1IndexedCol1Indexed,
): Position0Indexed {
  return {
    row: pos.row - 1,
    col: Math.max(0, pos.col - 1),
  } as Position0Indexed;
}

export type WindowId = number & { __winId: true };

export class NvimWindow {
  constructor(
    public readonly id: WindowId,
    private nvim: Nvim,
  ) {}

  valid(): Promise<boolean> {
    return this.nvim.call("nvim_win_is_valid", [this.id]);
  }

  clearjumps() {
    return this.nvim.call("nvim_command", [
      `call win_execute(${this.id}, 'clearjumps')`,
    ]);
  }

  setWidth(width: number) {
    return this.nvim.call("nvim_win_set_width", [this.id, width]);
  }

  getOption(name: string) {
    return this.nvim.call("nvim_win_get_option", [this.id, name]);
  }

  setOption(name: string, value: unknown) {
    return this.nvim.call("nvim_win_set_option", [this.id, name, value]);
  }

  async getVar(name: string) {
    try {
      return await this.nvim.call("nvim_win_get_var", [this.id, name]);
    } catch (e) {
      this.nvim.logger?.warn(`getVar(${name}) failed: ${JSON.stringify(e)}`);
      return undefined;
    }
  }

  setVar(name: string, value: unknown) {
    return this.nvim.call("nvim_win_set_var", [this.id, name, value]);
  }

  close(force: boolean = false) {
    return this.nvim.call("nvim_win_close", [this.id, force]);
  }

  async buffer(): Promise<NvimBuffer> {
    const bufNr = (await this.nvim.call("nvim_win_get_buf", [
      this.id,
    ])) as BufNr;
    return new NvimBuffer(bufNr, this.nvim);
  }

  async getCursor(): Promise<Position1Indexed> {
    const [row, col] = await this.nvim.call("nvim_win_get_cursor", [this.id]);
    return { row, col } as Position1Indexed;
  }

  setCursor(pos: Position1Indexed) {
    return this.nvim.call("nvim_win_set_cursor", [this.id, [pos.row, pos.col]]);
  }

  async setWindowAsCurrent() {
    return this.nvim.call("nvim_set_current_win", [this.id]);
  }

  zt() {
    return this.nvim.call("nvim_exec2", [
      `call win_execute(${this.id}, 'normal! zt')`,
      {},
    ]);
  }

  async topLine(): Promise<number> {
    const res = await this.nvim.call("nvim_exec2", [
      `echo line('w0', "${this.id}")`,
      { output: true },
    ]);

    return Number(res.output);
  }
}
