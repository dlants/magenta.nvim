import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { PollResult } from "../../../../sdk/watchers/index.ts";

export type FileChange = { path: string; state: string };

export type RepoSnapshot = {
  root: string;
  branch: string | undefined;
  head: string | undefined;
  headSubject: string | undefined;
  upstream: string | undefined;
  ahead: number;
  behind: number;
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: string[];
  conflicted: string[];
  operation: string | undefined;
  worktrees: string[];
};

function git(
  cwd: string,
  args: string[],
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) resolve({ ok: false, error: (stderr || err.message).trim() });
        else resolve({ ok: true, stdout });
      },
    );
  });
}

/** Key is any path inside a worktree; normalizes to the worktree root. */
export async function resolveRoot(
  key: string,
): Promise<{ ok: true; root: string } | { ok: false; error: string }> {
  if (!path.isAbsolute(key))
    return { ok: false, error: "key must be absolute" };
  let dir = key;
  while (!existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) return { ok: false, error: "path does not exist" };
    dir = parent;
  }
  const res = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (!res.ok) return { ok: false, error: `not a git repo: ${res.error}` };
  return { ok: true, root: res.stdout.trim() };
}

export function parseStatus(
  out: string,
): Pick<
  RepoSnapshot,
  | "branch"
  | "head"
  | "upstream"
  | "ahead"
  | "behind"
  | "staged"
  | "unstaged"
  | "untracked"
  | "conflicted"
> {
  const s: ReturnType<typeof parseStatus> = {
    branch: undefined,
    head: undefined,
    upstream: undefined,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };
  for (const line of out.split("\n")) {
    if (line.startsWith("# branch.oid ")) {
      const oid = line.slice(13);
      s.head = oid === "(initial)" ? undefined : oid;
    } else if (line.startsWith("# branch.head ")) {
      const h = line.slice(14);
      s.branch = h === "(detached)" ? undefined : h;
    } else if (line.startsWith("# branch.upstream ")) {
      s.upstream = line.slice(18);
    } else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        s.ahead = Number(m[1]);
        s.behind = Number(m[2]);
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const parts = line.split(" ");
      const xy = parts[1];
      // type 2 has an extra score field; path is followed by \t<origPath>
      const p = parts
        .slice(line.startsWith("1 ") ? 8 : 9)
        .join(" ")
        .split("\t")[0];
      if (xy[0] !== ".") s.staged.push({ path: p, state: xy[0] });
      if (xy[1] !== ".") s.unstaged.push({ path: p, state: xy[1] });
    } else if (line.startsWith("u ")) {
      s.conflicted.push(line.split(" ").slice(10).join(" "));
    } else if (line.startsWith("? ")) {
      s.untracked.push(line.slice(2));
    }
  }
  return s;
}

async function detectOperation(root: string): Promise<string | undefined> {
  const res = await git(root, ["rev-parse", "--git-dir"]);
  if (!res.ok) return undefined;
  const gitDir = path.resolve(root, res.stdout.trim());
  const markers: [string, string][] = [
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["BISECT_LOG", "bisect"],
  ];
  return markers.find(([f]) => existsSync(path.join(gitDir, f)))?.[1];
}

export async function poll(key: string): Promise<PollResult<RepoSnapshot>> {
  const resolved = await resolveRoot(key);
  if (!resolved.ok) return { kind: "unavailable", error: resolved.error };
  const root = resolved.root;
  const [status, subject, worktrees, operation] = await Promise.all([
    git(root, ["status", "--porcelain=v2", "--branch"]),
    git(root, ["log", "-1", "--format=%s"]),
    git(root, ["worktree", "list", "--porcelain"]),
    detectOperation(root),
  ]);
  if (!status.ok) return { kind: "error", error: status.error };
  return {
    kind: "ok",
    snapshot: {
      root,
      ...parseStatus(status.stdout),
      headSubject: subject.ok ? subject.stdout.trim() || undefined : undefined,
      operation,
      worktrees: worktrees.ok
        ? worktrees.stdout
            .split("\n")
            .filter((l) => l.startsWith("worktree "))
            .map((l) => l.slice(9))
        : [],
    },
  };
}

function fileLines(label: string, files: string[]): string[] {
  if (files.length === 0) return [];
  return [`${label} (${files.length}):`, ...files.map((f) => `  ${f}`)];
}

export function render(s: RepoSnapshot): string {
  const lines = [
    `repo: ${s.root}`,
    `branch: ${s.branch ?? "(detached)"}`,
    `head: ${s.head ? s.head.slice(0, 12) : "(none)"}${s.headSubject ? ` ${s.headSubject}` : ""}`,
    s.upstream
      ? `upstream: ${s.upstream} ahead ${s.ahead} behind ${s.behind}`
      : "upstream: (none)",
  ];
  if (s.operation) lines.push(`in progress: ${s.operation}`);
  lines.push(
    ...fileLines("conflicted", s.conflicted),
    ...fileLines(
      "staged",
      s.staged.map((f) => `${f.state} ${f.path}`),
    ),
    ...fileLines(
      "unstaged",
      s.unstaged.map((f) => `${f.state} ${f.path}`),
    ),
    ...fileLines("untracked", s.untracked),
  );
  const others = s.worktrees.filter((w) => w !== s.root);
  lines.push(...fileLines("other worktrees", others));
  return lines.join("\n");
}

export function summarize(s: RepoSnapshot): {
  summary: string;
  details?: string;
} {
  const dirty =
    s.staged.length +
    s.unstaged.length +
    s.untracked.length +
    s.conflicted.length;
  const parts = [s.branch ?? `(detached ${s.head?.slice(0, 7) ?? ""})`];
  if (s.upstream) parts.push(`↑${s.ahead} ↓${s.behind}`);
  let summary = `${parts.join(" ")}, ${dirty === 0 ? "clean" : `${dirty} dirty`}`;
  if (s.operation) summary += `, ${s.operation} in progress`;
  return { summary, details: render(s) };
}
