# Tool Render Refactor Guide

Move render functions from `node/tools/<tool>.ts` to `node/render-tools/<tool>.ts`.

## Steps for each tool

### 1. Create `node/render-tools/<tool>.ts`

- Copy all `render*` functions and any private helper functions used only by them.
- Add imports for what the render functions need (e.g. `d`, `VDOMNode`, `DisplayContext`, `CompletedToolInfo`, `ToolRequest as UnionToolRequest` from `../tools/types.ts`, plus any tool-specific types like file path utils).
- For the tool's `Input` type: redefine it locally in the render file (don't import from the tool file) to keep the dependency one-directional.
- Export the render functions, keep helpers private.

### 2. Remove render code from `node/tools/<tool>.ts`

- Delete all `render*` functions and their private helpers.
- Clean up imports that are now unused (e.g. `d`, `withInlineCode`, `VDOMNode`, `DisplayContext`, `UnionToolRequest`).

### 3. Update `node/tools/toolManager.ts`

- Add `import * as <Tool>Render from "../render-tools/<tool>.ts";`
- Replace `<Tool>.render*` calls with `<Tool>Render.render*` calls in the switch statements.

### 4. Verify

- `npx tsc --noEmit` should produce no errors.

## Render functions by tool

| Tool               | InFlightSummary | InFlightPreview | InFlightDetail | CompletedSummary | CompletedPreview | CompletedDetail |
| ------------------ | :-------------: | :-------------: | :------------: | :--------------: | :--------------: | :-------------: |
| getFile            |       ✅        |        —        |       —        |        ✅        |        —         |       ✅        |
| hover              |       ✅        |        —        |       —        |        ✅        |        —         |        —        |
| findReferences     |       ✅        |        —        |       —        |        ✅        |        —         |        —        |
| diagnostics        |       ✅        |        —        |       —        |        ✅        |        —         |        —        |
| bashCommand        |       ✅        |       ✅        |       ✅       |        ✅        |        ✅        |       ✅        |
| thread-title       |       ✅        |        —        |       —        |        ✅        |        —         |        —        |
| spawn-subagent     |       ✅        |       ✅        |       —        |        ✅        |        ✅        |       ✅        |
| spawn-foreach      |       ✅        |       ✅        |       —        |        ✅        |        ✅        |       ✅        |
| wait-for-subagents |       ✅        |       ✅        |       —        |        ✅        |        —         |        —        |
| yield-to-parent    |       ✅        |        —        |       —        |        ✅        |        —         |        —        |
| edl                |       ✅        |        —        |       —        |        ✅        |        ✅        |       ✅        |
| mcp/tool           |       ✅        |        —        |       —        |        ✅        |        —         |        —        |

## Progress types to move

Some tools export Progress types used only in rendering. These should move to the render file:

- `bashCommand`: `BashProgress`, `RenderContext`
- `spawn-subagent`: `SpawnSubagentProgress`
- `spawn-foreach`: `SpawnForeachProgress`, `SpawnForeachElementProgress`
- `wait-for-subagents`: `WaitForSubagentsProgress`
- `mcp/tool`: `MCPProgress`

Check if these types are also used in the tool execution code before moving — if shared, keep them in the tool file and import into the render file.

## Final step: move toolManager render code to `node/render-tools/index.ts`

After all tools are done, move these from `toolManager.ts`:

- `RenderContext` type
- `isError` helper
- `renderInFlightToolSummary`
- `renderInFlightToolPreview`
- `renderInFlightToolDetail`
- `renderCompletedToolSummary`
- `renderCompletedToolPreview`
- `renderCompletedToolDetail`

Update `node/chat/thread.ts` to import from `../render-tools/index.ts` instead of `../tools/toolManager.ts`.
