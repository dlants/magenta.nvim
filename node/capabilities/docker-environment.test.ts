import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import { DockerFileIO } from "./docker-file-io.ts";
import { DockerShell } from "./docker-shell.ts";
import { createDockerEnvironment } from "../environment.ts";
import { getToolSpecs } from "@magenta/core";
import type { ThreadId } from "../chat/types.ts";
import type { MCPToolManager } from "@magenta/core";

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

const mockThreadId = "test-thread-docker" as ThreadId;

const mockMcpToolManager: MCPToolManager = {
  getToolSpecs: () => [],
};

describe.skipIf(!dockerAvailable)("Docker Environment", () => {
  let containerId: string;

  beforeAll(async () => {
    const { stdout } = await execFile("docker", [
      "run",
      "-d",
      "bash:latest",
      "tail",
      "-f",
      "/dev/null",
    ]);
    containerId = stdout.trim();
  }, 60_000);

  afterAll(async () => {
    if (containerId) {
      await execFile("docker", ["rm", "-f", containerId]).catch(() => {});
    }
  });

  describe("DockerFileIO", () => {
    it("supports full FileIO surface", async () => {
      const fileIO = new DockerFileIO({ container: containerId });

      // mkdir
      await fileIO.mkdir("/tmp/test-dir/nested");
      expect(await fileIO.fileExists("/tmp/test-dir/nested")).toBe(true);

      // fileExists returns false for missing paths
      expect(await fileIO.fileExists("/tmp/nonexistent-path")).toBe(false);

      // writeFile + readFile
      await fileIO.writeFile("/tmp/test-dir/hello.txt", "hello world");
      const content = await fileIO.readFile("/tmp/test-dir/hello.txt");
      expect(content).toBe("hello world");

      // readBinaryFile
      const binaryContent = "binary\x00test\x01data";
      await fileIO.writeFile("/tmp/test-dir/binary.bin", binaryContent);
      const buf = await fileIO.readBinaryFile("/tmp/test-dir/binary.bin");
      expect(Buffer.isBuffer(buf)).toBe(true);

      // stat returns mtimeMs for existing files
      const statResult = await fileIO.stat("/tmp/test-dir/hello.txt");
      expect(statResult).toBeDefined();
      expect(statResult!.mtimeMs).toBeGreaterThan(0);
      // Should be a recent timestamp (within last minute)
      const now = Date.now();
      expect(statResult!.mtimeMs).toBeGreaterThan(now - 60_000);
      expect(statResult!.mtimeMs).toBeLessThanOrEqual(now + 5_000);

      // stat returns undefined for nonexistent files
      const missingStatResult = await fileIO.stat("/tmp/nonexistent-file");
      expect(missingStatResult).toBeUndefined();
    });
  });

  describe("DockerShell", () => {
    it("supports full Shell surface", async () => {
      const shell = new DockerShell({
        container: containerId,
        cwd: "/tmp",
        threadId: mockThreadId,
      });

      // Basic command execution
      const echoResult = await shell.execute("echo hello", {
        toolRequestId: "test-echo",
      });
      expect(echoResult.exitCode).toBe(0);
      expect(echoResult.output.some((l) => l.text.includes("hello"))).toBe(
        true,
      );

      // Non-zero exit code
      const failResult = await shell.execute("exit 42", {
        toolRequestId: "test-fail",
      });
      expect(failResult.exitCode).toBe(42);

      // cwd is respected
      const pwdResult = await shell.execute("pwd", {
        toolRequestId: "test-pwd",
      });
      expect(pwdResult.output.some((l) => l.text.includes("/tmp"))).toBe(true);

      // logFilePath exists on host
      expect(echoResult.logFilePath).toBeDefined();
      expect(fs.existsSync(echoResult.logFilePath!)).toBe(true);
      const logContent = fs.readFileSync(echoResult.logFilePath!, "utf-8");
      expect(logContent).toContain("echo hello");
      expect(logContent).toContain("hello");
    });

    it("can terminate a running command", async () => {
      const shell = new DockerShell({
        container: containerId,
        cwd: "/tmp",
        threadId: mockThreadId,
      });

      const executePromise = shell.execute("sleep 60", {
        toolRequestId: "test-terminate",
        onStart: () => {
          setTimeout(() => shell.terminate(), 100);
        },
      });

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("terminate timed out")), 10_000),
      );

      const result = await Promise.race([executePromise, timeoutPromise]);
      expect(result.signal !== undefined || result.exitCode !== 0).toBe(true);
    });
  });

  describe("createDockerEnvironment", () => {
    it("resolves cwd and homeDir from container", async () => {
      const env = await createDockerEnvironment({
        container: containerId,
        threadId: mockThreadId,
      });
      // cwd and homeDir should be non-empty paths
      expect(env.cwd).toBeTruthy();
      expect(env.homeDir).toBeTruthy();
      expect(env.cwd.startsWith("/")).toBe(true);
      expect(env.homeDir.startsWith("/")).toBe(true);
    });

    it("uses provided cwd", async () => {
      const env = await createDockerEnvironment({
        container: containerId,
        cwd: "/tmp",
        threadId: mockThreadId,
      });
      expect(env.cwd).toBe("/tmp");
    });

    it("has correct capabilities", async () => {
      const env = await createDockerEnvironment({
        container: containerId,
        threadId: mockThreadId,
      });
      expect(env.availableCapabilities.has("file-io")).toBe(true);
      expect(env.availableCapabilities.has("shell")).toBe(true);
      expect(env.availableCapabilities.has("threads")).toBe(true);
      expect(env.availableCapabilities.has("lsp")).toBe(false);
      expect(env.availableCapabilities.has("diagnostics")).toBe(false);
    });

    it("stores environmentConfig", async () => {
      const env = await createDockerEnvironment({
        container: containerId,
        cwd: "/tmp",
        threadId: mockThreadId,
      });
      expect(env.environmentConfig).toEqual({
        type: "docker",
        container: containerId,
        cwd: "/tmp",
      });
    });

    it("has no permission wrappers", async () => {
      const env = await createDockerEnvironment({
        container: containerId,
        threadId: mockThreadId,
      });
      expect(env.permissionFileIO).toBeUndefined();
      expect(env.permissionShell).toBeUndefined();
    });
  });

  describe("Tool filtering", () => {
    it("excludes LSP and diagnostics tools for Docker capabilities", async () => {
      const env = await createDockerEnvironment({
        container: containerId,
        threadId: mockThreadId,
      });
      const specs = getToolSpecs(
        "root",
        mockMcpToolManager,
        env.availableCapabilities,
      );
      const toolNames = specs.map((s) => s.name);

      // Should include file, shell, and thread tools
      expect(toolNames).toContain("get_file");
      expect(toolNames).toContain("edl");
      expect(toolNames).toContain("bash_command");
      expect(toolNames).toContain("spawn_subagent");
      expect(toolNames).toContain("spawn_foreach");
      expect(toolNames).toContain("wait_for_subagents");

      // Should exclude LSP and diagnostics tools
      expect(toolNames).not.toContain("hover");
      expect(toolNames).not.toContain("find_references");
      expect(toolNames).not.toContain("diagnostics");
    });

    it("subagent tool list also excludes LSP and diagnostics", async () => {
      const env = await createDockerEnvironment({
        container: containerId,
        threadId: mockThreadId,
      });
      const specs = getToolSpecs(
        "subagent_default",
        mockMcpToolManager,
        env.availableCapabilities,
      );
      const toolNames = specs.map((s) => s.name);

      expect(toolNames).toContain("get_file");
      expect(toolNames).toContain("bash_command");
      expect(toolNames).toContain("yield_to_parent");
      expect(toolNames).not.toContain("hover");
      expect(toolNames).not.toContain("find_references");
      expect(toolNames).not.toContain("diagnostics");
    });
  });
});
