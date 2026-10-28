import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import type { AbsFilePath } from "../utils/files.ts";
import { readGitStateAt } from "./git-client.ts";
import { LocalGitClient } from "./git-clients.ts";

const execFile = promisify(execFileCb);

async function git(projectDir: string, args: string[]): Promise<void> {
  await execFile(
    "git",
    ["-c", "user.email=test@test.com", "-c", "user.name=test", ...args],
    { cwd: projectDir },
  );
}

it("LocalGitClient reads branch, HEAD and changes from a real repo", async () => {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "magenta-git-")),
  );
  try {
    const client = new LocalGitClient();
    expect(await client.findRepoRoot(dir as AbsFilePath)).toBeUndefined();
    expect(await readGitStateAt(client, dir as AbsFilePath)).toBeUndefined();

    await fs.writeFile(path.join(dir, "poem.txt"), "roses\n");
    await git(dir, ["init", "-q"]);
    expect(await client.findRepoRoot(dir as AbsFilePath)).toBe(dir);
    await git(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    await git(dir, ["add", "poem.txt"]);
    await git(dir, ["commit", "-q", "-m", "initial commit"]);
    expect(await readGitStateAt(client, dir as AbsFilePath)).toMatchObject({
      repoRoot: dir,
      branch: "main",
      headSubject: "initial commit",
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
    });

    expect(
      await client.findRepoRoot(path.join(dir, "poem.txt") as AbsFilePath),
    ).toBe(dir);
    await git(dir, ["checkout", "-q", "-b", "feature"]);
    await fs.writeFile(path.join(dir, "poem.txt"), "violets\n");
    await fs.writeFile(path.join(dir, "new.txt"), "new\n");
    expect(await readGitStateAt(client, dir as AbsFilePath)).toMatchObject({
      branch: "feature",
      unstagedCount: 1,
      untrackedCount: 1,
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
