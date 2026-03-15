import { spawn } from "node:child_process";

export type SkillResult = {
  status: "ok" | "error";
  value?: string | undefined;
  error?: string | undefined;
};

export function executeSkill(
  command: string[],
  input: Record<string, unknown>,
): Promise<SkillResult> {
  return new Promise((resolve) => {
    const args = [...command.slice(1), JSON.stringify(input)];
    const proc = spawn(command[0], args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("error", (err: Error) => {
      resolve({
        status: "error",
        error: `Failed to spawn skill process: ${err.message}`,
      });
    });

    proc.on("close", (code: number | null) => {
      if (code !== 0) {
        resolve({
          status: "error",
          error: `Skill process exited with code ${code ?? "unknown"}${stderr ? `\nstderr: ${stderr}` : ""}`,
        });
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as Record<string, unknown>;
        if (parsed.status === "ok" || parsed.status === "error") {
          resolve({
            status: parsed.status,
            value: typeof parsed.value === "string" ? parsed.value : undefined,
            error: typeof parsed.error === "string" ? parsed.error : undefined,
          });
        } else {
          resolve({
            status: "ok",
            value: stdout.trim(),
          });
        }
      } catch {
        resolve({
          status: "ok",
          value: stdout.trim(),
        });
      }
    });
  });
}

export function getSkillDocs(command: string[]): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(command[0], command.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.on("error", (err: Error) => {
      resolve(`Failed to get skill docs: ${err.message}`);
    });

    proc.on("close", () => {
      resolve(stdout.trim());
    });
  });
}
