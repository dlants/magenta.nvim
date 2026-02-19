# context

The goal is to use Anthropic's `client.messages.countTokens()` API to get accurate context window sizes, instead of summing the usage fields from the last response. This is needed because web search `encrypted_content` blobs are not reflected in the standard usage metrics, making the reported token count inaccurate when web search results are present.

Currently, the token count displayed in the input window title bar comes from `Thread.getLastStopTokenCount()` (thread.ts:1202), which sums `inputTokens + outputTokens + cacheHits + cacheMisses` from `agent.getState().latestUsage`. This is inaccurate for two reasons:

1. Web search encrypted content isn't counted
2. It reflects the _last_ response's usage, not the _current_ context size (which grows as tool results come in)

The plan is to call `countTokens` as a **post-flight** after every streaming completion. After the agent finishes streaming and the full messages array is available, we count tokens on the entire conversation to know how large the _next_ request will be. This keeps `continueConversation` synchronous and gives the user an accurate "current context size" while composing their next message.

## Relevant files and entities

- `node/providers/provider-types.ts`: `Agent` interface (line 252), `AgentState` (line 234), `Usage` type (line 37), `AgentMsg` (line 247)
- `node/providers/anthropic-agent.ts`: `AnthropicAgent` class — implements `Agent`, has `continueConversation()` (line 431), the `stream-completed` action handler, stores `latestUsage`, has access to `this.client` and `this.params`
- `node/chat/thread.ts`: `Thread` class — has `getLastStopTokenCount()` (line 1202)
- `node/sidebar.ts`: `Sidebar` class — displays token count via `getTokenCount` callback (line 158), shown in input window title
- `node/magenta.ts`: passes `getTokenCount` callback to Sidebar (line 100-115)
- Anthropic SDK: `client.messages.countTokens({ messages, model, system, tools, thinking, tool_choice })` returns `{ input_tokens: number }`

# implementation

- [x] Add `inputTokenCount` field to `AgentState` in `provider-types.ts`
  - `inputTokenCount?: number` — the total input tokens for the current conversation (as counted by the API)

- [x] Implement post-flight `countTokens` in `AnthropicAgent`
  - Add a private `countTokensPostFlight()` async method
  - Calls `this.client.messages.countTokens()` with `this.params` + `this.messages`
  - Stores result in a `private inputTokenCount: number | undefined` field
  - On error, log a warning and leave the field unchanged
  - Dispatches `agent-content-updated` when done so the UI refreshes

- [x] Call `countTokensPostFlight()` in the `stream-completed` action handler
  - Fire-and-forget (no need to await — the stream is already done)
  - Also call it in `stream-error` and `stream-aborted` since the messages array is still valid

- [x] Expose `inputTokenCount` in `getState()`
  - Add it to the returned `AgentState` object

- [x] Update `Thread.getLastStopTokenCount()` to prefer `inputTokenCount`
  - If `agent.getState().inputTokenCount` is available, return it
  - Fall back to the current sum-of-usage calculation if not

- [x] Run type checks (`npx tsc --noEmit`) and iterate until clean

- [x] Test manually with web search to verify the token count is now accurate and stable across turns
  - Confirmed: the `usage` field from streaming responses still shows a spike during web search (expected — encrypted content inflates that response's usage), but `countTokens` reports consistent values across turns. The implementation is correct.
