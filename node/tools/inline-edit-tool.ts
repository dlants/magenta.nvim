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
import { NvimBuffer, type BufNr, type Line } from "../nvim/buffer.ts";
import type { ByteIdx, Position0Indexed } from "../nvim/window.ts";

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

export class InlineEditTool implements StaticTool {
  state: State;
  toolName = "inline_edit" as const;

  constructor(
    public request: Extract<StaticToolRequest, { toolName: "inline_edit" }>,
    public context: { bufnr: BufNr; nvim: Nvim; myDispatch: Dispatch<Msg> },
  ) {
    this.state = {
      state: "processing",
    };

    // wrap in setTimeout to force a new eventloop frame, to avoid dispatch-in-dispatch
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

  /** this is expected to be invoked as part of a dispatch, so we don't need to dispatch here to update the view
   */
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
        value: [{ type: "text", text: "Tool is being applied..." }],
      },
    };
  }

  view() {
    if (this.state.state == "processing") {
      return d`Applying edit...`;
    }

    if (this.state.result.result.status === "error") {
      return d`❌ Error applying edit: ${this.state.result.result.error}`;
    } else {
      return d`✅ Successfully applied edit`;
    }
  }

  async apply() {
    const input = this.request.input;

    const buffer = new NvimBuffer(this.context.bufnr, this.context.nvim);
    const lines = await buffer.getLines({ start: 0, end: -1 });
    const content = lines.join("\n");

    const replaceStart = content.indexOf(input.find);
    if (replaceStart === -1) {
      this.context.myDispatch({
        type: "finish",
        result: {
          status: "error",
          error: `\
Unable to find text in buffer:
\`\`\`
${input.find}
\`\`\``,
        },
      });
      return;
    }
    const replaceEnd = replaceStart + input.find.length;

    // Calculate the row and column for start and end positions
    let startRow = 0;
    let startCol = 0;
    let endRow = 0;
    let endCol = 0;
    let currentPos = 0;

    for (let i = 0; i < lines.length; i++) {
      const lineLength = lines[i].length + 1; // +1 for newline

      if (
        currentPos <= replaceStart &&
        replaceStart < currentPos + lineLength
      ) {
        startRow = i;
        startCol = (replaceStart - currentPos) as ByteIdx;
      }

      if (currentPos <= replaceEnd && replaceEnd <= currentPos + lineLength) {
        endRow = i;
        endCol = (replaceEnd - currentPos) as ByteIdx;
        break;
      }

      currentPos += lineLength;
    }

    await buffer.setText({
      startPos: { row: startRow, col: startCol } as Position0Indexed,
      endPos: { row: endRow, col: endCol } as Position0Indexed,
      lines: input.replace.split("\n") as Line[],
    });

    this.context.myDispatch({
      type: "finish",
      result: {
        status: "ok",
        value: [{ type: "text", text: "Applied edit" }],
      },
    });
  }

  displayInput() {
    return `replace: {
    match:
\`\`\`
${this.request.input.find}
\`\`\`
    replace:
\`\`\`
${this.request.input.replace}
\`\`\`
}`;
  }
}

export const spec: ProviderToolSpec = {
  name: "inline_edit" as ToolName,
  description: `Replace text. You will only get one shot so do the whole edit in a single tool invocation.`,
  input_schema: {
    type: "object",
    properties: {
      find: {
        type: "string",
        description: `The text to replace.
This should be the exact and complete text to replace, including indentation. Regular expressions are not supported.
If the text appears multiple times, only the first match will be replaced.`,
      },
      replace: {
        type: "string",
        description:
          "New content that will replace the existing text. This should be the complete text - do not skip lines or use ellipsis.",
      },
    },
    required: ["find", "replace"],
    additionalProperties: false,
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
