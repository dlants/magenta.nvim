import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { CompletedToolInfo } from "./types.ts";
import type {
  ProviderToolResult,
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { StaticTool, ToolName, GenericToolRequest } from "./types.ts";
import { NvimBuffer, type BufNr, type Line } from "../nvim/buffer.ts";
import type {
  ByteIdx,
  Position0Indexed,
  Position1IndexedCol1Indexed,
  Row0Indexed,
} from "../nvim/window.ts";

export type Input = {
  replace: string;
};

export type ToolRequest = GenericToolRequest<"replace_selection", Input>;

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

export type NvimSelection = {
  startPos: Position1IndexedCol1Indexed;
  endPos: Position1IndexedCol1Indexed;
  text: string;
};

export class ReplaceSelectionTool implements StaticTool {
  state: State;
  toolName = "replace_selection" as const;
  aborted: boolean = false;

  constructor(
    public request: ToolRequest,
    public selection: NvimSelection,
    public context: { bufnr: BufNr; nvim: Nvim; myDispatch: Dispatch<Msg> },
  ) {
    this.state = {
      state: "processing",
    };

    // setTimeout to force a new eventloop frame, to avoid dispatch-in-dispatch
    setTimeout(() => {
      if (this.aborted) return;
      this.apply().catch((err: Error) => {
        if (this.aborted) return;
        this.context.myDispatch({
          type: "finish",
          result: {
            status: "error",
            error: err.message + "\n" + err.stack,
          },
        });
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

  async apply() {
    const input = this.request.input;

    const buffer = new NvimBuffer(this.context.bufnr, this.context.nvim);
    const lines = await buffer.getLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
    });

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

    if (this.aborted) return;

    this.context.myDispatch({
      type: "finish",
      result: {
        status: "ok",
        value: [{ type: "text", text: "Successfully replaced selection" }],
      },
    });
  }

  renderSummary() {
    switch (this.state.state) {
      case "processing":
        return d`🔄⚙️ replace_selection`;
      case "done":
        return renderCompletedSummary({
          request: this.request as CompletedToolInfo["request"],
          result: this.state.result,
        });
      default:
        assertUnreachable(this.state);
    }
  }

  renderPreview() {
    switch (this.state.state) {
      case "processing":
        return d`⚙️ Applying edit...`;
      case "done": {
        const result = this.state.result.result;
        if (result.status === "error") {
          return d`❌ ${result.error}`;
        } else {
          return d`✅ Successfully replaced selection`;
        }
      }
      default:
        assertUnreachable(this.state);
    }
  }
}

export function renderCompletedSummary(info: CompletedToolInfo): VDOMNode {
  const result = info.result.result;
  const status = result.status === "error" ? "❌" : "✅";
  return d`🔄${status} replace_selection`;
}

export const spec: ProviderToolSpec = {
  name: "replace_selection" as ToolName,
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
  },
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
