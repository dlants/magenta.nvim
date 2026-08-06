# Objective and Context

> let's write a plan to fix these.
>
> 1. no brainer. Let's make sure we add tests
> 2. sg, though I don't get case 15. Let's ignore that
> 3. sg
> 4. sg

Referring to the four remedies derived from `plans/2026-08-06-edl-failure-dataset.md` (31 real
zero-match `select` failures harvested from the thread archive):

1. Regex patterns are compiled without the `m` flag, so `^`/`$` anchor to the whole document.
2. Heredoc lines support a trailing `...` wildcard but not a leading one.
3. Prefix-truncation failures (pattern line is a strict prefix of a real line) get no diagnostic.
4. Oversized-block failures (block written from memory, diverges partway) get no diagnostic.

Reflow/whitespace-insensitivity (dataset case 15) is explicitly out of scope.

## Entities

- `Pattern` (`node/core/src/edl/types.ts`) — discriminated union; the two variants we touch are
  `{ type: "regex"; pattern: RegExp }` and `{ type: "literal"; text: string }` (heredoc).
- `parse` (`node/core/src/edl/parser.ts:505`) — builds the `RegExp`; currently
  `tok.flags.includes("g") ? tok.flags : tok.flags + "g"`. This is the site of remedy 1.
- `heredocPatternRegex` / `hasHeredocPrefixMarker` (`executor.ts:32-43`) — compile a heredoc into a
  line-anchored `gm` regex; each line ending in `...` becomes `literal + [^\n]*`. Site of remedy 2.
- `findHeredocMatches` (`executor.ts:45`) — runs that regex and keeps only matches sitting on line
  boundaries, returning `Range[]` with `isLineSelection: true`.
- `findInText` (`executor.ts:221`) — dispatches per pattern type; the `literal` case enforces the
  "prefix pattern must match exactly one location in the file" uniqueness rule.
- `ExecutionError` (`executor.ts:19`) — carries `message` and `trace`. Thrown at six "no matches"
  sites: `narrow`, `narrow_multiple`, `select`, `select_multiple`, `select_next`, `select_prev`,
  `extend_forward`, `extend_back` (`executor.ts:497-660`).
- `Executor.execute` (`executor.ts:860`) — catches `ExecutionError`, records a `FileError` with
  `error`, `failedCommands`, `trace`, and auto-saved `_saved_N` registers.

## Files

- `node/core/src/edl/parser.ts` — tokenizer + `Pattern` construction; regex flags.
- `node/core/src/edl/executor.ts` — heredoc compilation, matching, and the failure paths.
- `node/core/src/edl/executor.test.ts` — vitest suite; `withTmpDir` writes real files,
  `expectFileError(result, pathSubstring, errorSubstring)` asserts on `fileErrors`.
- `node/core/src/edl/parser.test.ts` — pattern-construction unit tests.
- `node/core/src/tools/edl-description.md` — the tool description the agent reads; documents `...`.
- `doc/magenta-edl.txt` — user-facing vim help for the same syntax.

# Design

Remedies 1 and 2 are matcher fixes: they make patterns the agent already writes actually work.
Remedies 3 and 4 are diagnostic-only: they never change which selection succeeds, they only enrich
the `ExecutionError` message on a zero-match failure. Keeping the diagnostics strictly out of the
success path means no existing script can change behavior, and a wrong guess costs nothing but a
line of error text.

## 1. Multiline regex flag

In `parser.ts`, add `m` alongside `g` when constructing the `RegExp`, unless the author wrote `s`
or `m` explicitly (respect an explicit `m`; it is already the same thing). Agents write vim/ripgrep
flavored anchors and expect `^`/`$` to be line anchors — the dataset shows four of five regex
failures are exactly this. `findInText`'s `regex` case rebuilds the RegExp from `source` + flags, so
it inherits `m` automatically.

Note `formatPattern` (`executor.ts:71`) prints `pattern.flags.replace("g","")`, which would now
surface a bare `m` in error text. Strip `m` there too so failure messages echo what the agent wrote.

## 2. Leading `...` on heredoc lines

Make the wildcard symmetric in `heredocPatternRegex`:

- a line starting with `...` contributes a leading `[^\n]*`
- a line ending with `...` contributes a trailing `[^\n]*` (existing behavior)
- both may apply to the same line, making it an infix match
- a line that is exactly `...` is the degenerate both-ends case: `[^\n]*`, i.e. "any single line"

`hasHeredocPrefixMarker` must be widened the same way so the existing file-wide uniqueness check
(match exactly one location) still fires for leading-wildcard patterns. That uniqueness rule is what
keeps the looser matching safe.

## 3. Prefix-truncation diagnostic

On zero matches for a `literal` pattern, recompile it with an implicit trailing `[^\n]*` appended to
every line (as if the agent had written `...` on each), and re-run `findHeredocMatches`. If that
yields exactly one match, the error text gains:

    no exact match, but the pattern matches as a line-prefix at line 42. The full line is:
      `- Auth is OAuth 2.0 PKCE against \`auth.openai.com\` — token exchange lives in ...`
    Add `...` to the end of the truncated line(s) to match it.

If it yields zero or more than one, say nothing. Requiring exactly one keeps this silent for the
"target does not exist" group.

## 4. Divergence diagnostic for multi-line blocks

On zero matches for a multi-line `literal` pattern, find the longest prefix of the pattern's lines
that does match: compile lines `1..k` for `k = N-1` down to `1`, and take the largest `k` with at
least one match. Report:

    no exact match. Lines 1-8 of the pattern match at line 120. Pattern line 9 is:
      `  const eventGroupId = optionalString(body, "event_group_id", true);`
    but line 128 of the file is:
      `  const eventGroupId = optionalString(body, "eventGroupId", true);`
    Consider selecting the first line and using extend_forward to reach the end of the block.

If even line 1 matches nowhere, report that directly — "the first line of the pattern does not
appear in the file" — which is the correct, quiet answer for the invented-target group.

The naive loop is O(N) recompiles over the whole document. N is the pattern's line count (largest in
the dataset is 15) and this only runs on the failure path, so it is not worth optimizing.

Both diagnostics live in one helper, `describeHeredocMiss(patternText, doc): string | undefined`,
called from a single place. To avoid duplicating it across the eight throw sites, funnel the
zero-match `literal` case through a small `noMatchError(command, pattern, doc)` helper that builds
the message and appends the diagnostic when present.

Invariants:

- Diagnostics never influence the resulting selection — only `ExecutionError.message`.
- A diagnostic is emitted only when it identifies a single unambiguous location; ambiguity is
  silence.
- The existing rule "a heredoc pattern containing a `...` wildcard must match exactly one location
  in the file" continues to hold, now including leading wildcards.
- Heredoc matches stay line-anchored: a leading `...` widens within a line, never across lines.
- Adding `m` must not change the meaning of regexes with no `^`/`$`, and `.` must still not match
  newlines (do not add `s`).

# Stages

## multiline regex flag — DONE

Implemented: `tokenToPattern` (`parser.ts`) appends `m` unless the author wrote `m` or `s`.
Both `formatPattern` implementations (`parser.ts:42`, `executor.ts:75`) now strip `g` and `m`, so a
failing `/foo/i` still prints `/foo/i`. Existing parser tests updated to expect the `m` flag; new
executor tests live in the `regex line anchors` describe block at the end of `executor.test.ts`.
Note: some nvim-backed root tests (thread/script-manager) are flaky under parallel load; they pass
in isolation both with and without this change.

- Goal: `select /^import Foo from "bar";$/` matches an interior line of a file.
- Tests:
  - `select /^  buffer = prompt_buf,$/` against a multi-line file selects that line only (dataset
    case 3); before the fix this throws "no matches".
  - `select_multiple /^end$/` on a file with three `end` lines returns three ranges.
  - A regex with no anchors (`/world/`) selects the same ranges as before the change.
  - `/a.b/` does not match across a newline, confirming `s` was not introduced.
  - `formatPattern` output for a failing `/foo/i` still reads `/foo/i`, not `/foo/im`.

Review follow-up (addressed): added coverage for the `s`-flag branch — an executor test where
`select /a.b/s` matches across a newline (dotall preserved, `m` not appended), plus parser tests
that `/a.b/s` yields `gs`, that an explicit `/hello/m` is not duplicated, and that the parser-side
`formatPatternSource` echoes `/hello/i` and `/world/`.

## leading heredoc wildcard — DONE

Implemented in `executor.ts` via a shared `heredocLineWildcards(line)` helper used by both
`heredocPatternRegex` and `hasHeredocPrefixMarker`, so the uniqueness rule covers leading wildcards.
A bare `...` line is treated as the both-ends case (any single line). `...` in the middle of a line
stays literal. Tests: `leading heredoc wildcards` describe block at the end of `executor.test.ts`.

- Goal: `...fragment...` selects the line containing that fragment mid-line.
- Tests:
  - A heredoc whose single line is `...the API takes \`{ session, id }\`...` selects the whole
    containing line (dataset case 19).
  - Leading-only `...suffix` matches a line ending in `suffix` and anchors at the line end.
  - A leading-wildcard pattern matching two lines throws the "must match exactly one location"
    error rather than silently taking the first.
  - A multi-line heredoc whose middle line is bare `...` spans exactly three lines.
  - A pattern line containing a literal `...` in the middle (`a...b`) is still matched literally.

Review follow-up (addressed): added three tests — a `narrow` whose search text is a sub-range still
triggers the file-wide uniqueness error (covers the `findHeredocMatches(..., doc.content, ..., 0)`
re-scan branch), a `start`/bare-`...`/`end` pattern matching two places errors instead of taking the
first, and a `replace` through an infix-wildcard selection asserts the resulting file content (the
wildcard-matched remainder of the line is replaced).

## miss diagnostics — DONE

Implemented in `executor.ts`: `describeHeredocMiss(patternText, doc)` (single-line prefix
diagnostic + multi-line divergence diagnostic) and an `Executor.noMatchError(message, pattern, doc)`
funnel now used by all eight zero-match throw sites. Diagnostics only append to
`ExecutionError.message`.

Decisions/deviations:
- Divergence walks k downward and reports the largest k whose prefix matches exactly once; a
  prefix that matches in multiple places yields silence rather than a guessed location.
- The prefix diagnostic is skipped when the single-line pattern already carries a trailing wildcard.
- Diagnostics always scan the whole document, even for narrow/select_next/extend_*, since they are
  hints rather than selection logic.
- Tests: the `miss diagnostics` describe block at the end of `executor.test.ts` covers all six
  listed cases.

- Goal: a failing `select` explains what nearly matched, and stays quiet when nothing did.
- Tests:
  - Single-line pattern that is a strict prefix of a real line: error contains the full real line
    and the suggestion to add `...` (dataset cases 16, 20, 28).
  - Same, but the prefix matches two lines: error contains no suggestion.
  - 14-line pattern where lines 1-8 match and line 9 diverges: error names line 9, quotes both the
    expected and actual line, and suggests `extend_forward` (dataset case 6).
  - Pattern whose first line appears nowhere: error says so and includes neither a prefix
    suggestion nor a divergence report (dataset cases 24, 27).
  - A successful `select` produces no diagnostic text anywhere in the result.
  - `narrow` and `extend_forward` zero-match failures carry the same diagnostic (verifies the
    shared `noMatchError` path, not just `select`).

## documentation

- Goal: the agent-facing description teaches the leading `...` form.
- Tests: none automated. Update `node/core/src/tools/edl-description.md` (the `...` section around
  lines 55-75) with a leading- and infix-wildcard example, mirror it into `doc/magenta-edl.txt`, and
  confirm the existing `node/chat/thread.test.ts` snapshots that embed the description are
  regenerated.
