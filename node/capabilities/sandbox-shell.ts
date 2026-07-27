import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ThreadId } from "@magenta/core";
import { MAGENTA_TEMP_DIR } from "@magenta/core";
import type { MagentaOptions } from "../options.ts";
import type { NetworkAskTarget, Sandbox } from "../sandbox-manager.ts";
import { withTimeout } from "../utils/async.ts";
import type { HomeDir, NvimCwd } from "../utils/files.ts";
import type { SandboxViolationHandler } from "./sandbox-violation-handler.ts";
import type { OutputLine, Shell, ShellResult } from "./shell.ts";
import {
  createLogWriter,
  escalateToSigkill,
  processStreamData,
  terminateProcess,
  toolLogDir,
} from "./shell-utils.ts";
import { buildStraceCommand, parseStraceViolations } from "./strace.ts";

/** Grace period (ms) after first violation before terminating the process */
export const VIOLATION_GRACE_PERIOD_MS = 5000;
/** Interval (ms) between violation store polls during execution */
export const VIOLATION_POLL_INTERVAL_MS = 100;

export class SandboxShell implements Shell {
  private runningProcess: ChildProcess | undefined;
  private violationGracePeriodMs: number;
  private violationPollIntervalMs: number;

  constructor(
    private context: {
      cwd: NvimCwd;
      homeDir: HomeDir;
      threadId: ThreadId;
      getOptions: () => MagentaOptions;
      isBypassed: () => boolean;
    },
    private sandbox: Sandbox,
    private violationHandler: SandboxViolationHandler,
    opts?: {
      violationGracePeriodMs?: number;
      violationPollIntervalMs?: number;
    },
  ) {
    this.violationGracePeriodMs =
      opts?.violationGracePeriodMs ?? VIOLATION_GRACE_PERIOD_MS;
    this.violationPollIntervalMs =
      opts?.violationPollIntervalMs ?? VIOLATION_POLL_INTERVAL_MS;
  }

  // For the duration of a sandboxed command, this shell registers itself as the
  // sandbox's active network-ask target. The single global ask callback (in
  // magenta.ts) routes unknown-host connection requests to the top of the
  // sandbox's target stack, i.e. here, so we can surface a UI prompt. Approval
  // is remembered for the session so the same host is not re-prompted.
  private networkAskTarget: NetworkAskTarget = async ({ host, port }) => {
    const onUnknownHost =
      this.context.getOptions().sandbox.network.onUnknownHost;

    // "deny" fails closed without any UI; "allow" auto-approves (still recording
    // the host for session symmetry); "prompt" surfaces the approval prompt.
    if (onUnknownHost === "deny") {
      return false;
    }
    if (onUnknownHost === "allow") {
      this.sandbox.recordSessionApprovedHost(host);
      return true;
    }

    const approved = await this.violationHandler.promptForNetworkAccess({
      host,
      port,
    });
    if (approved) {
      this.sandbox.recordSessionApprovedHost(host);
    }
    return approved;
  };

  terminate(): void {
    const childProcess = this.runningProcess;
    if (!childProcess) return;

    terminateProcess(childProcess);

    setTimeout(() => {
      if (this.runningProcess === childProcess) {
        escalateToSigkill(childProcess);
      }
    }, 1000);
  }

  private async spawnCommand(
    command: string,
    opts: {
      toolRequestId: string;
      onOutput?: (line: OutputLine) => void;
      onStart?: () => void;
    },
  ): Promise<ShellResult> {
    const logWriter = createLogWriter(
      this.context.threadId,
      opts.toolRequestId,
      command,
    );

    const output: OutputLine[] = [];
    const startTime = Date.now();

    try {
      const result = await withTimeout(
        new Promise<{
          code: number | undefined;
          signal: NodeJS.Signals | undefined;
        }>((resolve, reject) => {
          const childProcess = spawn("bash", ["-c", command], {
            stdio: ["ignore", "pipe", "pipe"],
            cwd: this.context.cwd,
            env: process.env,
            detached: true,
          });
          this.runningProcess = childProcess;
          opts.onStart?.();

          childProcess.stdout?.on("data", (data: Buffer) => {
            processStreamData("stdout", data, output, logWriter, opts.onOutput);
          });

          childProcess.stderr?.on("data", (data: Buffer) => {
            processStreamData("stderr", data, output, logWriter, opts.onOutput);
          });

          childProcess.on(
            "close",
            (code: number | null, signal: NodeJS.Signals | null) => {
              resolve({
                code: code ?? undefined,
                signal: signal ?? undefined,
              });
            },
          );

          childProcess.on("error", (error: Error) => {
            reject(error);
          });
        }),
        300000,
      );

      const durationMs = Date.now() - startTime;

      if (result.signal) {
        logWriter.writeRaw(`terminated by signal ${result.signal}\n`);
      } else {
        logWriter.writeRaw(`exit code ${result.code}\n`);
      }
      logWriter.end();
      this.runningProcess = undefined;

      return {
        exitCode: result.code ?? -1,
        signal: result.signal,
        output,
        logFilePath: logWriter.filePath,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;

      if (this.runningProcess) {
        this.runningProcess.kill();
        this.runningProcess = undefined;
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      output.push({ stream: "stderr", text: errorMessage });
      logWriter.write("stderr", errorMessage);
      logWriter.writeRaw("exit code 1\n");
      logWriter.end();

      return {
        exitCode: 1,
        signal: undefined,
        output,
        logFilePath: logWriter.filePath,
        durationMs,
      };
    }
  }

  async execute(
    command: string,
    opts: {
      toolRequestId: string;
      onOutput?: (line: OutputLine) => void;
      onStart?: () => void;
    },
  ): Promise<ShellResult> {
    if (this.context.isBypassed()) {
      return this.spawnCommand(command, opts);
    }

    if (this.sandbox.getState().status !== "ready") {
      return this.violationHandler.promptForApproval(command, () =>
        this.spawnCommand(command, opts),
      );
    }

    const options = this.context.getOptions();

    if (
      this.matchesApprovalPattern(
        command,
        options.sandbox.requireApprovalPatterns,
      )
    ) {
      return this.violationHandler.promptForApproval(command, () =>
        this.spawnCommand(command, opts),
      );
    }

    // On Linux (bubblewrap) there is no live violation-log channel, so we run
    // the user command under strace and synthesize violation events from the
    // syscalls the sandbox denied (EPERM/EACCES). strace must trace the *user
    // command*, not bwrap's namespace setup, so we wrap the user command with
    // strace first and hand the straced command to wrapWithSandbox below —
    // bwrap stays the outermost process.
    //
    // Process-group / termination interaction: spawnCommand runs
    // `bash -c <wrapped>` detached, so bwrap is the process-group leader
    // (childProcess.pid == bwrap). With strace nested *inside* bwrap the tree is
    // `bwrap -> strace -f -> bash -c <command>`; the negative-pid group kill in
    // terminateProcess reaches strace, bash, and all descendants. strace must
    // stay nested under bwrap (never the outermost process) or it becomes the
    // group leader. A group SIGTERM also hits strace, which detaches and dies;
    // there is a race where a tracee is left in a ptrace-stop, so the
    // SIGTERM->SIGKILL escalation in terminate() is load-bearing (SIGKILL cannot
    // be held by a ptrace-stop).
    const isLinux = process.platform === "linux";
    let traceFilePath: string | undefined;
    let commandToWrap = command;
    let sandboxConfig = options.sandbox;
    if (isLinux) {
      const logDir = toolLogDir(this.context.threadId, opts.toolRequestId);
      fs.mkdirSync(logDir, { recursive: true });
      traceFilePath = path.join(logDir, "command.strace");
      commandToWrap = buildStraceCommand(command, traceFilePath);
      // The trace file lives under MAGENTA_TEMP_DIR, which must be writable
      // inside the sandbox for strace to record there.
      sandboxConfig = {
        ...options.sandbox,
        filesystem: {
          ...options.sandbox.filesystem,
          allowWrite: [
            ...options.sandbox.filesystem.allowWrite,
            MAGENTA_TEMP_DIR,
          ],
        },
      };
    }

    this.sandbox.updateConfigIfChanged(
      sandboxConfig,
      this.context.cwd,
      this.context.homeDir,
    );

    const store = this.sandbox.getViolationStore();
    const preCount = store.getTotalCount();

    const wrapped = await this.sandbox.wrapWithSandbox(commandToWrap);

    try {
      return await this.runWrappedAndHandleViolations(
        command,
        wrapped,
        opts,
        store,
        preCount,
        traceFilePath,
      );
    } finally {
      // Always clean up bwrap mount points (e.g. ghost .env / .magenta files
      // bwrap creates in cwd as denyWrite mount points). Without try/finally,
      // violation early-returns and exceptions would skip cleanup and leak
      // empty files into the working directory.
      if (traceFilePath) {
        try {
          fs.rmSync(traceFilePath, { force: true });
        } catch {
          // best-effort cleanup of the trace file
        }
      }
      this.sandbox.cleanupAfterCommand();
    }
  }

  private async runWrappedAndHandleViolations(
    command: string,
    wrapped: string,
    opts: {
      toolRequestId: string;
      onOutput?: (line: OutputLine) => void;
      onStart?: () => void;
    },
    store: ReturnType<Sandbox["getViolationStore"]>,
    preCount: number,
    traceFilePath: string | undefined,
  ): Promise<ShellResult> {
    // Monitor violations during execution and terminate early if a violation
    // is detected and the process doesn't finish within the grace period.
    // This prevents commands from spinning for minutes hitting the same
    // denied syscall repeatedly.
    const monitor = this.startViolationMonitor(store, preCount);
    this.sandbox.pushNetworkAskTarget(this.networkAskTarget);
    let result: ShellResult;
    try {
      result = await this.spawnCommand(wrapped, opts);
    } finally {
      this.sandbox.popNetworkAskTarget(this.networkAskTarget);
    }
    monitor.stop();

    // If the monitor didn't catch a violation during execution, poll briefly
    // for late-arriving violation events from the macOS `log stream` monitor
    if (result.exitCode !== 0 && !monitor.violationDetected) {
      const deadline = Date.now() + 100;
      while (store.getTotalCount() === preCount && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    let postCount = store.getTotalCount();

    // On Linux (bubblewrap / bwrap), the sandbox has no log monitor to populate
    // the violation store. Instead we ran the user command under strace; parse
    // the trace file for syscalls the sandbox denied (EPERM/EACCES) and
    // synthesize violation events so the user gets the same approval prompt as
    // on macOS.
    if (result.exitCode !== 0 && postCount === preCount && traceFilePath) {
      let traceContent = "";
      try {
        traceContent = fs.readFileSync(traceFilePath, "utf8");
      } catch {
        // No trace file (strace produced none); nothing to synthesize.
      }
      const synthetic = parseStraceViolations(traceContent, command);
      for (const v of synthetic) {
        store.addViolation(v);
      }
      postCount = store.getTotalCount();
    }

    // bwrap can fail during namespace/mount setup (e.g. a denyRead bind target
    // that doesn't exist). The user command never ran, so there are no
    // violations to report — treat it as a sandbox failure and ask the user
    // rather than surfacing a bogus command failure.
    if (result.exitCode !== 0 && postCount === preCount) {
      const stderr = result.output
        .filter((l) => l.stream === "stderr")
        .map((l) => l.text)
        .join("\n");
      if (/^bwrap: /m.test(stderr)) {
        return this.violationHandler.promptForApproval(command, () =>
          this.spawnCommand(command, opts),
        );
      }
    }

    if (postCount > preCount && result.exitCode !== 0) {
      const newViolations = store.getViolations(postCount - preCount);
      const stderr = result.output
        .filter((l) => l.stream === "stderr")
        .map((l) => l.text)
        .join("\n");
      const annotated = this.sandbox.annotateStderrWithSandboxFailures(
        command,
        stderr,
      );

      // When strace.autoAllowViolations is enabled, skip the approval prompt
      // and re-run the command unsandboxed automatically.
      if (this.context.getOptions().sandbox.strace.autoAllowViolations) {
        return this.spawnCommand(command, opts);
      }

      return this.violationHandler.addViolation(
        { command, violations: newViolations, stderr: annotated, result },
        () => this.spawnCommand(command, opts),
      );
    }

    return result;
  }

  private compiledPatterns:
    | { source: string[]; compiled: RegExp[] }
    | undefined;

  private matchesApprovalPattern(command: string, patterns: string[]): boolean {
    if (patterns.length === 0) return false;

    if (
      !this.compiledPatterns ||
      this.compiledPatterns.source.length !== patterns.length ||
      this.compiledPatterns.source.some((s, i) => s !== patterns[i])
    ) {
      this.compiledPatterns = {
        source: patterns,
        compiled: patterns.map((p) => new RegExp(p)),
      };
    }

    return this.compiledPatterns.compiled.some((re) => re.test(command));
  }

  private startViolationMonitor(
    store: ReturnType<Sandbox["getViolationStore"]>,
    preCount: number,
  ): { stop: () => void; violationDetected: boolean } {
    let stopped = false;
    let violationDetected = false;
    let graceTimeout: ReturnType<typeof setTimeout> | undefined;

    const pollInterval = setInterval(() => {
      if (stopped) return;
      if (store.getTotalCount() > preCount && !graceTimeout) {
        violationDetected = true;
        graceTimeout = setTimeout(() => {
          if (!stopped) {
            this.terminate();
          }
        }, this.violationGracePeriodMs);
      }
    }, this.violationPollIntervalMs);

    return {
      get violationDetected() {
        return violationDetected;
      },
      stop: () => {
        stopped = true;
        clearInterval(pollInterval);
        if (graceTimeout) clearTimeout(graceTimeout);
      },
    };
  }
}
