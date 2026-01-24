import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import type { Result } from "../utils/result.ts";
import type { Nvim } from "../nvim/nvim-node";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { StaticTool, ToolName, GenericToolRequest } from "./types.ts";
import type { PKB, SearchResult } from "../pkb/pkb.ts";
import type { CompletedToolInfo } from "./types.ts";

export type ToolRequest = GenericToolRequest<"search_pkb", Input>;

export type State =
  | {
      state: "pending";
    }
  | {
      state: "searching";
    }
  | {
      state: "done";
      result: ProviderToolResult;
    };

export type Msg = {
  type: "finish";
  result: Result<SearchResult[]>;
};

export class SearchPkbTool implements StaticTool {
  state: State;
  toolName = "search_pkb" as const;
  aborted: boolean = false;

  constructor(
    public request: ToolRequest,
    public context: {
      nvim: Nvim;
      pkb: PKB;
      myDispatch: Dispatch<Msg>;
    },
  ) {
    this.state = {
      state: "pending",
    };

    setTimeout(() => {
      this.executeSearch().catch((error: Error) =>
        this.context.myDispatch({
          type: "finish",
          result: {
            status: "error",
            error: error.message + "\n" + error.stack,
          },
        }),
      );
    });
  }

  private async executeSearch(): Promise<void> {
    if (this.aborted) return;

    this.state = { state: "searching" };

    const results = await this.context.pkb.search(
      this.request.input.query,
      this.request.input.topK ?? 10,
    );

    this.context.myDispatch({
      type: "finish",
      result: {
        status: "ok",
        value: results,
      },
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
      return this.state.result;
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

  update(msg: Msg) {
    switch (msg.type) {
      case "finish":
        if (msg.result.status === "error") {
          this.state = {
            state: "done",
            result: {
              type: "tool_result",
              id: this.request.id,
              result: {
                status: "error",
                error: msg.result.error,
              },
            },
          };
        } else {
          const results = msg.result.value;
          const formattedResults = results
            .map(
              (r, i) =>
                `## Result ${i + 1} (score: ${r.score.toFixed(3)})\nFile: ${r.file}\nLines ${r.chunk.start.line}-${r.chunk.end.line}\n\n${r.chunk.text}`,
            )
            .join("\n\n---\n\n");

          this.state = {
            state: "done",
            result: {
              type: "tool_result",
              id: this.request.id,
              result: {
                status: "ok",
                value: [
                  {
                    type: "text",
                    text:
                      results.length > 0
                        ? formattedResults
                        : "No results found.",
                  },
                ],
              },
            },
          };
        }
        return;
      default:
        assertUnreachable(msg.type);
    }
  }

  getToolResult(): ProviderToolResult {
    switch (this.state.state) {
      case "pending":
      case "searching":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: [
              {
                type: "text",
                text: `Searching PKB...`,
              },
            ],
          },
        };
      case "done":
        return this.state.result;
      default:
        assertUnreachable(this.state);
    }
  }

  renderSummary(): VDOMNode {
    switch (this.state.state) {
      case "pending":
      case "searching":
        return d`🔍⚙️ Searching PKB for "${this.request.input.query}"`;
      case "done":
        return renderCompletedSummary({
          request: this.request as CompletedToolInfo["request"],
          result: this.state.result,
        });
      default:
        assertUnreachable(this.state);
    }
  }
}

export function renderCompletedSummary(info: CompletedToolInfo): VDOMNode {
  const input = info.request.input as Input;
  const result = info.result.result;

  if (result.status === "error") {
    return d`🔍❌ PKB search: "${input.query}"`;
  }

  return d`🔍✅ PKB search: "${input.query}"`;
}

export const spec: ProviderToolSpec = {
  name: "search_pkb" as ToolName,
  description: `Search the personal knowledge base (PKB) for relevant information using semantic search.
The PKB contains markdown documents that have been embedded for similarity search.
Use this tool to find relevant context, documentation, or notes that may help with the current task.`,
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: `The search query. This will be embedded and compared against chunks of text in the PKB.`,
      },
      topK: {
        type: "number",
        description: `Number of results to return. Defaults to 10.`,
      },
    },
    required: ["query"],
  },
};

export type Input = {
  query: string;
  topK?: number;
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.query !== "string") {
    return {
      status: "error",
      error: "expected req.input.query to be a string",
    };
  }

  if (input.topK !== undefined && typeof input.topK !== "number") {
    return {
      status: "error",
      error: "expected req.input.topK to be a number",
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
