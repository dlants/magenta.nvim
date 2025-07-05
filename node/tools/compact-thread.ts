import { d } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { StaticToolRequest } from "./toolManager.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { StaticTool, ToolName } from "./types.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";

export type State = {
  state: "done";
  result: ProviderToolResult;
};

export class CompactThreadTool implements StaticTool {
  toolName = "compact_thread" as const;
  public state: State;

  constructor(
    public request: Extract<StaticToolRequest, { toolName: "compact_thread" }>,
    public context: { nvim: Nvim },
  ) {
    this.state = {
      state: "done",
      result: {
        type: "tool_result",
        id: this.request.id,
        result: {
          status: "ok",
          value: [{ type: "text", text: "" }], // this should never need to be sent to the agent
        },
      },
    };
  }

  isDone(): boolean {
    return this.state.state === "done";
  }

  abort() {}

  update(): void {}

  getToolResult(): ProviderToolResult {
    return this.state.result;
  }

  renderSummary() {
    return d``; // this should never need to be rendered
  }

  displayInput() {
    return `compact_thread: {
    summary: "${this.request.input.summary}",
    contextFiles: [${this.request.input.contextFiles.map((file) => `"${file}"`).join(", ")}]
}`;
  }
}

export const spec: ProviderToolSpec = {
  name: "compact_thread" as ToolName,
  description: `\
This tool extracts specific portions of the conversation history that are directly relevant to the user's next prompt.

First, provide a section where you analyze the conversation:

1. ANALYZE THE USER'S NEXT PROMPT:
   - Carefully examine what the user is asking for in their next prompt
   - Identify key technical concepts, files, functions, or problems they're focusing on
   - Determine what information from the thread directly relates to these specific elements

2. RELEVANCE:
   - Note technical decisions, code patterns, and architectural choices that impact the next prompt
   - Track the evolution of solutions and approaches that inform the upcoming work
   - Extract ONLY information that directly supports addressing the next prompt
   - Exclude general discussions not specifically relevant to the next task
   - Focus on actionable technical details needed for the next prompt

Then, provide the context section:
- Begin with the most critical information needed for the next task
- Keep code snippets minimal - only include what's absolutely necessary for the next prompt
- Reference file paths and function names rather than including implementations. NEVER include full file contents
- IMPORTANT: Do NOT include the user's next prompt in the summary - it will be automatically included

Remember: The goal is NOT to summarize the thread, but to extract ONLY the specific pieces that directly support addressing the user's next prompt.

<example>
user: compact this thread. My next prompt will be: "fix the authentication bug in the login component"

assistant:
# analysis
[consider the users next prompt]
[review the conversation so far, and decide what is the most relevant]

# context
[detailed description of only the relevant pieces]
</example>`,
  input_schema: {
    type: "object",
    properties: {
      contextFiles: {
        type: "array",
        items: {
          type: "string",
        },
        description:
          "List of ONLY the specific file names directly relevant to addressing the user's next prompt.",
      },
      summary: {
        type: "string",
        description: `\
Extract ONLY the specific parts of the thread that are directly relevant to the user's next prompt.
Focus on technical details, code patterns, and decisions that specifically help with the next task.
Do not include anything that isn't directly applicable to the next prompt's focus.
This should not restate anything relating to contextFiles, since those will be retained in full.`,
      },
    },
    required: ["contextFiles", "summary"],
    additionalProperties: false,
  },
};

export type Input = {
  contextFiles: UnresolvedFilePath[];
  summary: string;
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.summary != "string") {
    return {
      status: "error",
      error: `expected req.input.summary to be a string but it was ${JSON.stringify(input.summary)}`,
    };
  }

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

  return {
    status: "ok",
    value: input as Input,
  };
}
