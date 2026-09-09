import * as fs from "node:fs";
import * as path from "node:path";
import type {
  SandboxAskCallback,
  SandboxRuntimeConfig,
  SandboxViolationEvent,
} from "@anthropic-ai/sandbox-runtime";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { assertStraceAvailable } from "./capabilities/strace.ts";
import type { SandboxConfig } from "./options.ts";
import type { HomeDir, NvimCwd } from "./utils/files.ts";

export type SandboxState =
  | { status: "uninitialized" }
  | { status: "ready" }
  | { status: "unsupported"; reason: string };

export type FsReadConfig = { denyOnly: string[]; allowWithinDeny?: string[] };
export type FsWriteConfig = { allowOnly: string[]; denyWithinAllow: string[] };

export type NetworkAskParams = { host: string; port: number | undefined };
export type NetworkAskTarget = (params: NetworkAskParams) => Promise<boolean>;

export interface Sandbox {
  getState(): SandboxState;
  wrapWithSandbox(command: string): Promise<string>;
  getViolationStore(): {
    getTotalCount(): number;
    getViolations(count: number): SandboxViolationEvent[];
    addViolation(violation: SandboxViolationEvent): void;
  };
  annotateStderrWithSandboxFailures(command: string, stderr: string): string;
  getFsReadConfig(): FsReadConfig;
  getFsWriteConfig(): FsWriteConfig;
  updateConfigIfChanged(
    config: SandboxConfig,
    cwd: NvimCwd,
    homeDir: HomeDir,
  ): void;
  cleanupAfterCommand(): void;
  // The sandbox owns a single global network-ask callback, but UI prompts live
  // in per-command handlers. Each in-flight sandboxed command pushes itself as
  // the active target; routeNetworkAsk forwards to the top of the stack. An
  // empty stack fails closed (deny).
  pushNetworkAskTarget(target: NetworkAskTarget): void;
  popNetworkAskTarget(target: NetworkAskTarget): void;
  routeNetworkAsk(params: NetworkAskParams): Promise<boolean>;
  // Remember a host approved by the user for the rest of the session so the
  // network-ask callback (and the underlying proxy, via merged allowedDomains)
  // stops prompting for it.
  recordSessionApprovedHost(host: string): void;
}

// -- Path resolution helpers --

function resolvePath(p: string, cwd: NvimCwd, homeDir: HomeDir): string {
  if (p.startsWith("~/")) {
    return path.join(homeDir, p.slice(2));
  }
  if (p.startsWith("./")) {
    return path.join(cwd, p.slice(2));
  }
  if (path.isAbsolute(p)) {
    return p;
  }
  return path.join(cwd, p);
}

function resolvePaths(
  paths: string[],
  cwd: NvimCwd,
  homeDir: HomeDir,
): string[] {
  return paths.map((p) => resolvePath(p, cwd, homeDir));
}

// Merge session-approved network hosts into the runtime allowedDomains list,
// skipping any host that is already present so the proxy stops re-prompting.
export function mergeApprovedDomains(
  allowedDomains: string[],
  approvedHosts: string[],
): string[] {
  const merged = [...allowedDomains];
  for (const host of approvedHosts) {
    if (!merged.includes(host)) {
      merged.push(host);
    }
  }
  return merged;
}

// bwrap implements denyRead by bind-mounting an empty file/dir over each path,
// which is a hard error if the path doesn't exist — the whole sandbox then fails
// to start (e.g. no ~/.zshrc in a container). macOS seatbelt rules are purely
// path-pattern based, so this filtering is Linux-only.
function filterExisting(paths: string[]): string[] {
  if (process.platform !== "linux") return paths;
  return paths.filter((p) => fs.existsSync(p));
}

function dedup(arr: string[]): string[] {
  return [...new Set(arr)];
}

export function resolveConfigPaths(
  config: SandboxConfig,
  cwd: NvimCwd,
  homeDir: HomeDir,
): SandboxRuntimeConfig {
  return {
    filesystem: {
      allowWrite: dedup(
        resolvePaths(config.filesystem.allowWrite, cwd, homeDir),
      ),
      denyWrite: dedup(resolvePaths(config.filesystem.denyWrite, cwd, homeDir)),
      denyRead: filterExisting(
        dedup(resolvePaths(config.filesystem.denyRead, cwd, homeDir)),
      ),
      allowRead: dedup(resolvePaths(config.filesystem.allowRead, cwd, homeDir)),
    },
    network: {
      allowedDomains: dedup(config.network.allowedDomains),
      deniedDomains: dedup(config.network.deniedDomains),
      allowUnixSockets: dedup(
        resolvePaths(config.network.allowUnixSockets, cwd, homeDir),
      ),
      allowAllUnixSockets: config.network.allowAllUnixSockets,
    },
  };
}

// Shared LIFO routing for the active network-ask target. Reused by RealSandbox
// and test doubles so routing semantics stay identical.
export class NetworkAskStack {
  private stack: NetworkAskTarget[] = [];
  private approvedHosts = new Set<string>();

  push(target: NetworkAskTarget): void {
    this.stack.push(target);
  }

  pop(target: NetworkAskTarget): void {
    const idx = this.stack.lastIndexOf(target);
    if (idx !== -1) {
      this.stack.splice(idx, 1);
    }
  }

  // A host approved during this session is remembered so subsequent requests to
  // the same host (within the command or in later commands) are auto-approved
  // without re-prompting. Rejections are intentionally not remembered.
  recordApprovedHost(host: string): void {
    this.approvedHosts.add(host);
  }

  getApprovedHosts(): string[] {
    return [...this.approvedHosts];
  }

  route(params: NetworkAskParams): Promise<boolean> {
    if (this.approvedHosts.has(params.host)) {
      return Promise.resolve(true);
    }
    const target = this.stack[this.stack.length - 1];
    if (!target) {
      return Promise.resolve(false);
    }
    return target(params);
  }
}

// -- Real implementation wrapping @anthropic-ai/sandbox-runtime --

class RealSandbox implements Sandbox {
  private state: SandboxState;
  private lastConfigJson: string | undefined;
  private networkAskStack = new NetworkAskStack();

  constructor(state: SandboxState, lastConfigJson?: string) {
    this.state = state;
    this.lastConfigJson = lastConfigJson;
  }

  getState(): SandboxState {
    return this.state;
  }

  wrapWithSandbox(command: string): Promise<string> {
    return SandboxManager.wrapWithSandbox(command);
  }

  getViolationStore() {
    return SandboxManager.getSandboxViolationStore();
  }

  annotateStderrWithSandboxFailures(command: string, stderr: string): string {
    return SandboxManager.annotateStderrWithSandboxFailures(command, stderr);
  }

  getFsReadConfig(): FsReadConfig {
    return SandboxManager.getFsReadConfig();
  }

  getFsWriteConfig(): FsWriteConfig {
    return SandboxManager.getFsWriteConfig();
  }

  updateConfigIfChanged(
    config: SandboxConfig,
    cwd: NvimCwd,
    homeDir: HomeDir,
  ): void {
    const runtimeConfig = resolveConfigPaths(config, cwd, homeDir);
    runtimeConfig.network.allowedDomains = mergeApprovedDomains(
      runtimeConfig.network.allowedDomains,
      this.networkAskStack.getApprovedHosts(),
    );
    const configJson = JSON.stringify(runtimeConfig);
    if (configJson === this.lastConfigJson) {
      return;
    }
    this.lastConfigJson = configJson;
    SandboxManager.updateConfig(runtimeConfig);
  }

  cleanupAfterCommand(): void {
    SandboxManager.cleanupAfterCommand();
  }

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
}

// -- Factory --

export async function initializeSandbox(
  config: SandboxConfig,
  cwd: NvimCwd,
  homeDir: HomeDir,
  askCallback: SandboxAskCallback | undefined,
  logger: { warn(msg: string): void },
): Promise<Sandbox> {
  if (!SandboxManager.isSupportedPlatform()) {
    const reason = "Sandbox is not supported on this platform";
    logger.warn(reason);
    return new RealSandbox({ status: "unsupported", reason });
  }

  const depCheck = SandboxManager.checkDependencies();
  if (depCheck.errors.length > 0) {
    const reason = `Sandbox dependencies missing: ${depCheck.errors.join(", ")}`;
    logger.warn(reason);
    return new RealSandbox({ status: "unsupported", reason });
  }

  if (depCheck.warnings.length > 0) {
    for (const warning of depCheck.warnings) {
      logger.warn(`Sandbox dependency warning: ${warning}`);
    }
  }

  // On Linux, sandbox violations are captured by running commands under strace.
  // There is no regex fallback, so strace is a hard requirement: throw (refusing
  // to start) if it is missing or cannot attach.
  assertStraceAvailable(process.platform);

  const runtimeConfig = resolveConfigPaths(config, cwd, homeDir);
  await SandboxManager.initialize(runtimeConfig, askCallback, true);
  const lastConfigJson = JSON.stringify(runtimeConfig);

  return new RealSandbox({ status: "ready" }, lastConfigJson);
}
