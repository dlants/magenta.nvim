# rg hang investigation

## Problem

Running `rg "Full output" -t ts` (or just `rg "Full output"`) from the bash_command tool causes the command to hang indefinitely.

## What works

- `rg "Full output" "node/tools/bashCommand.ts"` - specifying a file path explicitly
- `rg "Full output" node/` - specifying a directory path
- `rg "Full output" -t ts .` - adding `.` as explicit path
- `rg "Full output" -t ts node/` - specifying subdirectory
- `rg --files -t ts` - listing files works fine (166 files)
- `echo "" | rg "Full output" -t ts` - piping input returns immediately (exit 1)

## What hangs

- `rg "Full output" -t ts` - no path specified
- `rg "Full output"` - also hangs (not specific to -t flag)

## Root cause hypothesis

When spawning from node with `stdio: "pipe"`, stdin is not a tty. When `rg` has no path argument and detects stdin is not a tty, it waits to read from stdin instead of searching the current directory.

Evidence:

```bash
bash -c 'if [ -t 0 ]; then echo "stdin is tty"; else echo "stdin is NOT tty"; fi'
# Output: stdin is NOT tty
```

## Attempted fix

Changed spawn options in `bashCommand.ts` from:

```javascript
stdio: "pipe";
```

to:

```javascript
stdio: ["ignore", "pipe", "pipe"];
```

This should ignore stdin entirely, preventing rg from waiting on it.

## Status

Fix applied but not yet verified (requires restart of node process to test).
