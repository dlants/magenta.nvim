# Context

**Objective**: Add a `use_skill` tool — a single static tool that dispatches to configured skill executables. Each executable is a CLI that returns docs when called with no args, and executes when called with a JSON string arg.

**Design:**

- Single static tool `use_skill` with input `{ toolName: string, params?: Record<string, unknown> }`
- If `params` omitted, returns usage docs (from config description or by calling executable with no args)
- Tool description is dynamically assembled from config (name + description per skill)
- Each skill is an executable: receives JSON as argv (last argument), writes JSON result to stdout
- No args → prints usage docs; with JSON arg → executes and returns result
- Execution via `child_process.spawn` (no shell) with command array for flexibility
- Configuration via ~/.magenta/options.json or .magenta/options.json:
  ```json
  {
    "toolSkills": {
      "host": [
        {
          "name": "skill-name",
          "description": "what it does",
          "command": ["/path/to/exe"]
        }
      ],
      "docker": [
        {
          "name": "other-skill",
          "description": "what it does",
          "command": ["node", "/path/to/script.js"]
        }
      ]
    }
  }
  ```
- Host always runs the executable locally; docker agents get access transparently

**Relevant files:**

- `node/options.ts` — `MagentaOptions` type (~163), `parseProjectOptions` (~1455), `mergeOptions` (~1656)
- `node/core/src/provider-options.ts` — `ProviderOptions` (what core sees)
- `node/core/src/tools/tool-registry.ts` — `STATIC_TOOL_NAMES`, capability sets
- `node/core/src/tools/toolManager.ts` — `getToolSpecs()`, `TOOL_SPEC_MAP`, `StaticToolMap`
- `node/core/src/tools/create-tool.ts` — `createTool()` dispatch, `CreateToolContext`
- `node/core/src/tools/helpers.ts` — `validateInput()`
- `node/core/src/thread-core.ts` — agent context, tool spec generation
- `node/chat/chat.ts` — `createThreadWithContext`, Thread wiring
- `node/core/src/providers/provider-types.ts` — `ProviderToolSpec`, `ProviderToolResult`

**Pattern**: Since this is a static tool with a dynamic description, it follows the same pattern as other static tools (like `bash_command`) — it gets its own module in `node/core/src/tools/`, is added to `STATIC_TOOL_NAMES`, and wired into `createTool`. The only special part is the tool spec description is generated at runtime from the configured executables.

# Implementation

- [x] **Step 1: Options layer**
  - [ ] Add `ToolSkillConfig` type: `{ name: string, description: string, command: string[] }`
  - [ ] Add `toolSkills?: { host?: ToolSkillConfig[], docker?: ToolSkillConfig[] }` to `MagentaOptions` in `node/options.ts`
  - [ ] Add parsing in `parseProjectOptions` for the new field
  - [ ] Add merging in `mergeOptions` (concatenate arrays, deduplicate by name)
  - [ ] Add `toolSkills` to `ProviderOptions` in `node/core/src/provider-options.ts`
  - [ ] Run type checks (`npx tsgo -b`)

- [x] **Step 2: Skill executable protocol**
  - [ ] Create `node/core/src/tools/skill/types.ts`:
    - `ToolSkillConfig` type (re-export or define for core): `{ name: string, description: string, command: string[] }`
    - `SkillResult` type: `{ status: "ok" | "error", value?: string, error?: string }`
  - [ ] Create `node/core/src/tools/skill/executable.ts`:
    - `executeSkill(command: string[], input: Record<string, unknown>): Promise<SkillResult>` — spawns process with `JSON.stringify(input)` as last argv, reads stdout, parses result
  - [ ] Run type checks

- [x] **Step 3: Skill helper functions**
  - [ ] In `node/core/src/tools/skill/manager.ts`, export pure functions (no class needed):
    - `buildSkillDescription(skills: ToolSkillConfig[]): string` — assembles combined description listing available skills
    - `findSkill(skills: ToolSkillConfig[], name: string): ToolSkillConfig | undefined` — lookup by name
  - [ ] These operate on the `ToolSkillConfig[]` from current options — no cached state
  - [ ] Run type checks

- [x] **Step 4: use_skill tool module**
  - [ ] Create `node/core/src/tools/useSkill.ts`:
    - `Input` type: `{ skill: string, input: Record<string, unknown> }`
    - `validateInput(input: unknown): Result<Input>`
    - `spec` — base spec with `name: "use_skill"`, placeholder description (will be replaced dynamically)
    - `execute(request, context)` — delegates to `SkillToolManager.execute()`
  - [ ] Add `"use_skill"` to `STATIC_TOOL_NAMES` in `tool-registry.ts`
  - [ ] Add to `TOOL_REQUIRED_CAPABILITIES` (empty set — no special capabilities needed)
  - [ ] Add to relevant tool name lists (CHAT, DOCKER_ROOT, SUBAGENT)
  - [ ] Wire into `TOOL_SPEC_MAP`, `StaticToolMap`, `validateInput()`, `createTool()` switch
  - [ ] Make `getToolSpecs()` dynamically replace the `use_skill` description using the manager
  - [ ] Only include `use_skill` in tool specs when skills are configured (via capability filtering or conditional logic)
  - [ ] Run type checks (`npx tsgo -b`)

- [x] **Step 5: Thread/Chat wiring**
  - [ ] Add `toolSkills: ToolSkillConfig[]` to `CreateToolContext` (the resolved list for this thread)
  - [ ] In `createThreadWithContext`: read `getOptions().toolSkills`, pick host or docker list based on environment, pass into thread context
  - [ ] `getToolSpecs()` uses the list to build the dynamic `use_skill` description; omits `use_skill` if list is empty
  - [ ] `createTool()` uses the list to find the right executable when `use_skill` is called
  - [ ] Options are re-read per thread creation since `getOptions()` checks mtimes (already handled by `DynamicOptionsLoader`)
  - [ ] Run type checks

- [x] **Step 6: Tests**
  - [ ] Unit tests for `executable.ts` (mock shell scripts that return spec/result JSON)
  - [ ] Unit tests for `manager.ts` (init, getDescription, execute, host vs docker filtering)
  - [ ] Integration test: create a real skill script, configure via options, verify the tool works end-to-end
  - [ ] Run all tests (`npx vitest run`)

- [ ] **Step 7: Documentation** (deferred)
  - [ ] Update `node/skills/create-skill/skill.md` to document tool-backed skills

