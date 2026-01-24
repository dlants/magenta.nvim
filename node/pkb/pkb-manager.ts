import type { PKB } from "./pkb.ts";
import type { Nvim } from "../nvim/nvim-node";

const DEFAULT_SCAN_INTERVAL_MS = 5_000; // 5 seconds
const DEFAULT_PROCESS_INTERVAL_MS = 100; // 100ms between processing files

export class PKBManager {
  private scanInterval: ReturnType<typeof setInterval> | undefined;
  private processTimeout: ReturnType<typeof setTimeout> | undefined;
  private isProcessing = false;

  constructor(
    private pkb: PKB,
    private nvim: Nvim,
    private scanIntervalMs: number = DEFAULT_SCAN_INTERVAL_MS,
    private processIntervalMs: number = DEFAULT_PROCESS_INTERVAL_MS,
  ) {}

  start(): void {
    this.runScan();
    this.scheduleNextProcess();

    this.scanInterval = setInterval(() => {
      this.runScan();
    }, this.scanIntervalMs);
  }

  stop(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = undefined;
    }
    if (this.processTimeout) {
      clearTimeout(this.processTimeout);
      this.processTimeout = undefined;
    }
  }

  private runScan(): void {
    try {
      const { queued, skipped } = this.pkb.scanForChanges();
      if (queued.length > 0) {
        this.nvim.logger.info(
          `PKB: Queued ${queued.length} files for indexing: ${queued.join(", ")}`,
        );
      }
      this.nvim.logger.debug(
        `PKB: Scanned ${queued.length + skipped.length} files, ${skipped.length} unchanged`,
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.nvim.logger.error(
        `PKB: Failed to scan for changes: ${err.message}\n${err.stack}`,
      );
    }
  }

  private scheduleNextProcess(): void {
    this.processTimeout = setTimeout(() => {
      this.processNext();
    }, this.processIntervalMs);
  }

  private processNext(): void {
    if (this.isProcessing) {
      this.scheduleNextProcess();
      return;
    }

    this.isProcessing = true;

    this.pkb
      .processNextInQueue()
      .then((result) => {
        if (result.status === "processed") {
          this.nvim.logger.info(
            `PKB: Indexed ${result.filename} (${this.pkb.getQueueSize()} remaining)`,
          );
        }
      })
      .catch((error: Error) => {
        this.nvim.logger.error(
          `PKB: Failed to process file: ${error.message}\n${error.stack}`,
        );
      })
      .finally(() => {
        this.isProcessing = false;
        this.scheduleNextProcess();
      });
  }

  getPKB(): PKB {
    return this.pkb;
  }
}
