import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import type { ThreadId } from "@magenta/server";
import { expect, it } from "vitest";
import { parseOptions } from "../options.ts";
import type { Sandbox } from "../sandbox-manager.ts";
import { pollUntil } from "../utils/async.ts";
import type { HomeDir, NvimCwd } from "../utils/files.ts";
import { SandboxShell } from "./sandbox-shell.ts";
import { SandboxViolationHandler } from "./sandbox-violation-handler.ts";
import type { OutputLine } from "./shell.ts";

/** A ready sandbox that runs commands unwrapped, so the real process
 * lifecycle (spawn, log file, termination) is exercised without nvim. */
const passthroughSandbox: Sandbox = {
  getState: () => ({ status: "ready" }),
  wrapWithSandbox: (command: string) => Promise.resolve(command),
  getViolationStore: () => ({
    getTotalCount: () => 0,
    getViolations: () => [],
    addViolation: () => {},
  }),
  annotateStderrWithSandboxFailures: (_command: string, stderr: string) =>
    stderr,
  cleanupAfterCommand: () => {},
  getFsReadConfig: () => ({ denyOnly: [] }),
  getFsWriteConfig: () => ({ allowOnly: ["/"], denyWithinAllow: [] }),
  updateConfigIfChanged: () => {},
  pushNetworkAskTarget: () => {},
  popNetworkAskTarget: () => {},
  routeNetworkAsk: () => Promise.resolve(false),
  recordSessionApprovedHost: () => {},
};

const options = parseOptions(
  { profiles: [{ name: "mock", provider: "mock", model: "mock" }] },
  { warn: () => {}, error: () => {} },
);

function createShell() {
  return new SandboxShell(
    {
      cwd: os.tmpdir() as NvimCwd,
      homeDir: os.homedir() as HomeDir,
      threadId: `shell-node-${process.pid}` as ThreadId,
      getOptions: () => options,
      isBypassed: () => false,
    },
    passthroughSandbox,
    new SandboxViolationHandler(() => {}),
  );
}

function isRunning(pid: number): boolean {
  const stat = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
    encoding: "utf-8",
    stdio: "pipe",
  });
  if (stat.status !== 0) return false;
  const state = stat.stdout.trim().charAt(0);
  return state !== "" && state !== "Z" && state !== "X";
}

/** Start `command`, wait for every `label: <pid>` line, then return the pids. */
async function startAndCollectPids(
  shell: SandboxShell,
  command: string,
  labels: string[],
  toolRequestId: string,
) {
  const lines: OutputLine[] = [];
  const result = shell.execute(command, {
    toolRequestId,
    onOutput: (line) => lines.push(line),
  });
  const pids = await pollUntil(
    () =>
      labels.map((label) => {
        const match = lines
          .map((l) => l.text.match(new RegExp(`${label}: (\\d+)`)))
          .find(Boolean);
        if (!match) throw new Error(`waiting for ${label}`);
        return Number.parseInt(match[1], 10);
      }),
    { timeout: 5000 },
  );
  return { result, pids };
}

it("creates log file with command and output", async () => {
  const result = await createShell().execute('echo "line1" && echo "line2"', {
    toolRequestId: "test-log-file",
  });
  expect(result.exitCode).toBe(0);
  if (!result.logFilePath) throw new Error("expected a log file");
  const logFilePath = result.logFilePath;
  // The log stream flushes asynchronously after the process closes.
  const log = await pollUntil(() => {
    const text = fs.readFileSync(logFilePath, "utf8");
    if (!text.includes("exit code")) throw new Error("log not flushed");
    return text;
  });
  expect(log).toContain('$ echo "line1" && echo "line2"');
  expect(log).toContain("stdout:");
  expect(log).toContain("line1");
  expect(log).toContain("line2");
  expect(log).toContain("exit code 0");
});

it("terminates process with SIGTERM", async () => {
  const shell = createShell();
  const { result, pids } = await startAndCollectPids(
    shell,
    'echo "pid: $$" && sleep 60',
    ["pid"],
    "test-bash-sigterm",
  );
  expect(isRunning(pids[0])).toBe(true);
  shell.terminate();
  await result;
  await pollUntil(
    () => {
      if (isRunning(pids[0])) throw new Error("still running");
    },
    { timeout: 3000 },
  );
});

it("escalates to SIGKILL when process ignores SIGTERM", async () => {
  const shell = createShell();
  const { result, pids } = await startAndCollectPids(
    shell,
    `bash -c 'trap "" TERM; echo "pid: $$"; while true; do sleep 1; done'`,
    ["pid"],
    "test-bash-sigkill",
  );
  expect(isRunning(pids[0])).toBe(true);
  shell.terminate();
  await result;
  await pollUntil(
    () => {
      if (isRunning(pids[0])) throw new Error("still running");
    },
    { timeout: 5000 },
  );
});

it("kills entire process tree including child processes", async () => {
  const shell = createShell();
  const { result, pids } = await startAndCollectPids(
    shell,
    `bash -c '
echo "parent: $$"
bash -c "echo child1: \\$\\$; sleep 60" &
bash -c "echo child2: \\$\\$; sleep 60" &
wait
'`,
    ["parent", "child1", "child2"],
    "test-bash-tree",
  );
  for (const pid of pids) expect(isRunning(pid)).toBe(true);
  shell.terminate();
  await result;
  await pollUntil(
    () => {
      const alive = pids.filter(isRunning);
      if (alive.length) throw new Error(`still running: ${alive.join(",")}`);
    },
    { timeout: 5000 },
  );
});
