import { attach, NeovimClient } from "neovim";
import { spawn } from "child_process";

process.env.NVIM_LOG_FILE = "/tmp/nvim.log"; // Helpful for debugging
process.env.NVIM_NODE_LOG_FILE = "/tmp/nvim-node.log"; // Helpful for debugging

export class NeovimTestHelper {
  private nvimProcess?: ReturnType<typeof spawn>;
  private nvimClient?: NeovimClient;

  startNvim(): Promise<NeovimClient> {
    return new Promise((resolve, reject) => {
      console.log("Starting Neovim");

      this.nvimProcess = spawn(
        "nvim",
        ["--headless", "-n", "--clean", "--embed"],
        {
          env: {
            ...process.env,
          },
        },
      );

      this.nvimProcess.on("error", (err) => {
        reject(err);
      });

      try {
        this.nvimClient = attach({ proc: this.nvimProcess });
        resolve(this.nvimClient);
        console.error("Neovim started");
      } catch (err) {
        reject(err as Error);
      }
    });
  }

  stopNvim(): void {
    if (this.nvimClient) {
      this.nvimClient.quit();
      this.nvimClient = undefined;
    }

    if (this.nvimProcess) {
      this.nvimProcess.kill();
      this.nvimProcess = undefined;
    }
  }
}