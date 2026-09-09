import { execFile as execFileCb, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { FileIO } from "@magenta/server";

const execFile = promisify(execFileCb);

export class DockerFileIO implements FileIO {
  private container: string;

  constructor({ container }: { container: string }) {
    this.container = container;
  }

  async readFile(path: string): Promise<string> {
    const { stdout } = await execFile("docker", [
      "exec",
      this.container,
      "cat",
      path,
    ]);
    return stdout;
  }

  async readBinaryFile(path: string): Promise<Buffer> {
    const { stdout } = await execFile(
      "docker",
      ["exec", this.container, "cat", path],
      { encoding: "buffer" },
    );
    return stdout;
  }

  async writeFile(path: string, content: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const proc = spawn(
        "docker",
        ["exec", "-i", this.container, "tee", path],
        {
          stdio: ["pipe", "ignore", "pipe"],
        },
      );
      let stderr = "";
      proc.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else
          reject(new Error(`docker exec tee failed (exit ${code}): ${stderr}`));
      });
      proc.on("error", reject);
      proc.stdin?.write(content);
      proc.stdin?.end();
    });
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      await execFile("docker", [
        "exec",
        this.container,
        "test",
        "-f",
        path,
        "-o",
        "-d",
        path,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string): Promise<void> {
    await execFile("docker", ["exec", this.container, "mkdir", "-p", path]);
  }

  async stat(
    path: string,
  ): Promise<{ mtimeMs: number; size: number } | undefined> {
    try {
      const { stdout } = await execFile("docker", [
        "exec",
        this.container,
        "stat",
        "-c",
        "%Y %s",
        path,
      ]);
      const parts = stdout.trim().split(" ");
      const seconds = parseInt(parts[0], 10);
      const size = parseInt(parts[1], 10);
      return { mtimeMs: seconds * 1000, size };
    } catch {
      return undefined;
    }
  }

  async readdir(path: string): Promise<string[]> {
    const { stdout } = await execFile("docker", [
      "exec",
      this.container,
      "ls",
      path,
    ]);
    return stdout.split("\n").filter((s) => s.length > 0);
  }

  async isDirectory(path: string): Promise<boolean> {
    try {
      await execFile("docker", ["exec", this.container, "test", "-d", path]);
      return true;
    } catch {
      return false;
    }
  }
}
