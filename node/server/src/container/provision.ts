import { execFile as execFileCb } from "node:child_process";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ContainerConfig, ProvisionResult } from "./types.ts";

const execFile = promisify(execFileCb);

export async function provisionContainer({
  hostDir,
  containerConfig,
  onProgress,
}: {
  hostDir: string;
  containerConfig: ContainerConfig;
  onProgress?: (message: string) => void;
}): Promise<ProvisionResult> {
  const progress = onProgress ?? (() => {});
  const shortHash = crypto.randomBytes(4).toString("hex");
  const containerName = `magenta-worker-${shortHash}`;
  const imageName = `magenta-dev-${shortHash}`;

  const dockerfilePath = path.resolve(hostDir, containerConfig.dockerfile);

  progress("Building Docker image...");
  await execFile(
    "docker",
    ["build", "-t", imageName, "-f", dockerfilePath, hostDir],
    { timeout: 600_000 },
  );

  progress("Starting container...");
  await execFile("docker", ["run", "-d", "--name", containerName, imageName]);

  return {
    containerName,
    imageName,
  };
}
