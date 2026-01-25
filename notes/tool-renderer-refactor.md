# Tool Renderer Refactor Pattern

## Status: ✅ COMPLETE

The refactor has been completed. `tool-renderers.ts` has been deleted and its contents merged into `toolManager.ts`.

## Goal

Colocate rendering functions for each tool inside the tool files, ensuring identical rendering between:

- The tool controller's `renderSummary()` method (for done state)
- The `toolManager.ts` `renderCompletedToolSummary()` function

## Pattern Established with `getFile.ts`

### 1. Add imports to tool file

```typescript
import type { VDOMNode } from "../tea/view.ts";
import type { CompletedToolInfo } from "./tool-renderers.ts";
```

### 2. Create exported render function in tool file

```typescript
export function renderCompletedSummary(info: CompletedToolInfo): VDOMNode {
  const input = info.request.input as Input;
  const result = info.result.result;

  if (result.status === "error") {
    return d`...error rendering...`;
  }

  return d`...success rendering...`;
}
```

### 3. Extract helper functions (if needed)

Move format helpers outside the class so they can be shared:

```typescript
function formatGetFileDisplay(input: Input): VDOMNode {
  // formatting logic
}
```

### 4. Update the tool class to use the shared function

```typescript
renderSummary() {
  switch (this.state.state) {
    // ... other states ...
    case "done":
      return renderCompletedSummary({
        request: this.request as CompletedToolInfo["request"],
        result: this.state.result,
      });
  }
}
```

Note: The cast `as CompletedToolInfo["request"]` is needed because the local `ToolRequest` type is more specific than the generic one.

### 5. Update tool-renderers.ts

```typescript
// Import the function with an alias matching the expected name
import { renderCompletedSummary as renderGetFileSummary } from "./getFile.ts";

// Remove the local implementation
// Keep a comment noting where the implementation lives
// ============================================================================
// get_file renderers - imported from ./getFile.ts
// ============================================================================
```

## Files Refactored

All tools now have `renderCompletedSummary` colocated in their respective files:

- ✅ get_file
- ✅ insert
- ✅ replace
- ✅ list_directory
- ✅ bash_command
- ✅ hover
- ✅ find_references
- ✅ diagnostics
- ✅ spawn_subagent
- ✅ spawn_foreach
- ✅ wait_for_subagents
- ✅ yield_to_parent
- ✅ fork_thread
- ✅ thread_title
- ✅ inline_edit
- ✅ replace_selection
- ✅ predict_edit

`CompletedToolInfo` type moved to `types.ts`. Dispatcher functions moved to `toolManager.ts`.
