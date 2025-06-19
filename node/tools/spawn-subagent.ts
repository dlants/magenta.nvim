import { d, withBindings } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { ToolRequest } from "./toolManager.ts";
import type {
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { ToolInterface } from "./types.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { RootMsg } from "../root-msg.ts";
import type { ThreadId } from "../chat/thread.ts";
import { SUBAGENT_TOOL_NAMES, type ToolName } from "./tool-registry.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import {
  SUBAGENT_SYSTEM_PROMPTS,
  type SubagentSystemPrompt,
} from "../providers/system-prompt.ts";
import { renderContentValue } from "../providers/helpers.ts";

export type Msg = {
  type: "subagent-created";
  result: Result<ThreadId>;
};

export type State =
  | {
      state: "preparing";
    }
  | {
      state: "done";
      threadId?: ThreadId;
      result: ProviderToolResultContent;
    };

export class SpawnSubagentTool implements ToolInterface {
  toolName = "spawn_subagent" as const;
  public state: State;

  constructor(
    public request: Extract<ToolRequest, { toolName: "spawn_subagent" }>,
    public context: {
      nvim: Nvim;
      dispatch: Dispatch<RootMsg>;
      threadId: ThreadId;
      myDispatch: Dispatch<Msg>;
    },
  ) {
    this.state = {
      state: "preparing",
    };

    // Start the process of spawning a sub-agent
    // Wrap in setTimeout to force new eventloop frame, to avoid dispatch-in-dispatch
    setTimeout(() => {
      this.spawnSubagent();
    });
  }

  private spawnSubagent(): void {
    const input = this.request.input;
    const prompt = input.prompt;
    const contextFiles = input.contextFiles || [];
    const systemPrompt = input.systemPrompt;

    const suppressTools = input.suppressTools || [];
    let allowedTools = SUBAGENT_TOOL_NAMES.filter(
      (tool) => !suppressTools.includes(tool),
    );

    if (!allowedTools.includes("yield_to_parent")) {
      allowedTools = [...allowedTools, "yield_to_parent"];
    }

    this.context.dispatch({
      type: "chat-msg",
      msg: {
        type: "spawn-subagent-thread",
        parentThreadId: this.context.threadId,
        spawnToolRequestId: this.request.id,
        allowedTools,
        initialPrompt: prompt,
        contextFiles,
        systemPrompt,
      },
    });
  }

  abort() {
    switch (this.state.state) {
      case "preparing":
        this.state = {
          state: "done",
          result: {
            type: "tool_result",
            id: this.request.id,
            result: {
              status: "error",
              error: "Sub-agent execution was aborted",
            },
          },
        };
        break;

      case "done":
        // Already done, nothing to abort
        break;
      default:
        assertUnreachable(this.state);
    }
  }

  update(msg: Msg): void {
    switch (msg.type) {
      case "subagent-created":
        switch (msg.result.status) {
          case "ok":
            this.state = {
              state: "done",
              result: {
                type: "tool_result",
                id: this.request.id,
                result: {
                  status: "ok",
                  value: `Sub-agent started with threadId: ${msg.result.value}`,
                },
              },
            };

            break;

          case "error":
            this.state = {
              state: "done",
              result: {
                type: "tool_result",
                id: this.request.id,
                result: {
                  status: "error",
                  error: `Failed to create sub-agent thread: ${msg.result.error}`,
                },
              },
            };
            return;
        }
        return;

      default:
        assertUnreachable(msg.type);
    }
  }

  getToolResult(): ProviderToolResultContent {
    if (this.state.state !== "done") {
      return {
        type: "tool_result",
        id: this.request.id,
        result: {
          status: "ok",
          value: `Waiting for subagent to finish running...`,
        },
      };
    }

    return this.state.result;
  }

  view() {
    switch (this.state.state) {
      case "preparing":
        return d`🤖⚙️ Preparing to spawn sub-agent...`;
      case "done": {
        const threadId = this.state.threadId;
        const result = this.state.result.result;
        if (result.status === "error") {
          return d`🤖❌ Error spawning sub-agent: ${result.error}`;
        } else {
          return withBindings(d`🤖✅ ${renderContentValue(result.value)}`, {
            "<CR>": () => {
              if (threadId) {
                this.context.dispatch({
                  type: "chat-msg",
                  msg: {
                    type: "select-thread",
                    id: threadId,
                  },
                });
              }
            },
          });
        }
      }
    }
  }

  displayInput(): string {
    const input = this.request.input;
    return `spawn_subagent: ${JSON.stringify(input, null, 2)}`;
  }
}

export const spec: ProviderToolSpec = {
  name: "spawn_subagent",
  description: `Create a sub-agent that can perform a specific task and report back the results.

## When to Use Sub-agents

Use sub-agents for:
- **Learning and discovery** tasks where you need to understand code, APIs, or concepts before proceeding
- **Planning tasks** that require breaking down complex work into actionable steps
- **Parallel work** when you need to perform multiple independent tasks

Don't use sub-agents for:
- Simple, single-step tasks you can complete directly
- When you already have all the information needed
- Quick clarifications or basic operations

IMPORTANT: if you use the planning tool, you should request user feedback on the plan before proceeding with the implementation.

## Effective Sub-agent Usage

The sub agent will run until it finishes the task. You will not be able to communicate with the subagent after spawning it, and it will only respond with a single output message.
Because of this, it is important that you write **clear, specific prompts**
- Be explicit about the task scope and expected deliverables
- Include relevant context about what you're trying to achieve
- Clearly define what specific information the sub-agent should include in its final response

**Choose appropriate system prompts:**
- Use 'learn' for discovery, research, and understanding tasks
- Use 'plan' for strategic planning and breaking down complex work
- Use default for everything else

**Provide relevant context files:**
- Include files the sub-agent will need to examine or modify
- Don't over-include - focus on what's directly relevant to the task
- Remember: sub-agents can use tools to discover additional files if needed

<example>
user: refactor this interface
assistant: [spawns learn subagent to learn about the interface]
assistant: [wiats for learn subagent]
assistant: [uses find_references tool to find all references of the interface]
assistant: [uses replace tool to refactor the interface]
assistant: [spawns one subagent per file to update all references to the interface]
assistant: [awaits all subagents]
</example>

<example>
user: I want to build a new feature that does X
assistant: [spawn plan subagent to plan the change]
assistnat: [wait for plan subagent, plan subagent writes to plans/X.md]
assistant: Please review \`plans/X.md\` and confirm before I proceed. (end_turn)
</example>

<example>
user: I am thinking about using technolgy X, Y or Z to implement a change.
assistant: [spawn learn subagent to learn about the task constraints]
assistant: [wait for learn subagent]
assistant: [spawns learn subagent to consider the use of X for the task, given the constraints]
assistant: [spawns learn subagent to consider the use of Y for the task, given the constraints]
assistant: [spawns learn subagent to consider the use of Z for the task, given the constraints]
assistant: [wait for learn subagents X, Y and Z]
assistant: Summarizes the results
</example>`,
  input_schema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The sub-agent prompt.",
      },
      contextFiles: {
        type: "array",
        items: {
          type: "string",
        },
        description:
          "Optional list of file paths to provide as context to the sub-agent.",
      },
      suppressTools: {
        type: "array",
        items: {
          type: "string",
          enum: SUBAGENT_TOOL_NAMES,
        },
        description:
          "List of tool names that the sub-agent is not allowed to use. If not provided, all standard tools except spawn_subagent will be available. Note: spawn_subagent is never allowed to prevent recursive spawning. yield_to_parent is always available to subagents regardless of this setting.",
      },
      systemPrompt: {
        type: "string",
        enum: SUBAGENT_SYSTEM_PROMPTS as unknown as string[],
        description:
          "Optional preset system prompt to use for the sub-agent. 'learn' provides instructions optimized for learning and discovery tasks. 'plan' provides instructions optimized for planning and strategy tasks.",
      },
    },
    // NOTE: openai requries all properties to be required.
    // https://community.openai.com/t/api-rejects-valid-json-schema/906163
    required: ["prompt", "contextFiles", "suppressTools", "systemPrompt"],
    additionalProperties: false,
  },
};

export type Input = {
  prompt: string;
  contextFiles?: UnresolvedFilePath[];
  suppressTools?: ToolName[];
  systemPrompt?: SubagentSystemPrompt;
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.prompt != "string") {
    return {
      status: "error",
      error: `expected req.input.prompt to be a string but it was ${JSON.stringify(input.prompt)}`,
    };
  }

  if (input.contextFiles !== undefined) {
    if (!Array.isArray(input.contextFiles)) {
      return {
        status: "error",
        error: `expected req.input.contextFiles to be an array but it was ${JSON.stringify(input.contextFiles)}`,
      };
    }

    if (!input.contextFiles.every((item) => typeof item === "string")) {
      return {
        status: "error",
        error: `expected all items in req.input.contextFiles to be strings but they were ${JSON.stringify(input.contextFiles)}`,
      };
    }
  }

  if (input.suppressTools !== undefined) {
    if (!Array.isArray(input.suppressTools)) {
      return {
        status: "error",
        error: `expected req.input.suppressTools to be an array but it was ${JSON.stringify(input.suppressTools)}`,
      };
    }

    if (!input.suppressTools.every((item) => typeof item === "string")) {
      return {
        status: "error",
        error: `expected all items in req.input.suppressTools to be strings but they were ${JSON.stringify(input.suppressTools)}`,
      };
    }

    // we're not going to check that every tool in suppressTools is a valid tool. If invalid tools are included, we will
    // just ignore them
  }

  if (input.systemPrompt !== undefined) {
    if (typeof input.systemPrompt !== "string") {
      return {
        status: "error",
        error: `expected req.input.systemPrompt to be a string but it was ${JSON.stringify(input.systemPrompt)}`,
      };
    }

    if (
      !SUBAGENT_SYSTEM_PROMPTS.includes(
        input.systemPrompt as SubagentSystemPrompt,
      )
    ) {
      return {
        status: "error",
        error: `expected req.input.systemPrompt to be one of ${SUBAGENT_SYSTEM_PROMPTS.join(", ")} but it was ${JSON.stringify(input.systemPrompt)}`,
      };
    }
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
