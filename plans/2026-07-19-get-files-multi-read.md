# Objective and Context

User request (verbatim):

> hmm.. I'm thinking actually it might be better to just change get-file to get-files, so we can provide an array of files to read. The round trips are mostly in reading multiple files, not in reading -> editing (the agent needs to see the read text before it can write the edit anyway).
>
> What would a plan for amending get-file to accept an array of files to read look like?

The goal is to let a single tool call read multiple files, cutting the round trips
where an agent reads several files one at a time. Reading-then-editing is explicitly
out of scope (the agent must see content before editing anyway).

## Key entities

- `get_file` tool: `node/core/src/tools/getFile.ts` — `execute`, `spec`, `Input`,
  `StructuredResult`, `validateInput`. Currently one `filePath` plus optional
  `force`, `pdfPage`, `startLine`, `numLines`. Returns a single `ProviderToolResult`
  whose `value` is an array of content blocks (text/image/document) and a
  `StructuredResult` of `{ toolName, lineCount, filePath, systemReminder }`.
- `ProviderToolResult` / `ProviderToolResultContent` (`node/core/src/providers/provider-types.ts`)
  — the `value` is already an array of content blocks, so multi-file output fits
  without a structural change to the result envelope.
- `OnToolApplied` / `ContextTracker` (`node/core/src/capabilities/context-tracker.ts`)
  — per-file context tracking. `onToolApplied` is already called once per file, so
  looping is natural; the change tracking / context layer is per-file and unaffected.
- Tool registration/plumbing that names `get_file`:
  - `node/core/src/tool-types.ts` (StructuredResult union)
  - `node/core/src/tools/tool-registry.ts` (STATIC_TOOL_NAMES, COMPACT_STATIC_TOOL_NAMES, capability map)
  - `node/core/src/tools/helpers.ts` (validateInput dispatch)
  - `node/core/src/tools/create-tool.ts` (execute dispatch + context wiring)
  - `node/render-tools/index.ts`, `node/render-tools/streaming.ts`, `node/render-tools/getFile.ts` (rendering)
  - `node/core/src/thread-core.ts:~1363` (consumes `structured.systemReminder`)
  - `node/core/src/compact-renderer.ts:~215` (special-cases `get_file` result)
  - agent prompt docs: `node/core/src/agents/{default,docker,explore,subagent}.md`

# Design

Rename the tool to `get_files` and change its input to a list of per-file requests.
Each list entry carries the same options a single `get_file` call has today, so no
capability is lost:

```
Input = {
  files: Array<{
    filePath: UnresolvedFilePath;
    force?: boolean;
    pdfPage?: number;
    startLine?: number;
    numLines?: number;
  }>;
}
```

The core of `execute` is refactored into a per-file helper `readOneFile(fileReq): Promise<{
  blocks: ProviderToolResultContent[]; structured: PerFileResult }>` that contains
today's logic (text paging/summary/hard-cap, PDF summary/page, image, size limits,
already-in-context dedup, `onToolApplied`). The top-level `execute` loops over
`input.files`, calls `readOneFile` for each, and concatenates results.

Output assembly:
- The returned `value` is the concatenation of each file's content blocks, each
  preceded by a small text header block identifying the file, e.g.
  `=== <displayPath> ===`, so the model can attribute content to a path even when a
  file yields an image/document block.
- `StructuredResult` becomes `{ toolName: "get_files"; files: PerFileResult[] }`
  where `PerFileResult = { filePath: AbsFilePath; lineCount: number; systemReminder: string | undefined }`.

Per-file error isolation: a single missing/unsupported/too-large file must not fail
the whole batch. `readOneFile` returns a text error block for that file (and no
`onToolApplied`), and the overall call stays `status: "ok"`. Only if the input is
structurally invalid (e.g. empty `files`) does `validateInput` reject.

Downstream adjustments:
- `thread-core.ts`: iterate `structured.files` and emit an `activate-reminder`
  update for each entry that has a `systemReminder` (today it handles one).
- `compact-renderer.ts`: match `toolName === "get_files"` and keep the
  "[file contents omitted]" behavior for the whole block.
- `render-tools`: `renderSummary` / `renderResultSummary` render a list of the
  requested files (one line each); streaming case stays a no-op.
- The single-shared text-processing logic (`processTextContentStandalone`, summary,
  hard cap) stays in `getFile.ts` and is simply reused by the per-file helper.

Alternative considered (keep the name `get_file`, let `filePath` be `string | string[]`,
or add an optional `filePaths`): lower rename churn, but a union-typed field is
awkward to validate and document, and per-file options (startLine/pdfPage) don't map
onto a bare string array. The explicit `files: [{...}]` shape is clearer and is what
the user asked for. The rename is mechanical.

## Invariants

- Reading a single file via `get_files` produces output byte-for-byte equivalent to
  today's `get_file` for that file (same headers, summary, truncation hints, hard cap,
  abridging), plus the new per-file `=== path ===` header.
- The 40,000-char hard cap is per file (unchanged); no attempt is made to budget
  across files in this iteration.
- `onToolApplied` is invoked exactly once per successfully, fully-read file — never for
  a file that errored or was served the "already in context" short-circuit.
- One file's error never aborts the reads of the other files in the same call.
- Every `systemReminder` produced by a `.md` file in the batch is activated.

# Stages

## core tool rewrite

- Goal: `get_files` executes a batch of file reads in one call, with per-file error
  isolation and per-file context tracking, reusing the existing text/PDF/image logic.
- Work: rename `spec.name` to `get_files`; new `Input`/`validateInput`; extract
  `readOneFile`; loop and concatenate with per-file headers; new `StructuredResult`
  shape. Update `tool-types.ts`, `tool-registry.ts`, `helpers.ts`, `create-tool.ts`.
- Tests (extend `getFile.test.ts`):
  - Reading two text files returns both, each under its `=== path ===` header, and
    calls `onToolApplied` twice.
  - A batch with one missing file and one good file: good file content present, error
    text present for the missing one, overall status ok, `onToolApplied` called once.
  - Per-file `startLine`/`numLines` and `pdfPage` still behave as before.
  - Single-file batch output matches the pre-rename output (guard against regressions).
  - Two `.md` files both surface their system reminders in `StructuredResult.files`.

## downstream consumers

- Goal: reminders, compaction, and rendering all handle the batch shape.
- Work: `thread-core.ts` loops `structured.files` for reminders; `compact-renderer.ts`
  matches `get_files`; `render-tools/{index,streaming,getFile}.ts` render the file list.
- Tests:
  - thread-core: a `get_files` call including two `.md` files activates both reminders
    (verify via the same path exercised by the existing get_file reminder test).
  - compact-renderer: a `get_files` result renders as "[file contents omitted]".
  - A render/streaming snapshot for a multi-file request shows each requested path.

## prompts and docs

- Goal: agents call the tool with the new name and array shape.
- Work: update `spec.description` (document `files` array, per-file options, per-file
  error isolation, text-only note unchanged); update agent md files and any
  system-reminder text referencing `get_file`.
- Tests: `docker-toolspecs.test.ts` / `toolManager.test.ts` updated for the new name;
  a grep confirms no stale `get_file` tool-name references remain in prompts.

## test migration

- Goal: the whole suite and type-check pass again after the rename.
- Work: sweep every remaining test that references the `get_file` tool name, its
  `Input` shape, or its `StructuredResult`; regenerate affected snapshots.
- Done when: `npx tsgo -b` and `npx vitest run` both pass with zero failures.

# Notes

- Backwards compatibility is explicitly a non-goal. Drop the `get_file` name entirely;
  no aliasing for historical threads/archives.
- No cross-file output budget. The per-file 40,000-char hard cap is the only limit.
- Expect this to break many types (the `StructuredResult` union, tool-name literals,
  `Input` shape, render dispatch). Broken types are acceptable in the interim — do not
  stop to keep the tree type-clean at every step. Follow the `npx tsgo -b` errors as
  the worklist and drive them all to zero by the end (in the final "test migration"
  stage).

## Testing callout

This rename touches a large number of tests (any fixture, snapshot, or assertion that
references the `get_file` tool name, its `Input` shape, or its `StructuredResult`).
Do NOT try to keep every test green while landing the code change — that would balloon
the core rewrite. Instead:

- Stages "core tool rewrite" and "downstream consumers" should land the production code
  and only the *new/updated* unit tests called out in each stage (enough to prove the
  new behavior).
- Add a dedicated final stage **"test migration"** whose sole goal is to sweep the
  remaining broken tests: update tool-name literals, `Input`/`StructuredResult` shapes,
  and regenerate snapshots. Run `npx vitest run` and `npx tsgo -b` to completion and
  drive the failure list to zero.
