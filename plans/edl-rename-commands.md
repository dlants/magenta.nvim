# context

The goal is to rename EDL commands to make single-match the default and discourage line-number usage:

1. `select` (currently multi-match) → `select` becomes single-match (like current `select_one`)
2. `select_one` → removed (absorbed into `select`)
3. New `select_multiple` for multi-match (old `select` behavior)
4. `narrow` (currently multi-match) → `narrow` becomes single-match (like current `narrow_one`)
5. `narrow_one` → removed (absorbed into `narrow`)
6. New `narrow_multiple` for multi-match (old `narrow` behavior)
7. Update `edl-description.md` to discourage line-number patterns and emphasize text/regex matches

## Relevant files

- `node/edl/parser.ts`: Defines `Command` union type and parses command names from tokens
- `node/edl/executor.ts`: Executes commands via switch statement (`executeCommand` method)
- `node/edl/index.ts`: Public API, formatting
- `node/tools/edl-description.md`: Tool description shown to the LLM agent
- `node/tools/edl.ts`: Loads and uses edl-description.md
- `node/edl/parser.test.ts`: Parser tests
- `node/edl/executor.test.ts`: Executor tests (~1727 lines)
- `node/edl/index.test.ts`: Integration tests
- `node/tools/edl.test.ts`: Tool integration tests

## Behavioral mapping (old → new)

| Old command  | Old behavior | New command       | New behavior (same) |
| ------------ | ------------ | ----------------- | ------------------- |
| `select`     | multi-match  | `select_multiple` | multi-match         |
| `select_one` | single-match | `select`          | single-match        |
| `narrow`     | multi-match  | `narrow_multiple` | multi-match         |
| `narrow_one` | single-match | `narrow`          | single-match        |

# implementation

- [x] **Step 1: Update `Command` type in `parser.ts`**
  - [ ] Remove `select_one` and `narrow_one` from the union
  - [ ] Add `select_multiple` and `narrow_multiple` to the union
  - [ ] Note: `select` now means single-match, `select_multiple` means multi-match
  - [ ] Update the parser switch statement to recognize `select_multiple` and `narrow_multiple` (and stop recognizing `select_one` / `narrow_one`)

- [x] **Step 2: Update `executor.ts`**
  - [ ] The current `select` case becomes `select_multiple` (multi-match behavior, no count assertion)
  - [ ] The current `select_one` case becomes `select` (single-match behavior, asserts exactly 1 match)
  - [ ] The current `narrow` case becomes `narrow_multiple` (multi-match behavior)
  - [ ] The current `narrow_one` case becomes `narrow` (single-match behavior, asserts exactly 1 match)
  - [ ] Update all error messages to use the new command names

- [x] **Step 3: Fix type errors**
  - [ ] Run `npx tsc --noEmit` and iterate until clean

- [x] **Step 4: Update tests in `parser.test.ts`**
  - [ ] Rename test cases referencing `select_one` → `select`, `select` → `select_multiple`
  - [ ] Rename test cases referencing `narrow_one` → `narrow`, `narrow` → `narrow_multiple`
  - [ ] Update expected command types in assertions

- [x] **Step 5: Update tests in `executor.test.ts`**
  - [ ] Rename all EDL script strings: `select_one` → `select`, `select ` (multi) → `select_multiple`
  - [ ] Rename all EDL script strings: `narrow_one` → `narrow`, `narrow ` (multi) → `narrow_multiple`
  - [ ] Update expected error messages and trace entries

- [x] **Step 6: Update tests in `index.test.ts`**
  - [ ] Same command renames in test scripts
  - [ ] Update snapshots if needed

- [x] **Step 7: Update tests in `edl.test.ts`**
  - [ ] Same command renames in test scripts

- [x] **Step 8: Run tests and iterate**
  - [ ] `npx vitest run node/edl/`
  - [ ] `npx vitest run node/tools/edl.test.ts`
  - [ ] Fix any failures

- [x] **Step 9: Update `edl-description.md`**
  - [ ] Rename all command references (`select_one` → `select`, `select` multi → `select_multiple`, etc.)
  - [ ] Discourage line-number patterns: add guidance to prefer heredoc/regex over line numbers
  - [ ] Move line-number patterns to a secondary/advanced section
  - [ ] Emphasize `select` (single-match) as the primary/default command
  - [ ] Add warnings about line-number fragility

- [x] **Step 10: Final validation**
  - [ ] `npx tsc --noEmit`
  - [ ] `npx vitest run`
  - [ ] Review edl-description.md for consistency
