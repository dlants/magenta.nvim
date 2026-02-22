# context

The goal is to set up auto-compaction so that when a conversation approaches the model's maximum context window size, the thread automatically triggers compaction before the next send, preventing `model_context_window_exceeded` errors.

Currently, compaction is only triggered manually via the `@compact` command in `handleSendMessageMsg`. We want to add a pre-flight check that runs before every `continueConversation()` call: if the current token count exceeds a threshold (e.g. 80% of the model's context window), we trigger compaction instead of sending.

The token count is available via `agent.getState().inputTokenCount`, which is populated asynchronously by `countTokensPostFlight()` in `AnthropicAgent` after each streaming completion. This count reflects the full conversation size as counted by the API, and is the right metric to compare against the context window limit.

## Key design decisions

1. **Use the last known `inputTokenCount` from post-flight** — this is already populated after each streaming completion. We check it before starting the next `continueConversation()`. No new API call needed for the pre-flight check.

2. **Threshold at 80% of context window** — this gives enough room for a final response while still maximizing context usage. This should be configurable but 80% is a good default.

3. **Need a `getContextWindowSize` function** — maps model names to their context window sizes (200K for all current Claude models). Similar to the existing `getMaxTokensForModel` for output tokens.

4. **Check happens in Thread, not Agent** — Thread already manages compaction logic (`startCompaction`). The check goes in `sendMessage` and `sendToolResultsAndContinue` right before calling `agent.continueConversation()`.

5. **After compact-complete, resume normally** — the existing `handleCompactComplete` flow already handles this: it creates a fresh agent and sends the summary + next prompt.

6. **Provider-agnostic threshold check in Thread** — The `Agent` interface exposes `inputTokenCount` via `getState()`. Thread can check this against a context window size derived from the profile's model. Non-Anthropic providers that don't populate `inputTokenCount` simply won't trigger auto-compact (the check is skipped when `inputTokenCount` is undefined).

## Relevant files and entities

- `node/providers/anthropic-agent.ts`: `getMaxTokensForModel()` (line ~1206) — existing function mapping model → max output tokens. We'll add a sibling `getContextWindowForModel()`.
- `node/providers/anthropic-agent.ts`: `AnthropicAgent.countTokensPostFlight()` (line ~427) — populates `inputTokenCount` after streaming
- `node/providers/provider-types.ts`: `AgentState` (line 234) — has `inputTokenCount?: number`
- `node/chat/thread.ts`: `Thread.sendMessage()` — calls `agent.continueConversation()`, needs pre-flight check
- `node/chat/thread.ts`: `Thread.sendToolResultsAndContinue()` — also calls `agent.continueConversation()`, needs pre-flight check
- `node/chat/thread.ts`: `Thread.startCompaction()` — existing compaction trigger
- `node/chat/thread.ts`: `Thread.handleCompactComplete()` — handles post-compaction resume
- `node/options.ts`: `Profile` type (line 49) — could add `autoCompactThreshold` config
- `node/sidebar.ts`: `getInputWindowTitle()` — displays token count, could show auto-compact warning

# implementation

- [x] Add `getContextWindowForModel(model: string): number` function in `anthropic-agent.ts`
  - Place it next to `getMaxTokensForModel`
  - Return 200_000 for all current Claude models (Claude 3+, Claude 4+)
  - Return 100_000 for Claude 2.x
  - Export it for use in Thread

- [x] Add a private `shouldAutoCompact(): boolean` method to `Thread`
  - Read `agent.getState().inputTokenCount`
  - If undefined, return false (no data — non-Anthropic providers or first turn)
  - Get context window size via `getContextWindowForModel(this.state.profile.model)`
  - Return true if `inputTokenCount >= contextWindowSize * 0.80`
  - Never return true if `this.state.threadType === "compact"` (compact threads must not self-compact)

- [x] Add auto-compact check to `Thread.sendMessage()`
  - **Placement**: after preparing content and context updates, but BEFORE calling `agent.appendUserMessage()` and `agent.continueConversation()`
  - This way the new user message is NOT yet in the agent's messages, keeping the compaction summary clean
  - If `shouldAutoCompact()` returns true:
    - Reconstruct the raw user text from `inputMessages` to pass as `nextPrompt`
    - Call `startCompaction(nextPrompt)` — this renders current messages to markdown and spawns the compact thread
    - Return early (don't append or continue)
  - After compaction completes, `handleCompactComplete` creates a fresh agent, sends the summary, then sends `nextPrompt` through normal `sendMessage` — which will re-prepare content and context updates

- [x] Add auto-compact check to `Thread.sendToolResultsAndContinue()`
  - **Placement**: after sending tool results to the agent (they must be sent — Anthropic requires tool_results for tool_use blocks), but BEFORE calling `agent.continueConversation()`
  - The tool results are now in the conversation and will be included in the compaction summary
  - If `shouldAutoCompact()` returns true:
    - Call `startCompaction()` with no `nextPrompt` — the default "please continue" message will be sent after compaction
    - Return early
  - Note: `pendingMessages` need to be preserved. If we're auto-compacting, stash them back into `this.state.pendingMessages` so they survive the compaction and get sent after resume

- [x] Run type checks (`npx tsc --noEmit`) and iterate until clean

- [ ] Manually test auto-compaction
  - Run a long conversation until token count approaches 80% of 200K
  - Verify compaction triggers automatically before the next send
  - Verify the conversation resumes correctly after compaction
  - Verify compact threads don't self-compact
  - Verify non-Anthropic providers (where `inputTokenCount` is undefined) don't trigger auto-compact
  - Verify that pending messages survive auto-compaction and get sent after resume
