Execute an EDL (Edit Description Language) script to perform programmatic file edits.

```
# file commands
# Prefer absolute paths. Relative paths resolve against nvim's cwd.
file `path` # Select a file to edit, resets the selection to the entire contents of the file.
newfile `path` # Create a new file (must not already exist)

# selection commands
# patterns can be: heredoc, /regex/
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
# value can be a heredoc, quoted string, or register name
replace <value>
insert_before <value>
insert_after <value>
delete                   # Delete selected text
cut <register_name>      # Cut selection into a named register
```

**Heredocs operate on full lines**

- **In selections** (`select`, `narrow`, `extend_forward`, etc.) — heredoc will only match the entire line (including whitespace).

For example, if a file contains the string " abc"

```
# none of these will match
select <<END
b
END
select <<END
abc
END

# this will match (whole line with indentation only)
select <<END
  abc
END
```

- **In mutations** (`replace`, `insert_before`, `insert_after`) — heredoc text gets a trailing `\n` appended automatically.

if a file contains abc def

```
select <<END
abc
END
replace <<END
cba
END
```

output cba def

if instead we do

```
# selection includes newline at the end of the line
select <<END
abc
END
replace "cba"
```

output cbadef

```
file `src/file.test`
select <<END
describe("test block", () => {
END

# eof = special value that means end of file (we also support bof)
extend_forward eof
delete
```

```
file `src/utils.ts`
select <<END
import { foo } from './foo';
END
insert_after <<END
import { bar } from './bar';
END
```

```
# writing a new file
newfile `src/newModule.ts`
insert_after <<END2
export function hello() {
  return "world";
}
END2
```

```
file `src/config.ts`
select <<END
const DEBUG = true;
END
delete
```

You can chain multiple edits:

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

Large heredoc blocks are fragile and wasteful. Instead match the beginning of text + extend_forward to match a block by its boundaries:

```
file `src/app.test.ts`
select <<END
  describe('authentication', () => {
END
# extend forward with a heredoc to match the line exactly. The indentation to match the closing brace for this block.
extend_forward <<ENDFWD
  });
ENDFWD
```

Replace all instances of an identifier in a block:

```
file `src/handler.ts`
select <<FIND
  handleRequest(req: Request) {
FIND
extend_forward <<ENDFWD
  }
ENDFWD
narrow_multiple /req/
# a heredoc would insert a new line at the end. Double quotes for inline edits
replace "request"
```

```
file `src/config.ts`
select <<END
const value = "old-value";
END
narrow /"old-value"/
# escape " when using quotes (inline strings)
replace "\"new-value\""
```

Move a block with cut and paste. `cut` stores the selection in a named register (and removes it); then reselect the destination and use the register as the text for `insert_after`:

```
file `src/utils.ts`
select <<BLOCK
function helper() {
BLOCK
extend_forward <<BLOCK
}
BLOCK
cut helperFn

select <<ANCHOR
export function main() {
ANCHOR
insert_after helperFn
```

Use a unique termination code for your EDL heredoc to avoid conflicts. For example, if you want to edit text that contains "END", you can use the delimeter "DELIM"

```
select <<DELIM
const x = 1;
END
DELIM
```

If a script fails because a select pattern didn't match, the replace text will be auto-saved into a register

```
# First EDL invocation fails:
#   select: no matches for pattern ...
#   Text saved to register _saved_1 (1500 chars). Use `replace _saved_1` to reference it.
#
file `src/component.ts`
select <<END
corrected pattern
END
replace _saved_1
```
