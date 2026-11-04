import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseWatcherManifest } from "../../../../node/server/src/watchers/protocol.ts";
import { poll, type RepoSnapshot, render, summarize } from "./git-repo.ts";

let tmp: string;
let repo: string;

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

async function snap(key: string): Promise<RepoSnapshot> {
  const r = await poll(key);
  if (r.kind !== "ok") throw new Error(`poll failed: ${JSON.stringify(r)}`);
  return r.snapshot;
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "git-watcher-")));
  repo = path.join(tmp, "repo");
  mkdirSync(path.join(repo, "sub"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(path.join(repo, "sub", "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "initial");
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("git-repo watcher", () => {
  it("normalizes subdirectory keys to the worktree root", async () => {
    const s = await snap(path.join(repo, "sub"));
    expect(s.root).toBe(repo);
    expect(render(s)).toContain("branch: main");
    expect(summarize(s).summary).toBe("main, clean");
  });

  it("non-repo path is unavailable", async () => {
    const dir = path.join(tmp, "plain");
    mkdirSync(dir);
    expect((await poll(dir)).kind).toBe("unavailable");
  });

  it("each git change alters the rendering; no change keeps it", async () => {
    const seen = [render(await snap(repo))];
    expect(render(await snap(repo))).toBe(seen[0]);
    const step = async (fn: () => void) => {
      fn();
      const r = render(await snap(repo));
      expect(seen).not.toContain(r);
      seen.push(r);
      return r;
    };
    expect(
      await step(() => writeFileSync(path.join(repo, "sub", "a.txt"), "b\n")),
    ).toContain("M sub/a.txt");
    expect(await step(() => git(repo, "add", "."))).toContain("staged (1)");
    expect(
      await step(() => git(repo, "commit", "-q", "-m", "second")),
    ).toContain("second");
    expect(
      await step(() => git(repo, "checkout", "-q", "-b", "feat")),
    ).toContain("branch: feat");
    expect(
      await step(() => writeFileSync(path.join(repo, "new.txt"), "x")),
    ).toContain("untracked (1)");
  });

  it("linked and main worktrees are separate keys", async () => {
    const wt = path.join(tmp, "wt");
    git(repo, "worktree", "add", "-q", "-b", "other", wt);
    writeFileSync(path.join(wt, "only-wt.txt"), "x");
    const main = await snap(repo);
    const linked = await snap(wt);
    expect(linked.root).toBe(wt);
    expect(linked.branch).toBe("other");
    expect(linked.untracked).toEqual(["only-wt.txt"]);
    expect(main.untracked).toEqual([]);
    expect(render(main)).toContain(`other worktrees (1):\n  ${wt}`);
  });

  it("trigger matches absolute paths under the configured root only", () => {
    const manifest = parseWatcherManifest(
      JSON.parse(
        readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
      ),
    );
    if (manifest.status !== "ok") throw new Error("bad manifest");
    const trigger = manifest.value.triggers[0];
    const re = new RegExp(trigger.pattern, trigger.flags);
    expect(re.exec("see /Users/me/src/magenta.nvim/node/x.ts")?.[0]).toBe(
      "/Users/me/src/magenta.nvim",
    );
    expect(re.exec("/tmp/src/foo")).toBeNull();
    expect(re.exec("/Users/me/Documents/foo")).toBeNull();
  });
});
