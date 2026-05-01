# Context

The goal is to allow users to suppress project-level skills by skill name when they conflict with shared cloud configurations. Today, in `loadSkills`, later directories in `skillsPaths` override earlier ones, and the default order puts user-level paths (`~/.magenta/skills`, `~/.claude/skills`) before project-level paths (`.magenta/skills`, `.claude/skills`). This means a project's shared cloud config can override the user's personal skills with the same name.

The new option will be a user-level list of skill names. For any name in this list, project-level skills with that name are ignored. User-level skills with that name continue to load normally.

The option is "user-level" in the sense that it only takes effect when set in the lua `setup({...})` config or in `~/.magenta/options.json`. If set in a project's `.magenta/options.json`, it is ignored with a warning, since allowing the project to disable its own suppression would defeat the purpose.

## Key types and interfaces

- `MagentaOptions` (`node/options.ts`) — root option type. Currently has `skillsPaths: string[]`. We add `suppressProjectSkills: string[]`.
- `ProviderOptions` (`node/core/src/provider-options.ts`) — minimal interface that core uses. Currently has `skillsPaths` and `agentsPaths`. We add `suppressProjectSkills?: string[]`.
- `SkillsMap` and `SkillInfo` (`node/core/src/providers/skills.ts`) — core skill data structures. The internals of `loadSkills` need to know which paths are user-level vs project-level.
- `expandTilde(filepath, homeDir)` (`node/core/src/utils/files.ts`) — used to expand `~/` in paths. We use this (combined with `homeDir`) to classify a path as user-level vs project-level.

## Classification rule for user-level vs project-level paths

A `skillsPaths` entry is **user-level** iff, after `expandTilde`, the resulting absolute path is inside `homeDir`. This naturally covers:

- `~/.magenta/skills` → expands to `/home/me/.magenta/skills` → user-level ✓
- `~/.claude/skills` → user-level ✓
- `.magenta/skills` → relative, not absolute, not under home → project-level ✓
- `.claude/skills` → project-level ✓
- `/some/absolute/path` → project-level (unless inside home dir)
- `/home/me/team-skills` → user-level (since it's under home)

## Relevant files

- `node/options.ts` — defines `MagentaOptions`, `parseOptions`, `parseProjectOptions`, `mergeOptions`, `loadUserSettings`, `loadProjectSettings`. Need to add the new field, parsing, and project-settings filtering.
- `node/core/src/provider-options.ts` — defines the minimal `ProviderOptions` that core sees. Need to add the optional field.
- `node/core/src/providers/skills.ts` — `loadSkills` walks `skillsPaths`. We modify the loop to skip project-level skills whose names are in `suppressProjectSkills`.
- `node/core/src/utils/files.ts` — `expandTilde` and `HomeDir` type live here. No changes needed; we just use them.
- `lua/magenta/options.lua` — defaults exposed to lua users. Add `suppressProjectSkills = {}` so the field is documented and present.
- `node/core/src/providers/skills.test.ts` — new core-level unit tests that call `loadSkills` directly. Add tests for the new behavior here.
- `node/options.test.ts` — unit tests for option parsing and merging. Add tests for the new field.
- `doc/magenta-skills.txt` — user-facing docs for skills.
- `doc/magenta-config.txt` — user-facing config reference for `skillsPaths` and `suppressProjectSkills`.
- `README.md` — brief mention if relevant.

# Implementation

- [ ] **Add `suppressProjectSkills` field to `ProviderOptions`**
  - In `node/core/src/provider-options.ts`, add `suppressProjectSkills?: string[]` to the `ProviderOptions` type.
  - This is the minimum surface that core needs.

- [ ] **Modify `loadSkills` to apply suppression**
  - In `node/core/src/providers/skills.ts`:
    - Read `context.options.suppressProjectSkills ?? []` once at the top of `loadSkills` into a `Set<string>`.
    - Inside the per-`skillsDir` loop, before processing skill files, classify the directory: a directory is user-level iff `path.isAbsolute(expandedDir)` AND `expandedDir.startsWith(homeDir)` (with a trailing-separator check to avoid false matches like `/home/foo/...` matching `homeDir = "/home/fo"`). Pass this `isUserLevel` flag into the inner loop.
    - When iterating the skill files in that directory, before adding/overwriting `skills[skillInfo.name]`, check: `if (!isUserLevel && suppressedNames.has(skillInfo.name)) { logger.info("Suppressing project-level skill ..."); continue; }`.
  - Tests live in `node/core/src/providers/skills.test.ts` and call `loadSkills` directly with a constructed `context` (logger, fileIO, options, `cwd`, `homeDir`). They should not use `withDriver` or inspect the sidebar / system prompt — just assert on the returned `SkillsMap`.
  - Test for this behavior:
    - Behavior: a project-level skill listed in `suppressProjectSkills` is dropped while the user-level skill with the same name is kept.
    - Setup: create `<tmpHome>/.claude/skills/plan/skill.md` with frontmatter `name: plan, description: user-plan`, and `<tmpCwd>/.claude/skills/plan/skill.md` with `name: plan, description: project-plan`. Configure options with `skillsPaths: ["~/.claude/skills", ".claude/skills"]` and `suppressProjectSkills: ["plan"]`.
    - Actions: call `loadSkills(context)` and inspect the returned `SkillsMap`.
    - Assertions: `skills["plan"].description === "user-plan"`; `skills["plan"].skillFile` points to the user-level path.
  - Second test:
    - Behavior: a project-level skill listed in `suppressProjectSkills` is dropped even when no user-level skill with that name exists.
    - Setup: create `<tmpCwd>/.claude/skills/plan/skill.md` only. Options have `suppressProjectSkills: ["plan"]`.
    - Assertions: `skills["plan"]` is `undefined` in the returned map.
  - Third test:
    - Behavior: project-level skills not in the suppression list are unaffected.
    - Setup: project-level `plan` and `browser` skills, `suppressProjectSkills: ["plan"]`.
    - Assertions: `skills["browser"]` is defined; `skills["plan"]` is `undefined`.

- [ ] **Add `suppressProjectSkills` to root `MagentaOptions`**
  - In `node/options.ts`:
    - Add `suppressProjectSkills: string[]` to the `MagentaOptions` type (required, defaulted in `parseOptions`).
    - In `parseOptions`, default to `[]` and parse from `inputOptionsObj.suppressProjectSkills` using the existing `parseStringArray` helper.
    - In `parseProjectOptions`, parse `suppressProjectSkills` the same way (so user `~/.magenta/options.json` works).
    - In `loadProjectSettings`, after `parseProjectOptions` returns, if the parsed result has `suppressProjectSkills`, log a warning ("`suppressProjectSkills` is a user-level option and is ignored when set in project options.") and delete the field from the partial result. (Do **not** filter inside `parseProjectOptions` — `loadUserSettings` calls the same parser and must keep the field.)
    - In `mergeOptions`, merge: if `projectSettings.suppressProjectSkills` is defined, replace `merged.suppressProjectSkills` with it (concatenating could also work, but since project settings can never set it post-filter, replacement is fine and matches existing patterns for simple lists).
  - Test for this behavior:
    - Behavior: `parseOptions` populates `suppressProjectSkills` from lua input and defaults to `[]`.
    - Assertions: `parseOptions({ profiles: [...], suppressProjectSkills: ["plan"] }, logger).suppressProjectSkills` equals `["plan"]`; with no field, equals `[]`.
  - Test for project-settings filtering:
    - Behavior: `loadProjectSettings` strips `suppressProjectSkills` and warns.
    - Setup: write a `.magenta/options.json` with `suppressProjectSkills: ["plan"]` to a tmp cwd; capture warnings.
    - Expected: returned partial options do not contain `suppressProjectSkills`; logger warned at least once.
  - Test for user-settings retention:
    - Behavior: `loadUserSettings` retains `suppressProjectSkills`.
    - Setup: write `~/.magenta/options.json` containing `suppressProjectSkills: ["plan"]`.
    - Expected: returned partial options have `suppressProjectSkills: ["plan"]`.

- [ ] **Plumb the field through `ProviderOptions` consumers**
  - The root project's `MagentaOptions` already structurally satisfies `ProviderOptions` because `MagentaOptions` is passed where `ProviderOptions` is expected. Adding the optional field on the core side and a defaulted field on the root side is sufficient — no call-site changes are needed beyond confirming `tsgo -b` still passes.
  - Run `npx tsgo -b` and fix any type issues.

- [ ] **Update lua defaults**
  - In `lua/magenta/options.lua`, add `suppressProjectSkills = {}` to the `defaults` table. Place it next to `skillsPaths` for discoverability.

- [ ] **Update documentation**
  - `doc/magenta-skills.txt`: add a new section after "SKILL LOCATIONS" titled "SUPPRESSING PROJECT SKILLS" (`*magenta-skills-suppress*`). Explain the use case (shared cloud configs dropping unwanted skills), how to set the option in lua or `~/.magenta/options.json`, and the precedence rules. Cross-reference `magenta-suppressProjectSkills`.
  - `doc/magenta-config.txt`:
    - Add `suppressProjectSkills` (`*magenta-suppressProjectSkills*`) to the GENERAL OPTIONS section near `skillsPaths`. Type: `table`, Default: `{}`. Brief description, link to `magenta-skills-suppress`.
    - Update the PROJECT SETTINGS merging-behavior list: note that `suppressProjectSkills` is **user-level only** and is ignored if set in project options.
  - `README.md`: no change needed beyond what's already there about skills, unless we want to mention the new option in the "Skills" bullet. Light touch: add a short clause like "supports suppressing project-level skills by name". Keep it brief.

- [ ] **End-to-end verification**
  - Run `TEST_MODE=sandbox npx vitest run node/core/src/providers/skills.test.ts node/options.test.ts` — ensure all new tests pass and no regressions.
  - Run `npx tsgo -b` — confirm type checks pass.
  - Run `npx biome check .` — confirm lint/format passes.
