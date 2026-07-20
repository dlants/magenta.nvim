# Objective and Context

Add a `@next` message prefix that sends the message when the agent next stops. It should work like `@async`, except instead of being injected into the current turn at the earliest opportunity (e.g. mid-turn after the current tool batch completes), it waits until the next time the agent fully stops (end_turn).

## Key entities

- `ThreadCore` (`node/core/src/thread-core.ts`) — orchestrates the agent. Holds `state.pendingMessages: InputMessage[]`, the queue that backs `@async`.
- `maybeAutoRespond()` (thread-core.ts ~1143) — the decision point. Two relevant branches:
  - `mode.type === "tool_use"`: drains `pendingMessages` and passes them to `sendToolResultsAndContinue`, i.e. injects them **mid-turn** after the current tool batch. This is why `@async` can land before the agent stops.
  - `agentStatus.type === "stopped" && stopReason === "end_turn" && pendingMessages.length`: drains `pendingMessages` and calls `sendMessage`, i.e. sends after the agent has stopped.
- `handleSendMessageRequest(messages, isAsync?)` (thread-core.ts ~1102) — when busy and `isAsync`, does `push-pending-messages` (silent). Otherwise aborts current work and sends immediately.
- Reducer actions `push-pending-messages` / `drain-pending-messages` (thread-core.ts ~510) mutate `state.pendingMessages`.
- Rollback paths that consume `pendingMessages`: `handleErrorState` (~873) and `recoverPendingMessagesOnAbort` (~1008).
- Root plumbing:
  - `Magenta.preprocessAndSend` (`node/magenta.ts` ~1128) parses `@compact` / `@async`, sets `async: true` on the `send-message` thread-msg.
  - `Thread` `Msg` union + `myUpdate` (`node/chat/thread.ts` ~60, ~748) carries `async?` through to `core.handleSendMessageRequest`.
  - `CommandRegistry.processMessage` (`node/chat/commands/registry.ts` ~106) strips `@async` before command expansion.
  - `lua/magenta/completion/keywords.lua` — completion entry for `@async`.

## Relevant files

- `node/core/src/thread-core.ts` — core queue + auto-respond logic.
- `node/magenta.ts` — `@next` prefix detection.
- `node/chat/thread.ts` — `send-message` msg plumbing.
- `node/chat/commands/registry.ts` — prefix stripping before command expansion.
- `lua/magenta/completion/keywords.lua` — completion entry.
- `node/chat/thread.test.ts` — existing `@async` queueing tests to model `@next` tests after.

# Design

Introduce a second queue in `ThreadCore.state`: `pendingNextMessages: InputMessage[]`, distinct from `pendingMessages`. `@next` messages go into `pendingNextMessages`; `@async` messages continue to go into `pendingMessages`.

The only behavioral difference is *when* each queue drains inside `maybeAutoRespond`:

- The `tool_use` branch continues to drain **only** `pendingMessages` into `sendToolResultsAndContinue` — `pendingNextMessages` is left untouched so it is not injected mid-turn.
- The `end_turn` stopped branch drains **both** `pendingMessages` and `pendingNextMessages` (concatenated, async first then next) and sends them via `sendMessage`. Its guard changes from `pendingMessages.length` to `pendingMessages.length || pendingNextMessages.length`.

`handleSendMessageRequest` gains a way to distinguish the two. Rather than a second boolean, model the queue target as a single optional `queue?: "async" | "next"` param (keeping `isAsync` semantics readable). When busy and `queue` is set, push into the corresponding array; when not busy, send immediately as today (if the agent is already stopped, "next stop" is now).

Root plumbing mirrors `@async`: detect `@next` prefix in `preprocessAndSend`, strip it in `CommandRegistry.processMessage`, thread a `next?: boolean` (or reuse a `queue` discriminator) through the `send-message` `Msg`, and add a completion keyword.

Rollback paths (`handleErrorState`, `recoverPendingMessagesOnAbort`) should also account for `pendingNextMessages` so queued `@next` text is recovered into the input on error/abort, matching `@async` behavior.

Alternatives considered: a single queue with a per-message `deferToStop` flag. Rejected because the drain sites filter by phase, and two arrays keep the drain logic trivial (whole-array drains) and avoid partial-array bookkeeping.

Invariants:

- A `@next` message must never be sent while the agent is still streaming or in a tool-use turn — only after a full stop (end_turn) or if the agent was already stopped when submitted.
- `@async` behavior is unchanged: it may still be injected mid-turn via the tool_use branch.
- On abort/error, queued `@next` messages are recovered into the input buffer (not silently dropped), consistent with `@async`.
- Ordering when both queues have content at a stop: async messages precede next messages (or a deliberate, documented order).

# Stages

## core queue + drain logic

- Goal: `ThreadCore` supports a separate `pendingNextMessages` queue that only drains when the agent stops, exposed via `handleSendMessageRequest`.
- Changes: add `pendingNextMessages` to state + init; add reducer actions to push/drain it; update `handleSendMessageRequest` to route `@next` into it when busy; update `maybeAutoRespond` (tool_use branch drains async only; end_turn branch drains both); update `handleErrorState` and `recoverPendingMessagesOnAbort` to recover it.
- Tests (in `node/core` or `node/chat/thread.test.ts`, modeled on existing `@async` queue tests ~215/246/1577):
  - Queue a `@next` message while a tool call is in flight; assert it is NOT sent when that tool batch completes and the turn continues, and IS sent only after the agent reaches end_turn.
  - Contrast: an `@async` message queued in the same situation is injected when the tool batch completes (existing behavior preserved).
  - `@next` submitted while the agent is already stopped sends immediately.
  - Abort while a `@next` message is queued recovers its text into the input.

## root plumbing + completion

- Goal: typing `@next ...` in the input reaches `handleSendMessageRequest` with the next-queue routing, and `@next` autocompletes.
- Changes: detect/strip `@next` in `preprocessAndSend` and `CommandRegistry.processMessage`; carry the discriminator through `Thread` `Msg` + `myUpdate`; add `@next` to `keywords.lua`.
- Tests:
  - `registry.test.ts`: `@next do something` strips the prefix from processed text (mirror the `@async` test ~141).
  - An end-to-end/thread-level test (mirroring existing `@async` in-flight tests) that a `@next`-prefixed input queues and fires on the next stop.
