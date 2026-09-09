import type { LuaExecutor } from "@magenta/server";
import type { Nvim } from "../nvim/nvim-node/index.ts";

export class NvimLuaExecutor implements LuaExecutor {
  constructor(private nvim: Nvim) {}

  async execLua(code: string): Promise<unknown> {
    const result = await this.nvim.call("nvim_exec_lua", [code, []]);
    return result ?? undefined;
  }
}
