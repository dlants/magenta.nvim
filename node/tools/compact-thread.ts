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

export type State = {
  state: "done";
  result: ProviderToolResultContent;
};

export class CompactThreadTool implements ToolInterface {
  toolName = "compact_thread" as const;
  public state: State;

  constructor(
    public request: Extract<ToolRequest, { toolName: "compact_thread" }>,
    public context: { nvim: Nvim },
  ) {
    this.state = {
      state: "done",
      result: {
        type: "tool_result",
        id: this.request.id,
        result: {
          status: "ok",
          value: "", // this should never need to be sent to the agent
        },
      },
    };
  }

  abort() {}

  update(): void {}

  getToolResult(): ProviderToolResultContent {
    return this.state.result;
  }

  view() {
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
  name: "compact_thread",
  description: `\
This tool extracts ONLY the specific portions of the conversation history that are directly relevant to the user's NEXT PROMPT.

ANALYZE THE USER'S NEXT PROMPT FIRST:
- Carefully examine what the user is asking for in their next prompt
- Identify key technical concepts, files, functions, or problems they're focusing on
- Extract ONLY the information from the thread that directly relates to these specific elements

PRIORITIZE WITH LASER FOCUS:
- Code discussions, architectural decisions, and technical details DIRECTLY relevant to the next prompt
- File paths and function signatures that will be needed to address the next prompt
- Previous solutions or approaches that directly inform the upcoming work
- Technical constraints or requirements that specifically impact the task in the next prompt

RUTHLESSLY EXCLUDE:
- ANY content from the thread not directly related to the specific focus of the next prompt
- General architectural discussions not specifically relevant to the next task
- Code explanations for components not involved in the next prompt
- Previous problems that have been fully resolved and don't impact the next task

CONTEXT FILES:
- Include ONLY files that are DIRECTLY relevant to the next prompt in contextFiles
- Prefer adding files to contextFiles rather than including code snippets in the summary

SUMMARY:
- Structure the summary to directly address what the user needs for their next prompt
- Begin with the most critical information needed for the next task
- Use precise technical language focused on the specific task at hand
- Keep code snippets minimal - only include what's absolutely necessary for the next prompt
- Reference file paths and function names rather than including implementations
- NEVER include full file contents
- ⚠️ IMPORTANT: Do NOT include the user's next prompt in the summary - it will be automatically included

Remember: The goal is NOT to summarize the thread, but to extract ONLY the specific pieces that directly support addressing the user's next prompt.`,
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
