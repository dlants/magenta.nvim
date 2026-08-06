# Objective and Context

> When an edl command fails to select using a heredoc selector, I'd like to find the closest match in the doc, using something like edit distance. If that location is unique, I'd then like to capture that selection in a register, and give the agent an error that tells it about the match and the register number, so the agent can quickly fix the command in a followup.

Key entities:

- `Pattern` (`node/core/src/edl/parser.ts:7`) — union of `regex` / `literal` (heredoc or quoted string) / positional / range. Heredoc selectors produce `{ type: "literal", text }`.
- `Executor` (`node/core/src/edl/executor.ts`) — holds `registers: Map<string, string>`, `savedRegisterCount`, `fileDocs`, `currentFile`, `selection`. Throws `ExecutionError` on `select`/`narrow`/`select_next`/`select_prev`/`extend_forward`/`extend_back` when a pattern yields zero matches.
- `Executor.saveCommandTexts` — on failure, stashes mutation texts into `_saved_N` registers and reports them via `FileError.savedRegisters` (`SavedRegisterInfo` in `types.ts`).
- `FileError` / `SavedRegisterInfo` (`node/core/src/edl/types.ts`) — the error payload surfaced per file.
- `formatFileErrors` (`node/core/src/edl/index.ts:169`) — renders the agent-visible error text, including the "Text saved to register ..." lines.
- `EdlRegisters` (`node/core/src/edl/index.ts:16`) — registers plus `nextSavedId`, threaded across edl tool invocations, so a register created during a failed call is available in the agent's follow-up call.
- `findHeredocMatches` / `heredocPatternRegex` (`node/core/src/edl/executor.ts`) — the exact line-anchored heredoc matcher, including the `...` line-suffix wildcard.

Relevant files:

- `node/core/src/edl/executor.ts` — pattern matching + command execution + error/register bookkeeping.
- `node/core/src/edl/parser.ts` — command/pattern grammar; needs to accept a register as a selector.
- `node/core/src/edl/types.ts` — `FileError` shape.
- `node/core/src/edl/index.ts` — error formatting shown to the agent, and `EdlRegisters` plumbing.
- `node/core/src/tools/edl-description.md` — the tool docs the agent reads.
- `node/core/src/edl/executor.test.ts`, `index.test.ts` — existing test patterns for both layers.

# Empirical grounding

Sampled every `edl` failure in the thread archive (`/tmp/magenta/threads`, ~2600 threads, last 6 days): **31 zero-match failures**, 26 with heredoc patterns and 5 with regex patterns (regex is out of scope for this feature). Of the heredoc failures, 16 were single-line patterns. The mistakes that actually occur:

- **Line typed as a prefix of the real line.** Case: pattern `...must replay cleanly through the mock.` where the file has `...must replay cleanly through the mock client.`; and `Comment identity. Records have no id.` where the file has `Comment identity. Records have no id. The API derives a stable one:`. This is the single most recoverable class and prefix matching handles it at zero cost.
- **Line quoted starting mid-line (prose reflow).** The agent quotes a sentence that in the file is wrapped across lines at different points, so its "line" is a fragment starting in the middle of a document line, or spans two of them. Both a suffix-fragment case (` * requiredness speaks only to the parts of its value that must be present:`, which appears mid-line in a wrapped comment) and a spans-two-lines case showed up.
- **Long multi-line block written from memory with something wrong in the middle.** The agent's recovery is always the same: throw the block away, re-anchor on a single line, and use `extend_forward`. A near-match report is most valuable here because the block is expensive to re-derive.
- **Genuinely invented text**, where the retry targets an entirely different location. The locator must stay silent here.

Notably absent: pure indentation mistakes. Whitespace insensitivity is still right (it costs nothing and removes a whole failure class), but it is not the motivating case — truncation and mid-line quoting are.

# Design

Two pieces: (1) a fuzzy locator that runs only on failure, (2) a way for the agent to *use* the result cheaply.

## 1. Fuzzy locator

New module `node/core/src/edl/fuzzy.ts` exporting:

```ts
type FuzzyMatch = { range: Range; score: number };
function findClosestHeredocMatch(patternText: string, doc: Document): FuzzyMatch | undefined
```

Algorithm (line oriented, matching how heredoc selectors already work):

- Split the pattern into `N` lines. Slide a window of exactly `N` lines over the document's lines (offsets come from `doc.lineStarts`), producing `L - N + 1` candidates. The line count is required to match: the mistakes we're recovering from are whitespace differences and partially-typed lines, not missing or extra lines.
- A trailing `...` on a pattern line is stripped before comparison rather than interpreted as a wildcard: prefix matching already makes a short pattern line free against a longer document line, so the marker is redundant here, and leaving it in would charge three spurious character errors. This keeps the locator a plain text comparison; its only purpose is telling the agent where it meant to point.
- Score a candidate line-by-line rather than as one blob, with a per-line error cap of `MAX_LINE_ERRORS = 2`. No prefilter is needed: the cap lets us abandon a window as soon as one line diverges, which kills essentially every window on its first line, so scanning all `L` positions is cheap.
- Per-line comparison, `lineDistance(patternLine, docLine)`:
  - Strip all whitespace from both lines first. Indentation and internal spacing differences should cost nothing, so they're removed rather than penalized.
  - Cheap length reject: if `patternLine.length > docLine.length + MAX_LINE_ERRORS` (post-strip), return `Infinity` immediately. This is the common case for a non-matching window and costs one comparison.
  - Otherwise compute an *infix* edit distance: the pattern line may match any contiguous stretch of the document line, free of charge at both ends. In DP terms, initialize row 0 to all zeros (free start) and take the minimum of the final row (free end). This makes both dominant mistakes cost nothing: a truncated pattern line against a longer document line, and a fragment quoted from the middle of a wrapped prose line.
  - Band the DP to `±MAX_LINE_ERRORS` diagonals and abort the line as soon as every cell in a row exceeds the cap, so each line comparison is `O(len * 5)` at worst and usually terminates in the first row or two.
- Window score is the sum of `lineDistance` over the `N` lines, abandoned as soon as any line returns `Infinity` or the running total exceeds `MAX_WINDOW_ERRORS` (a small budget, e.g. `2 * N` capped at some absolute like 20). A score of `0` means the window differs from the pattern only in whitespace and/or line truncation.
- Return the best-scoring candidate if it is strictly better than the best *non-overlapping* runner-up. Otherwise return `undefined` — with the cap in place, a surviving second candidate means the pattern genuinely doesn't identify a unique location, so we say nothing rather than guess.
- **Reflow fallback.** If the per-line pass finds nothing, the pattern's line breaks probably don't line up with the document's — the case where an agent re-wraps a quoted sentence. Retry once by stripping *all* whitespace including newlines from the pattern, and running the same banded infix search against the whitespace-free document text (approximate string matching with at most `k` errors, `O(docChars * k)` with the band). Map the resulting character offsets back to the original document via an offset table built while stripping, then round outward to line boundaries. Same uniqueness rule applies. Held to a tighter error budget than the per-line pass, since it has no line structure to anchor it.
The range returned is line-oriented (`isLineSelection: true`, ending after the trailing newline), identical in shape to what `findHeredocMatches` returns, so it behaves like a normal heredoc selection.

## 2. Surfacing and reusing the match

- In `Executor`, when a select-family command fails with zero matches *and* the pattern is `{ type: "literal" }`, call the locator against the current file's doc. On a hit, store the matched text in a new register `_near_N` (counter parallel to `_saved_N`, `nearRegisterCount`), and attach it to the thrown `ExecutionError`.
- Extend `FileError` with `nearMatch?: { register: string; startPos: Pos; endPos: Pos; content: string; score: number }`, populated in `Executor.execute` from the caught error.
- `formatFileErrors` renders, e.g.:

  ```
    Closest match at [12:0 - 18:0] (3 character differences), captured in register _near_1:
      <abridged content>
    Retry with `select _near_1` (or edit the register's text into your pattern).
  ```

  Content is abridged with the existing `abridgeContent` helper.
- Grammar change: the select-family commands currently take only a pattern token. Allow a bare word that is not a positional keyword (`bof`/`eof`/`N:`/`N:M`) to parse as `{ type: "register"; register: string }`, a new `Pattern` variant. In `Executor.findInText`/`findAllMatches`, a `register` pattern resolves the register text and matches it exactly as a literal heredoc pattern (error if the register is unset). This is what makes recovery a one-token edit rather than a re-transcription.

Alternatives considered: (a) only printing the near-miss text and having the agent retype it — wastes tokens and reintroduces the same transcription error; (b) auto-applying the fuzzy match — unacceptable, silent wrong edits; (c) char-level diff over the whole document — too slow and produces ranges that don't align to lines.

Invariants:

- The fuzzy path is failure-only: no behavior change to any script that succeeds today, and no extra cost on the success path.
- The locator never causes a command to succeed. The command still fails; we only enrich the error.
- If the best match is ambiguous or poor, no `_near_N` register is created and no near-match text is added to the error.
- `_near_N` registers survive into the follow-up tool call via `EdlRegisters`, same as `_saved_N`.
- Register naming never collides with `_saved_N` numbering.
- `select _near_1` must still enforce the usual uniqueness rules (`select` requires exactly one match).

# Stages

## fuzzy locator

- Goal: `findClosestHeredocMatch` returns the right line range for near-miss patterns and `undefined` when it shouldn't guess.
- Tests (`node/core/src/edl/fuzzy.test.ts`):
  - A pattern whose lines are all indented wrong finds the intended block with score `0`, and the range covers exactly those lines including the trailing newline.
  - A pattern with a single typo'd identifier finds the intended block with a small nonzero score.
  - A pattern where one line is truncated mid-token (a partially typed line) finds the intended block with score `0` — prefix matching means truncation is free.
  - A pattern line that is *longer* than the corresponding document line by more than 2 non-whitespace characters rejects that window.
  - A pattern with a missing line returns `undefined` (line count must match) — documents the deliberate limitation.
  - A document containing two blocks that both match within the caps returns `undefined`.
  - Regression fixtures taken verbatim from the archive cases above: the "mock." / "mock client." truncation, the "Records have no id." truncation, and the mid-line prose fragment (which must exercise the reflow fallback). Each must resolve to the intended block.
  - A one-line pattern of `}` returns `undefined` — infix matching makes short lines match everywhere, and the uniqueness rule is what must catch it.
  - A pattern with no line matching within the cap returns `undefined`.
  - A large file (thousands of lines) with a pattern that matches nothing completes quickly — guards the per-line early termination, which is what makes the prefilter-free scan viable.

## executor integration

- Goal: failing heredoc selects capture the near match into a register and report it in `FileError`.
- Tests (`node/core/src/edl/executor.test.ts`):
  - A script whose `select` heredoc is slightly wrong fails, and the resulting `FileError.nearMatch` names a register whose content is the intended block text; `executor.registers` contains it.
  - No mutations are written for the failed file (existing behavior preserved).
  - Failure on a `/regex/` or positional pattern produces no `nearMatch`.
  - Ambiguous near matches produce no `nearMatch` and no register.
  - Register numbering interleaves correctly with `_saved_N` when a failed `select` is followed by a `replace <<HEREDOC`.

## register-as-selector

- Goal: `select _near_1` / `narrow _near_1` / `extend_forward _near_1` work.
- Tests (`parser.test.ts`, `executor.test.ts`):
  - Parser: `select _near_1` yields `{ type: "register" }`; `select bof`, `select 5:`, `select 5:3` still parse as positional.
  - Executor: after a failed select seeds `_near_1`, a second `execute` on the same executor with `select _near_1` selects the block and a subsequent `replace` applies.
  - `select` on a register whose text occurs twice fails with the normal "expected 1 match" error.
  - Referencing an unset register gives a clear error.

## agent-facing surface

- Goal: the rendered error tells the agent exactly what to do, and the tool docs describe register selectors.
- Tests (`node/core/src/edl/index.test.ts`, snapshot in `__snapshots__/index.test.ts.snap`):
  - End-to-end `runScript` with a near-miss heredoc produces formatted output containing the position, the abridged matched content, and the retry hint; snapshot updated.
  - The returned `edlRegisters` carries `_near_1` so a follow-up `runScript` invocation can use it — assert by round-tripping registers into a second `runScript` that does `select _near_1` + `replace`.
  - `edl-description.md` documents register selectors and the recovery workflow.
