import { d, withBindings, type VDOMNode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { CompletedToolInfo } from "./types.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { StaticTool, ToolName, GenericToolRequest } from "./types.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { RootMsg } from "../root-msg.ts";
import { AGENT_TYPES, type AgentType } from "../providers/system-prompt.ts";
import type { ThreadId, ThreadType } from "../chat/types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";

export type ToolRequest = GenericToolRequest<"spawn_subagent", Input>;

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
      result: ProviderToolResult;
    };

export class SpawnSubagentTool implements StaticTool {
  toolName = "spawn_subagent" as const;
  public state: State;
  public aborted: boolean = false;

  constructor(
    public request: ToolRequest,
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
      if (this.aborted) return;
      this.spawnSubagent();
    });
  }

  private spawnSubagent(): void {
    const input = this.request.input;
    const prompt = input.prompt;
    const contextFiles = input.contextFiles || [];
    const threadType: ThreadType =
      input.agentType === "fast" ? "subagent_fast" : "subagent_default";

    this.context.dispatch({
      type: "chat-msg",
      msg: {
        type: "spawn-subagent-thread",
        parentThreadId: this.context.threadId,
        spawnToolRequestId: this.request.id,
        inputMessages: [{ type: "system", text: prompt }],
        threadType,
        contextFiles,
      },
    });
  }

  isDone(): boolean {
    return this.state.state === "done";
  }

  isPendingUserAction(): boolean {
    return false; // Spawn subagent never requires user action
  }

  abort(): ProviderToolResult {
    if (this.state.state === "done") {
      return this.getToolResult();
    }

    this.aborted = true;

    const result: ProviderToolResult = {
      type: "tool_result",
      id: this.request.id,
      result: {
        status: "error",
        error: "Request was aborted by the user.",
      },
    };

    this.state = {
      state: "done",
      result,
    };

    return result;
  }

  update(msg: Msg): void {
    if (this.aborted) return;

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
                  value: [
                    {
                      type: "text",
                      text: `Sub-agent started with threadId: ${msg.result.value}`,
                    },
                  ],
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

  getToolResult(): ProviderToolResult {
    if (this.state.state !== "done") {
      return {
        type: "tool_result",
        id: this.request.id,
        result: {
          status: "ok",
          value: [
            { type: "text", text: `Waiting for subagent to finish running...` },
          ],
        },
      };
    }

    return this.state.result;
  }

  renderSummary() {
    const promptPreview =
      this.request.input.prompt.length > 50
        ? this.request.input.prompt.substring(0, 50) + "..."
        : this.request.input.prompt;

    switch (this.state.state) {
      case "preparing":
        return d`🚀⚙️ spawn_subagent: ${promptPreview}`;
      case "done":
        return renderCompletedSummary(
          {
            request: this.request as CompletedToolInfo["request"],
            result: this.state.result,
          },
          this.context.dispatch,
        );
    }
  }
}

export function renderCompletedSummary(
  info: CompletedToolInfo,
  dispatch: Dispatch<RootMsg>,
): VDOMNode {
  const result = info.result.result;
  if (result.status === "error") {
    const errorPreview =
      result.error.length > 50
        ? result.error.substring(0, 50) + "..."
        : result.error;

    return d`🤖❌ spawn_subagent: ${errorPreview}`;
  }

  // Parse threadId from result text: "Sub-agent started with threadId: <id>"
  const resultText =
    result.value[0]?.type === "text" ? result.value[0].text : "";
  const match = resultText.match(/threadId: ([a-f0-9-]+)/);
  const threadId = match ? (match[1] as ThreadId) : undefined;

  return withBindings(d`🤖✅ spawn_subagent ${threadId || "undefined"}`, {
    "<CR>": () => {
      if (threadId) {
        dispatch({
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

export const spec: ProviderToolSpec = {
  name: "spawn_subagent" as ToolName,
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

## Effective Sub-agent Usage

The sub agent will run until it finishes the task. You will not be able to communicate with the subagent after spawning it, and it will only respond with a single output message.
Because of this, it is important that you write **clear, specific prompts**
- Be explicit about the task scope and expected deliverables
- Include relevant context about what you're trying to achieve
- Clearly define what specific information the sub-agent should include in its final response
- For learning/discovery or planning tasks, remind the subagent to read the relevant skill file first

**Choose appropriate agent types:**
- Use 'fast' for quick tasks that don't require the full model capabilities
- Use 'default' for everything else

**Provide relevant context files:**
- Include files the sub-agent will need to examine or modify
- Don't over-include - focus on what's directly relevant to the task
- Remember: sub-agents can use tools to discover additional files if needed

Sub-agents have access to all standard tools except spawn_subagent (to prevent recursive spawning) and always have access to yield_to_parent.

<example>
user: refactor this interface
assistant: [spawns subagent to learn about the interface]
assistant: [waits for subagent]
assistant: [uses find_references tool to find all references of the interface]
assistant: [uses replace tool to refactor the interface]
assistant: [spawns one subagent per file to update all references to the interface]
assistant: [awaits all subagents]
</example>

<example>
user: I want to build a new feature that does X
assistant: [spawn subagent to plan the change]
assistant: [wait for subagent, subagent writes to plans/X.md]
assistant: Please review \`plans/X.md\` and confirm before I proceed. (end_turn)
</example>

<example>
user: I am thinking about using technology X, Y or Z to implement a change.
assistant: [spawn subagent to learn about the task constraints]
assistant: [wait for subagent]
assistant: [spawns subagent to consider the use of X for the task, given the constraints]
assistant: [spawns subagent to consider the use of Y for the task, given the constraints]
assistant: [spawns subagent to consider the use of Z for the task, given the constraints]
assistant: [wait for subagents X, Y and Z]
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

      agentType: {
        type: "string",
        enum: AGENT_TYPES as unknown as string[],
        description:
          "Optional agent type to use for the sub-agent. 'fast' uses the fast model for quick tasks. 'default' uses the standard model.",
      },
    },

    required: ["prompt"],
  },
};

export type Input = {
  prompt: string;
  contextFiles?: UnresolvedFilePath[];
  agentType?: AgentType;
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

  if (input.agentType !== undefined) {
    if (typeof input.agentType !== "string") {
      return {
        status: "error",
        error: `expected req.input.agentType to be a string but it was ${JSON.stringify(input.agentType)}`,
      };
    }

    if (!AGENT_TYPES.includes(input.agentType as AgentType)) {
      return {
        status: "error",
        error: `expected req.input.agentType to be one of ${AGENT_TYPES.join(", ")} but it was ${JSON.stringify(input.agentType)}`,
      };
    }
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
