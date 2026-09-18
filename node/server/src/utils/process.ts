import type { spawn } from "node:child_process";

/** Terminate a detached child's whole process group, falling back to the
 * process itself when there is no pid (or no group). */
export function terminateProcess(childProcess: ReturnType<typeof spawn>): void {
  const pid = childProcess.pid;
  if (pid) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      childProcess.kill("SIGTERM");
    }
  } else {
    childProcess.kill("SIGTERM");
  }
}

export function escalateToSigkill(
  childProcess: ReturnType<typeof spawn>,
): void {
  const pid = childProcess.pid;
  if (pid) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      childProcess.kill("SIGKILL");
    }
  } else {
    childProcess.kill("SIGKILL");
  }
}
