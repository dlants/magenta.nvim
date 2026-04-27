# Context

Today multiple system reminders that fire on the same auto-respond turn (subsequent reminder + bash-summary reminder) are emitted as two separate text content blocks, each wrapped in its own `<system-reminder>...</system-reminder>` tags. After the round-trip through the provider, they end up as two `system_reminder` content blocks in the user message, and the view renders them as two `📋 [System Reminder]` lines.

We want:
1. When multiple reminders fire on the same user message, combine them into a single `<system-reminder>` block (and therefore a single `system_reminder` content block).
2. Every system reminder (including the bash one) renders with the existing `📋 [System Reminder]` collapsed header. After step 1 there is at most one such header per turn.
3. Preserve the existing "drop user header / no highlighting" behavior when a user message contains only auto-generated content (tool_result + system_reminder, or system_reminder alone). After combining, this naturally becomes "a single system reminder line".

## Relevant files & entities

- `node/core/src/providers/system-reminders.ts` — defines `SKILLS_REMINDER`, `BASH_REMINDER`, `EDL_REMINDER`, `SUBAGENT_REMINDER` body strings and exposes `getSubsequentReminder(threadType, subagentConfig)` and `getBashSummaryReminder(threadType)`. Each currently returns a fully wrapped `<system-reminder>...</system-reminder>` string.
- `node/core/src/thread-core.ts`
  - `sendToolResultsAndContinue`: pushes the subsequent reminder and bash reminder as two separate `{ type: "text" }` blocks via `appendUserMessage`.
  - `prepareUserContent`: pushes the subsequent reminder as a single `system_reminder` content block on every user-submitted message.
- `node/core/src/providers/anthropic-agent.ts` `convertBlockToProvider` — detects text blocks containing `<system-reminder>` and converts them back to `{ type: "system_reminder" }` provider content for display.
- `node/chat/thread-view.ts`
  - `renderMessageContent` `case "system_reminder"`: renders collapsed header `📋 [System Reminder]` and full body when expanded.
  - User-message header suppression block (~line 351): if `message.content.every((c) => c.type === "tool_result" || c.type === "system_reminder")` and at least one is `system_reminder`, drop the `# user:` header and `CursorLine` highlight.
- `node/core/src/providers/system-reminders.test.ts` — unit tests for the reminder builders.
- `node/core/src/thread-core.test.ts` — unit tests for the bash reminder gating in `ThreadCore`.
- `node/chat/system-reminders.test.ts` — driver-level tests asserting reminder text and `📋 [System Reminder]` UI rendering.
- `node/chat/thread.test.ts` — integration tests asserting the structure of message content (e.g. `"user:system_reminder"`).

## Key types

- `ProviderSystemReminderContent = { type: "system_reminder"; text: string }` (in `provider-types.ts`).
- `AgentInput` excludes `system_reminder`; reminders are passed as `text` blocks containing the wrapper tags and re-detected on read.

# Implementation

- [ ] Refactor `system-reminders.ts` to expose a single combined builder.
  - Keep the body constants (`SKILLS_REMINDER`, `BASH_REMINDER`, `EDL_REMINDER`, `SUBAGENT_REMINDER`) as private bodies.
  - Add private body builders, e.g. `getSubsequentReminderBody(threadType, subagentConfig)` and `getBashSummaryReminderBody(threadType)`, that return only the inner body text (no `<system-reminder>` tags) or `undefined`.
  - Add a public `buildSystemReminder({ threadType, subagentConfig, kinds })` that takes the set of reminder kinds requested for this turn (e.g. `"subsequent"`, `"bashSummary"`), assembles the bodies in a stable order, and returns a single `<system-reminder>\n...\n</system-reminder>` string, or `undefined` if nothing applies.
  - Replace the existing `getSubsequentReminder` and `getBashSummaryReminder` exports with this new function (keeping any test seams we still need); update imports in `thread-core.ts`.
  - Testing
    - Behavior: `buildSystemReminder` returns one combined block when multiple kinds are requested.
    - Setup: invoke with `{ threadType: "root", kinds: ["subsequent", "bashSummary"] }`.
    - Actions: call directly.
    - Expected output: a string starting with `<system-reminder>` and ending with `</system-reminder>`, containing the skills/edl/subagent body and the bash-summarizer body, with exactly one open and one close tag.
    - Assertions: `(text.match(/<system-reminder>/g) ?? []).length === 1`, both bodies present.
  - Behavior: kinds outside the thread type's allow-list are skipped.
    - Setup: `{ threadType: "compact", kinds: ["subsequent", "bashSummary"] }` returns `undefined` (compact threads still get only the compact-specific reminder via the existing code path; we keep that path unchanged).
    - Assertions: returns `undefined`.

- [ ] Update `thread-core.ts` to compute reminder kinds and push at most one combined block.
  - In `sendToolResultsAndContinue`, replace the two separate `if` blocks that push reminders with:
    - Build a `kinds: ReminderKind[]` array based on the existing gating (`outputTokensSinceLastReminder >= SYSTEM_REMINDER_MIN_TOKEN_INTERVAL` → push `"subsequent"`; `pendingBashReminder && (firstBashReminderPending || bashTokensSinceLastReminder >= BASH_REMINDER_TOKEN_INTERVAL)` → push `"bashSummary"`).
    - Call `buildSystemReminder({ threadType, subagentConfig, kinds })` once and, if defined, push a single `{ type: "text", text: combined }` content block.
    - Preserve the existing reset side-effects: `reset-output-tokens` only when `"subsequent"` was added; `reset-bash-reminder` only when `"bashSummary"` was added.
  - In `prepareUserContent`, replace the existing call to `getSubsequentReminder` with `buildSystemReminder({ threadType, subagentConfig, kinds: ["subsequent"] })` and continue to push the result as a `{ type: "system_reminder", text }` content block (so the user's typed message message still goes through the normal `system_reminder` path).
  - Compact-thread reminder path (currently inside `getSubsequentReminder("compact")`) should remain functional. Either:
    - Treat `"compact"` as a thread type that maps `"subsequent"` to the compact-specific body inside `buildSystemReminder`, OR
    - Keep a small dedicated `getCompactReminder()` helper and wire it where compact reminders are built. Pick the simpler one once the call sites are visible.
  - Testing
    - Behavior: when both gating conditions trigger on the same auto-respond turn, only one `<system-reminder>` text block appears in the next stream's user message, and it contains both the subsequent body and the bash-summary body.
    - Setup: extend the existing "ThreadCore bash summary reminder" test in `thread-core.test.ts`. Configure the mock so the first stream finishes with enough output tokens to clear `SYSTEM_REMINDER_MIN_TOKEN_INTERVAL` and the bash result is abbreviated.
    - Actions: send a user message; respond with a `bash_command` tool use producing abbreviated output; finish with a high-output-token usage so that subsequent gating also fires.
    - Expected output: the next stream's last user message has exactly one text block containing `<system-reminder>` (count of `<system-reminder>` substrings == 1), and that block contains both `Remember the skills` and `bash_summarizer`.
    - Assertions: count `<system-reminder>` occurrences across all text blocks of the last user message; assert `=== 1`. Assert content includes both markers.

- [ ] Verify `convertBlockToProvider` handles a single combined block correctly (no change expected; just confirm).
  - The detection rule already returns one `system_reminder` content for any text containing `<system-reminder>`, so a combined block becomes a single `system_reminder` content. No code change required.
  - Testing
    - Behavior: a user message text block containing one `<system-reminder>...</system-reminder>` with multiple body sections round-trips into a single `system_reminder` content.
    - Setup: unit test in an existing `anthropic-agent`-level test file (or add a tiny one) that calls `convertBlockToProvider` directly with the combined string.
    - Assertions: the result is `{ type: "system_reminder", text: <combined> }`.

- [ ] Confirm view rendering of a single combined `system_reminder` block.
  - The existing `case "system_reminder"` in `thread-view.ts` already collapses to `📋 [System Reminder]` with `<CR>` to expand; one block ⇒ one collapsed header. No code change required for this point.
  - Testing
    - Behavior: when the model auto-responds with both reminders, the chat displays exactly one `📋 [System Reminder]` line for that turn.
    - Setup: extend `node/chat/system-reminders.test.ts` (or add a new test). Use `withDriver`, send a message, respond with `bash_command` tool use that produces abbreviated output, finish the response with enough output tokens to also fire the subsequent reminder.
    - Actions: drive the auto-respond, then capture the display buffer.
    - Expected output: the display buffer contains exactly one occurrence of `📋 [System Reminder]` for that turn.
    - Assertions: `(displayText.match(/📋 \[System Reminder\]/g) ?? []).length === 1` for the relevant region.

- [ ] Apply the user-header / highlight suppression to system-reminder-only messages.
  - In `node/chat/thread-view.ts`, the existing rule already covers user messages composed of `tool_result` + `system_reminder` (and reminder-only). After step 1 a reminder-only user message will have exactly one `system_reminder` content block, so the existing branch already drops the header.
  - Decide whether we want to extend the suppression to messages whose content is `system_reminder` + `context_update` (auto-generated content blocks during auto-respond can mix these). If yes:
    - Replace the every-check predicate with `(c) => c.type === "tool_result" || c.type === "system_reminder" || c.type === "context_update"`, and keep the `some(c => c.type === "system_reminder")` requirement so we only drop the header when an actual reminder is present.
  - Testing
    - Behavior: a user message containing only a single `system_reminder` block renders without the `# user:` header and without `CursorLine` highlighting; the `📋 [System Reminder]` line is still shown.
    - Setup: `node/chat/system-reminders.test.ts`, drive an auto-respond that yields a reminder-only user message.
    - Assertions: display buffer does not contain `# user:` adjacent to the reminder line; `📋 [System Reminder]` is present.
  - Testing (extension case, only if we adopt the `context_update` change)
    - Behavior: user message with `context_update` + `system_reminder` content also renders without the user header.
    - Setup: add a file to context (so a context update fires), then auto-respond that triggers a subsequent reminder.
    - Assertions: display buffer renders the reminder collapsed and the context-update view, without a `# user:` header for that message.

- [ ] Update existing tests that lock in the old shape.
  - `node/chat/thread.test.ts` content-block expectation list includes `"user:system_reminder"` after each tool_result. Re-check: with combining, when only the bash reminder fires there's still one `system_reminder` block; when both fire there's still one. So the existing string expectations remain valid in single-reminder cases. Update only the cases that asserted two separate reminder blocks (search for any) to expect one.
  - `node/core/src/providers/system-reminders.test.ts` — replace tests of `getSubsequentReminder`/`getBashSummaryReminder` with tests of `buildSystemReminder`.
  - `node/core/src/thread-core.test.ts` — update the existing bash summary reminder tests to use the new combined-block detection helper (count `<system-reminder>` occurrences === 1; assert both bodies present when both fire).
  - Run `npx vitest run` and iterate until green; run `npx tsgo -b` and iterate until clean.
