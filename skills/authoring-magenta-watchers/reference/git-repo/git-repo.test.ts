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
import {
  parseStatus,
  poll,
  type RepoSnapshot,
  render,
  summarize,
} from "./git-repo.ts";

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
    expect((await snap(path.join(repo, "does", "not", "exist.ts"))).root).toBe(
      repo,
    );
    const rel = await poll("relative/path");
    expect(rel.kind).toBe("unavailable");
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
    expect(linked.head).toMatchObject({ kind: "branch", name: "other" });
    expect(linked.untracked).toEqual(["only-wt.txt"]);
    expect(main.untracked).toEqual([]);
    expect(render(main)).toContain(`other worktrees (1):\n  ${wt}`);
  });

  it("trigger matches absolute paths under the configured root only", () => {
    const raw = JSON.parse(
      readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
    ) as { triggers: Array<{ pattern: string; flags?: string }> };
    const trigger = raw.triggers[0];
    const re = new RegExp(trigger.pattern, trigger.flags);
    expect(re.exec("see /Users/me/src/magenta.nvim/node/x.ts")?.[0]).toBe(
      "/Users/me/src/magenta.nvim",
    );
    expect(re.exec("/tmp/src/foo")).toBeNull();
    expect(re.exec("/Users/me/Documents/foo")).toBeNull();
  });

  it("parseStatus handles renames, conflicts, spaces and headers", () => {
    const out = [
      "# branch.oid (initial)",
      "# branch.head (detached)",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 aaa bbb dir/with space.txt",
      "2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt\told name.txt",
      "u UU N... 100644 100644 100644 100644 aaa bbb ccc con flict.txt",
      "? untracked file.txt",
      "",
    ].join("\n");
    expect(parseStatus(out)).toEqual({
      head: { kind: "detached", oid: "" },
      upstream: { name: "origin/main", ahead: 2, behind: 1 },
      staged: [{ path: "new name.txt", state: "R" }],
      unstaged: [{ path: "dir/with space.txt", state: "M" }],
      untracked: ["untracked file.txt"],
      conflicted: ["con flict.txt"],
    });
    expect(parseStatus("# branch.oid abc\n# branch.head main\n").head).toEqual({
      kind: "branch",
      name: "main",
      oid: "abc",
    });
  });

  it("detects a merge in progress, also inside a linked worktree", async () => {
    const wt = path.join(tmp, "wt");
    git(repo, "worktree", "add", "-q", "-b", "other", wt);
    for (const [dir, content] of [
      [wt, "wt\n"],
      [repo, "main\n"],
    ]) {
      writeFileSync(path.join(dir, "sub", "a.txt"), content);
      git(dir, "commit", "-q", "-am", `change in ${dir}`);
    }
    expect(() => git(wt, "merge", "-q", "main")).toThrow();
    const s = await snap(wt);
    expect(s.operation).toBe("merge");
    expect(s.conflicted).toEqual(["sub/a.txt"]);
    expect(summarize(s).summary).toContain("merge in progress");
    expect((await snap(repo)).operation).toBeUndefined();
  });

  it("renders upstream ahead/behind and detached HEAD", async () => {
    const bare = path.join(tmp, "bare.git");
    git(tmp, "clone", "-q", "--bare", repo, bare);
    git(repo, "remote", "add", "origin", bare);
    git(repo, "fetch", "-q", "origin");
    git(repo, "branch", "-q", "--set-upstream-to", "origin/main");
    writeFileSync(path.join(repo, "sub", "a.txt"), "c\n");
    git(repo, "commit", "-q", "-am", "ahead");
    let s = await snap(repo);
    expect(summarize(s).summary).toBe("main ↑1 ↓0, clean");
    expect(render(s)).toContain("upstream: origin/main ahead 1 behind 0");
    git(repo, "checkout", "-q", "--detach");
    s = await snap(repo);
    if (s.head.kind !== "detached") throw new Error("expected detached");
    expect(summarize(s).summary).toBe(
      `(detached ${s.head.oid.slice(0, 7)}), clean`,
    );
    expect(render(s)).toContain("branch: (detached)");
  });
});
