import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { ToolRequest } from "./toolManager.ts";
import type {
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { ToolInterface } from "./types.ts";
import { NvimBuffer, type BufNr, type Line } from "../nvim/buffer.ts";
import type {
  ByteIdx,
  Position0Indexed,
  Position1IndexedCol1Indexed,
  Row0Indexed,
} from "../nvim/window.ts";

export type State =
  | {
      state: "processing";
    }
  | {
      state: "done";
      result: ProviderToolResultContent;
    };

export type Msg = {
  type: "finish";
  result: Result<string>;
};

export type NvimSelection = {
  startPos: Position1IndexedCol1Indexed;
  endPos: Position1IndexedCol1Indexed;
  text: string;
};

export class ReplaceSelectionTool implements ToolInterface {
  state: State;
  toolName = "replace_selection" as const;

  constructor(
    public request: Extract<ToolRequest, { toolName: "replace_selection" }>,
    public selection: NvimSelection,
    public context: { bufnr: BufNr; nvim: Nvim; myDispatch: Dispatch<Msg> },
  ) {
    this.state = {
      state: "processing",
    };

    this.apply().catch((err: Error) =>
      this.context.myDispatch({
        type: "finish",
        result: {
          status: "error",
          error: err.message + "\n" + err.stack,
        },
      }),
    );
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

  getToolResult(): ProviderToolResultContent {
    if (this.state.state == "done") {
      return this.state.result;
    }

    return {
      type: "tool_result",
      id: this.request.id,
      result: {
        status: "ok",
        value: "Tool is being applied...",
      },
    };
  }

  async apply() {
    const input = this.request.input;

    const buffer = new NvimBuffer(this.context.bufnr, this.context.nvim);
    const lines = await buffer.getLines({ start: 0, end: -1 });

    // in visual mode, you can select past the end of the line, so we need to clamp the columns
    function clamp(pos: Position0Indexed): Position0Indexed {
      const line = lines[pos.row];
      if (line == undefined) {
        throw new Error(`Tried to clamp a non-existant line ${pos.row}`);
      }

      const buf = Buffer.from(line, "utf8");
      return {
        row: pos.row,
        col: Math.min(pos.col, buf.length) as ByteIdx,
      };
    }

    function pos1col1to0(pos: { row: number; col: number }): Position0Indexed {
      return {
        row: (pos.row - 1) as Row0Indexed,
        col: (pos.col - 1) as ByteIdx,
      };
    }

    await buffer.setText({
      startPos: clamp(pos1col1to0(this.selection.startPos)),
      endPos: clamp(pos1col1to0(this.selection.endPos)),
      lines: input.replace.split("\n") as Line[],
    });

    this.context.myDispatch({
      type: "finish",
      result: {
        status: "ok",
        value: "Successfully replaced selection",
      },
    });
  }

  view() {
    if (this.state.state == "processing") {
      return d`Applying edit...`;
    }

    if (this.state.result.result.status === "error") {
      return d`❌ Error replacing selection: ${this.state.result.result.error}`;
    } else {
      return d`✅ Successfully replaced selection`;
    }
  }

  displayInput() {
    return `replace: {
    replace:
\`\`\`
${this.request.input.replace}
\`\`\`
}`;
  }
}

export const spec: ProviderToolSpec = {
  name: "replace_selection",
  description: `Replace the selected text.`,
  input_schema: {
    type: "object",
    properties: {
      replace: {
        type: "string",
        description:
          "New content that will replace the existing text. This should be the complete text - do not skip lines or use ellipsis.",
      },
    },
    required: ["replace"],
    additionalProperties: false,
  },
};

export type Input = {
  replace: string;
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
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
