# Blocking Subagent Dialogues - Surface Pending Approvals in Parent Thread

## Context

**Objective**: When a parent thread is waiting on a subagent (via `spawn_subagent`, `wait_for_subagents`, or `spawn_foreach`), and the subagent is blocked on user approval (e.g. bash command, edl, getFile), show that approval dialog directly in the parent thread's view. This avoids the user needing to navigate to the subagent thread to approve/deny actions.

### Key Insight

Each subagent tool's `renderSummary()` already has `withBindings` that dispatch through the tool's `myDispatch`, which routes: subagent tool → subagent thread → root dispatch. So we can embed the subagent tool's `renderSummary()` directly in the parent thread's view, and the buttons will dispatch correctly without any new dispatch paths.

### Subagents Cannot Spawn Subagents

Subagents do not have access to the `spawn_subagent`, `wait_for_subagents`, or `spawn_foreach` tools. This means we only need to handle one level of nesting — a parent thread's subagent tools checking their direct subagent threads for pending approvals. There is no recursive case to worry about.

### Rendering is Reactive

Every dispatch through `Magenta.dispatch` triggers a full re-render of the current view. Since the parent tool's `renderSummary()` will read the subagent thread's tool state via `Chat`, the parent view will automatically show/hide approval buttons as subagent tools transition in/out of `pending-user-action` state.

### Relevant Files

- `node/chat/chat.ts`: `Chat` class with `getThreadSummary()` (lines 960-1059), `notifyParent()` (lines 1060-1139), and `threadWrappers` map
- `node/chat/thread.ts`: `Thread` class with `ConversationMode` (lines 164-173), `activeTools` map, `playChimeIfNeeded` (lines 1008-1015)
- `node/tools/spawn-subagent.ts`: `SpawnSubagentTool` with `renderSummary()` (lines 270-334), `isPendingUserAction()` (line 118, returns false)
- `node/tools/wait-for-subagents.ts`: `WaitForSubagentsTool` with `renderSummary()` (lines 196-216), `renderThreadStatus()` (lines 218-269), `isPendingUserAction()` (line 127, returns false)
- `node/tools/spawn-foreach.ts`: `SpawnForeachTool` with `renderSummary()` (lines 485-544), `renderElementWithThread()` (lines 432-483), `isPendingUserAction()` (line 191, returns false)
- `node/tools/bashCommand.ts`: `BashCommandTool` with pending-user-action rendering (lines 860-900) using `withBindings` for `[NO] [YES] [ALWAYS]`
- `node/tools/edl.ts`: `EdlTool` with pending-user-action rendering using `[NO] [YES]`
- `node/tools/getFile.ts`: `GetFileTool` with pending-user-action rendering using `[NO] [YES]`
- `node/tools/types.ts`: `Tool` and `StaticTool` interfaces with `isPendingUserAction(): boolean` and `renderSummary(): VDOMNode`
- `node/tools/create-tool.ts`: Factory that creates tools with wrapped dispatch (lines 66-195)

### Key Types

```typescript
// Tool/StaticTool interface (from types.ts)
interface Tool {
  isPendingUserAction(): boolean;
  renderSummary(): VDOMNode;
  // ...
}

// Thread's ConversationMode (from thread.ts)
type ConversationMode =
  | { type: "normal" }
  | { type: "tool_use"; activeTools: Map<ToolRequestId, Tool | StaticTool> }
  | { type: "control_flow"; operation: ControlFlowOp }
  | { type: "awaiting_control_flow"; pendingOp: "compact"; nextPrompt: string };

// getThreadSummary return type (from chat.ts)
{ title?: string; status:
  | { type: "missing" }
  | { type: "pending" }
  | { type: "running"; activity: string }
  | { type: "stopped"; reason: string }
  | { type: "yielded"; response: string }
  | { type: "error"; message: string }
}
```

## Implementation

- [ ] **Step 0: Reformat approval dialogs to use vertical layout**
  - [ ] In `node/tools/bashCommand.ts` (renderSummary, pending-user-action case ~line 862): Replace the box-art horizontal layout (`┌───┐ │ [NO] [YES] [ALWAYS] │ └───┘`) with vertical `> ` prefixed lines:
    ```
    > NO
    > YES
    > ALWAYS
    ```
    Each line is its own `withBindings`/`withExtmark` block. Remove all box-drawing characters.
  - [ ] In `node/tools/edl.ts` (renderSummary, pending-user-action case ~line 394): Same change but only `> NO` and `> YES` (no ALWAYS)
  - [ ] In `node/tools/getFile.ts` (renderSummary, pending-user-action case ~line 719): Same change but only `> NO` and `> YES`
  - [ ] Run `npx tsc --noEmit` and fix any type errors

- [ ] **Step 1: Add `getThreadPendingApprovalTools` method to `Chat`**
  - [ ] In `node/chat/chat.ts`, add a new method to the `Chat` class:
    ```typescript
    getThreadPendingApprovalTools(threadId: ThreadId): (Tool | StaticTool)[] {
      const wrapper = this.threadWrappers[threadId];
      if (!wrapper || wrapper.state !== "initialized") return [];
      const mode = wrapper.thread.state.mode;
      if (mode.type !== "tool_use") return [];
      const result: (Tool | StaticTool)[] = [];
      for (const [, tool] of mode.activeTools) {
        if (tool.isPendingUserAction()) {
          result.push(tool);
        }
      }
      return result;
    }
    ```
  - [ ] Run `npx tsc --noEmit` and fix any type errors

- [ ] **Step 2: Create shared rendering helper**
  - [ ] Create `node/tools/render-pending-approvals.ts` with a helper function:

    ```typescript
    import type { Chat } from "../chat/chat.ts";
    import type { ThreadId } from "../chat/types.ts";
    import { d, type VDOMNode } from "../tea/view.ts";

    export function renderPendingApprovals(
      chat: Chat,
      threadId: ThreadId,
    ): VDOMNode | undefined {
      const tools = chat.getThreadPendingApprovalTools(threadId);
      if (tools.length === 0) return undefined;
      return d`${tools.map((t) => d`\n${t.renderSummary()}`)}`;
    }
    ```

  - [ ] Run `npx tsc --noEmit` and fix any type errors

- [ ] **Step 3: Update `getThreadSummary` to distinguish pending-user-action**
  - [ ] In `node/chat/chat.ts`, in the `getThreadSummary` method, when `mode.type === "tool_use"`, check if any active tool has `isPendingUserAction()`. If so, return activity `"waiting for approval"` instead of `"executing tools"`:
    ```typescript
    if (mode.type === "tool_use") {
      let hasPendingApproval = false;
      for (const [, tool] of mode.activeTools) {
        if (tool.isPendingUserAction()) {
          hasPendingApproval = true;
          break;
        }
      }
      return {
        type: "running" as const,
        activity: hasPendingApproval
          ? "waiting for approval"
          : "executing tools",
      };
    }
    ```
  - [ ] Run `npx tsc --noEmit` and fix any type errors

- [ ] **Step 4: Update `SpawnSubagentTool` rendering and `isPendingUserAction`**
  - [ ] In `node/tools/spawn-subagent.ts`:
    - Import `renderPendingApprovals` from `./render-pending-approvals.ts`
    - In `renderSummary()`, in the `"waiting-for-subagent"` case, when status is `"running"`, call `renderPendingApprovals(this.context.chat, this.state.threadId)` and append the result after the status line if non-empty
    - Update `isPendingUserAction()`: when in `"waiting-for-subagent"` state, return `this.context.chat.getThreadPendingApprovalTools(this.state.threadId).length > 0`
  - [ ] Run `npx tsc --noEmit` and fix any type errors

- [ ] **Step 5: Update `WaitForSubagentsTool` rendering and `isPendingUserAction`**
  - [ ] In `node/tools/wait-for-subagents.ts`:
    - Import `renderPendingApprovals` from `./render-pending-approvals.ts`
    - In `renderThreadStatus()`, when status is `"running"`, call `renderPendingApprovals(this.context.chat, threadId)` and append the result after the status text if non-empty
    - Update `isPendingUserAction()`: when in `"waiting"` state, check if any thread in `this.request.input.threadIds` has pending approval tools via `chat.getThreadPendingApprovalTools()`
  - [ ] Run `npx tsc --noEmit` and fix any type errors

- [ ] **Step 6: Update `SpawnForeachTool` rendering and `isPendingUserAction`**
  - [ ] In `node/tools/spawn-foreach.ts`:
    - Import `renderPendingApprovals` from `./render-pending-approvals.ts`
    - In `renderElementWithThread()`, when status is `"running"`, call `renderPendingApprovals(this.context.chat, threadId)` and append the result after the status text if non-empty
    - Update `isPendingUserAction()`: when in `"running"` state, check if any running element's thread has pending approval tools
  - [ ] Run `npx tsc --noEmit` and fix any type errors

- [ ] **Step 7: Unit tests**
  - [ ] Create `node/tools/render-pending-approvals.test.ts`
  - [ ] Test `renderPendingApprovals()` returns `undefined` when no tools are pending
  - [ ] Test `renderPendingApprovals()` returns VDOMNodes when tools are pending
  - [ ] Test that `isPendingUserAction()` on subagent tools correctly delegates to checking subagent threads
  - [ ] Test that `getThreadSummary()` returns `"waiting for approval"` activity when tools are pending
  - [ ] Run tests and iterate until they pass

- [ ] **Step 8: Integration testing**
  - [ ] Manually verify: start a subagent that runs a bash command requiring approval
  - [ ] Verify the approval buttons appear in the parent thread view
  - [ ] Verify selecting yes / no correctly routes the action to the subagent tool
  - [ ] Verify the approval buttons disappear from the parent view after approval
