import type { TeardownResult, YieldAction } from "@magenta/core";
import { teardownContainer, UnsupervisedSupervisor } from "@magenta/core";

export class DockerSupervisor extends UnsupervisedSupervisor {
  public teardownResult: TeardownResult | undefined;

  constructor(
    private containerName: string,
    private workspacePath: string,
    private hostDir: string,
    private opts?: {
      maxRestarts?: number;
      onProgress?: (message: string) => void;
    },
  ) {
    super(
      opts?.maxRestarts !== undefined
        ? { maxRestarts: opts.maxRestarts }
        : undefined,
    );
  }

  override async onYield(_result: string): Promise<YieldAction> {
    this.teardownResult = await teardownContainer({
      containerName: this.containerName,
      workspacePath: this.workspacePath,
      hostDir: this.hostDir,
      ...(this.opts?.onProgress ? { onProgress: this.opts.onProgress } : {}),
    });

    return {
      type: "accept",
      resultPrefix: `[Changes synced to ${this.hostDir}]`,
    };
  }
}
