import { teardownContainer } from "./container/teardown.ts";
import type { TeardownResult } from "./container/types.ts";
import type { YieldValue } from "./thread-api.ts";
import type {
  EndTurnAction,
  EndTurnContext,
  ThreadSupervisor,
  YieldAction,
} from "./thread-supervisor.ts";
import { UnsupervisedSupervisor } from "./thread-supervisor.ts";

type DockerSupervisorArgs = {
  containerName: string;
  workspacePath: string;
  hostDir: string;
  maxRestarts?: number;
  onProgress?: (message: string) => void;
};
type DockerTeardownConfig = Readonly<Omit<DockerSupervisorArgs, "maxRestarts">>;

export class DockerSupervisor implements ThreadSupervisor {
  static create(args: DockerSupervisorArgs): DockerSupervisor {
    const teardownConfig: DockerTeardownConfig = {
      containerName: args.containerName,
      workspacePath: args.workspacePath,
      hostDir: args.hostDir,
      ...(args.onProgress ? { onProgress: args.onProgress } : {}),
    };
    return new DockerSupervisor(
      teardownConfig,
      UnsupervisedSupervisor.create(
        args.maxRestarts !== undefined
          ? { maxRestarts: args.maxRestarts }
          : undefined,
      ),
      undefined,
    );
  }

  static clone(args: { source: DockerSupervisor }): DockerSupervisor {
    return new DockerSupervisor(
      { ...args.source.teardownConfig },
      UnsupervisedSupervisor.clone({ source: args.source.unsupervised }),
      args.source.teardownResult
        ? { ...args.source.teardownResult }
        : undefined,
    );
  }

  private constructor(
    private readonly teardownConfig: DockerTeardownConfig,
    private readonly unsupervised: UnsupervisedSupervisor,
    public teardownResult: TeardownResult | undefined,
  ) {}

  onEndTurnWithoutYield(context: EndTurnContext): EndTurnAction {
    return this.unsupervised.onEndTurnWithoutYield(context);
  }

  async onYield(_result: YieldValue): Promise<YieldAction> {
    this.teardownResult = await teardownContainer({
      containerName: this.teardownConfig.containerName,
      workspacePath: this.teardownConfig.workspacePath,
      hostDir: this.teardownConfig.hostDir,
      ...(this.teardownConfig.onProgress
        ? { onProgress: this.teardownConfig.onProgress }
        : {}),
    });

    return {
      type: "accept",
      resultPrefix: `[Changes synced to ${this.teardownConfig.hostDir}]`,
    };
  }
}
