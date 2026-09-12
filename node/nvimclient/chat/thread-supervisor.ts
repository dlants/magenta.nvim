import type {
  EndTurnAction,
  EndTurnContext,
  TeardownResult,
  ThreadSupervisor,
  YieldAction,
} from "@magenta/server";
import { teardownContainer, UnsupervisedSupervisor } from "@magenta/server";

type DockerSupervisorArgs = {
  containerName: string;
  workspacePath: string;
  hostDir: string;
  maxRestarts?: number;
  onProgress?: (message: string) => void;
};

export class DockerSupervisor implements ThreadSupervisor {
  static create(args: DockerSupervisorArgs): DockerSupervisor {
    return new DockerSupervisor(
      args,
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
      args.source.args,
      UnsupervisedSupervisor.clone({ source: args.source.unsupervised }),
      args.source.teardownResult,
    );
  }

  private constructor(
    private readonly args: DockerSupervisorArgs,
    private readonly unsupervised: UnsupervisedSupervisor,
    public teardownResult: TeardownResult | undefined,
  ) {}

  onEndTurnWithoutYield(context: EndTurnContext): EndTurnAction {
    return this.unsupervised.onEndTurnWithoutYield(context);
  }

  async onYield(_result: string): Promise<YieldAction> {
    this.teardownResult = await teardownContainer({
      containerName: this.args.containerName,
      workspacePath: this.args.workspacePath,
      hostDir: this.args.hostDir,
      ...(this.args.onProgress ? { onProgress: this.args.onProgress } : {}),
    });

    return {
      type: "accept",
      resultPrefix: `[Changes synced to ${this.args.hostDir}]`,
    };
  }
}
