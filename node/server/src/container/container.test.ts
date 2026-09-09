import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionContainer } from "./provision.ts";
import { teardownContainer } from "./teardown.ts";
import type { ContainerConfig } from "./types.ts";

const execFile = promisify(execFileCb);

describe("Container Provisioning", () => {
  let hostDir: string;
  let result: { containerName: string; imageName: string } | undefined;

  const containerConfig: ContainerConfig = {
    dockerfile: "Dockerfile",
    workspacePath: "/workspace",
  };

  beforeAll(async () => {
    hostDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "magenta-test-host-"),
    );

    const dockerfile = [
      "FROM alpine:latest",
      "WORKDIR /workspace",
      "COPY . .",
      'CMD ["tail", "-f", "/dev/null"]',
    ].join("\n");
    await fs.promises.writeFile(path.join(hostDir, "Dockerfile"), dockerfile);
    await fs.promises.writeFile(
      path.join(hostDir, "hello.txt"),
      "hello from host",
    );

    // Create a .dockerignore to test exclusion
    await fs.promises.writeFile(
      path.join(hostDir, ".dockerignore"),
      "node_modules\n.git\n",
    );
  }, 30_000);

  afterAll(async () => {
    if (result) {
      await execFile("docker", ["rm", "-f", result.containerName]).catch(
        () => {},
      );
    }
    if (hostDir) {
      await fs.promises.rm(hostDir, { recursive: true, force: true });
    }
  });

  it("provisions a container with project files baked in", async () => {
    result = await provisionContainer({
      hostDir,
      containerConfig,
    });

    expect(result.containerName).toMatch(/^magenta-worker-/);
    expect(result.imageName).toMatch(/^magenta-dev-/);

    // Container should be running
    const { stdout: status } = await execFile("docker", [
      "inspect",
      "-f",
      "{{.State.Running}}",
      result.containerName,
    ]);
    expect(status.trim()).toBe("true");

    // Project files should be baked into the image
    const { stdout: content } = await execFile("docker", [
      "exec",
      result.containerName,
      "cat",
      "/workspace/hello.txt",
    ]);
    expect(content.trim()).toBe("hello from host");
  }, 120_000);

  it("tears down and syncs changed files back", async () => {
    expect(result).toBeDefined();
    const r = result!;

    // Make changes inside the container
    await execFile("docker", [
      "exec",
      "-w",
      "/workspace",
      r.containerName,
      "sh",
      "-c",
      'echo "new file from agent" > agent.txt && echo "modified" > hello.txt && mkdir -p node_modules && echo "should be excluded" > node_modules/foo.js',
    ]);

    const containerName = r.containerName;

    const teardownResult = await teardownContainer({
      containerName,
      workspacePath: containerConfig.workspacePath,
      hostDir,
    });

    result = undefined;

    expect(teardownResult.syncedFiles).toBeGreaterThanOrEqual(0);

    // Container should be gone
    const inspectResult = await execFile("docker", [
      "inspect",
      containerName,
    ]).then(
      () => "exists",
      () => "gone",
    );
    expect(inspectResult).toBe("gone");

    // New file should appear on host
    const agentContent = await fs.promises.readFile(
      path.join(hostDir, "agent.txt"),
      "utf-8",
    );
    expect(agentContent.trim()).toBe("new file from agent");

    // Modified file should be updated
    const helloContent = await fs.promises.readFile(
      path.join(hostDir, "hello.txt"),
      "utf-8",
    );
    expect(helloContent.trim()).toBe("modified");

    // node_modules should NOT be synced back (excluded by .dockerignore)
    expect(fs.existsSync(path.join(hostDir, "node_modules", "foo.js"))).toBe(
      false,
    );
  }, 60_000);
});
