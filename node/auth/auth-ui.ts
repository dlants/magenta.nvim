import type { AuthUI } from "@magenta/core";
import open from "open";
import type { Nvim } from "../nvim/nvim-node/index.ts";

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

  showLoginProgress(chunk: string): void {
    const text = chunk.trim();
    if (!text) return;
    this.nvim
      .call("nvim_exec_lua", [`vim.notify((...), vim.log.levels.INFO)`, [text]])
      .catch((err: unknown) => {
        this.nvim.logger.error(`Failed to show login progress: ${err}`);
      });
  }

  showError(message: string): void {
    this.nvim
      .call("nvim_exec_lua", [
        `vim.notify((...), vim.log.levels.ERROR)`,
        [message],
      ])
      .catch((err: unknown) => {
        this.nvim.logger.error(
          `Failed to show auth error notification: ${err}`,
        );
      });
  }
}
