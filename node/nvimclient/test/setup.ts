import { realpathSync, rmSync } from "node:fs";
import * as path from "node:path";
import { threadId } from "node:worker_threads";
import { afterAll } from "vitest";

// Redirect magenta's scratch dir (thread archives, tool logs) into a per-worker
// temp dir so test runs don't pollute the developer's real archive. This must
// happen before any module reads MAGENTA_TEMP_DIR, and is inherited by the nvim
// processes each test spawns.
const workerTempDir = path.join(
  realpathSync("/tmp"),
  "magenta-test-runtime",
  // threadId distinguishes workers sharing a process in the threads pool.
  `${process.pid}-${threadId}`,
);
process.env.MAGENTA_TEMP_DIR = workerTempDir;

afterAll(() => {
  rmSync(workerTempDir, { recursive: true, force: true });
});
