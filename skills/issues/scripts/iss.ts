// Issue tracker CLI. Source of truth is `<root>/issues/<id>/{meta.json,content.md}`
// in a git repo; `<root>/.cache.db` is a gitignored sqlite index derived from it.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

const ROOT = path.resolve(
  process.env.MAGENTA_ISSUES_DIR ?? path.join(os.homedir(), ".magenta-issues"),
);
const ISSUES = path.join(ROOT, "issues");
const CACHE = path.join(ROOT, ".cache.db");
const SCHEMA_VERSION = "1";

type Status = "open" | "in_progress" | "done" | "wontfix";

type Meta = {
  id: string;
  project: string;
  title: string;
  summary: string;
  status: Status;
  parent: string | null;
  blockedOn: string[];
  assignee: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

type Row = Omit<Meta, "blockedOn" | "archived"> & { archived: number };

class UsageError extends Error {}

function git(...args: string[]): string {
  return execFileSync("git", ["-C", ROOT, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function tryGit(...args: string[]): string | undefined {
  try {
    return git(...args);
  } catch {
    return undefined;
  }
}

const metaPath = (id: string) => path.join(ISSUES, id, "meta.json");
const contentPath = (id: string) => path.join(ISSUES, id, "content.md");

function readMeta(id: string): Meta | undefined {
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), "utf8")) as Meta;
  } catch {
    return undefined;
  }
}

function writeMeta(meta: Meta): void {
  const file = metaPath(meta.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// --- cache ---

function openCache(): DatabaseSync {
  if (!fs.existsSync(path.join(ROOT, ".git")))
    throw new UsageError(`${ROOT} is not initialized; run \`iss init\``);
  const db = new DatabaseSync(CACHE, { timeout: 5000 });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS issues (
      id TEXT PRIMARY KEY, project TEXT, title TEXT, summary TEXT, status TEXT,
      parent TEXT, assignee TEXT, archived INTEGER, createdAt TEXT, updatedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS blocks (
      issue_id TEXT, blocked_on TEXT, PRIMARY KEY (issue_id, blocked_on)
    );
    CREATE INDEX IF NOT EXISTS issues_parent ON issues(parent);
    CREATE INDEX IF NOT EXISTS blocks_on ON blocks(blocked_on);
  `);
  return db;
}

const db = (() => {
  try {
    return process.argv[2] === "init" ? undefined : openCache();
  } catch (e) {
    console.error(`iss: ${(e as Error).message}`);
    process.exit(1);
  }
})() as DatabaseSync;

function getState(key: string): string | undefined {
  const row = db.prepare("SELECT value FROM state WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function setState(key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)").run(
    key,
    value,
  );
}

function indexIssue(id: string): void {
  db.prepare("DELETE FROM issues WHERE id = ?").run(id);
  db.prepare("DELETE FROM blocks WHERE issue_id = ?").run(id);
  const meta = readMeta(id);
  if (!meta) return;
  db.prepare(
    `INSERT INTO issues (id, project, title, summary, status, parent, assignee, archived, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    meta.id,
    meta.project,
    meta.title,
    meta.summary,
    meta.status,
    meta.parent,
    meta.assignee,
    meta.archived ? 1 : 0,
    meta.createdAt,
    meta.updatedAt,
  );
  for (const b of meta.blockedOn)
    db.prepare("INSERT OR IGNORE INTO blocks VALUES (?, ?)").run(meta.id, b);
}

function idsFromPaths(paths: Iterable<string>): Set<string> {
  const ids = new Set<string>();
  for (const p of paths) {
    const m = /^issues\/([^/]+)\//.exec(p);
    if (m) ids.add(m[1]);
  }
  return ids;
}

function fullRebuild(): void {
  db.exec("DELETE FROM issues; DELETE FROM blocks;");
  const ids = fs.existsSync(ISSUES) ? fs.readdirSync(ISSUES) : [];
  for (const id of ids) indexIssue(id);
}

/** Re-index only issues touched since the last sync: committed changes since the
 * recorded HEAD, current working-tree changes, and the previous dirty set (so a
 * reverted edit is re-read). Must run inside a transaction. */
function sync(): void {
  const head = tryGit("rev-parse", "--verify", "-q", "HEAD")?.trim() || null;
  const dirty = git("status", "--porcelain", "-uall", "-z", "--", "issues")
    .split("\0")
    .filter(Boolean)
    .map((entry) =>
      entry.length > 3 && entry[2] === " " ? entry.slice(3) : entry,
    );

  const indexedHead = getState("indexed_head") ?? null;
  const prevDirty: string[] = JSON.parse(getState("dirty_paths") ?? "[]");
  const fresh = getState("schema_version") !== SCHEMA_VERSION;

  let committed: string[] | undefined = [];
  if (head !== indexedHead) {
    committed =
      head && indexedHead
        ? tryGit("diff", "--name-only", "-z", indexedHead, head, "--", "issues")
            ?.split("\0")
            .filter(Boolean)
        : undefined;
  }

  if (fresh || committed === undefined) {
    fullRebuild();
  } else {
    for (const id of idsFromPaths([...committed, ...dirty, ...prevDirty]))
      indexIssue(id);
  }
  setState("schema_version", SCHEMA_VERSION);
  if (head) setState("indexed_head", head);
  else db.prepare("DELETE FROM state WHERE key = 'indexed_head'").run();
  setState("dirty_paths", JSON.stringify(dirty));
}

function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    sync();
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// --- helpers ---

function getMeta(id: string): Meta {
  const meta = readMeta(id);
  if (!meta) throw new UsageError(`no issue ${id}`);
  return meta;
}

function save(meta: Meta): Meta {
  meta.updatedAt = new Date().toISOString();
  writeMeta(meta);
  indexIssue(meta.id);
  return meta;
}

function newId(): string {
  for (;;) {
    const id = BigInt(`0x${randomBytes(5).toString("hex")}`)
      .toString(36)
      .padStart(6, "0")
      .slice(-6);
    if (!fs.existsSync(path.join(ISSUES, id))) return id;
  }
}

function parseIds(s: string | undefined): string[] {
  return s
    ? s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
}

function assertBlockable(issueId: string, blockedOn: string): void {
  getMeta(blockedOn);
  if (issueId === blockedOn)
    throw new UsageError("an issue cannot block itself");
  const cycle = db
    .prepare(
      `WITH RECURSIVE deps(id) AS (
         SELECT ? UNION SELECT b.blocked_on FROM blocks b JOIN deps d ON b.issue_id = d.id
       ) SELECT 1 FROM deps WHERE id = ?`,
    )
    .get(blockedOn, issueId);
  if (cycle)
    throw new UsageError(
      `${issueId} blocked on ${blockedOn} would create a cycle`,
    );
}

function assertParentable(id: string, parent: string): void {
  getMeta(parent);
  const cycle = db
    .prepare(
      `WITH RECURSIVE up(id) AS (
         SELECT ? UNION SELECT i.parent FROM issues i JOIN up ON i.id = up.id WHERE i.parent IS NOT NULL
       ) SELECT 1 FROM up WHERE id = ?`,
    )
    .get(parent, id);
  if (cycle) throw new UsageError(`parent ${parent} would create a cycle`);
}

function fmtRow(i: {
  id: string;
  status: string;
  project: string;
  title: string;
  assignee: string | null;
}): string {
  const who = i.assignee ? ` @${i.assignee}` : "";
  return `${i.id}\t[${i.status}]\t${i.project}\t${i.title}${who}`;
}

function output(json: boolean, data: unknown, text: () => string): void {
  const out = json ? JSON.stringify(data, null, 2) : text();
  if (out) console.log(out);
}

const STRING = { type: "string" } as const;
const BOOL = { type: "boolean" } as const;
const NOT_ARCHIVED = "archived = 0";

// --- commands ---

const commands: Record<string, (argv: string[]) => void> = {
  init() {
    fs.mkdirSync(ISSUES, { recursive: true });
    if (!fs.existsSync(path.join(ROOT, ".git"))) git("init", "-q");
    const ignore = path.join(ROOT, ".gitignore");
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, ".cache.db*\n*.tmp\n");
    const cache = openCache();
    cache.close();
    console.log(ROOT);
  },

  create(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        project: STRING,
        summary: STRING,
        parent: STRING,
        "blocked-by": STRING,
        json: BOOL,
      },
    });
    const title = positionals[0];
    if (!title || !values.project)
      throw new UsageError(
        'usage: iss create "Title" --project P [--summary S] [--parent ID] [--blocked-by ID,...]',
      );
    const meta = tx(() => {
      const id = newId();
      if (values.parent) getMeta(values.parent);
      const blockedOn = parseIds(values["blocked-by"]);
      for (const b of blockedOn) assertBlockable(id, b);
      const now = new Date().toISOString();
      fs.mkdirSync(path.join(ISSUES, id), { recursive: true });
      fs.writeFileSync(contentPath(id), `# ${title}\n`);
      return save({
        id,
        project: values.project!,
        title,
        summary: values.summary ?? "",
        status: "open",
        parent: values.parent ?? null,
        blockedOn,
        assignee: null,
        archived: false,
        createdAt: now,
        updatedAt: now,
      });
    });
    output(
      !!values.json,
      { ...meta, content: contentPath(meta.id) },
      () => `${meta.id}\t${contentPath(meta.id)}`,
    );
  },

  ready(argv) {
    const { values } = parseArgs({
      args: argv,
      options: { project: STRING, json: BOOL },
    });
    const rows = tx(
      () =>
        db
          .prepare(
            `SELECT i.* FROM issues i
             WHERE i.status = 'open' AND i.${NOT_ARCHIVED}
               AND (?1 IS NULL OR i.project = ?1)
               AND NOT EXISTS (SELECT 1 FROM blocks b LEFT JOIN issues x ON x.id = b.blocked_on
                               WHERE b.issue_id = i.id AND (x.id IS NULL OR x.${NOT_ARCHIVED}))
               AND NOT EXISTS (SELECT 1 FROM issues c WHERE c.parent = i.id AND c.${NOT_ARCHIVED})
             ORDER BY i.createdAt`,
          )
          .all(values.project ?? null) as Row[],
    );
    output(!!values.json, rows, () => rows.map(fmtRow).join("\n"));
  },

  list(argv) {
    const { values } = parseArgs({
      args: argv,
      options: {
        project: STRING,
        status: STRING,
        parent: STRING,
        assignee: STRING,
        all: BOOL,
        json: BOOL,
      },
    });
    const rows = tx(
      () =>
        db
          .prepare(
            `SELECT * FROM issues
             WHERE (?1 IS NULL OR project = ?1)
               AND (?2 IS NULL OR status = ?2)
               AND (?3 IS NULL OR parent = ?3)
               AND (?4 IS NULL OR assignee = ?4)
               AND (?5 OR ${NOT_ARCHIVED})
             ORDER BY createdAt`,
          )
          .all(
            values.project ?? null,
            values.status ?? null,
            values.parent ?? null,
            values.assignee ?? null,
            values.all ? 1 : 0,
          ) as Row[],
    );
    output(!!values.json, rows, () => rows.map(fmtRow).join("\n"));
  },

  show(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { json: BOOL },
    });
    if (positionals.length === 0)
      throw new UsageError("usage: iss show <id>...");
    const details = tx(() =>
      positionals.map((id) => {
        const meta = getMeta(id);
        const related = (sql: string) => db.prepare(sql).all(id) as Row[];
        return {
          ...meta,
          content: contentPath(id),
          blockedOnIssues: related(
            "SELECT i.* FROM blocks b JOIN issues i ON i.id = b.blocked_on WHERE b.issue_id = ?",
          ),
          blocks: related(
            "SELECT i.* FROM blocks b JOIN issues i ON i.id = b.issue_id WHERE b.blocked_on = ?",
          ),
          children: related(
            "SELECT * FROM issues WHERE parent = ? ORDER BY createdAt",
          ),
        };
      }),
    );
    output(!!values.json, details, () =>
      details
        .map((d) =>
          [
            `${d.id}: ${d.title}`,
            `  project: ${d.project}  status: ${d.status}${d.archived ? " (archived)" : ""}${d.assignee ? `  assignee: ${d.assignee}` : ""}`,
            d.parent ? `  parent: ${d.parent}` : null,
            d.summary ? `  summary: ${d.summary}` : null,
            `  content: ${d.content}`,
            ...(
              [
                ["blocked on", d.blockedOnIssues],
                ["blocks", d.blocks],
                ["children", d.children],
              ] as const
            )
              .filter(([, xs]) => xs.length > 0)
              .flatMap(([label, xs]) => [
                `  ${label}:`,
                ...xs.map((x) => `    ${fmtRow(x)}`),
              ]),
          ]
            .filter((l) => l !== null)
            .join("\n"),
        )
        .join("\n\n"),
    );
  },

  update(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        title: STRING,
        summary: STRING,
        status: STRING,
        parent: STRING,
        project: STRING,
        claim: BOOL,
        unclaim: BOOL,
        assignee: STRING,
        json: BOOL,
      },
    });
    const id = positionals[0];
    if (!id) throw new UsageError("usage: iss update <id> [flags]");
    const assignee = values.assignee ?? process.env.MAGENTA_THREAD_ID;
    if (values.claim && !assignee)
      throw new UsageError(
        "--claim requires --assignee (or MAGENTA_THREAD_ID)",
      );
    if (values.status && !["open", "in_progress"].includes(values.status))
      throw new UsageError(
        "--status must be open|in_progress; use `iss close` to finish",
      );
    const meta = tx(() => {
      const meta = getMeta(id);
      if (meta.archived) throw new UsageError(`${id} is archived`);
      if (values.claim) {
        const mine =
          meta.status === "in_progress" && meta.assignee === assignee;
        if (meta.status !== "open" && !mine)
          throw new UsageError(
            `cannot claim ${id}: status=${meta.status} assignee=${meta.assignee ?? "-"}`,
          );
        meta.status = "in_progress";
        meta.assignee = assignee!;
      }
      if (values.unclaim) {
        meta.status = "open";
        meta.assignee = null;
      }
      if (values.parent !== undefined) {
        const parent = values.parent === "none" ? null : values.parent;
        if (parent) assertParentable(id, parent);
        meta.parent = parent;
      }
      if (values.title !== undefined) meta.title = values.title;
      if (values.summary !== undefined) meta.summary = values.summary;
      if (values.project !== undefined) meta.project = values.project;
      if (values.status !== undefined) meta.status = values.status as Status;
      return save(meta);
    });
    output(!!values.json, meta, () => fmtRow(meta));
  },

  close(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { reason: STRING, wontfix: BOOL, json: BOOL },
    });
    if (positionals.length === 0)
      throw new UsageError("usage: iss close <id>... [--reason R] [--wontfix]");
    const closed = tx(() =>
      positionals.map((id) => {
        const meta = getMeta(id);
        if (meta.archived) throw new UsageError(`${id} is already archived`);
        if (values.reason)
          fs.appendFileSync(
            contentPath(id),
            `\n## Outcome\n\n${values.reason}\n`,
          );
        meta.status = values.wontfix ? "wontfix" : "done";
        meta.archived = true;
        return save(meta);
      }),
    );
    output(!!values.json, closed, () => closed.map(fmtRow).join("\n"));
  },

  dep(argv) {
    const [action, issueId, blockedOn] = argv;
    if (!(action === "add" || action === "rm") || !issueId || !blockedOn)
      throw new UsageError("usage: iss dep add|rm <id> <blocked-on>");
    tx(() => {
      const meta = getMeta(issueId);
      if (action === "add") {
        assertBlockable(issueId, blockedOn);
        if (!meta.blockedOn.includes(blockedOn)) meta.blockedOn.push(blockedOn);
      } else {
        meta.blockedOn = meta.blockedOn.filter((b) => b !== blockedOn);
      }
      save(meta);
    });
  },

  tree(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { json: BOOL },
    });
    const root = positionals[0];
    if (!root) throw new UsageError("usage: iss tree <id>");
    const rows = tx(
      () =>
        db
          .prepare(
            `WITH RECURSIVE t(id, depth, path) AS (
               SELECT ?1, 0, ?1
               UNION ALL SELECT i.id, t.depth + 1, t.path || '/' || i.createdAt || i.id
               FROM issues i JOIN t ON i.parent = t.id
             ) SELECT i.*, t.depth FROM t JOIN issues i ON i.id = t.id ORDER BY t.path`,
          )
          .all(root) as (Row & { depth: number })[],
    );
    output(!!values.json, rows, () =>
      rows.map((r) => `${"  ".repeat(r.depth)}${fmtRow(r)}`).join("\n"),
    );
  },

  search(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { all: BOOL, json: BOOL },
    });
    const needle = positionals.join(" ").toLowerCase();
    if (!needle) throw new UsageError("usage: iss search <text> [--all]");
    const rows = tx(
      () =>
        db
          .prepare(
            `SELECT * FROM issues WHERE ? OR ${NOT_ARCHIVED} ORDER BY createdAt`,
          )
          .all(values.all ? 1 : 0) as Row[],
    ).filter((i) => {
      const content = fs.existsSync(contentPath(i.id))
        ? fs.readFileSync(contentPath(i.id), "utf8")
        : "";
      return [i.title, i.summary, content]
        .join("\n")
        .toLowerCase()
        .includes(needle);
    });
    output(!!values.json, rows, () => rows.map(fmtRow).join("\n"));
  },

  sql(argv) {
    if (!argv[0]) throw new UsageError('usage: iss sql "<select query>"');
    const rows = tx(() => {
      const stmt = db.prepare(argv.join(" "));
      if (stmt.columns().length === 0)
        throw new UsageError(
          "iss sql is read-only: the cache is derived from meta.json files",
        );
      return stmt.all();
    });
    console.log(JSON.stringify(rows, null, 2));
  },
};

const [cmd, ...rest] = process.argv.slice(2);
const run = cmd ? commands[cmd] : undefined;
if (!run) {
  console.error(`usage: iss <${Object.keys(commands).join("|")}> ...`);
  process.exit(2);
}
try {
  run(rest);
} catch (e) {
  console.error(`iss ${cmd}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
