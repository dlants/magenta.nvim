import { describe, expect, it } from "vitest";
import { withDriver } from "./test/preamble.ts";

describe("node/nvimclient/bridge-guard.test.ts", () => {
  it("refuses a second channel while the bridged one is alive, and accepts one after it dies", async () => {
    await withDriver({}, async (driver) => {
      const result = (await driver.nvim.call("nvim_exec_lua", [
        `local M = require("magenta")
         local live = M.channel_id
         local stray = 424242
         local ok = pcall(M.bridge, stray)
         local kept = M.channel_id
         -- Pretend the bridged channel died: a channel id nvim never issued.
         M.channel_id = 424243
         local ok2, err2 = pcall(M.bridge, live)
         return { live = live, ok = ok, kept = kept, ok2 = ok2, err2 = tostring(err2), after = M.channel_id }`,
        [],
      ])) as {
        live: number;
        ok: boolean;
        kept: number;
        ok2: boolean;
        err2: string;
        after: number;
      };
      expect(result.ok).toBe(false);
      expect(result.kept).toBe(result.live);
      expect(result.ok2, result.err2).toBe(true);
      expect(result.after).toBe(result.live);
    });
  });
});
