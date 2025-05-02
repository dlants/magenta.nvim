import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { Thunk } from "../tea/tea.ts";
import type { ToolRequest } from "./toolManager.ts";
import type {
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import { REVIEW_PROMPT } from "./diff.ts";

export type State = {
  state: "done";
  result: ProviderToolResultContent;
};

export type Msg = {
  type: "finish";
  result: Result<string>;
};

export class InsertTool {
  state: State;
  toolName = "insert" as const;

  constructor(public request: Extract<ToolRequest, { toolName: "insert" }>) {
    this.state = {
      state: "done",
      result: {
        type: "tool_result",
        id: request.id,
        result: {
          status: "ok",
          value: REVIEW_PROMPT,
        },
      },
    };
  }

  update(msg: Msg): Thunk<Msg> | undefined {
    switch (msg.type) {
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
        assertUnreachable(msg.type);
    }
  }

  view(): VDOMNode {
    return d`Insert [[ +${(
      (this.request.input.content.match(/\n/g) || []).length + 1
    ).toString()} ]] in \`${this.request.input.filePath}\` ${this.toolStatusView()}`;
  }

  toolStatusView(): VDOMNode {
    switch (this.state.state) {
      case "done":
        if (this.state.result.result.status == "error") {
          return d`⚠️ Error: ${JSON.stringify(this.state.result.result.error, null, 2)}`;
        } else {
          return d`Awaiting user review.`;
        }
    }
  }

  getToolResult(): ProviderToolResultContent {
    switch (this.state.state) {
      case "done":
        return this.state.result;
      default:
        assertUnreachable(this.state.state);
    }
  }

  displayInput() {
    return `insert: {
    filePath: ${this.request.input.filePath}
    insertAfter: "${this.request.input.insertAfter}"
    content:
\`\`\`
${this.request.input.content}
\`\`\`
}`;
  }
}

export const spec: ProviderToolSpec = {
  name: "insert",
  description:
    "Insert content after the specified string in a file. You can also use this tool to create new files.",
  input_schema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: `Path to the file to modify. The file will be created if it does not exist yet.`,
      },
      insertAfter: {
        type: "string",
        description: `String after which to insert the content.

The \`insertAfter\` string MUST uniquely identify a single location in the file. Provide at least 2-3 lines of context from the target file to ensure that the insert only matches ONE location. This should exactly match the file content, including the exact indentation. Regular expressions are not supported.

The insertAfter text will not be changed.

Set insertAfter to the empty string to insert at the beginning of the file.`,
      },
      content: {
        type: "string",
        description:
          "Content to insert immediately after the `insertAfter` text. Make sure you match the indentation of the file.",
      },
    },
    required: ["filePath", "insertAfter", "content"],
    additionalProperties: false,
  },
};

export type Input = {
  filePath: string;
  insertAfter: string;
  content: string;
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.filePath != "string") {
    return {
      status: "error",
      error: "expected req.input.filePath to be a string",
    };
  }

  if (typeof input.insertAfter != "string") {
    return {
      status: "error",
      error: "expected req.input.insertAfter to be a string",
    };
  }

  if (typeof input.content != "string") {
    return {
      status: "error",
      error: "expected req.input.content to be a string",
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
