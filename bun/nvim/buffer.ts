import type { Nvim } from "bunvim";

export type Line = string & { __line: true };
export type BufNr = number & { __bufnr: true };
export type Mode = "n" | "i" | "v";

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

  setLines({
    start,
    end,
    lines,
  }: {
    start: number;
    end: number;
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
    start: number;
    end: number;
  }): Promise<Line[]> {
    const lines = await this.nvim.call("nvim_buf_get_lines", [
      this.id,
      start,
      end,
      false,
    ]);
    return lines as Line[];
  }

  setKeymap({
    mode,
    lhs,
    rhs,
    opts,
  }: {
    mode: Mode;
    lhs: string;
    rhs: string;
    opts: {
      silent?: boolean;
      noremap?: boolean;
    };
  }) {
    return this.nvim.call("nvim_buf_set_keymap", [
      this.id,
      mode,
      lhs,
      rhs,
      opts,
    ]);
  }

  getName() {
    return this.nvim.call("nvim_buf_get_name", [this.id]);
  }

  setName(name: string) {
    return this.nvim.call("nvim_buf_set_name", [this.id, name]);
  }

  static async create(listed: boolean, scratch: boolean, nvim: Nvim) {
    const bufNr = (await nvim.call("nvim_create_buf", [
      listed,
      scratch,
    ])) as BufNr;
    return new NvimBuffer(bufNr, nvim);
  }

  static async bufadd(absolutePath: string, nvim: Nvim) {
    const bufNr = (await nvim.call("nvim_eval", [
      `bufadd("${absolutePath}")`,
    ])) as BufNr;
    await nvim.call("nvim_eval", [`bufload(${bufNr})`]);
    return new NvimBuffer(bufNr, nvim);
  }
}
