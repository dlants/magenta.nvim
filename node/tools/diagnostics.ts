import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { Dispatch, Thunk } from "../tea/tea.ts";
import type { Nvim } from "nvim-node";
import { parseLsResponse } from "../utils/lsBuffers.ts";
import type { ToolRequest } from "./toolManager.ts";
import type {
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";

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

type DiagnosticsRes = {
  end_col: number;
  message: string;
  namespace: number;
  col: number;
  code: number;
  end_lnum: number;
  source: string;
  lnum: number;
  user_data: {
    lsp: {
      code: number;
      message: string;
      range: {
        start: {
          character: number;
          line: number;
        };
        end: {
          character: number;
          line: number;
        };
      };
      tags: [];
      source: string;
      severity: number;
    };
  };
  bufnr: number;
  severity: number;
};

export class DiagnosticsTool {
  state: State;
  toolName = "diagnostics" as const;

  private constructor(
    public request: Extract<ToolRequest, { toolName: "diagnostics" }>,
    public context: { nvim: Nvim },
  ) {
    this.state = {
      state: "processing",
    };
  }

  static create(
    request: Extract<ToolRequest, { toolName: "diagnostics" }>,
    context: { nvim: Nvim },
  ): [DiagnosticsTool, Thunk<Msg>] {
    const tool = new DiagnosticsTool(request, context);
    return [tool, tool.getDiagnostics()];
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

  getDiagnostics(): Thunk<Msg> {
    return async (dispatch: Dispatch<Msg>) => {
      this.context.nvim.logger?.debug(`in diagnostics initModel`);
      let diagnostics;
      try {
        diagnostics = (await this.context.nvim.call("nvim_exec_lua", [
          `return vim.diagnostic.get(nil)`,
          [],
        ])) as DiagnosticsRes[];
      } catch (e) {
        throw new Error(`failed to nvim_exec_lua: ${JSON.stringify(e)}`);
      }
      const lsResponse = await this.context.nvim.call("nvim_exec2", [
        "ls",
        { output: true },
      ]);

      const result = parseLsResponse(lsResponse.output as string);
      const bufMap: { [bufId: string]: string } = {};
      for (const res of result) {
        bufMap[res.id] = res.filePath;
      }

      const content = diagnostics
        .map(
          (d) =>
            `file: ${bufMap[d.bufnr]} source: ${d.source}, severity: ${d.severity}, message: "${d.message}"`,
        )
        .join("\n");
      this.context.nvim.logger?.debug(`got diagnostics content: ${content}`);

      dispatch({
        type: "finish",
        result: {
          status: "ok",
          value: content,
        },
      });
    };
  }

  getToolResult(): ProviderToolResultContent {
    switch (this.state.state) {
      case "processing":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: `This tool use is being processed. Please proceed with your answer or address other parts of the question.`,
          },
        };
      case "done":
        return this.state.result;
      default:
        assertUnreachable(this.state);
    }
  }

  view() {
    switch (this.state.state) {
      case "processing":
        return d`⚙️ Getting diagnostics...`;
      case "done":
        return d`✅ Finished getting diagnostics.`;
      default:
        assertUnreachable(this.state);
    }
  }

  displayInput() {
    return `diagnostics: {}`;
  }
}

export const spec: ProviderToolSpec = {
  name: "diagnostics",
  description: "Get all diagnostic messages in the workspace.",
  input_schema: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
};

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type Input = {};

export function validateInput(): Result<Input> {
  return {
    status: "ok",
    value: {} as Input,
  };
}
