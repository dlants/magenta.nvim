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
      searchResults?: SearchResult[];
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
                `## Result ${i + 1} (score: ${r.score.toFixed(3)})\nFile: ${r.file}\nLines ${r.chunk.start.line}-${r.chunk.end.line}\n\n${r.chunk.contextualizedText}`,
            )
            .join("\n\n---\n\n");

          this.state = {
            state: "done",
            searchResults: results,
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
          searchResults: this.state.searchResults,
        });
      default:
        assertUnreachable(this.state);
    }
  }

  renderPreview(): VDOMNode {
    if (this.state.state !== "done" || !this.state.searchResults) {
      return d``;
    }
    return renderSearchPreview(this.state.searchResults);
  }

  renderDetail(): VDOMNode {
    if (this.state.state !== "done" || !this.state.searchResults) {
      return d``;
    }
    return renderSearchDetail(this.request.input, this.state.searchResults);
  }
}

export type SearchPkbCompletedInfo = CompletedToolInfo & {
  searchResults?: SearchResult[] | undefined;
};

type ParsedResult = {
  file: string;
  startLine: number;
  endLine: number;
  score: number;
  text: string;
};

function parseResultsFromText(text: string): ParsedResult[] {
  const results: ParsedResult[] = [];
  const resultPattern =
    /## Result \d+ \(score: ([\d.]+)\)\nFile: ([^\n]+)\nLines (\d+)-(\d+)\n\n([\s\S]*?)(?=\n\n---\n\n|$)/g;

  let match;
  while ((match = resultPattern.exec(text)) !== null) {
    results.push({
      score: parseFloat(match[1]),
      file: match[2],
      startLine: parseInt(match[3], 10),
      endLine: parseInt(match[4], 10),
      text: match[5],
    });
  }
  return results;
}

export function renderCompletedSummary(info: SearchPkbCompletedInfo): VDOMNode {
  const input = info.request.input as Input;
  const result = info.result.result;

  if (result.status === "error") {
    return d`🔍❌ PKB search: "${input.query}"`;
  }

  // Try to get counts from searchResults if available, otherwise parse from text
  let resultCount = 0;
  let fileCount = 0;

  if (info.searchResults) {
    resultCount = info.searchResults.length;
    fileCount = new Set(info.searchResults.map((r) => r.file)).size;
  } else if (result.value.length > 0 && result.value[0].type === "text") {
    const text = result.value[0].text;
    if (text === "No results found.") {
      resultCount = 0;
      fileCount = 0;
    } else {
      const parsed = parseResultsFromText(text);
      resultCount = parsed.length;
      fileCount = new Set(parsed.map((r) => r.file)).size;
    }
  }

  return d`🔍✅ PKB search: "${input.query}" (${resultCount.toString()} results in ${fileCount.toString()} files)`;
}

export function renderCompletedPreview(info: CompletedToolInfo): VDOMNode {
  const result = info.result.result;
  if (result.status !== "ok" || result.value.length === 0) {
    return d``;
  }

  const firstValue = result.value[0];
  if (firstValue.type !== "text") {
    return d``;
  }

  if (firstValue.text === "No results found.") {
    return d`No results found.`;
  }

  const parsed = parseResultsFromText(firstValue.text);
  if (parsed.length === 0) {
    return d``;
  }

  const fileGroups = new Map<string, ParsedResult[]>();
  for (const r of parsed) {
    const existing = fileGroups.get(r.file) || [];
    existing.push(r);
    fileGroups.set(r.file, existing);
  }

  const lines: VDOMNode[] = [];
  for (const [file, fileResults] of fileGroups) {
    const lineRanges = fileResults
      .map((r) => `${r.startLine}-${r.endLine}`)
      .join(", ");
    lines.push(d`• ${file}: lines ${lineRanges}`);
  }

  return d`${lines.map((line, i) => (i === lines.length - 1 ? line : d`${line}\n`))}`;
}

export function renderCompletedDetail(info: CompletedToolInfo): VDOMNode {
  const input = info.request.input as Input;
  const result = info.result.result;

  if (result.status !== "ok" || result.value.length === 0) {
    return d`Query: "${input.query}"`;
  }

  const firstValue = result.value[0];
  if (firstValue.type !== "text") {
    return d`Query: "${input.query}"`;
  }

  return d`Query: "${input.query}"

${firstValue.text}`;
}

function renderSearchPreview(results: SearchResult[]): VDOMNode {
  if (results.length === 0) {
    return d`No results found.`;
  }

  const fileGroups = new Map<string, SearchResult[]>();
  for (const r of results) {
    const existing = fileGroups.get(r.file) || [];
    existing.push(r);
    fileGroups.set(r.file, existing);
  }

  const lines: VDOMNode[] = [];
  for (const [file, fileResults] of fileGroups) {
    const lineRanges = fileResults
      .map((r) => `${r.chunk.start.line}-${r.chunk.end.line}`)
      .join(", ");
    lines.push(d`• ${file}: lines ${lineRanges}`);
  }

  return d`${lines.map((line, i) => (i === lines.length - 1 ? line : d`${line}\n`))}`;
}

function renderSearchDetail(input: Input, results: SearchResult[]): VDOMNode {
  if (results.length === 0) {
    return d`Query: "${input.query}"
No results found.`;
  }

  const resultBlocks = results.map((r, i) => {
    return d`## Result ${(i + 1).toString()} (score: ${r.score.toFixed(3)})
File: ${r.file}
Lines ${r.chunk.start.line.toString()}-${r.chunk.end.line.toString()}

${r.chunk.contextualizedText}`;
  });

  return d`Query: "${input.query}"

${resultBlocks.map((block, i) => (i === resultBlocks.length - 1 ? block : d`${block}\n\n---\n\n`))}`;
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
