import { d } from "../tea/view.ts";
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
import { CHAT_TOOL_NAMES, type ToolName } from "./tool-registry.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";

export type Msg =
  | {
      type: "finish";
      result: Result<string>;
    }
  | {
      type: "subagent-created";
      threadId: ThreadId;
    };

export type State =
  | {
      state: "preparing";
    }
  | {
      state: "running";
      subagentThreadId: ThreadId;
    }
  | {
      state: "done";
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

    let allowedTools =
      input.allowedTools ||
      CHAT_TOOL_NAMES.filter((tool) => tool !== "spawn_subagent");

    if (!allowedTools.includes("yield_to_parent")) {
      allowedTools = [...allowedTools, "yield_to_parent"];
    }

    this.context.dispatch({
      type: "chat-msg",
      msg: {
        type: "spawn-subagent-thread",
        parentThreadId: this.context.threadId,
        parentToolRequestId: this.request.id,
        allowedTools,
        initialPrompt: prompt,
        contextFiles,
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

      case "running": {
        const subagentThreadId = this.state.subagentThreadId;
        // setTimeout to avoid dispatch-in-dispatch
        setTimeout(() => {
          // the child thread should notify & update this tool when it finishes aborting
          this.context.dispatch({
            type: "thread-msg",
            id: subagentThreadId,
            msg: {
              type: "abort",
            },
          });
        });

        break;
      }

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
        this.state = {
          state: "running",
          subagentThreadId: msg.threadId,
        };
        return;

      case "finish":
        this.state = {
          state: "done",
          result: {
            type: "tool_result",
            id: this.request.id,
            result: msg.result,
          },
        };
        return;

      default:
        assertUnreachable(msg);
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
      case "running":
        return d`🤖⏳ Sub-agent running with thread ID: ${this.state.subagentThreadId.toString()}. Waiting for results...`;
      case "done": {
        const result = this.state.result.result;
        if (result.status === "error") {
          return d`🤖❌ Error spawning sub-agent: ${result.error}`;
        } else {
          return d`🤖✅ Sub-agent completed with result: ${result.value}`;
        }
      }
    }
  }

  displayInput(): string {
    const input = this.request.input;
    const contextFilesStr = input.contextFiles
      ? input.contextFiles.map((file) => `"${file}"`).join(", ")
      : "";
    const allowedToolsStr = input.allowedTools
      ? input.allowedTools.map((tool) => `"${tool}"`).join(", ")
      : "";

    return `spawn_subagent: {
    prompt: "${input.prompt}",
    contextFiles: [${contextFilesStr}],
    allowedTools: [${allowedToolsStr}]
}`;
  }
}

// Create a list of available tools for subagents, excluding spawn_subagent
const AVAILABLE_SUBAGENT_TOOLS = CHAT_TOOL_NAMES.filter(
  (tool) => tool !== "spawn_subagent",
);

export const spec: ProviderToolSpec = {
  name: "spawn_subagent",
  description: `This tool allows you to create a sub-agent that can perform a specific task and report back the results.
The sub-agent runs in a separate thread with its own context and tools.`,
  input_schema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The sub-agent prompt",
      },
      contextFiles: {
        type: "array",
        items: {
          type: "string",
        },
        description:
          "Optional list of file paths to provide as context to the sub-agent",
      },
      allowedTools: {
        type: "array",
        items: {
          type: "string",
          enum: AVAILABLE_SUBAGENT_TOOLS,
        },
        description:
          "List of tool names that the sub-agent is allowed to use. If not provided, all standard tools except spawn_subagent will be available. Note: spawn_subagent is never allowed to prevent recursive spawning. yield_to_parent is always available to subagents regardless of this setting.",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
};

export type Input = {
  prompt: string;
  contextFiles?: UnresolvedFilePath[];
  allowedTools?: ToolName[];
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

  if (input.allowedTools !== undefined) {
    if (!Array.isArray(input.allowedTools)) {
      return {
        status: "error",
        error: `expected req.input.allowedTools to be an array but it was ${JSON.stringify(input.allowedTools)}`,
      };
    }

    if (!input.allowedTools.every((item) => typeof item === "string")) {
      return {
        status: "error",
        error: `expected all items in req.input.allowedTools to be strings but they were ${JSON.stringify(input.allowedTools)}`,
      };
    }

    // Check that each tool name is valid against the available subagent tools
    const invalidTools = input.allowedTools.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      (tool) => !AVAILABLE_SUBAGENT_TOOLS.includes(tool as any),
    );

    if (invalidTools.length > 0) {
      return {
        status: "error",
        error: `Found invalid tool names: ${invalidTools.join(", ")}. Valid tools are: ${AVAILABLE_SUBAGENT_TOOLS.join(", ")}`,
      };
    }
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
