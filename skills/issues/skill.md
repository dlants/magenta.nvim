---
name: issues
description: Shared, git-backed issue tracker for splitting work into issues and sub-issues, tracking blockers, claiming and completing work. Use when planning or decomposing work, picking up the next task, or when the user mentions issues/tickets.
---

# Layout

Issues live in `$MAGENTA_ISSUES_DIR` (default `~/.magenta-issues`, configurable via the `issuesDir` magenta option), a git repo shared across all projects:

- `issues/<id>/meta.json` — metadata. Never edit by hand; use `iss`.
- `issues/<id>/content.md` — the issue body. Edit with EDL.
- `.cache.db` — gitignored sqlite index derived from the files, kept in sync automatically.

Ids are short random strings (e.g. `a3f9k2`). The user commits and syncs the repo with git; do not run git there yourself.

# CLI

Run `scripts/iss` from this skill's directory (below, `iss` means that path). Commands that print issues accept `--json`. Mutations are atomic across concurrent agents on this machine.

- `iss create "Title" --project P [--summary S] [--parent ID] [--blocked-by ID,...]` — prints the id and content path; then write the body with EDL.
- `iss ready [--project P]` — open, unarchived issues whose blockers and children are all archived.
- `iss list [--project P] [--status S] [--parent ID] [--assignee A] [--all]` — unarchived by default; `--all` includes archived.
- `iss show <id>...` — metadata, content path, blockers, what it blocks, children.
- `iss update <id> --claim` — atomically take an open issue for this thread (assignee defaults to `$MAGENTA_THREAD_ID`); fails if someone else holds it.
- `iss update <id> --unclaim` — release back to `open`.
- `iss update <id> [--title T] [--summary S] [--project P] [--parent ID|none] [--status open|in_progress]`
- `iss close <id>... [--reason R] [--wontfix]` — set status done/wontfix and archive; `--reason` is appended to content.md as `## Outcome`.
- `iss dep add|rm <id> <blocked-on>` — `add` rejects cycles.
- `iss tree <id>` — sub-issue hierarchy.
- `iss search <text> [--all]` — substring match over title, summary and content.
- `iss sql "<select>"` — read-only query against the cache, printed as JSON.

# Cache schema (for `iss sql`)

- `issues(id, project, title, summary, status ∈ open|in_progress|done|wontfix, parent, assignee, archived 0|1, createdAt, updatedAt)`
- `blocks(issue_id, blocked_on)`

```bash
iss sql "$(cat <<'SQL'
SELECT i.id, i.title, count(*) AS unblocks
FROM issues i JOIN blocks b ON b.blocked_on = i.id
WHERE i.archived = 0
GROUP BY i.id ORDER BY unblocks DESC
SQL
)"
```

# Conventions

- `parent` is decomposition (sub-issues); `blockedOn` is ordering. Do not use one for the other.
- `project` is free-form, and a project may span several repos. Reuse existing names: `iss sql "SELECT project, count(*) n FROM issues GROUP BY project"`.

# Workflow

- Search existing issues before creating new ones.
- An issue is small enough when a single thread can complete it end-to-end. If not, split it into children and add blockers between children that must be ordered. A parent becomes ready only once all its children are archived.
- content.md holds what a fresh agent needs: objective, relevant repos/files, acceptance criteria.
- Claim before starting work. When done, `iss close <id> --reason "..."` with a short note of what was done and anything learned.
- If you discover new work mid-task, file a new issue rather than expanding scope; add a blocker if your issue depends on it.
- Only modify issues you have claimed, except for creating issues and adding blockers.
