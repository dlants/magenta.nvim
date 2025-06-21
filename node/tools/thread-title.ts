import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { StaticToolRequest } from "./toolManager.ts";
import type {
  ProviderToolResult,
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { StaticTool, ToolName } from "./types.ts";

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

export class ThreadTitleTool implements StaticTool {
  state: State;
  toolName = "thread_title" as const;

  constructor(
    public request: Extract<StaticToolRequest, { toolName: "thread_title" }>,
    public context: { nvim: Nvim; myDispatch: Dispatch<Msg> },
  ) {
    this.state = {
      state: "processing",
    };

    setTimeout(() => {
      this.apply().catch((err: Error) =>
        this.context.myDispatch({
          type: "finish",
          result: {
            status: "error",
            error: err.message + "\n" + err.stack,
          },
        }),
      );
    });
  }

  isDone(): boolean {
    return this.state.state === "done";
  }

  abort() {
    this.state = {
      state: "done",
      result: {
        type: "tool_result",
        id: this.request.id,
        result: { status: "error", error: `The user aborted this request.` },
      },
    };
  }

  update(msg: Msg): void {
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

  getToolResult(): ProviderToolResult {
    if (this.state.state == "done") {
      return this.state.result;
    }

    return {
      type: "tool_result",
      id: this.request.id,
      result: {
        status: "ok",
        value: [{ type: "text", text: "Processing thread title..." }],
      },
    };
  }

  view() {
    if (this.state.state == "processing") {
      return d`Setting thread title...`;
    }

    if (this.state.result.result.status === "error") {
      return d`❌ Error setting thread title: ${this.state.result.result.error}`;
    } else {
      return d`✅ Thread title set to: "${this.request.input.title}"`;
    }
  }

  async apply() {
    // Simply return the title as the result
    // The actual setting of the thread title would be handled elsewhere
    // Adding an await to satisfy the "async method has no await" warning
    await Promise.resolve();

    // We've already validated the input in the constructor
    this.context.myDispatch({
      type: "finish",
      result: {
        status: "ok",
        value: [{ type: "text", text: this.request.input.title }],
      },
    });
  }

  displayInput() {
    return `thread_title: {
    title: "${this.request.input.title}"
}`;
  }
}

export const spec: ProviderToolSpec = {
  name: "thread_title" as ToolName,
  description: `Set a title for the current conversation thread based on the user's message.`,
  input_schema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "A short, descriptive title for the conversation thread. Should be shorter than 80 characters.",
      },
    },
    required: ["title"],
    additionalProperties: false,
  },
};

export type Input = {
  title: string;
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.title != "string") {
    return {
      status: "error",
      error: "expected req.input.title to be a string",
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
