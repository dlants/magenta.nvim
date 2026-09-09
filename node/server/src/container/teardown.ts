import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { TeardownResult } from "./types.ts";

const execFile = promisify(execFileCb);

export async function teardownContainer({
  containerName,
  workspacePath,
  hostDir,
  onProgress,
}: {
  containerName: string;
  workspacePath: string;
  hostDir: string;
  onProgress?: (message: string) => void;
}): Promise<TeardownResult> {
  const progress = onProgress ?? (() => {});

  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "magenta-teardown-"),
  );

  try {
    progress("Copying files from container...");
    const containerSrc = `${containerName}:${workspacePath}/.`;
    const tempDest = path.join(tempDir, "workspace");
    await fs.promises.mkdir(tempDest, { recursive: true });
    await execFile("docker", ["cp", containerSrc, tempDest]);

    progress("Syncing files to host directory...");
    const rsyncArgs = ["-a", "--delete", "--exclude=.magenta/options.json"];

    const dockerignorePath = path.join(hostDir, ".dockerignore");
    try {
      await fs.promises.access(dockerignorePath);
      rsyncArgs.push(`--exclude-from=${dockerignorePath}`);
    } catch {
      // no .dockerignore, sync everything
    }

    // trailing slash on source is important for rsync
    rsyncArgs.push(`${tempDest}/`, `${hostDir}/`);

    const { stdout } = await execFile("rsync", rsyncArgs);
    const syncedFiles = stdout
      .split("\n")
      .filter((line) => line.length > 0).length;

    progress("Removing container...");
    await execFile("docker", ["rm", "-f", containerName]).catch(() => {});

    return { syncedFiles };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}
