import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { AuthUI } from "@magenta/core";
import open from "open";

export class NvimAuthUI implements AuthUI {
  constructor(private nvim: Nvim) {}

  async showOAuthFlow(authUrl: string): Promise<string> {
    try {
      await open(authUrl);
    } catch {
      this.nvim.logger.warn(
        "Could not automatically open browser, please open URL manually",
      );
    }

    const luaScript = `
      vim.notify(
        "Claude Max Authentication Required\\n\\nThe browser should open automatically. If not, open this URL:\\n${authUrl}\\n\\nAfter completing the authorization process, copy the authorization code and paste it below.",
        vim.log.levels.INFO
      )
      return vim.fn.input("Enter authorization code: ")
    `;

    const code = await this.nvim.call("nvim_exec_lua", [luaScript, []]);

    if (!code || typeof code !== "string" || code.trim() === "") {
      throw new Error("No authorization code provided");
    }

    return code.trim();
  }
}
