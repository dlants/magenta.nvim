Execute an EDL (Edit Description Language) script to perform programmatic file edits.

```
# file commands
file `path` # Select a file to edit, resets the selection to the entire contents of the file.
newfile `path` # Create a new file (must not already exist)

# selection commands
# patterns can be: heredoc, /regex/
# bof is beginning of file
# eof is end of file
select <pattern>          # Select the unique match in the entire document (asserts exactly one match)
select_multiple <pattern> # Select all matches in the entire document
narrow <pattern>          # Narrow to the unique match within current selection (asserts exactly one match)
narrow_multiple <pattern> # Narrow to all matches within current selection
retain_first              # Keep just the first selection from multi-selection
retain_last               # Keep just the last selection
select_next <pattern>     # Select next non-overlapping match after current selection
select_prev <pattern>     # Select previous non-overlapping match before current selection
extend_forward <pattern>  # Extend selection forward to include next match
extend_back <pattern>     # Extend selection backward to include previous match

# mutation commands
# replace/insert_before/insert_after accept either a heredoc or a register name
replace <heredoc>        # Replace selection with heredoc text
replace <register_name>  # Replace selection with text from a named register
insert_before <heredoc>  # Insert text before selection
insert_before <register> # Insert register contents before selection
insert_after <heredoc>   # Insert text after selection
insert_after <register>  # Insert register contents after selection
delete                   # Delete selected text
cut <register_name>      # Cut selection into a named register

```

**IMPORTANT: Prefer heredoc or regex patterns for selection.** Prefer text matching over line numbers — line numbers are error-prone. Use heredoc patterns as the default since they match exactly. Only use regexes when you need wildcards or character classes. You should only use line numbers when you have verified that they are correct.

WRONG - using line numbers to select:

```
file `src/service.ts`
select 42-58
replace <<END2
function newImpl() { ... }
END2
```

RIGHT - using text patterns:

```
file `src/service.ts`
select <<END2
function oldImpl() {
END2
extend_forward /^\}/
replace <<END2
function newImpl() { ... }
END2
```

# Registers

Registers are named storage for text that persists across EDL tool invocations within the same thread.

- **`cut <name>`**: Save selection text into a named register (and delete it from the file).
- **`replace <name>`, `insert_before <name>`, `insert_after <name>`**: Use a register name (a plain word) instead of a heredoc to supply the text from a previously stored register.
- **Auto-saved registers on error**: When an EDL script fails for a file (e.g., a `select` finds no matches), any text from unexecuted `replace`/`insert_before`/`insert_after` commands in that file is automatically saved to registers named `_saved_1`, `_saved_2`, etc. The error message reports the register names and sizes so you can reuse them.

## Retry workflow using auto-saved registers

If a script fails because a select pattern didn't match, you don't need to regenerate the replacement text. Just fix the select pattern and reference the auto-saved register:

```
# First EDL invocation fails:
#   select: no matches for pattern ...
#   Text saved to register _saved_1 (1500 chars). Use `replace _saved_1` to reference it.
#
# Second EDL invocation retries with corrected select and reuses the saved text:
file `src/component.ts`
select <<END
corrected pattern here
END
replace _saved_1
```

# Simple text replacement using replace:

```
file `src/utils.ts`
select <<END
const oldValue = 42;
END
replace <<END
const newValue = 100;
END
```

# delete from pattern to the end of file

```
file `src/file.test`
select <<END
describe("test block", () =>
END
extend_forward eof
delete
```

# Insert after a match using insert_after:

```
file `src/utils.ts`
select <<END
import { foo } from './foo';
END
insert_after <<END

import { bar } from './bar';
END
```

# Create a new file:

```
newfile `src/newModule.ts`
insert_after <<END2
export function hello() {
  return "world";
}
END2
```

# Delete a line using delete:

```
file `src/config.ts`
select <<END
const DEBUG = true;
END
extend_forward /$/
delete
```

# Replace part of a line (heredocs don't include surrounding newlines):

file contents before:
const prev = true;
const value = "old-value";
const next = true;

```
file `src/config.ts`
select <<END
const value = "old-value";
END
narrow <<END
"old-value"
END
replace <<END
"new-value"
END
```

file contents after:
const prev = true;
const value = "new-value";
const next = true;

# Multiple edits in the same file:

When doing multiple operations on the same file, each `select` searches from the beginning of the file.

```
file `src/utils.ts`
select <<END1
const oldName = "foo";
END1
replace <<END1
const newName = "foo";
END1

select <<END2
return oldName;
END2
replace <<END2
return newName;
END2
```

# Replace all instances of an identifier in a function body:

```
file `src/service.ts`
select <<FIND
function myMethod(
FIND
extend_forward /^\}/
narrow_multiple <<FIND
method
FIND
replace <<REPLACE
this.method
REPLACE
```

## Selecting large blocks of text

**CRITICAL: Avoid using large heredoc patterns for select operations.** Large text blocks are fragile and wasteful. Instead:

1. **Use beginning of text + extend_forward** to match a block by its boundaries:

```
file `src/service.ts`
select <<END
function processRequest(
END
extend_forward /^\}/
```

This selects from the function signature through its closing brace, without needing to include the entire function body in the pattern.

2. **Use select + narrow** to find something within a known region:

```
file `src/service.ts`
select <<END
function processRequest(
END
extend_forward /^\}/
narrow <<END
return result;
END
```

WRONG - using a large heredoc to select a multi-line block:

```
select <<END
function processRequest(req: Request) {
  const validated = validate(req);
  const result = transform(validated);
  logger.info("processed", result);
  return result;
}
END
```

RIGHT - selecting by boundaries:

```
select <<END
function processRequest(req: Request) {
END
extend_forward /^\}/
```

When doing this be careful to make sure that you're still uniquely identifying the location in the doc.

## Notes on pattern matching

## Heredoc termination codes

When the text you're selecting or inserting contains heredoc delimiters (e.g. `<<END`, `<<EOF`), you **must** use a different, unique termination code for your EDL heredoc to avoid conflicts. For example, if the file contains `<<END`, use `<<DELIM` or `<<MARKER` instead:

WRONG - termination code conflicts with file content:

```
select <<END
select <<END
const x = 1;
END
END
```

RIGHT - use a unique termination code:

```
select <<DELIM
select <<END
const x = 1;
END
DELIM
```

Pick any termination code that does not appear in the text you're matching or inserting.

- Patterns match against raw file bytes. Heredoc patterns are literal text and match exactly.
- **Prefer heredoc patterns over regexes** - they are easier to read, less error-prone, and match exactly what you write. Only use regexes when you need their power (wildcards, character classes, etc.).
- For regex, to match a literal backslash in the file, escape it with another backslash (e.g. /\\/ matches a single backslash).
