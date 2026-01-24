import type { PKB } from "./pkb.ts";

export type Logger = {
  info: (msg: string) => void;
  debug: (msg: string) => void;
  error: (msg: string) => void;
};

export class PKBManager {
  constructor(
    private pkb: PKB,
    private logger: Logger,
  ) {}

  async reindex(): Promise<void> {
    this.logger.info("PKB: Starting reindex...");

    const { queued, skipped } = this.pkb.scanForChanges();
    this.logger.info(
      `PKB: Queued ${queued.length} files for indexing, ${skipped.length} unchanged`,
    );

    let processed = 0;
    while (true) {
      const result = await this.pkb.processNextInQueue();
      if (result.status === "empty") {
        break;
      }
      processed++;
      this.logger.info(
        `PKB: Indexed ${result.filename} (${this.pkb.getQueueSize()} remaining)`,
      );
    }

    this.logger.info(`PKB: Reindex complete. Processed ${processed} files.`);
  }

  getPKB(): PKB {
    return this.pkb;
  }
}
