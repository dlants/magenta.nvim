import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { Dispatch } from "../tea/tea.ts";
import type {
  ProviderToolResult,
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { ThreadId } from "../chat/types.ts";
import type {
  StaticTool,
  ToolName,
  GenericToolRequest,
  CompletedToolInfo,
} from "./types.ts";

export type ToolRequest = GenericToolRequest<"predict_edit", Input>;

export type State =
  | {
      state: "processing";
    }
  | {
      state: "done";
      result: ProviderToolResult;
    };

export type Msg = {
  type: "finish";
  result: Result<ProviderToolResultContent[]>;
};

export class PredictEditTool implements StaticTool {
  state: State;
  toolName = "predict_edit" as const;
  aborted: boolean = false;

  constructor(
    public request: ToolRequest,
    public threadId: ThreadId,
    private context: {
      myDispatch: Dispatch<Msg>;
    },
  ) {
    this.state = { state: "processing" };

    // For now, just mark as done immediately
    setTimeout(() => {
      if (this.aborted) return;
      this.context.myDispatch({
        type: "finish",
        result: {
          status: "ok",
          value: [{ type: "text", text: "Edit prediction completed." }],
        },
      });
    });
  }

  isDone(): boolean {
    return this.state.state === "done";
  }

  isPendingUserAction(): boolean {
    return false;
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
    switch (msg.type) {
      case "finish":
        if (this.state.state == "processing") {
          this.state = {
            state: "done",
            result: {
              type: "tool_result",
              id: this.request.id,
              result: msg.result,
            },
          };
        }
        return;
      default:
        assertUnreachable(msg.type);
    }
  }

  renderSummary(): VDOMNode {
    switch (this.state.state) {
      case "processing":
        return d`🔮⚙️ Predicting next edit...`;
      case "done":
        return renderCompletedSummary({
          request: this.request as CompletedToolInfo["request"],
          result: this.state.result,
        });
      default:
        assertUnreachable(this.state);
    }
  }

  renderPreview(): VDOMNode {
    return d``;
  }

  renderDetail(): VDOMNode {
    return d`Edit prediction tool executed`;
  }

  getToolResult(): ProviderToolResult {
    switch (this.state.state) {
      case "done":
        return this.state.result;
      case "processing":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: [
              { type: "text", text: `This tool use is being processed.` },
            ],
          },
        };
      default:
        assertUnreachable(this.state);
    }
  }
}

export function renderCompletedSummary(info: CompletedToolInfo): VDOMNode {
  const result = info.result.result;

  if (result.status === "error") {
    return d`🔮❌ Edit prediction failed - ${result.error}`;
  }

  return d`🔮✅ Edit prediction completed`;
}

export const spec: ProviderToolSpec = {
  name: "predict_edit" as ToolName,
  description: `Predicts the user's next edit based on recent changes and current context.`,
  input_schema: {
    type: "object",
    properties: {
      find: {
        type: "string",
        description: `\`find\` identifies the text you want to replace.
This should be the complete text to replace, exactly as it appears in the provided context, including indentation.
Regular expressions are not supported.
Make sure to remove │ from this parameter, as it is a cursor indicator and not actually present in the text.
`,
      },
      replace: {
        type: "string",
        description: `This will replace the find text.
This MUST be the complete and exact replacement text. Make sure to match braces and indentation.
Make sure to remove │ from this parameter, as it is a cursor indicator and not actually present in the text.`,
      },
    },
    required: ["find", "replace"],
  },
};

export type Input = {
  find: string;
  replace: string;
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.find != "string") {
    return {
      status: "error",
      error: "expected req.input.find to be a string",
    };
  }

  if (typeof input.replace != "string") {
    return {
      status: "error",
      error: "expected req.input.replace to be a string",
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
