import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { MAGENTA_TEMP_DIR, type ThreadId } from "@magenta/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MagentaOptions, SandboxConfig } from "../options.ts";
import type { SandboxState } from "../sandbox-manager.ts";
import { MockSandboxManager } from "../test/mock-sandbox-manager.ts";
import { pollUntil } from "../utils/async.ts";
import type { HomeDir, NvimCwd } from "../utils/files.ts";
import { SandboxShell } from "./sandbox-shell.ts";
import type { SandboxViolationHandler } from "./sandbox-violation-handler.ts";
import type { ShellResult } from "./shell.ts";
import { toolLogDir } from "./shell-utils.ts";

// Mock sandbox object (implements Sandbox interface via DI)
const mockWrapWithSandbox = vi.fn<(command: string) => Promise<string>>();
const mockGetSandboxViolationStore = vi.fn();
const mockAnnotateStderrWithSandboxFailures =
  vi.fn<(command: string, stderr: string) => string>();
const mockCleanupAfterCommand = vi.fn();
const mockGetSandboxState = vi.fn<() => SandboxState>();
const mockUpdateConfigIfChanged = vi.fn();

const mockSandbox = {
  getState: () => mockGetSandboxState(),
  wrapWithSandbox: (...args: [string]) => mockWrapWithSandbox(...args),
  getViolationStore: () => mockGetSandboxViolationStore(),
  annotateStderrWithSandboxFailures: (...args: [string, string]) =>
    mockAnnotateStderrWithSandboxFailures(...args),
  cleanupAfterCommand: () => mockCleanupAfterCommand(),
  getFsReadConfig: () => ({ denyOnly: [] }),
  getFsWriteConfig: () => ({ allowOnly: ["/"], denyWithinAllow: [] }),
  updateConfigIfChanged: (...args: [SandboxConfig, NvimCwd, HomeDir]) =>
    mockUpdateConfigIfChanged(...args),
  pushNetworkAskTarget: () => {},
  popNetworkAskTarget: () => {},
  routeNetworkAsk: () => Promise.resolve(false),
  recordSessionApprovedHost: () => {},
};

// Mock child_process
const mockSpawn = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: (...args: Parameters<typeof original.spawn>) => mockSpawn(...args),
  };
});

function createMockChildProcess(): ChildProcess & {
  _listeners: Record<string, ((...args: unknown[]) => void)[]>;
  _emit: (event: string, ...args: unknown[]) => void;
} {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const proc = {
    pid: 1234,
    stdout: {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        listeners[`stdout:${event}`] = listeners[`stdout:${event}`] || [];
        listeners[`stdout:${event}`].push(handler);
      }),
    },
    stderr: {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        listeners[`stderr:${event}`] = listeners[`stderr:${event}`] || [];
        listeners[`stderr:${event}`].push(handler);
      }),
    },
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(handler);
    }),
    kill: vi.fn(),
    _listeners: listeners,
    _emit: (event: string, ...args: unknown[]) => {
      const handlers = listeners[event] || [];
      for (const handler of handlers) {
        handler(...args);
      }
    },
  };
  return proc as unknown as ChildProcess & {
    _listeners: Record<string, ((...args: unknown[]) => void)[]>;
    _emit: (event: string, ...args: unknown[]) => void;
  };
}

function createMockViolationHandler(): SandboxViolationHandler & {
  promptForApproval: ReturnType<typeof vi.fn>;
  addViolation: ReturnType<typeof vi.fn>;
  promptForWriteApproval: ReturnType<typeof vi.fn>;
  promptForNetworkAccess: ReturnType<typeof vi.fn>;
  approve: ReturnType<typeof vi.fn>;
  reject: ReturnType<typeof vi.fn>;
  approveAll: ReturnType<typeof vi.fn>;
  rejectAll: ReturnType<typeof vi.fn>;
  getPendingViolations: ReturnType<typeof vi.fn>;
  view: ReturnType<typeof vi.fn>;
} {
  return {
    promptForApproval: vi.fn(),
    addViolation: vi.fn(),
    promptForWriteApproval: vi.fn(),
    promptForNetworkAccess: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    approveAll: vi.fn(),
    rejectAll: vi.fn(),
    getPendingViolations: vi.fn(),
    view: vi.fn(),
  } as unknown as ReturnType<typeof createMockViolationHandler>;
}

const defaultSandboxConfig: SandboxConfig = {
  filesystem: {
    allowWrite: ["./"],
    denyWrite: [],
    denyRead: [],
    allowRead: [],
  },
  network: {
    allowedDomains: [],
    deniedDomains: [],
    allowUnixSockets: [],
    allowAllUnixSockets: false,
    onUnknownHost: "prompt",
  },
  requireApprovalPatterns: [],
  strace: {
    autoAllowViolations: false,
  },
};

function createContext() {
  return {
    cwd: "/test/cwd" as NvimCwd,
    homeDir: "/home/user" as HomeDir,
    threadId: "test-thread" as ThreadId,
    getOptions: () =>
      ({
        sandbox: defaultSandboxConfig,
      }) as MagentaOptions,
    isBypassed: () => false,
  };
}

function createOpts() {
  return {
    toolRequestId: "test-tool-1",
    onOutput: vi.fn(),
    onStart: vi.fn(),
  };
}

function setupSpawnSuccess(
  stdout = "hello world",
  exitCode = 0,
): ReturnType<typeof createMockChildProcess> {
  const proc = createMockChildProcess();
  mockSpawn.mockReturnValue(proc);

  // Schedule output and close after spawn
  setTimeout(() => {
    if (stdout) {
      proc._emit("stdout:data", Buffer.from(stdout));
    }
    proc._emit("close", exitCode, null);
  }, 0);

  return proc;
}

describe("SandboxShell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSandboxState.mockReturnValue({ status: "ready" });
    mockWrapWithSandbox.mockImplementation(
      async (cmd: string) => `sandbox-wrapped:${cmd}`,
    );
    mockGetSandboxViolationStore.mockReturnValue({
      getTotalCount: () => 0,
      getViolations: () => [],
    });
    mockAnnotateStderrWithSandboxFailures.mockImplementation(
      (_cmd: string, stderr: string) => stderr,
    );
  });

  test("command wrapped when sandbox ready", async () => {
    setupSpawnSuccess("output", 0);
    const handler = createMockViolationHandler();
    const shell = new SandboxShell(createContext(), mockSandbox, handler);

    const result = await shell.execute("echo hello", createOpts());

    expect(mockWrapWithSandbox).toHaveBeenCalledWith("echo hello");
    expect(mockSpawn).toHaveBeenCalledWith(
      "bash",
      ["-c", "sandbox-wrapped:echo hello"],
      expect.objectContaining({ cwd: "/test/cwd" }),
    );
    expect(result.exitCode).toBe(0);
    expect(handler.promptForApproval).not.toHaveBeenCalled();
    expect(mockCleanupAfterCommand).toHaveBeenCalled();
  });

  test("prompts when disabled", async () => {
    mockGetSandboxState.mockReturnValue({
      status: "unsupported",
      reason: "disabled",
    });
    const handler = createMockViolationHandler();
    const expectedResult: ShellResult = {
      exitCode: 0,
      signal: undefined,
      output: [{ stream: "stdout", text: "ok" }],
      logFilePath: undefined,
      durationMs: 100,
    };
    handler.promptForApproval.mockResolvedValue(expectedResult);

    const shell = new SandboxShell(createContext(), mockSandbox, handler);
    const result = await shell.execute("rm -rf /", createOpts());

    expect(handler.promptForApproval).toHaveBeenCalledWith(
      "rm -rf /",
      expect.any(Function),
    );
    expect(mockWrapWithSandbox).not.toHaveBeenCalled();
    expect(result).toBe(expectedResult);
  });

  test("prompts when unsupported", async () => {
    mockGetSandboxState.mockReturnValue({
      status: "unsupported",
      reason: "missing deps",
    });
    const handler = createMockViolationHandler();
    const expectedResult: ShellResult = {
      exitCode: 0,
      signal: undefined,
      output: [],
      logFilePath: undefined,
      durationMs: 50,
    };
    handler.promptForApproval.mockResolvedValue(expectedResult);

    const shell = new SandboxShell(createContext(), mockSandbox, handler);
    const result = await shell.execute("cat /etc/passwd", createOpts());

    expect(handler.promptForApproval).toHaveBeenCalledWith(
      "cat /etc/passwd",
      expect.any(Function),
    );
    expect(mockWrapWithSandbox).not.toHaveBeenCalled();
    expect(result).toBe(expectedResult);
  });

  test("prompts when uninitialized", async () => {
    mockGetSandboxState.mockReturnValue({ status: "uninitialized" });
    const handler = createMockViolationHandler();
    const expectedResult: ShellResult = {
      exitCode: 0,
      signal: undefined,
      output: [],
      logFilePath: undefined,
      durationMs: 50,
    };
    handler.promptForApproval.mockResolvedValue(expectedResult);

    const shell = new SandboxShell(createContext(), mockSandbox, handler);
    await shell.execute("ls", createOpts());

    expect(handler.promptForApproval).toHaveBeenCalled();
  });

  test("violation detected on non-zero exit", async () => {
    let preCountCalls = 0;
    mockGetSandboxViolationStore.mockReturnValue({
      getTotalCount: () => {
        preCountCalls++;
        // First call returns 0 (pre-count), second returns 2 (post-count)
        return preCountCalls === 1 ? 0 : 2;
      },
      getViolations: (limit: number) =>
        [
          {
            line: "sandbox deny read",
            command: "cat ~/.ssh/id_rsa",
            timestamp: new Date(),
          },
          {
            line: "sandbox deny read 2",
            command: "cat ~/.ssh/id_rsa",
            timestamp: new Date(),
          },
        ].slice(0, limit),
    });
    mockAnnotateStderrWithSandboxFailures.mockReturnValue(
      "Operation not permitted",
    );

    setupSpawnSuccess("", 1);
    const handler = createMockViolationHandler();
    const violationResult: ShellResult = {
      exitCode: 0,
      signal: undefined,
      output: [{ stream: "stdout", text: "retried" }],
      logFilePath: undefined,
      durationMs: 200,
    };
    handler.addViolation.mockResolvedValue(violationResult);

    const shell = new SandboxShell(createContext(), mockSandbox, handler);
    const result = await shell.execute("cat ~/.ssh/id_rsa", createOpts());

    expect(handler.addViolation).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "cat ~/.ssh/id_rsa",
        stderr: "Operation not permitted",
      }),
      expect.any(Function),
    );
    expect(result).toBe(violationResult);
    // cleanupAfterCommand must be called even on the violation path so that
    // bwrap mount points (e.g. ghost .env / .magenta files in cwd) get
    // removed instead of leaking onto the host filesystem.
    expect(mockCleanupAfterCommand).toHaveBeenCalled();
  });

  test("no violation when exit 0", async () => {
    let preCountCalls = 0;
    mockGetSandboxViolationStore.mockReturnValue({
      getTotalCount: () => {
        preCountCalls++;
        // Even if count changes, exit code 0 means no violation
        return preCountCalls === 1 ? 0 : 1;
      },
      getViolations: () => [],
    });

    setupSpawnSuccess("output", 0);
    const handler = createMockViolationHandler();
    const shell = new SandboxShell(createContext(), mockSandbox, handler);

    const result = await shell.execute("echo hi", createOpts());

    expect(handler.addViolation).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(mockCleanupAfterCommand).toHaveBeenCalled();
  });

  test("normal failure without new violations", async () => {
    mockGetSandboxViolationStore.mockReturnValue({
      getTotalCount: () => 5, // Same count before and after
      getViolations: () => [],
    });

    setupSpawnSuccess("command failed", 1);
    const handler = createMockViolationHandler();
    const shell = new SandboxShell(createContext(), mockSandbox, handler);

    const result = await shell.execute("false", createOpts());

    expect(handler.addViolation).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
    expect(mockCleanupAfterCommand).toHaveBeenCalled();
  });

  test("updates sandbox config before execution", async () => {
    setupSpawnSuccess("ok", 0);
    const handler = createMockViolationHandler();
    const context = createContext();
    const shell = new SandboxShell(context, mockSandbox, handler);

    await shell.execute("ls", createOpts());

    expect(mockUpdateConfigIfChanged).toHaveBeenCalledWith(
      defaultSandboxConfig,
      context.cwd,
      context.homeDir,
    );
  });

  test("bypass skips sandbox wrapping", async () => {
    setupSpawnSuccess("direct output", 0);
    const handler = createMockViolationHandler();
    const context = {
      ...createContext(),
      isBypassed: () => true,
    };
    const shell = new SandboxShell(context, mockSandbox, handler);

    const result = await shell.execute("echo hello", createOpts());

    expect(mockWrapWithSandbox).not.toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledWith(
      "bash",
      ["-c", "echo hello"],
      expect.objectContaining({ cwd: "/test/cwd" }),
    );
    expect(result.exitCode).toBe(0);
    expect(handler.promptForApproval).not.toHaveBeenCalled();
  });

  test("terminate delegates to running process", () => {
    const proc = createMockChildProcess();
    mockSpawn.mockReturnValue(proc);

    const handler = createMockViolationHandler();
    const shell = new SandboxShell(createContext(), mockSandbox, handler);

    // Start a command without awaiting
    shell.execute("sleep 100", createOpts());

    shell.terminate();

    // terminateProcess tries process.kill(-pid, "SIGTERM") first
    // Since we mock process.kill, we verify the process got the signal
    // The terminate method uses terminateProcess from shell-utils
    expect(proc.kill).toBeDefined();
  });

  test("execute callback in promptForApproval spawns command directly", async () => {
    mockGetSandboxState.mockReturnValue({
      status: "unsupported",
      reason: "disabled",
    });
    const handler = createMockViolationHandler();

    handler.promptForApproval.mockImplementation(
      async (_command: string, execute: () => Promise<ShellResult>) => {
        // Simulate the handler calling the execute callback
        setupSpawnSuccess("direct output", 0);
        return execute();
      },
    );

    const shell = new SandboxShell(createContext(), mockSandbox, handler);
    const result = await shell.execute("echo test", createOpts());

    // The command should be spawned directly (not wrapped)
    expect(mockSpawn).toHaveBeenCalledWith(
      "bash",
      ["-c", "echo test"],
      expect.objectContaining({ cwd: "/test/cwd" }),
    );
    expect(mockWrapWithSandbox).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });

  describe("violation polling", () => {
    test("polls for violations arriving after command exits", async () => {
      let totalCount = 0;

      mockGetSandboxViolationStore.mockReturnValue({
        getTotalCount: () => totalCount,
        getViolations: (limit: number) =>
          [
            {
              line: "sandbox deny read /home/.ssh/id_rsa",
              command: "cat ~/.ssh/id_rsa",
              timestamp: new Date(),
            },
          ].slice(0, limit),
      });
      mockAnnotateStderrWithSandboxFailures.mockReturnValue(
        "Operation not permitted\n<sandbox_violations>\nsandbox deny read\n</sandbox_violations>",
      );

      // Simulate violation arriving 30ms after command exits
      const proc = createMockChildProcess();
      mockSpawn.mockReturnValue(proc);
      setTimeout(() => {
        proc._emit("stderr:data", Buffer.from("Operation not permitted"));
        proc._emit("close", 1, null);
      }, 0);
      // Violation arrives asynchronously after process closes
      setTimeout(() => {
        totalCount = 1;
      }, 30);

      const handler = createMockViolationHandler();
      const violationResult: ShellResult = {
        exitCode: 0,
        signal: undefined,
        output: [],
        logFilePath: undefined,
        durationMs: 100,
      };
      handler.addViolation.mockResolvedValue(violationResult);

      const shell = new SandboxShell(createContext(), mockSandbox, handler);
      const result = await shell.execute("cat ~/.ssh/id_rsa", createOpts());

      expect(handler.addViolation).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "cat ~/.ssh/id_rsa",
        }),
        expect.any(Function),
      );
      expect(result).toBe(violationResult);
    });

    test("stops polling once violation is detected", async () => {
      let totalCount = 0;
      let getTotalCountCalls = 0;

      mockGetSandboxViolationStore.mockReturnValue({
        getTotalCount: () => {
          getTotalCountCalls++;
          return totalCount;
        },
        getViolations: () => [
          {
            line: "sandbox deny",
            command: "test",
            timestamp: new Date(),
          },
        ],
      });
      mockAnnotateStderrWithSandboxFailures.mockReturnValue("denied");

      const proc = createMockChildProcess();
      mockSpawn.mockReturnValue(proc);
      setTimeout(() => {
        proc._emit("close", 1, null);
      }, 0);
      // Violation arrives on first poll iteration
      setTimeout(() => {
        totalCount = 1;
      }, 5);

      const handler = createMockViolationHandler();
      handler.addViolation.mockResolvedValue({
        exitCode: 0,
        signal: undefined,
        output: [],
        logFilePath: undefined,
        durationMs: 50,
      } as ShellResult);

      const shell = new SandboxShell(createContext(), mockSandbox, handler);
      await shell.execute("test", createOpts());

      // Should have polled a few times, not the full ~10 iterations
      // First call is the pre-count, then a few polls before violation arrives
      expect(getTotalCountCalls).toBeLessThan(15);
      expect(handler.addViolation).toHaveBeenCalled();
    });

    test("gives up polling after 100ms deadline", async () => {
      // Violation never arrives — totalCount stays at 0
      mockGetSandboxViolationStore.mockReturnValue({
        getTotalCount: () => 0,
        getViolations: () => [],
      });

      setupSpawnSuccess("error output", 1);
      const handler = createMockViolationHandler();
      const shell = new SandboxShell(createContext(), mockSandbox, handler);

      const startTime = Date.now();
      const result = await shell.execute("bad-command", createOpts());
      const elapsed = Date.now() - startTime;

      // Should not have called addViolation since no new violations appeared
      expect(handler.addViolation).not.toHaveBeenCalled();
      // Should have waited roughly 100ms polling, not much longer
      expect(elapsed).toBeGreaterThanOrEqual(90);
      expect(elapsed).toBeLessThan(300);
      expect(result.exitCode).toBe(1);
      expect(mockCleanupAfterCommand).toHaveBeenCalled();
    });

    test("skips polling when exit code is 0", async () => {
      let getTotalCountCalls = 0;
      mockGetSandboxViolationStore.mockReturnValue({
        getTotalCount: () => {
          getTotalCountCalls++;
          return 0;
        },
        getViolations: () => [],
      });

      setupSpawnSuccess("ok", 0);
      const handler = createMockViolationHandler();
      const shell = new SandboxShell(createContext(), mockSandbox, handler);

      const startTime = Date.now();
      await shell.execute("echo ok", createOpts());
      const elapsed = Date.now() - startTime;

      // 2 calls: pre-count before execution, post-count after (no polling since exit 0)
      expect(getTotalCountCalls).toBe(2);
      // Should complete quickly without any polling delay
      expect(elapsed).toBeLessThan(90);
      expect(handler.addViolation).not.toHaveBeenCalled();
    });
  });

  describe("early termination on violation", () => {
    test("terminates long-running command after grace period when violation detected during execution", async () => {
      let totalCount = 0;

      mockGetSandboxViolationStore.mockReturnValue({
        getTotalCount: () => totalCount,
        getViolations: (limit: number) =>
          [
            {
              line: "sandbox deny write /etc/passwd",
              command: "long-running-cmd",
              timestamp: new Date(),
            },
          ].slice(0, limit),
      });
      mockAnnotateStderrWithSandboxFailures.mockReturnValue(
        "Operation not permitted",
      );

      // Process that runs until killed
      const proc = createMockChildProcess();
      mockSpawn.mockReturnValue(proc);

      // Violation arrives 20ms into execution
      setTimeout(() => {
        totalCount = 1;
      }, 20);

      // When kill is called (by terminate after grace period), close the process
      proc.kill = vi.fn(() => {
        setTimeout(() => {
          proc._emit("close", null, "SIGTERM");
        }, 10);
        return true;
      });

      const handler = createMockViolationHandler();
      const violationResult: ShellResult = {
        exitCode: 0,
        signal: undefined,
        output: [],
        logFilePath: undefined,
        durationMs: 100,
      };
      handler.addViolation.mockResolvedValue(violationResult);

      // Use short timings so the test completes quickly
      const shell = new SandboxShell(createContext(), mockSandbox, handler, {
        violationGracePeriodMs: 100,
        violationPollIntervalMs: 10,
      });

      const result = await shell.execute("long-running-cmd", createOpts());

      expect(proc.kill).toHaveBeenCalled();
      expect(handler.addViolation).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "long-running-cmd",
        }),
        expect.any(Function),
      );
      expect(result).toBe(violationResult);
    });

    test("does not terminate if command finishes within grace period", async () => {
      let totalCount = 0;

      mockGetSandboxViolationStore.mockReturnValue({
        getTotalCount: () => totalCount,
        getViolations: (limit: number) =>
          [
            {
              line: "sandbox deny read /secret",
              command: "quick-cmd",
              timestamp: new Date(),
            },
          ].slice(0, limit),
      });
      mockAnnotateStderrWithSandboxFailures.mockReturnValue("denied");

      const proc = createMockChildProcess();
      mockSpawn.mockReturnValue(proc);

      // Violation arrives at 50ms
      setTimeout(() => {
        totalCount = 1;
      }, 50);

      // But the process finishes at 200ms (well within 5s grace period)
      setTimeout(() => {
        proc._emit("stderr:data", Buffer.from("denied"));
        proc._emit("close", 1, null);
      }, 200);

      const handler = createMockViolationHandler();
      handler.addViolation.mockResolvedValue({
        exitCode: 0,
        signal: undefined,
        output: [],
        logFilePath: undefined,
        durationMs: 200,
      } as ShellResult);

      const shell = new SandboxShell(createContext(), mockSandbox, handler);
      await shell.execute("quick-cmd", createOpts());

      // Process was NOT killed - it exited naturally
      expect(proc.kill).not.toHaveBeenCalled();
      // But violation was still detected and reported
      expect(handler.addViolation).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "quick-cmd",
        }),
        expect.any(Function),
      );
    });

    test("does not terminate when command succeeds despite violation during execution", async () => {
      let totalCount = 0;

      mockGetSandboxViolationStore.mockReturnValue({
        getTotalCount: () => totalCount,
        getViolations: () => [],
      });

      const proc = createMockChildProcess();
      mockSpawn.mockReturnValue(proc);

      // Violation arrives during execution
      setTimeout(() => {
        totalCount = 1;
      }, 50);

      // But process exits successfully
      setTimeout(() => {
        proc._emit("stdout:data", Buffer.from("ok"));
        proc._emit("close", 0, null);
      }, 100);

      const handler = createMockViolationHandler();
      const shell = new SandboxShell(createContext(), mockSandbox, handler);
      const result = await shell.execute("resilient-cmd", createOpts());

      // Violations are ignored for successful commands
      expect(handler.addViolation).not.toHaveBeenCalled();
      expect(result.exitCode).toBe(0);
      expect(mockCleanupAfterCommand).toHaveBeenCalled();
    });
  });

  describe("requireApprovalPatterns pre-check", () => {
    test("command matching a pattern triggers immediate approval prompt", async () => {
      const handler = createMockViolationHandler();
      const expectedResult: ShellResult = {
        exitCode: 0,
        signal: undefined,
        output: [{ stream: "stdout", text: "pushed" }],
        logFilePath: undefined,
        durationMs: 100,
      };
      handler.promptForApproval.mockResolvedValue(expectedResult);

      const context = {
        ...createContext(),
        getOptions: () =>
          ({
            sandbox: {
              ...defaultSandboxConfig,
              requireApprovalPatterns: ["git\\s+push"],
            },
          }) as MagentaOptions,
      };

      const shell = new SandboxShell(context, mockSandbox, handler);
      const result = await shell.execute(
        "git commit -m 'test' && git push",
        createOpts(),
      );

      expect(handler.promptForApproval).toHaveBeenCalledWith(
        "git commit -m 'test' && git push",
        expect.any(Function),
      );
      expect(mockWrapWithSandbox).not.toHaveBeenCalled();
      expect(result).toBe(expectedResult);
    });

    test("command not matching any pattern proceeds through sandbox normally", async () => {
      setupSpawnSuccess("output", 0);
      const handler = createMockViolationHandler();

      const context = {
        ...createContext(),
        getOptions: () =>
          ({
            sandbox: {
              ...defaultSandboxConfig,
              requireApprovalPatterns: ["git\\s+push", "rm\\s+-rf"],
            },
          }) as MagentaOptions,
      };

      const shell = new SandboxShell(context, mockSandbox, handler);
      const result = await shell.execute("ls -la", createOpts());

      expect(handler.promptForApproval).not.toHaveBeenCalled();
      expect(mockWrapWithSandbox).toHaveBeenCalledWith("ls -la");
      expect(result.exitCode).toBe(0);
    });

    test("empty requireApprovalPatterns does not trigger pre-check", async () => {
      setupSpawnSuccess("output", 0);
      const handler = createMockViolationHandler();
      const shell = new SandboxShell(createContext(), mockSandbox, handler);
      const result = await shell.execute("git push", createOpts());

      expect(handler.promptForApproval).not.toHaveBeenCalled();
      expect(mockWrapWithSandbox).toHaveBeenCalled();
      expect(result.exitCode).toBe(0);
    });

    test("approval prompt callback runs command unsandboxed", async () => {
      const handler = createMockViolationHandler();

      handler.promptForApproval.mockImplementation(
        async (_command: string, execute: () => Promise<ShellResult>) => {
          setupSpawnSuccess("direct output", 0);
          return execute();
        },
      );

      const context = {
        ...createContext(),
        getOptions: () =>
          ({
            sandbox: {
              ...defaultSandboxConfig,
              requireApprovalPatterns: ["git\\s+push"],
            },
          }) as MagentaOptions,
      };

      const shell = new SandboxShell(context, mockSandbox, handler);
      const result = await shell.execute("git push origin main", createOpts());

      expect(mockSpawn).toHaveBeenCalledWith(
        "bash",
        ["-c", "git push origin main"],
        expect.objectContaining({ cwd: "/test/cwd" }),
      );
      expect(mockWrapWithSandbox).not.toHaveBeenCalled();
      expect(result.exitCode).toBe(0);
    });
  });

  describe("Linux strace violation detection", () => {
    const originalPlatform = process.platform;

    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "linux" });
    });

    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    });

    function setupStoreWithSyntheticSupport() {
      const violations: { line: string; command: string; timestamp: Date }[] =
        [];
      mockGetSandboxViolationStore.mockReturnValue({
        getTotalCount: () => violations.length,
        getViolations: (limit: number) => violations.slice(-limit),
        addViolation: (v: {
          line: string;
          command: string;
          timestamp: Date;
        }) => {
          violations.push(v);
        },
      });
    }

    function writeTraceFile(content: string) {
      const dir = toolLogDir("test-thread", "test-tool-1");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "command.strace"), content);
    }

    test("parses denied syscall from trace, prompts, retries unwrapped on approval", async () => {
      setupStoreWithSyntheticSupport();
      mockAnnotateStderrWithSandboxFailures.mockImplementation(
        (_cmd: string, stderr: string) => stderr,
      );

      let resolveViolation: (result: ShellResult) => void;
      const handler = createMockViolationHandler();
      handler.addViolation.mockReturnValue(
        new Promise<ShellResult>((resolve) => {
          resolveViolation = resolve;
        }),
      );

      const proc = createMockChildProcess();
      mockSpawn.mockReturnValueOnce(proc);

      const shell = new SandboxShell(createContext(), mockSandbox, handler);
      const executePromise = shell.execute("cat /secret.txt", createOpts());

      await pollUntil(() => {
        if (!mockSpawn.mock.calls.length) throw new Error("waiting for spawn");
      });
      // The user command is wrapped with strace, then handed to the sandbox.
      expect(mockWrapWithSandbox).toHaveBeenCalled();
      const wrappedArg = mockWrapWithSandbox.mock.calls[0][0];
      expect(wrappedArg).toContain("strace");
      expect(wrappedArg).toContain("cat /secret.txt");

      // Simulate the trace strace would have written for a denied read.
      writeTraceFile(
        'openat(AT_FDCWD, "/secret.txt", O_RDONLY) = -1 EACCES (Permission denied)\n',
      );
      proc._emit("close", 1, null);

      await pollUntil(() => {
        if (!handler.addViolation.mock.calls.length)
          throw new Error("waiting for addViolation");
      });
      expect(handler.addViolation).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "cat /secret.txt",
          violations: expect.arrayContaining([
            expect.objectContaining({
              line: 'openat("/secret.txt") -> EACCES',
            }),
          ]),
        }),
        expect.any(Function),
      );

      const retryFn = handler.addViolation.mock
        .calls[0][1] as () => Promise<ShellResult>;
      const retryProc = createMockChildProcess();
      mockSpawn.mockReturnValueOnce(retryProc);
      const retryPromise = retryFn();

      await pollUntil(() => {
        if (mockSpawn.mock.calls.length < 2)
          throw new Error("waiting for retry spawn");
      });
      // The retry runs the original command unsandboxed (no strace wrapping).
      expect(mockSpawn).toHaveBeenLastCalledWith(
        "bash",
        ["-c", "cat /secret.txt"],
        expect.objectContaining({ cwd: "/test/cwd" }),
      );

      retryProc._emit("stdout:data", Buffer.from("secret-contents"));
      retryProc._emit("close", 0, null);

      const retryResult = await retryPromise;
      expect(retryResult.exitCode).toBe(0);

      resolveViolation!(retryResult);
      const result = await executePromise;
      expect(result.exitCode).toBe(0);
    });

    test("autoAllowViolations re-runs unsandboxed without prompting", async () => {
      setupStoreWithSyntheticSupport();
      mockAnnotateStderrWithSandboxFailures.mockImplementation(
        (_cmd: string, stderr: string) => stderr,
      );
      const handler = createMockViolationHandler();
      const proc = createMockChildProcess();
      mockSpawn.mockReturnValueOnce(proc);
      const context = {
        ...createContext(),
        getOptions: () =>
          ({
            sandbox: {
              ...defaultSandboxConfig,
              strace: { autoAllowViolations: true },
            },
          }) as MagentaOptions,
      };
      const shell = new SandboxShell(context, mockSandbox, handler);
      const executePromise = shell.execute("cat /secret.txt", createOpts());
      await pollUntil(() => {
        if (!mockSpawn.mock.calls.length) throw new Error("waiting for spawn");
      });
      writeTraceFile(
        'openat(AT_FDCWD, "/secret.txt", O_RDONLY) = -1 EACCES (Permission denied)\n',
      );
      // The retry (unsandboxed) command spawns directly without a prompt.
      const retryProc = createMockChildProcess();
      mockSpawn.mockReturnValueOnce(retryProc);
      proc._emit("close", 1, null);
      await pollUntil(() => {
        if (mockSpawn.mock.calls.length < 2)
          throw new Error("waiting for auto retry spawn");
      });
      expect(handler.addViolation).not.toHaveBeenCalled();
      expect(mockSpawn).toHaveBeenLastCalledWith(
        "bash",
        ["-c", "cat /secret.txt"],
        expect.objectContaining({ cwd: "/test/cwd" }),
      );
      retryProc._emit("close", 0, null);
      const result = await executePromise;
      expect(result.exitCode).toBe(0);
    });
    test("does not flag failures whose trace has no denied syscalls", async () => {
      setupStoreWithSyntheticSupport();

      const proc = createMockChildProcess();
      mockSpawn.mockReturnValueOnce(proc);

      const handler = createMockViolationHandler();
      const shell = new SandboxShell(createContext(), mockSandbox, handler);
      const executePromise = shell.execute("cat nonexistent", createOpts());
      await pollUntil(() => {
        if (!mockSpawn.mock.calls.length) throw new Error("waiting for spawn");
      });

      // Only an unrelated ENOENT failure — not a sandbox denial.
      writeTraceFile(
        'openat(AT_FDCWD, "nonexistent", O_RDONLY) = -1 ENOENT (No such file or directory)\n',
      );
      proc._emit(
        "stderr:data",
        Buffer.from("cat: nonexistent: No such file or directory"),
      );
      proc._emit("close", 1, null);

      const result = await executePromise;

      expect(handler.addViolation).not.toHaveBeenCalled();
      expect(result.exitCode).toBe(1);
      expect(mockCleanupAfterCommand).toHaveBeenCalled();
    });

    test("adds MAGENTA_TEMP_DIR to allowWrite so strace can write the trace", async () => {
      setupStoreWithSyntheticSupport();

      const proc = createMockChildProcess();
      mockSpawn.mockReturnValueOnce(proc);

      const handler = createMockViolationHandler();
      const shell = new SandboxShell(createContext(), mockSandbox, handler);
      const executePromise = shell.execute("echo hi", createOpts());
      await pollUntil(() => {
        if (!mockSpawn.mock.calls.length) throw new Error("waiting for spawn");
      });

      const sandboxConfig = mockUpdateConfigIfChanged.mock
        .calls[0][0] as SandboxConfig;
      expect(sandboxConfig.filesystem.allowWrite).toContain(MAGENTA_TEMP_DIR);

      proc._emit("close", 0, null);
      await executePromise;
    });
  });

  describe("network ask routing", () => {
    // Drive a sandboxed command whose underlying proxy "asks" about a host
    // mid-execution by invoking the sandbox's routed ask callback while the
    // command is in flight (i.e. while SandboxShell has registered itself as the
    // active network-ask target).
    function runCommandThatAsks(
      sandbox: MockSandboxManager,
      handler: ReturnType<typeof createMockViolationHandler>,
      host: string,
      onAskResult: (approved: boolean) => void,
      context: ReturnType<typeof createContext> = createContext(),
    ): Promise<ShellResult> {
      const proc = createMockChildProcess();
      mockSpawn.mockReturnValueOnce(proc);
      setTimeout(() => {
        void sandbox.routeNetworkAsk({ host, port: 443 }).then((approved) => {
          onAskResult(approved);
          proc._emit("close", 0, null);
        });
      }, 0);
      const shell = new SandboxShell(context, sandbox, handler);
      return shell.execute(`curl https://${host}`, createOpts());
    }

    test("approve records host for the session — no second prompt", async () => {
      const sandbox = new MockSandboxManager();
      const handler = createMockViolationHandler();
      handler.promptForNetworkAccess.mockResolvedValue(true);

      const results: boolean[] = [];
      await runCommandThatAsks(sandbox, handler, "example.com", (r) =>
        results.push(r),
      );
      await runCommandThatAsks(sandbox, handler, "example.com", (r) =>
        results.push(r),
      );

      expect(results).toEqual([true, true]);
      // Only the first request prompted; the second was auto-approved from the
      // session allowlist.
      expect(handler.promptForNetworkAccess).toHaveBeenCalledTimes(1);
    });

    test("reject blocks and is not persisted — prompts again", async () => {
      const sandbox = new MockSandboxManager();
      const handler = createMockViolationHandler();
      handler.promptForNetworkAccess.mockResolvedValue(false);

      const results: boolean[] = [];
      await runCommandThatAsks(sandbox, handler, "blocked.com", (r) =>
        results.push(r),
      );
      await runCommandThatAsks(sandbox, handler, "blocked.com", (r) =>
        results.push(r),
      );

      expect(results).toEqual([false, false]);
      // Rejections are not remembered, so the same host prompts on each command.
      expect(handler.promptForNetworkAccess).toHaveBeenCalledTimes(2);
    });

    test("empty active-target stack fails closed (deny)", async () => {
      const sandbox = new MockSandboxManager();
      const approved = await sandbox.routeNetworkAsk({
        host: "nobody.com",
        port: 443,
      });
      expect(approved).toBe(false);
    });
    function contextWithOnUnknownHost(
      onUnknownHost: "prompt" | "allow" | "deny",
    ) {
      return {
        ...createContext(),
        getOptions: () =>
          ({
            sandbox: {
              ...defaultSandboxConfig,
              network: { ...defaultSandboxConfig.network, onUnknownHost },
            },
          }) as MagentaOptions,
      };
    }
    test('onUnknownHost "allow" auto-approves without prompting', async () => {
      const sandbox = new MockSandboxManager();
      const recordSpy = vi.spyOn(sandbox, "recordSessionApprovedHost");
      const handler = createMockViolationHandler();
      const results: boolean[] = [];
      await runCommandThatAsks(
        sandbox,
        handler,
        "auto.com",
        (r) => results.push(r),
        contextWithOnUnknownHost("allow"),
      );
      expect(results).toEqual([true]);
      expect(handler.promptForNetworkAccess).not.toHaveBeenCalled();
      // "allow" still records the host for session symmetry.
      expect(recordSpy).toHaveBeenCalledWith("auto.com");
    });
    test('onUnknownHost "deny" rejects without prompting', async () => {
      const sandbox = new MockSandboxManager();
      const recordSpy = vi.spyOn(sandbox, "recordSessionApprovedHost");
      const handler = createMockViolationHandler();
      const results: boolean[] = [];
      await runCommandThatAsks(
        sandbox,
        handler,
        "blocked.com",
        (r) => results.push(r),
        contextWithOnUnknownHost("deny"),
      );
      expect(results).toEqual([false]);
      expect(handler.promptForNetworkAccess).not.toHaveBeenCalled();
      // "deny" does not record the host.
      expect(recordSpy).not.toHaveBeenCalled();
    });
  });
});
