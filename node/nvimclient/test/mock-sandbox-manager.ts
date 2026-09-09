import type { SandboxViolationEvent } from "@anthropic-ai/sandbox-runtime";
import {
  type NetworkAskParams,
  NetworkAskStack,
  type NetworkAskTarget,
  type Sandbox,
  type SandboxState,
} from "../sandbox-manager.ts";

export class MockSandboxManager implements Sandbox {
  private state: SandboxState = { status: "ready" };
  private blockedReadPaths: string[] = [];
  private blockedWritePaths: string[] = [];
  private allowWritePaths: string[] = ["/"];
  private violationCount = 0;
  private pendingViolations: SandboxViolationEvent[] = [];

  getState(): SandboxState {
    return this.state;
  }

  async wrapWithSandbox(command: string): Promise<string> {
    return command;
  }

  getViolationStore() {
    return {
      getTotalCount: () => this.violationCount,
      getViolations: (count: number) => this.pendingViolations.splice(0, count),
      addViolation: () => {},
    };
  }

  annotateStderrWithSandboxFailures(_command: string, stderr: string): string {
    return stderr;
  }

  getFsReadConfig() {
    return { denyOnly: this.blockedReadPaths, allowWithinDeny: [] as string[] };
  }

  getFsWriteConfig() {
    return {
      allowOnly: this.allowWritePaths,
      denyWithinAllow: this.blockedWritePaths,
    };
  }

  updateConfigIfChanged(): void {}
  cleanupAfterCommand(): void {}

  private networkAskStack = new NetworkAskStack();

  pushNetworkAskTarget(target: NetworkAskTarget): void {
    this.networkAskStack.push(target);
  }

  popNetworkAskTarget(target: NetworkAskTarget): void {
    this.networkAskStack.pop(target);
  }

  routeNetworkAsk(params: NetworkAskParams): Promise<boolean> {
    return this.networkAskStack.route(params);
  }

  recordSessionApprovedHost(host: string): void {
    this.networkAskStack.recordApprovedHost(host);
  }

  // -- Test configuration methods --

  setState(state: SandboxState): void {
    this.state = state;
  }

  blockReadsFrom(...paths: string[]): void {
    this.blockedReadPaths.push(...paths);
  }

  blockWritesTo(...paths: string[]): void {
    this.blockedWritePaths.push(...paths);
  }

  setAllowWritePaths(paths: string[]): void {
    this.allowWritePaths = paths;
  }

  simulateViolation(event: SandboxViolationEvent): void {
    this.violationCount++;
    this.pendingViolations.push(event);
  }

  resetConfig(): void {
    this.state = { status: "ready" };
    this.violationCount = 0;
    this.pendingViolations = [];
    this.blockedReadPaths = [];
    this.blockedWritePaths = [];
    this.allowWritePaths = ["/"];
  }
}
