# Context

The goal is to simplify `ProviderThreadStatus` to not include magenta-specific states (`tool_use`, `yielded`), and instead introduce an explicit `ConversationState` in `thread.ts` that derives these states from the provider thread.

## Current State

`ProviderThreadStatus` in `provider-types.ts`:

```typescript
export type ProviderThreadStatus =
  | { type: "idle" }
  | { type: "streaming"; startTime: Date }
  | { type: "stopped"; stopReason: StopReason }
  | {
      type: "tool_use";
      pendingTools: Map<ToolRequestId, ProviderToolUseContent>;
    } // magenta-specific
  | { type: "yielded"; response: string } // magenta-specific
  | { type: "error"; error: Error };
```

The `tool_use` and `yielded` states are magenta-specific concepts that should not be in the provider abstraction.

## Target State

**`ProviderThreadStatus`** (simplified - provider-level only):

```typescript
export type ProviderThreadStatus =
  | { type: "idle" }
  | { type: "streaming"; startTime: Date }
  | { type: "stopped"; stopReason: StopReason }
  | { type: "error"; error: Error };
```

**`ConversationState`** (new - in thread.ts):

```typescript
export type ConversationState =
  | { type: "idle" }
  | { type: "streaming"; startTime: Date }
  | { type: "stopped"; stopReason: StopReason }
  | { type: "tool_use"; activeTools: Map<ToolRequestId, Tool | StaticTool> }
  | { type: "yielded"; response: string }
  | { type: "error"; error: Error };
```

## Relevant Files

- `node/providers/provider-types.ts`: Remove `tool_use` and `yielded` from `ProviderThreadStatus`
- `node/providers/anthropic-thread.ts`: Update to not compute `tool_use`/`yielded`, just use `stopped` with appropriate stopReason
- `node/chat/thread.ts`: Introduce `ConversationState`, compute it from provider status, move activeTools under it
- `node/chat/chat.ts`: Update to use `thread.getConversationState()` instead of `thread.getStatus()`

# Implementation

- [ ] **Step 1: Update `ProviderThreadStatus` in `provider-types.ts`**
  - [ ] Remove `tool_use` and `yielded` variants from `ProviderThreadStatus`
  - [ ] Run type check to see what breaks

- [ ] **Step 2: Update `anthropic-thread.ts`**
  - [ ] Remove `extractPendingTools` method
  - [ ] Remove `yield_to_parent` detection logic
  - [ ] When `stopReason === "tool_use"`, just set status to `{ type: "stopped", stopReason: "tool_use" }`
  - [ ] Run type check

- [ ] **Step 3: Introduce `ConversationState` in `thread.ts`**
  - [ ] Define `ConversationState` type
  - [ ] Add `conversationState` to thread state, replacing `activeTools` at top level
  - [ ] Add `getConversationState()` method
  - [ ] Update `handleProviderThreadAction` to compute `ConversationState`:
    - When provider status is `stopped` with `stopReason: "tool_use"`:
      - Extract tool_use blocks from last assistant message
      - Check for `yield_to_parent` tool
      - Initialize active tools
      - Set conversationState to `tool_use` or `yielded`
    - For other statuses, map directly
  - [ ] Run type check

- [ ] **Step 4: Update thread.ts view and methods**
  - [ ] Update `getStatus()` to return `ConversationState` (or rename to `getConversationState()`)
  - [ ] Update `view` function to use `conversationState`
  - [ ] Update `maybeAutoRespond` to use `conversationState`
  - [ ] Update all references to `this.state.activeTools` to use `conversationState.activeTools`
  - [ ] Run type check

- [ ] **Step 5: Update chat.ts**
  - [ ] Update `getThreadSummary` to use the new conversation state
  - [ ] Update `getThreadResult` to use the new conversation state
  - [ ] Update parent notification logic
  - [ ] Run type check

- [ ] **Step 6: Final cleanup**
  - [ ] Run full type check: `npx tsc --noEmit`
  - [ ] Run tests: `npx vitest run`
  - [ ] Iterate until all pass
