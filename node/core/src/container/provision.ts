import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { ContainerConfig, ProvisionResult } from "./types.ts";

const execFile = promisify(execFileCb);

const TEMP_BASE = "/tmp/magenta-dev-containers";

export async function provisionContainer({
  repoPath,
  branch,
  baseBranch = "main",
  containerConfig,
}: {
  repoPath: string;
  branch: string;
  baseBranch?: string;
  containerConfig: ContainerConfig;
}): Promise<ProvisionResult> {
  const shortHash = crypto.randomBytes(4).toString("hex");
  const safeBranch = branch.replace(/[^a-zA-Z0-9_-]/g, "-");
  const containerName = `magenta-${safeBranch}-${shortHash}`;
  const tempDir = path.join(TEMP_BASE, containerName);
  const repoDir = path.join(tempDir, "repo");

  await fs.promises.mkdir(repoDir, { recursive: true });

  // Clone the repo locally (hardlinks for speed)
  await execFile("git", ["clone", "--local", repoPath, repoDir]);

  // Check if branch exists in the clone
  const { exitCode: branchExists } = await execFile("git", [
    "-C",
    repoDir,
    "rev-parse",
    "--verify",
    branch,
  ]).then(
    () => ({ exitCode: 0 }),
    () => ({ exitCode: 1 }),
  );

  if (branchExists === 0) {
    await execFile("git", ["-C", repoDir, "checkout", branch]);
  } else {
    await execFile("git", [
      "-C",
      repoDir,
      "checkout",
      "-b",
      branch,
      baseBranch,
    ]);
  }

  // Remove remote so the agent can't push
  await execFile("git", ["-C", repoDir, "remote", "remove", "origin"]);

  // Build the Docker image
  const dockerfilePath = path.join(repoPath, containerConfig.devcontainer);
  const dockerContext = path.dirname(dockerfilePath);
  const imageName = `magenta-dev-${safeBranch}`;

  await execFile(
    "docker",
    ["build", "-t", imageName, "-f", dockerfilePath, dockerContext],
    { timeout: 600_000 },
  );

  // Prepare docker run args
  const runArgs = [
    "run",
    "-d",
    "--name",
    containerName,
    "-v",
    `${repoDir}:${containerConfig.workspacePath}`,
  ];

  // Add volume overlays to isolate platform-specific dirs
  if (containerConfig.volumeOverlays) {
    for (const overlay of containerConfig.volumeOverlays) {
      const volumeName = `${containerName}-${overlay.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
      const mountPath = path.posix.join(containerConfig.workspacePath, overlay);
      runArgs.push("-v", `${volumeName}:${mountPath}`);
    }
  }

  runArgs.push(imageName);
  await execFile("docker", runArgs);

  // Run install command inside the container
  await execFile(
    "docker",
    [
      "exec",
      "-w",
      containerConfig.workspacePath,
      containerName,
      "sh",
      "-c",
      containerConfig.installCommand,
    ],
    { timeout: 300_000 },
  );

  return { containerName, tempDir, imageName };
}
