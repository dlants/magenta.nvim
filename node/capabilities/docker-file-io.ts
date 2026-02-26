import { execFile as execFileCb, spawn } from "child_process";
import { promisify } from "util";
import type { FileIO } from "@magenta/core";

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

  async stat(path: string): Promise<{ mtimeMs: number } | undefined> {
    try {
      const { stdout } = await execFile("docker", [
        "exec",
        this.container,
        "stat",
        "-c",
        "%Y",
        path,
      ]);
      const seconds = parseInt(stdout.trim(), 10);
      return { mtimeMs: seconds * 1000 };
    } catch {
      return undefined;
    }
  }
}
