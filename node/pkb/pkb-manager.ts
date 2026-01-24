import type { PKB } from "./pkb.ts";
import type { Nvim } from "../nvim/nvim-node";

const DEFAULT_UPDATE_INTERVAL_MS = 60_000; // 1 minute

export class PKBManager {
  private updateInterval: ReturnType<typeof setInterval> | undefined;

  constructor(
    private pkb: PKB,
    private nvim: Nvim,
    private intervalMs: number = DEFAULT_UPDATE_INTERVAL_MS,
  ) {}

  start(): void {
    this.runUpdate();

    this.updateInterval = setInterval(() => {
      this.runUpdate();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = undefined;
    }
  }

  private runUpdate(): void {
    this.pkb
      .updateEmbeddings()
      .then(({ updated, skipped }) => {
        if (updated.length > 0) {
          this.nvim.logger.info(
            `PKB: Updated embeddings for ${updated.length} files: ${updated.join(", ")}`,
          );
        }
        this.nvim.logger.debug(
          `PKB: Skipped ${skipped.length} files (unchanged)`,
        );
      })
      .catch((error: Error) => {
        this.nvim.logger.error(
          `PKB: Failed to update embeddings: ${error.message}\n${error.stack}`,
        );
      });
  }

  getPKB(): PKB {
    return this.pkb;
  }
}
