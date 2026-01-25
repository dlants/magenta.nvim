import { assertUnreachable } from "../utils/assertUnreachable.ts";
import {
  d,
  type VDOMNode,
  withInlineCode,
  withCode,
  withExtmark,
  withBindings,
} from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { CompletedToolInfo } from "./types.ts";
import type { Dispatch } from "../tea/tea.ts";
import type {
  ProviderToolResult,
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import { applyEdit } from "./applyEdit.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { RootMsg } from "../root-msg.ts";
import type { ThreadId } from "../chat/types.ts";
import type { StaticTool, ToolName, GenericToolRequest } from "./types.ts";
import type { NvimCwd, UnresolvedFilePath } from "../utils/files.ts";
import type { BufferTracker } from "../buffer-tracker.ts";
import { resolveFilePath } from "../utils/files.ts";
import type { MagentaOptions } from "../options.ts";
import { canWriteFile } from "./permissions.ts";
import type { Gitignore } from "./util.ts";

export type ToolRequest = GenericToolRequest<"insert", Input>;

export type State =
  | {
      state: "pending";
    }
  | {
      state: "processing";
      approved: boolean;
    }
  | {
      state: "pending-user-action";
    }
  | {
      state: "done";
      result: ProviderToolResult;
    };

export type Msg =
  | {
      type: "finish";
      result: Result<ProviderToolResultContent[]>;
    }
  | {
      type: "automatic-approval";
    }
  | {
      type: "request-user-approval";
    }
  | {
      type: "user-approval";
      approved: boolean;
    };

export class InsertTool implements StaticTool {
  state: State;
  toolName = "insert" as const;
  aborted: boolean = false;

  constructor(
    public request: ToolRequest,
    public threadId: ThreadId,
    private context: {
      myDispatch: Dispatch<Msg>;
      bufferTracker: BufferTracker;
      nvim: Nvim;
      cwd: NvimCwd;
      dispatch: Dispatch<RootMsg>;
      options: MagentaOptions;
      getDisplayWidth: () => number;
      gitignore: Gitignore;
    },
  ) {
    this.state = { state: "pending" };

    // wrap in setTimeout to force a new eventloop frame, so we don't dispatch-in-dispatch
    setTimeout(() => {
      if (this.aborted) return;
      try {
        this.initInsert();
      } catch (error) {
        if (this.aborted) return;
        this.context.myDispatch({
          type: "finish",
          result: {
            status: "error",
            error: (error as Error).message + "\n" + (error as Error).stack,
          },
        });
      }
    });
  }

  private initInsert(): void {
    if (this.aborted) return;

    const filePath = this.request.input.filePath;
    const absFilePath = resolveFilePath(this.context.cwd, filePath);

    if (this.state.state === "pending") {
      const allowed = canWriteFile(absFilePath, this.context);

      if (allowed) {
        this.context.myDispatch({
          type: "automatic-approval",
        });
      } else {
        this.context.myDispatch({ type: "request-user-approval" });
      }
    }
  }

  private async doInsert(): Promise<void> {
    await applyEdit(this.request, this.threadId, this.context);
  }

  isDone(): boolean {
    return this.state.state === "done";
  }

  isPendingUserAction(): boolean {
    return this.state.state === "pending-user-action";
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
      case "request-user-approval":
        if (this.state.state === "pending") {
          this.state = {
            state: "pending-user-action",
          };
        }
        return;
      case "user-approval": {
        if (this.state.state === "pending-user-action") {
          if (msg.approved) {
            this.state = {
              state: "processing",
              approved: true,
            };

            // wrap in setTimeout to force a new eventloop frame, to avoid dispatch-in-dispatch
            setTimeout(() => {
              if (this.aborted) return;
              this.doInsert().catch((error: Error) => {
                if (this.aborted) return;
                this.context.myDispatch({
                  type: "finish",
                  result: {
                    status: "error",
                    error: error.message + "\n" + error.stack,
                  },
                });
              });
            });
            return;
          } else {
            this.state = {
              state: "done",
              result: {
                type: "tool_result",
                id: this.request.id,
                result: {
                  status: "error",
                  error: `The user did not allow this insertion.`,
                },
              },
            };
            return;
          }
        }
        return;
      }
      case "automatic-approval": {
        if (this.state.state === "pending") {
          this.state = {
            state: "processing",
            approved: true,
          };

          // wrap in setTimeout to force a new eventloop frame, to avoid dispatch-in-dispatch
          setTimeout(() => {
            if (this.aborted) return;
            this.doInsert().catch((error: Error) => {
              if (this.aborted) return;
              this.context.myDispatch({
                type: "finish",
                result: {
                  status: "error",
                  error: error.message + "\n" + error.stack,
                },
              });
            });
          });
        }
        return;
      }
      default:
        assertUnreachable(msg);
    }
  }

  renderSummary(): VDOMNode {
    const lineCount =
      (this.request.input.content.match(/\n/g) || []).length + 1;

    switch (this.state.state) {
      case "pending":
      case "processing":
        return d`✏️⚙️ Insert [[ +${lineCount.toString()} ]] in ${withInlineCode(d`\`${this.request.input.filePath}\``)}`;
      case "pending-user-action":
        return d`✏️⏳ May I insert in file ${withInlineCode(d`\`${this.request.input.filePath}\``)}?

┌────────────────┐
│ ${withBindings(
          withExtmark(d`[ NO ]`, {
            hl_group: ["ErrorMsg", "@markup.strong.markdown"],
          }),
          {
            "<CR>": () =>
              this.context.myDispatch({
                type: "user-approval",
                approved: false,
              }),
          },
        )} ${withBindings(
          withExtmark(d`[ YES ]`, {
            hl_group: ["String", "@markup.strong.markdown"],
          }),
          {
            "<CR>": () =>
              this.context.myDispatch({
                type: "user-approval",
                approved: true,
              }),
          },
        )} │
└────────────────┘`;
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
    switch (this.state.state) {
      case "pending":
      case "processing":
        return d``;
      case "pending-user-action":
        return renderInsertPreview(
          this.request.input,
          this.context.getDisplayWidth(),
        );
      case "done":
        if (this.state.result.result.status === "error") {
          return d``;
        } else {
          return renderInsertPreview(
            this.request.input,
            this.context.getDisplayWidth(),
          );
        }
      default:
        assertUnreachable(this.state);
    }
  }

  renderDetail(): VDOMNode {
    return d`\
filePath: ${withInlineCode(d`\`${this.request.input.filePath}\``)}
insertAfter: ${withInlineCode(d`\`${this.request.input.insertAfter}\``)}
content:
${withCode(d`\`\`\`
${withExtmark(d`${this.request.input.content}`, { line_hl_group: "DiffAdd" })}
\`\`\``)}`;
  }

  getToolResult(): ProviderToolResult {
    switch (this.state.state) {
      case "done":
        return this.state.result;
      case "pending":
      case "processing":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: [
              {
                type: "text",
                text: `This tool use is being processed. Please proceed with your answer or address other parts of the question.`,
              },
            ],
          },
        };
      case "pending-user-action":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: [
              {
                type: "text",
                text: `Waiting for user approval to finish processing this tool use.`,
              },
            ],
          },
        };
      default:
        assertUnreachable(this.state);
    }
  }
}

export function renderCompletedSummary(info: CompletedToolInfo): VDOMNode {
  const input = info.request.input as Input;
  const lineCount = (input.content.match(/\n/g) || []).length + 1;
  const result = info.result.result;
  const status = result.status === "error" ? "❌" : "✅";

  if (result.status === "error") {
    return d`✏️${status} Insert [[ +${lineCount.toString()} ]] in ${withInlineCode(d`\`${input.filePath}\``)} - ${result.error}`;
  }
  return d`✏️${status} Insert [[ +${lineCount.toString()} ]] in ${withInlineCode(d`\`${input.filePath}\``)}`;
}

export function renderInsertPreview(
  input: Input,
  displayWidth: number,
): VDOMNode {
  const content = input.content;
  const lines = content.split("\n");
  const maxLines = 5;
  const maxLength = displayWidth - 5;

  let previewLines = lines.length > maxLines ? lines.slice(-maxLines) : lines;
  previewLines = previewLines.map((line) =>
    line.length > maxLength ? line.substring(0, maxLength) + "..." : line,
  );

  let result = previewLines.join("\n");
  if (lines.length > maxLines) {
    result = "...\n" + result;
  }

  return withCode(d`\`\`\`
${withExtmark(d`${result}`, { line_hl_group: "DiffAdd" })}
\`\`\``);
}

export function renderInsertDetail(input: Input): VDOMNode {
  return d`\
filePath: ${withInlineCode(d`\`${input.filePath}\``)}
insertAfter: ${withInlineCode(d`\`${input.insertAfter}\``)}
content:
${withCode(d`\`\`\`
${withExtmark(d`${input.content}`, { line_hl_group: "DiffAdd" })}
\`\`\``)}`;
}

export const spec: ProviderToolSpec = {
  name: "insert" as ToolName,
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

The insertAfter string MUST uniquely identify a single location in the file. Provide at least 3 lines of context from the target file to ensure that the insert only matches ONE location.

If insertAfter only contains punctuation (new lines, braces), expand it to 5 or more lines until you get some identifiers.

Break up large inserts into smaller chunks (20-30 lines). This way, you are more likely to detect errors early and won't waste as much time generating an insert command that will fail.

This should exactly match the file content, including indentation. Regular expressions are not supported.

Content will be inserted on the same line, immediately after insertAfter. If you want to insert on a new line,
make sure to include the last newline character in insertAfter or start content with a new line.

Set insertAfter to the empty string to append to the end of the file.`,
      },
      content: {
        type: "string",
        description: `Content to insert immediately after the insertAfter text.
Make sure you match braces and indentation.
`,
      },
    },
    required: ["filePath", "insertAfter", "content"],
  },
};

export type Input = {
  filePath: UnresolvedFilePath;
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

const CONTENT_START_STR = '"content":"';
export function renderStreamedBlock(streamed: string): VDOMNode {
  // Look for file path pattern
  const filePathMatch = streamed.match(/"filePath"\s*:\s*"([^"]+)"/);
  const filePath = filePathMatch ? filePathMatch[1] : null;

  // Check for content and count lines
  let lineCount = 1; // Start with 1 for the first line
  const contentKeyIndex = streamed.indexOf(CONTENT_START_STR);
  if (contentKeyIndex !== -1) {
    // Start after the opening quote
    for (
      let i = contentKeyIndex + CONTENT_START_STR.length;
      i < streamed.length;
      i++
    ) {
      const char = streamed[i];
      const prevChar = i > 0 ? streamed[i - 1] : "";

      if (char === '"' && prevChar !== "\\") {
        // Unescaped quote marks the end of content
        break;
      } else if (char === "n" && prevChar === "\\") {
        // Found a newline sequence
        lineCount++;
      }
    }
  }

  // Format the message in the same style as the view method
  if (filePath) {
    return d`⏳ Insert [[ +${lineCount.toString()} ]] in ${withInlineCode(d`\`${filePath}\``)} streaming...`;
  } else {
    return d`⏳ Insert...`;
  }
}
