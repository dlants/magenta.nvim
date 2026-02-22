# context

The goal is to enforce the Anthropic API constraint that every `tool_use` block in an assistant message must be followed by a corresponding `tool_result` in a user message before the conversation can continue. Currently:

1. **The mock (`MockAnthropicClient`)** does not validate this constraint, so tests can accidentally violate it without catching bugs.
2. **Malformed tool_use blocks** (where `validateInput` fails) are silently skipped in `thread.ts:handleProviderStoppedWithToolUse` — no error `tool_result` is ever sent back, which would cause an API error with the real Anthropic API.

## Relevant files and entities

- `node/providers/mock-anthropic-client.ts`: `MockAnthropicClient.messages.stream()` — where we need to add the constraint validation. When a new stream is created, it should check that the messages being sent satisfy the tool_use → tool_result invariant.
- `node/providers/anthropic-agent.ts`: `AnthropicAgent` — the real agent. `convertBlockToProvider()` is where `validateInput` is called and malformed blocks get `request.status === "error"`.
- `node/chat/thread.ts`: `handleProviderStoppedWithToolUse()` (line ~510) — currently does `continue` for `block.request.status !== "ok"`, silently dropping malformed blocks. Also `handleCompactAgentToolUse()` (line ~788) has the same pattern.
- `node/providers/provider-types.ts`: `ProviderToolUseContent` — the `request` field is `Result<ToolRequest, { rawRequest: unknown }>`.
- `node/tools/helpers.ts`: `validateInput()` — dispatches to per-tool validators, returns `Result`.
- `node/providers/anthropic-agent.test.ts`: Test file for the agent — where we'll add malformed tool tests.

## Key constraint

The Anthropic API requires that if an assistant message contains `tool_use` blocks, the next user message must contain a `tool_result` for **every** `tool_use` block (by matching `tool_use_id`). The conversation cannot continue (no new streaming request) until all tool results are provided.

# implementation

- [ ] **Step 1: Add tool_use → tool_result constraint to MockAnthropicClient**
  - [ ] In `MockAnthropicClient.messages.stream()`, before creating the `MockStream`, validate that the `params.messages` satisfy the constraint: for every assistant message containing `tool_use` blocks, the immediately following user message must contain a `tool_result` for each `tool_use.id`.
  - [ ] Write a helper function `validateToolUseConstraint(messages: Anthropic.MessageParam[]): void` that throws a descriptive error if the constraint is violated.
  - [ ] Check for type errors and iterate until they pass.

- [ ] **Step 2: Handle malformed tool_use blocks in thread.ts**
  - [ ] In `handleProviderStoppedWithToolUse()`, instead of `continue`-ing past `block.request.status !== "ok"`, immediately send an error `tool_result` back to the agent via `this.agent.toolResult(block.id, errorResult)`. The error message should include the validation error from `block.request.error`.
  - [ ] Apply the same fix in `handleCompactAgentToolUse()` for compact threads.
  - [ ] Check for type errors and iterate until they pass.

- [ ] **Step 3: Run existing tests, fix any failures from the new constraint**
  - [ ] Run `npx vitest run` and check if any existing tests now fail because they were violating the tool_use → tool_result constraint.
  - [ ] Fix any failing tests by ensuring they provide proper tool_results before continuing.
  - [ ] Iterate until all tests pass.

- [ ] **Step 4: Write tests for malformed tool_use handling**
  - [ ] In `node/providers/anthropic-agent.test.ts`, add a test that streams a tool_use block with invalid input (e.g. `get_file` with missing `filePath`), verifies that the converted `ProviderMessage` has `request.status === "error"`.
  - [ ] Write an integration test (or amend an existing one) that exercises the full flow: mock provider sends a malformed tool_use → thread handles it → error tool_result is sent back → agent can continue.
  - [ ] Iterate until all tests pass.
