# context

Revisit how `bash_command` output is presented to the agent and add a reminder hook
that nudges the agent to use a subagent when bash output is large.

Goals:

1. **Short output → no log file reference.** When the bash output already fits in the
   token budget, the formatted result should be the raw output without the
   `Full output (N lines): /path/...` trailer. The log file is still written for the
   user-facing UI, just not surfaced to the agent.
2. **Subagent reminder hook.** When the agent receives a long (abbreviated) bash
   output, inject a `<system-reminder>` encouraging it to spawn a subagent to
   explore the log. Fire on the first long output, and afterwards only when
   `BASH_REMINDER_TOKEN_INTERVAL` output tokens have elapsed since the last
   bash reminder (so we don't spam reminders on every bash command).

Default summarization behavior (head/tail strategy with `MAX_OUTPUT_TOKENS_FOR_AGENT`,
`MAX_CHARS_PER_LINE`, `abbreviateLine`) stays as-is — only the trailer changes
(omitted entirely for short output, kept for abbreviated output). The log file
path format is unchanged.

## Relevant files & entities

- `node/core/src/tools/bashCommand.ts`
  - `formatOutputForToolResult` (lines ~122-220): produces the agent-facing string.
    Needs to (a) skip the trailer when output is unabbreviated and (b) report
    abbreviation status to the caller.
  - `StructuredResult` type: needs a `wasAbbreviated: boolean` field so
    `ThreadCore` can detect long-output bash results.
  - `execute` (lines ~248-380): consumes `formatOutputForToolResult` and builds
    the `ProviderToolResult`.

- `node/core/src/thread-core.ts`
  - State: add `pendingBashReminder`, `bashTokensSinceLastReminder`,
    `firstBashReminderPending` to `ThreadCore.state`.
  - `ThreadCoreAction`: add `mark-bash-output-abbreviated` and
    `reset-bash-reminder`. Extend `increment-output-tokens` reducer to bump
    `bashTokensSinceLastReminder` as well.
  - `sendToolResultsAndContinue`: before submitting the tool results, scan each
    `bash_command` result's `structuredResult.wasAbbreviated`; if any is true,
    dispatch `mark-bash-output-abbreviated`. While building `contentToSend`,
    decide whether to append the bash reminder using the gating condition
    `pendingBashReminder && (firstBashReminderPending || bashTokensSinceLastReminder >= BASH_REMINDER_TOKEN_INTERVAL)`.
  - New constant `BASH_REMINDER_TOKEN_INTERVAL = 5000` (output tokens).

- `node/core/src/providers/system-reminders.ts`
  - Add `getBashSummaryReminder(threadType, subagentConfig)` returning a
    `<system-reminder>` block (or undefined for thread types where it doesn't
    apply, e.g. `compact`). Wording: encourage spawning a subagent (or, for
    subagents, delegating exploration if appropriate) to read the log file and
    extract the relevant slice rather than re-running the command.

- `node/core/src/tools/bashCommand.test.ts`
  - Existing assertions on `Full output ...` need to be updated where the test
    no longer expects a trailer (short output).

- `node/core/src/thread-core.test.ts` — pattern to use for the new
  reminder-hook integration tests.

- `node/core/src/providers/system-reminders.test.ts` — pattern to use for the
  new `getBashSummaryReminder` unit tests.

# implementation

- [x] **Update `formatOutputForToolResult` to drop the trailer for short output and
      report abbreviation status.**
  - Change the return type to `{ formattedOutput: string; wasAbbreviated: boolean }`.
  - In the "fits in budget" branch, do NOT append the
    `Full output (N lines): <path>` line. Set `wasAbbreviated: false`.
  - In the abbreviated branch, keep the trailer. Set `wasAbbreviated: true`.
  - Update `execute` to consume the new shape and add `wasAbbreviated` to the
    `StructuredResult`.
  - Add `wasAbbreviated: boolean` to the `StructuredResult` type definition.
  - Iterate until type checks pass (`npx tsgo -p node/core/tsconfig.json --noEmit`).
  - Tests:
    - Behavior: short output omits the `Full output` trailer.
      - Setup: mock shell returns 3 short stdout lines with `logFilePath`.
      - Actions: invoke `BashCommand.execute` and await the result.
      - Expected output: text contains the lines and exit code; does NOT contain
        the substring `Full output (`.
      - Assertions: `expect(text).not.toContain("Full output (")`,
        `expect(structuredResult.wasAbbreviated).toBe(false)`.
    - Behavior: long output keeps the `Full output` trailer.
      - Setup: mock shell returns 100 lines of 500 char content.
      - Actions: invoke `BashCommand.execute`.
      - Expected output: text contains `lines omitted` and `Full output (100 lines):`.
      - Assertions: `expect(text).toContain("Full output (")`,
        `expect(structuredResult.wasAbbreviated).toBe(true)`.

- [x] **Add `getBashSummaryReminder` to `system-reminders.ts`.**
  - Returns a `<system-reminder>` block recommending the agent spawn a subagent
    (or delegate via available tools) to read the log file and extract relevant
    portions, rather than re-running the command or scrolling through the
    abbreviated output. For `threadType === "compact"` return `undefined`.
  - Tests in `system-reminders.test.ts`:
    - Behavior: root threads receive a non-empty reminder mentioning subagents
      and the log file.
      - Setup: none.
      - Actions: `getBashSummaryReminder("root")`.
      - Expected output: contains `<system-reminder>`, mentions
        `subagent` and `log file`.
      - Assertions: `toContain` for those substrings.
    - Behavior: compact threads receive `undefined`.
      - Setup: none.
      - Actions: `getBashSummaryReminder("compact")`.
      - Expected output: `undefined`.
      - Assertions: `toBeUndefined()`.

- [x] **Add bash-reminder state and actions to `ThreadCore`.**
  - Extend `ThreadCore.state` with:
    - `pendingBashReminder: boolean` (init `false`)
    - `bashTokensSinceLastReminder: number` (init `0`)
    - `firstBashReminderPending: boolean` (init `true`)
  - Extend `ThreadCoreAction` with `mark-bash-output-abbreviated` and
    `reset-bash-reminder`.
  - In the reducer:
    - `increment-output-tokens`: also add `tokens` to
      `bashTokensSinceLastReminder`.
    - `mark-bash-output-abbreviated`: set `pendingBashReminder = true`.
    - `reset-bash-reminder`: clear `pendingBashReminder`, set
      `bashTokensSinceLastReminder = 0`, set `firstBashReminderPending = false`.
    - `reset-after-compaction`: also reset all three bash-reminder fields back
      to their initial values (consistent with how the existing
      `outputTokensSinceLastReminder` is reset).
  - Add the constant `BASH_REMINDER_TOKEN_INTERVAL = 5000` near
    `SYSTEM_REMINDER_MIN_TOKEN_INTERVAL`.
  - Iterate until type checks pass.

- [x] **Wire the reminder into `sendToolResultsAndContinue`.**
  - Before the existing tool-result loop, iterate `toolResults` and check each
    `result.result`. If `result.result.status === "ok"` and the
    `structuredResult.toolName === "bash_command"` and
    `structuredResult.wasAbbreviated === true`, dispatch
    `mark-bash-output-abbreviated` (idempotent).
  - When building `contentToSend` (after the existing
    `outputTokensSinceLastReminder` block), add a parallel block: if
    `pendingBashReminder && (firstBashReminderPending || bashTokensSinceLastReminder >= BASH_REMINDER_TOKEN_INTERVAL)`,
    push `{ type: "text", text: getBashSummaryReminder(...) }` (only if defined),
    then dispatch `reset-bash-reminder`.
  - Iterate until type checks pass.
  - Tests in `thread-core.test.ts`:
    - Behavior: first long bash output triggers the bash reminder on the next
      `sendToolResultsAndContinue`.
      - Setup: `createThreadCoreWithMock`. Stream a `tool_use` for
        `bash_command` and provide a cached tool result whose
        `structuredResult.wasAbbreviated === true`. Drive the auto-respond loop.
      - Actions: invoke `maybeAutoRespond` after the tool completes.
      - Expected output: the next user-side message sent to the agent contains
        the bash reminder text.
      - Assertions: inspect `mockClient` recorded message history for a content
        block whose text contains the bash reminder marker.
    - Behavior: a second short bash output within the threshold does NOT trigger
      a second reminder.
      - Setup: as above, but after the first reminder the cached
        `wasAbbreviated` is `false` and only a small number of output tokens
        have accumulated.
      - Actions: drive auto-respond again.
      - Expected output: no bash reminder in the next message content.
      - Assertions: `not.toContain` the reminder text.
    - Behavior: another long bash output AFTER `BASH_REMINDER_TOKEN_INTERVAL`
      tokens triggers a second reminder.
      - Setup: after the first reminder, dispatch
        `increment-output-tokens` enough times to exceed the interval, then
        produce another long bash result.
      - Actions: drive auto-respond.
      - Expected output: bash reminder is present again.
      - Assertions: `toContain` the reminder text.

- [x] **Update existing tests broken by the trailer change.**
  - `node/core/src/tools/bashCommand.test.ts`: adjust the simple-success test
    that asserts `Full output (1 lines): /tmp/test.log` to instead assert the
    trailer is absent for short output. Keep the abbreviated-output test
    asserting the trailer is present.
  - Run `TEST_MODE=sandbox npx vitest run node/core/src/tools/bashCommand.test.ts`.
  - Run `TEST_MODE=sandbox npx vitest run node/core/src/thread-core.test.ts`.
  - Run `TEST_MODE=sandbox npx vitest run node/core/src/providers/system-reminders.test.ts`.
  - Iterate until all relevant tests pass.

- [x] **Run full sandbox suite + type/lint checks before yielding.**
  - `npx tsgo -b`
  - `npx biome check .`
  - `TEST_MODE=sandbox npx vitest run`
  - Iterate until all green.
