import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { provisionContainer } from "./provision.ts";
import { teardownContainer } from "./teardown.ts";
import type { ContainerConfig } from "./types.ts";

const execFile = promisify(execFileCb);

async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFile("docker", ["info"]);
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)("Container Provisioning", () => {
  let sourceRepo: string;
  let result:
    | { containerName: string; tempDir: string; imageName: string }
    | undefined;

  const containerConfig: ContainerConfig = {
    devcontainer: "Dockerfile",
    workspacePath: "/workspace",
    installCommand: "echo install-done",
    volumeOverlays: ["test-overlay"],
  };

  beforeAll(async () => {
    // Create a minimal git repo as the "source project"
    sourceRepo = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "magenta-test-repo-"),
    );
    await execFile("git", ["-C", sourceRepo, "init", "-b", "main"]);
    await execFile("git", ["-C", sourceRepo, "config", "user.name", "test"]);
    await execFile("git", [
      "-C",
      sourceRepo,
      "config",
      "user.email",
      "test@test.com",
    ]);

    // Create a minimal Dockerfile in the source repo
    const dockerfile = [
      "FROM alpine:latest",
      "RUN apk add --no-cache git",
      'RUN git config --global user.name "test" && git config --global user.email "test@test"',
      'CMD ["tail", "-f", "/dev/null"]',
    ].join("\n");
    await fs.promises.writeFile(
      path.join(sourceRepo, "Dockerfile"),
      dockerfile,
    );
    await fs.promises.writeFile(
      path.join(sourceRepo, "hello.txt"),
      "hello from source",
    );

    await execFile("git", ["-C", sourceRepo, "add", "."]);
    await execFile("git", ["-C", sourceRepo, "commit", "-m", "initial commit"]);
  }, 30_000);

  afterAll(async () => {
    // Clean up container if provisioned
    if (result) {
      await execFile("docker", ["rm", "-f", result.containerName]).catch(
        () => {},
      );
      // Clean up volume overlays
      const volumeName = `${result.containerName}-test-overlay`;
      await execFile("docker", ["volume", "rm", volumeName]).catch(() => {});
      await fs.promises.rm(result.tempDir, { recursive: true, force: true });
    }
    // Clean up source repo
    if (sourceRepo) {
      await fs.promises.rm(sourceRepo, { recursive: true, force: true });
    }
  });

  it("provisions a container with a cloned repo", async () => {
    result = await provisionContainer({
      repoPath: sourceRepo,
      branch: "test-branch",
      containerConfig,
    });

    expect(result.containerName).toMatch(/^magenta-test-branch-/);
    expect(result.tempDir).toContain("magenta-dev-containers");

    // Container should be running
    const { stdout: status } = await execFile("docker", [
      "inspect",
      "-f",
      "{{.State.Running}}",
      result.containerName,
    ]);
    expect(status.trim()).toBe("true");

    // Repo should be mounted and accessible
    const { stdout: content } = await execFile("docker", [
      "exec",
      result.containerName,
      "cat",
      "/workspace/hello.txt",
    ]);
    expect(content.trim()).toBe("hello from source");

    // Branch should exist in the clone
    const { stdout: branchOutput } = await execFile("docker", [
      "exec",
      "-w",
      "/workspace",
      result.containerName,
      "git",
      "branch",
      "--show-current",
    ]);
    expect(branchOutput.trim()).toBe("test-branch");

    // Remote should be removed
    const { stdout: remotes } = await execFile("docker", [
      "exec",
      "-w",
      "/workspace",
      result.containerName,
      "git",
      "remote",
    ]);
    expect(remotes.trim()).toBe("");
  }, 120_000);

  it("tears down and fetches the branch back", async () => {
    expect(result).toBeDefined();
    const r = result!;

    // Make a commit inside the container
    await execFile("docker", [
      "exec",
      "-w",
      "/workspace",
      r.containerName,
      "sh",
      "-c",
      'git config user.name "agent" && git config user.email "agent@test" && echo "agent change" > agent.txt && git add . && git commit -m "agent commit"',
    ]);

    const containerName = r.containerName;
    const tempDir = r.tempDir;

    await teardownContainer({
      containerName,
      repoPath: sourceRepo,
      branch: "test-branch",
      tempDir,
      volumeOverlays: containerConfig.volumeOverlays,
    });

    // Prevent afterAll from trying to clean up again
    result = undefined;

    // Container should be gone
    const inspectResult = await execFile("docker", [
      "inspect",
      containerName,
    ]).then(
      () => "exists",
      () => "gone",
    );
    expect(inspectResult).toBe("gone");

    // Branch should be fetched back into the source repo
    const { stdout: logOutput } = await execFile("git", [
      "-C",
      sourceRepo,
      "log",
      "--oneline",
      "test-branch",
    ]);
    expect(logOutput).toContain("agent commit");

    // Temp directory should be gone
    expect(fs.existsSync(tempDir)).toBe(false);
  }, 60_000);

  it("fails teardown on diverged branch without force", async () => {
    // Provision again
    result = await provisionContainer({
      repoPath: sourceRepo,
      branch: "diverge-test",
      containerConfig,
    });

    // Make a commit in the container clone
    await execFile("docker", [
      "exec",
      "-w",
      "/workspace",
      result.containerName,
      "sh",
      "-c",
      'git config user.name "agent" && git config user.email "agent@test" && echo "clone change" > clone.txt && git add . && git commit -m "clone commit"',
    ]);

    // Make a diverging commit in the source repo on the same branch
    await execFile("git", ["-C", sourceRepo, "checkout", "-b", "diverge-test"]);
    await fs.promises.writeFile(
      path.join(sourceRepo, "source-change.txt"),
      "source change",
    );
    await execFile("git", ["-C", sourceRepo, "add", "."]);
    await execFile("git", ["-C", sourceRepo, "commit", "-m", "source diverge"]);

    // Go back to main so later tests can create branches from it
    await execFile("git", ["-C", sourceRepo, "checkout", "main"]);
    // Teardown without force should fail
    await expect(
      teardownContainer({
        containerName: result.containerName,
        repoPath: sourceRepo,
        branch: "diverge-test",
        tempDir: result.tempDir,
        volumeOverlays: containerConfig.volumeOverlays,
      }),
    ).rejects.toThrow("diverged");

    // Note: container was already removed by teardown's first step.
    // But temp dir should still exist since teardown threw before cleanup.
    expect(fs.existsSync(result.tempDir)).toBe(true);

    // Clean up manually
    await fs.promises.rm(result.tempDir, { recursive: true, force: true });
    const volumeName = `${result.containerName}-test-overlay`;
    await execFile("docker", ["volume", "rm", volumeName]).catch(() => {});
    result = undefined;
  }, 120_000);

  it("succeeds teardown on diverged branch with force", async () => {
    // Provision again
    result = await provisionContainer({
      repoPath: sourceRepo,
      branch: "force-test",
      containerConfig,
    });

    // Make a commit in the container clone
    await execFile("docker", [
      "exec",
      "-w",
      "/workspace",
      result.containerName,
      "sh",
      "-c",
      'git config user.name "agent" && git config user.email "agent@test" && echo "clone change" > clone.txt && git add . && git commit -m "clone commit"',
    ]);

    // Make a diverging commit in the source repo
    await execFile("git", ["-C", sourceRepo, "checkout", "-b", "force-test"]);
    await fs.promises.writeFile(
      path.join(sourceRepo, "source-force.txt"),
      "source",
    );
    await execFile("git", ["-C", sourceRepo, "add", "."]);
    await execFile("git", ["-C", sourceRepo, "commit", "-m", "source diverge"]);

    // Go back to main so fetch into force-test can succeed
    await execFile("git", ["-C", sourceRepo, "checkout", "main"]);
    const containerName = result.containerName;
    const tempDir = result.tempDir;

    // Teardown with force should succeed
    await teardownContainer({
      containerName,
      repoPath: sourceRepo,
      branch: "force-test",
      tempDir,
      volumeOverlays: containerConfig.volumeOverlays,
      force: true,
    });

    result = undefined;

    // Branch should exist with the clone's commit
    const { stdout: logOutput } = await execFile("git", [
      "-C",
      sourceRepo,
      "log",
      "--oneline",
      "force-test",
    ]);
    expect(logOutput).toContain("clone commit");

    // Temp dir should be gone
    expect(fs.existsSync(tempDir)).toBe(false);
  }, 120_000);
});
