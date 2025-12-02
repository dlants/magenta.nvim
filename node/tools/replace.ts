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
import type { Dispatch } from "../tea/tea.ts";
import type { StaticToolRequest } from "./toolManager.ts";
import type {
  ProviderToolResult,
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import { applyEdit } from "./applyEdit.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { RootMsg } from "../root-msg.ts";
import type { MessageId } from "../chat/message.ts";
import * as diff from "diff";
import type { ThreadId } from "../chat/types";
import type { StaticTool, ToolName } from "./types.ts";
import type { NvimCwd, UnresolvedFilePath } from "../utils/files.ts";
import type { BufferTracker } from "../buffer-tracker.ts";
import { resolveFilePath } from "../utils/files.ts";
import type { MagentaOptions } from "../options.ts";
import { canWriteFile } from "./permissions.ts";
import type { Gitignore } from "./util.ts";

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

export class ReplaceTool implements StaticTool {
  state: State;
  toolName = "replace" as const;

  constructor(
    public request: Extract<StaticToolRequest, { toolName: "replace" }>,
    public threadId: ThreadId,
    public messageId: MessageId,
    private context: {
      myDispatch: Dispatch<Msg>;
      dispatch: Dispatch<RootMsg>;
      bufferTracker: BufferTracker;
      cwd: NvimCwd;
      nvim: Nvim;
      options: MagentaOptions;
      getDisplayWidth(): number;
      gitignore: Gitignore;
    },
  ) {
    this.state = { state: "pending" };

    // wrap in setTimeout to force a new eventloop frame, so we don't dispatch-in-dispatch
    setTimeout(() => {
      try {
        this.initReplace();
      } catch (error) {
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

  private initReplace(): void {
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

  private async doReplace(): Promise<void> {
    await applyEdit(this.request, this.threadId, this.messageId, this.context);
  }

  isDone(): boolean {
    return this.state.state === "done";
  }

  isPendingUserAction(): boolean {
    return this.state.state === "pending-user-action";
  }

  abort(): void {
    this.state = {
      state: "done",
      result: {
        type: "tool_result",
        id: this.request.id,
        result: {
          status: "error",
          error: "The user aborted this tool request.",
        },
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
              this.doReplace().catch((error: Error) =>
                this.context.myDispatch({
                  type: "finish",
                  result: {
                    status: "error",
                    error: error.message + "\n" + error.stack,
                  },
                }),
              );
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
                  error: `The user did not allow this replacement.`,
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
            this.doReplace().catch((error: Error) =>
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
        return;
      }
      default:
        assertUnreachable(msg);
    }
  }

  renderSummary(): VDOMNode {
    const findLines = this.countLines(this.request.input.find);
    const replaceLines = this.countLines(this.request.input.replace);

    switch (this.state.state) {
      case "pending":
      case "processing":
        return d`✏️⚙️ Replace [[ -${findLines.toString()} / +${replaceLines.toString()} ]] in ${withInlineCode(d`\`${this.request.input.filePath}\``)}`;
      case "pending-user-action":
        return d`✏️⏳ May I replace in file ${withInlineCode(d`\`${this.request.input.filePath}\``)}?

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
        if (this.state.result.result.status === "error") {
          return d`✏️❌ Replace [[ -${findLines.toString()} / +${replaceLines.toString()} ]] in ${withInlineCode(d`\`${this.request.input.filePath}\``)} - ${this.state.result.result.error}`;
        } else {
          return d`✏️✅ Replace [[ -${findLines.toString()} / +${replaceLines.toString()} ]] in ${withInlineCode(d`\`${this.request.input.filePath}\``)}`;
        }
      default:
        assertUnreachable(this.state);
    }
  }

  renderPreview(): VDOMNode {
    switch (this.state.state) {
      case "pending":
      case "pending-user-action":
      case "processing":
        return d``;
      case "done":
        if (this.state.result.result.status === "error") {
          return d``;
        } else {
          return this.renderDiffPreview();
        }
      default:
        assertUnreachable(this.state);
    }
  }

  countLines(str: string) {
    return (str.match(/\n/g) || []).length + 1;
  }

  getReplacePreview(): string {
    const find = this.request.input.find;
    const replace = this.request.input.replace;

    const diffResult = diff.createPatch(
      this.request.input.filePath,
      find,
      replace,
      "before",
      "after",
      {
        context: 2,
        ignoreNewlineAtEof: true,
      },
    );

    // slice off the diff header
    const diffLines = diffResult.split("\n").slice(5);

    const maxLines = 10;
    const maxLength = 80;

    let previewLines =
      diffLines.length > maxLines
        ? diffLines.slice(diffLines.length - maxLines)
        : diffLines;

    previewLines = previewLines.map((line) => {
      if (line.length > maxLength) {
        return line.substring(0, maxLength) + "...";
      }
      return line;
    });

    // Add prefix indicators
    let result = previewLines.join("\n");

    // Add ellipsis if we truncated
    if (diffLines.length > maxLines) {
      result = "...\n" + result;
    }

    return result;
  }

  private renderDiffPreview(): VDOMNode {
    const find = this.request.input.find;
    const replace = this.request.input.replace;

    const diffResult = diff.createPatch(
      this.request.input.filePath,
      find,
      replace,
      "before",
      "after",
      {
        context: 2,
        ignoreNewlineAtEof: true,
      },
    );

    // slice off the diff header
    const diffLines = diffResult.split("\n").slice(5);

    const maxLines = 10;
    const maxLength = this.context.getDisplayWidth() - 5;

    let previewLines =
      diffLines.length > maxLines
        ? diffLines.slice(diffLines.length - maxLines)
        : diffLines;

    previewLines = previewLines.map((line) => {
      if (line.length > maxLength) {
        return line.substring(0, maxLength) + "...";
      }
      return line;
    });

    // Add ellipsis if we truncated
    const allLines =
      diffLines.length > maxLines ? ["...", ...previewLines] : previewLines;

    // Create diff content with individual line highlighting
    const diffContent = allLines.map((line) => {
      if (line.startsWith("+")) {
        return withExtmark(d`${line}`, { line_hl_group: "DiffAdd" });
      } else if (line.startsWith("-")) {
        return withExtmark(d`${line}`, { line_hl_group: "DiffDelete" });
      } else {
        return d`${line}`;
      }
    });

    return withCode(d`\`\`\`diff
${diffContent.map((line, index) => (index === diffContent.length - 1 ? line : d`${line}\n`))}
\`\`\``);
  }

  renderDetail(): VDOMNode {
    const find = this.request.input.find;
    const replace = this.request.input.replace;

    const diffResult = diff.createPatch(
      this.request.input.filePath,
      find,
      replace,
      "before",
      "after",
      {
        context: 5,
        ignoreNewlineAtEof: true,
      },
    );

    // slice off the diff header
    const diffLines = diffResult.split("\n").slice(5);

    // Create diff content with individual line highlighting
    const diffContent = diffLines.map((line) => {
      if (line.startsWith("+")) {
        return withExtmark(d`${line}`, { line_hl_group: "DiffAdd" });
      } else if (line.startsWith("-")) {
        return withExtmark(d`${line}`, { line_hl_group: "DiffDelete" });
      } else {
        return d`${line}`;
      }
    });

    return d`\
filePath: ${withInlineCode(d`\`${this.request.input.filePath}\``)}
${withCode(d`\`\`\`diff
${diffContent.map((line, index) => (index === diffContent.length - 1 ? line : d`${line}\n`))}
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

export const spec: ProviderToolSpec = {
  name: "replace" as ToolName,
  description: `This is a tool for replacing text in a file.

Break up large replace calls into multiple, small replace calls. Ideally each replace is less than 20 lines of code.
A large replace increases the probability of making a mistake in the find parameter.
You will detect errors faster, and waste less time if you approach this through a series of smaller edits.

Try to make each replace call meaningful and atomic. This makes it easier for the human to review and understand your changes.`,
  input_schema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Path of the file to modify.",
      },
      find: {
        type: "string",
        description: `The text to replace.

\`find\` MUST uniquely identify the text you want to replace. You MUST provide at least 5 lines of context to ensure that only one location in the file matches this text.

This should be the complete text to replace, exactly as it appears in the file, including indentation. Regular expressions are not supported.

If the text appears multiple times, only the first match will be replaced. If you would like to replace multiple instances of the same text, use multiple tool calls.

Special case: If \`find\` is an empty string (""), the entire file content will be replaced with the \`replace\` text.`,
      },
      replace: {
        type: "string",
        description: `This will replace all of the find text. If you provided extra lines for context, repeat the context lines exactly as they appear to preserve them.

This MUST be the complete and exact replacement text. Make sure to match braces and indentation.`,
      },
    },
    required: ["filePath", "find", "replace"],
  },
};

export type Input = {
  filePath: UnresolvedFilePath;
  find: string;
  replace: string;
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.filePath != "string") {
    return {
      status: "error",
      error: `expected req.input.filePath to be a string, but input was ${JSON.stringify(input)}`,
    };
  }

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
const FIND_KEY_STR = '"find":"';
const REPLACE_KEY_STR = '"replace":"';

export function renderStreamedBlock(streamed: string): VDOMNode {
  // Look for file path pattern
  const filePathMatch = streamed.match(/"filePath"\s*:\s*"([^"]+)"/);
  const filePath = filePathMatch ? filePathMatch[1] : null;

  // Count negative lines (find)
  let findLineCount = 1; // Start with 1 for the first line
  const findKeyIndex = streamed.indexOf(FIND_KEY_STR);
  if (findKeyIndex !== -1) {
    // Start after the opening quote
    for (let i = findKeyIndex + FIND_KEY_STR.length; i < streamed.length; i++) {
      const char = streamed[i];
      const prevChar = i > 0 ? streamed[i - 1] : "";

      if (char === '"' && prevChar !== "\\") {
        // Unescaped quote marks the end of content
        break;
      } else if (char === "n" && prevChar === "\\") {
        // Found a newline sequence
        findLineCount++;
      }
    }
  }

  // Count positive lines (replace)
  let replaceLineCount = 1; // Start with 1 for the first line
  const replaceKeyIndex = streamed.indexOf(REPLACE_KEY_STR);
  if (replaceKeyIndex !== -1) {
    // Start after the opening quote
    for (
      let i = replaceKeyIndex + REPLACE_KEY_STR.length;
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
        replaceLineCount++;
      }
    }
  }

  // Format the message in the same style as the view method
  if (filePath) {
    return d`⏳✅ Replace [[ -${findLineCount.toString()} / +${replaceLineCount.toString()} ]] in ${withInlineCode(d`\`${filePath}\``)} streaming...`;
  } else {
    return d`⏳ Preparing replace operation...`;
  }
}
