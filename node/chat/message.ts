import { ToolManager, type ToolRequestId } from "../tools/toolManager.ts";
import { type Role, type ThreadId } from "./thread.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, withBindings } from "../tea/view.ts";
import type { Nvim } from "../nvim/nvim-node";
import { type Dispatch } from "../tea/tea.ts";
import type { RootMsg } from "../root-msg.ts";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow.ts";
import type { MagentaOptions } from "../options.ts";
import type { FileSnapshots } from "../tools/file-snapshots.ts";
import { displaySnapshotDiff } from "../tools/display-snapshot-diff.ts";
import type { AbsFilePath, UnresolvedFilePath } from "../utils/files.ts";
import type {
  ProviderMessageContent,
  ProviderStreamEvent,
  StopReason,
  Usage,
} from "../providers/provider.ts";
import {
  applyDelta,
  finalizeStreamingBlock,
  renderContentValue,
  type StreamingBlock,
} from "../providers/helpers.ts";
import { renderStreamdedTool } from "../tools/helpers.ts";
import type { WebSearchResultBlock } from "@anthropic-ai/sdk/resources.mjs";
import type { FileUpdates } from "../context/context-manager.ts";
export type MessageId = number & { __messageId: true };
import type { Input as GetFileInput } from "../tools/getFile.ts";
import type { Input as ReplaceInput } from "../tools/replace.ts";

type State = {
  id: MessageId;
  role: Role;
  streamingBlock: StreamingBlock | undefined;
  content: ProviderMessageContent[];
  stops: {
    [contentIdx: number]: {
      stopReason: StopReason;
      usage: Usage;
    };
  };
  contextUpdates?: FileUpdates | undefined;
  expandedUpdates?: {
    [absFilePath: string]: boolean;
  };
  edits: {
    [filePath: UnresolvedFilePath]: {
      requestIds: ToolRequestId[];
      status:
        | {
            status: "pending";
          }
        | {
            status: "error";
            message: string;
          };
    };
  };
  toolDetailsExpanded: {
    [requestId: ToolRequestId]: boolean;
  };
};

export type Msg =
  | {
      type: "stream-event";
      event: Extract<
        ProviderStreamEvent,
        {
          type:
            | "content_block_start"
            | "content_block_delta"
            | "content_block_stop";
        }
      >;
    }
  | {
      type: "open-edit-file";
      filePath: UnresolvedFilePath | AbsFilePath;
    }
  | {
      type: "diff-snapshot";
      filePath: string;
    }
  | {
      type: "toggle-expand-update";
      filePath: AbsFilePath;
    }
  | {
      type: "toggle-tool-details";
      requestId: ToolRequestId;
    }
  | {
      type: "stop";
      stopReason: StopReason;
      usage: Usage;
    };

export class Message {
  public state: State;
  constructor(
    initialState: {
      id: State["id"];
      role: State["role"];
      content?: State["content"];
      contextUpdates?: State["contextUpdates"];
    },
    private context: {
      dispatch: Dispatch<RootMsg>;
      myDispatch: Dispatch<Msg>;
      threadId: ThreadId;
      nvim: Nvim;
      toolManager: ToolManager;
      fileSnapshots: FileSnapshots;
      options: MagentaOptions;
    },
  ) {
    this.state = {
      streamingBlock: undefined,
      content: [],
      stops: {},
      edits: {},
      toolDetailsExpanded: {},
      ...initialState,
    };
  }

  update(msg: Msg) {
    switch (msg.type) {
      case "stream-event": {
        switch (msg.event.type) {
          case "content_block_start": {
            if (this.state.streamingBlock) {
              throw new Error(
                `Unexpected block start while previous streaming block not closed.`,
              );
            }

            this.state.streamingBlock = {
              ...msg.event.content_block,
              streamed: "",
            };
            return;
          }

          case "content_block_delta":
            if (!this.state.streamingBlock) {
              throw new Error(
                `Received delta when streaming block not initialized.`,
              );
            }
            applyDelta(this.state.streamingBlock, msg.event);
            return;

          case "content_block_stop": {
            if (!this.state.streamingBlock) {
              throw new Error(
                `Received block stop when streaming block not initialized.`,
              );
            }
            const block = finalizeStreamingBlock(this.state.streamingBlock);
            this.state.content.push(block);
            this.state.streamingBlock = undefined;

            if (block.type == "tool_use" && block.request.status == "ok") {
              const request = block.request.value;

              this.context.toolManager.update({
                type: "init-tool-use",
                request,
                messageId: this.state.id,
                threadId: this.context.threadId,
              });

              const tool = this.context.toolManager.getTool(request.id);
              if (!tool) {
                throw new Error(
                  `Tool request did not initialize successfully: ${request.id}`,
                );
              }

              if (tool.toolName == "insert" || tool.toolName == "replace") {
                const input = tool.request.input as GetFileInput | ReplaceInput;
                const filePath = input.filePath;

                if (!this.state.edits[filePath]) {
                  this.state.edits[filePath] = {
                    status: { status: "pending" },
                    requestIds: [],
                  };
                }

                this.state.edits[filePath].requestIds.push(request.id);
              }
            }

            return;
          }

          default:
            return assertUnreachable(msg.event);
        }
      }

      case "open-edit-file": {
        openFileInNonMagentaWindow(msg.filePath, this.context).catch(
          (e: Error) => this.context.nvim.logger?.error(e.message),
        );
        return;
      }

      case "diff-snapshot": {
        displaySnapshotDiff({
          unresolvedFilePath: msg.filePath as UnresolvedFilePath,
          messageId: this.state.id,
          nvim: this.context.nvim,
          fileSnapshots: this.context.fileSnapshots,
        }).catch((e: Error) => this.context.nvim.logger?.error(e.message));
        return;
      }

      case "toggle-expand-update": {
        this.state.expandedUpdates = this.state.expandedUpdates || {};
        this.state.expandedUpdates[msg.filePath] =
          !this.state.expandedUpdates[msg.filePath];
        return;
      }

      case "toggle-tool-details": {
        this.state.toolDetailsExpanded[msg.requestId] =
          !this.state.toolDetailsExpanded[msg.requestId];
        return;
      }

      case "stop": {
        this.state.stops[this.state.content.length - 1] = {
          stopReason: msg.stopReason,
          usage: msg.usage,
        };
        return;
      }

      default:
        assertUnreachable(msg);
    }
  }

  setContext(updates: FileUpdates) {
    this.state.contextUpdates = updates;
  }

  renderTool(tool: ReturnType<ToolManager["getTool"]>) {
    if (!tool) {
      return "";
    }

    const showDetails =
      this.state.toolDetailsExpanded[tool.request.id] || false;

    return withBindings(
      d`${tool.view()}${
        showDetails
          ? d`\nid: ${tool.request.id}\n${tool.displayInput()}\n${this.context.toolManager.renderToolResult(tool.request.id)}`
          : ""
      }`,
      {
        "<CR>": () =>
          this.context.myDispatch({
            type: "toggle-tool-details",
            requestId: tool.request.id,
          }),
      },
    );
  }

  toString() {
    // Basic message info
    let result = `Message(id=${this.state.id}, role=${this.state.role}):\n`;

    // Parts info
    result += `  Content: ${this.state.content.length}\n`;

    // List all parts with their toString representation
    if (this.state.content.length > 0) {
      result += "  Content details:\n";
      this.state.content.forEach((content, index) => {
        result += `    ${index}: ${JSON.stringify(content)}\n`;
      });
    }

    // File edits info
    const editCount = Object.keys(this.state.edits).length;
    if (editCount > 0) {
      result += `  Edits: ${editCount} files\n`;
      for (const [filePath, edit] of Object.entries(this.state.edits)) {
        result += `    - ${filePath}: ${edit.requestIds.length} edits (${edit.status.status})\n`;
      }
    } else {
      result += "  Edits: none\n";
    }

    return result;
  }

  view() {
    const renderContentWithStop = (
      content: ProviderMessageContent,
      contentIdx: number,
    ) => {
      let stopView;
      if (this.state.stops[contentIdx]) {
        stopView = this.renderStop(contentIdx);
      }

      return d`${this.renderContent(content)}\n${stopView ?? ""}`;
    };

    return d`\
# ${this.state.role}:
${this.renderContextUpdate()}${this.state.content.map(renderContentWithStop)}${this.renderStreamingBlock()}${this.renderEdits()}`;
  }

  renderStop(contentIdx: number) {
    const stop = this.state.stops[contentIdx];
    if (!stop) {
      return "";
    }

    const { stopReason, usage } = stop;

    return d`\nStopped (${stopReason}) [input: ${usage.inputTokens.toString()}, output: ${usage.outputTokens.toString()}${
      usage.cacheHits !== undefined
        ? d`, cache hits: ${usage.cacheHits.toString()}`
        : ""
    }${
      usage.cacheMisses !== undefined
        ? d`, cache misses: ${usage.cacheMisses.toString()}`
        : ""
    }]\n`;
  }

  renderContextUpdate() {
    if (
      !(
        this.state.contextUpdates &&
        Object.keys(this.state.contextUpdates).length
      )
    ) {
      return "";
    }

    const fileUpdates = [];
    for (const path in this.state.contextUpdates) {
      const absFilePath = path as AbsFilePath;
      const update = this.state.contextUpdates[absFilePath];

      if (update.update.status === "ok") {
        let changeIndicator = "";
        if (update.update.value.type === "diff") {
          // Count additions and deletions in the patch
          const patch = update.update.value.patch;
          const additions = (patch.match(/^\+[^+]/gm) || []).length;
          const deletions = (patch.match(/^-[^-]/gm) || []).length;
          changeIndicator = `[ +${additions} / -${deletions} ]`;
        } else {
          // Count lines in the whole file content
          const lineCount =
            (update.update.value.content.match(/\n/g) || []).length + 1;
          changeIndicator = `[ +${lineCount} ]`;
        }

        const filePathLink = withBindings(d`- \`${update.relFilePath}\``, {
          "<CR>": () =>
            this.context.myDispatch({
              type: "open-edit-file",
              filePath: absFilePath,
            }),
        });

        const updateLink = withBindings(d`${changeIndicator}`, {
          "<CR>": () =>
            this.context.myDispatch({
              type: "toggle-expand-update",
              filePath: absFilePath,
            }),
        });

        fileUpdates.push(d`${filePathLink} ${updateLink}\n`);

        // Show expanded content if this update is expanded
        if (
          this.state.expandedUpdates &&
          this.state.expandedUpdates[absFilePath]
        ) {
          if (update.update.value.type === "whole-file") {
            fileUpdates.push(
              d`\`\`\`\n${update.update.value.content}\n\`\`\`\n`,
            );
          } else if (update.update.value.type === "diff") {
            fileUpdates.push(
              d`\`\`\`diff\n${update.update.value.patch}\n\`\`\`\n`,
            );
          }
        }
      } else {
        fileUpdates.push(
          d`- \`${absFilePath}\` [Error: ${update.update.error}]\n`,
        );
      }
    }

    return fileUpdates.length > 0 ? d`Context Updates:\n${fileUpdates}\n` : "";
  }

  renderContent(content: ProviderMessageContent) {
    switch (content.type) {
      case "text": {
        return d`${content.text}${content.citations ? content.citations.map((c) => d`[${c.title}](${c.url})`) : ""}`;
      }

      case "server_tool_use":
        return d`🔍 Searching ${content.input.query}...`;

      case "web_search_tool_result": {
        if (
          "type" in content.content &&
          content.content.type === "web_search_tool_result_error"
        ) {
          return d`🌐 Search error: ${content.content.error_code}`;
        } else {
          const results = content.content as Array<WebSearchResultBlock>;
          return d`\
🌐 Search results:\n${results.map(
            (result) => d`\
- [${result.title}](${result.url})${result.page_age ? ` (${result.page_age})` : ""}\n`,
          )}`;
        }
      }

      case "tool_result":
        return "";

      case "tool_use": {
        if (content.request.status == "error") {
          return d`Malformed request: ${content.request.error}`;
        } else {
          const tool = this.context.toolManager.getTool(
            content.request.value.id,
          );
          if (!tool) {
            this.context.nvim.logger?.error(
              `Unable to find tool with requestId ${content.request.value.id}`,
            );
            throw new Error(
              `Unable to find tool with requestId ${content.request.value.id}`,
            );
          }
          return this.renderTool(tool);
        }
      }

      case "image":
      case "document":
        return renderContentValue(content);

      default:
        assertUnreachable(content);
    }
  }

  renderStreamingBlock() {
    if (!this.state.streamingBlock) {
      return "";
    }

    const block = this.state.streamingBlock;
    switch (block.type) {
      case "text":
        return block.streamed;
      case "server_tool_use":
        return block.streamed;
      case "web_search_tool_result":
        return block.streamed;
      case "tool_use": {
        return renderStreamdedTool(block);
      }
      case "thinking":
      case "redacted_thinking":
        throw new Error(`NOT IMPLEMENTED`);
      default:
        return assertUnreachable(block);
    }
  }

  renderEdits() {
    const fileEdits = [];
    for (const filePath in this.state.edits) {
      const edit = this.state.edits[filePath as UnresolvedFilePath];

      const filePathLink = withBindings(d`\`${filePath}\``, {
        "<CR>": () =>
          this.context.myDispatch({
            type: "open-edit-file",
            filePath: filePath as UnresolvedFilePath,
          }),
      });

      const diffSnapshot = withBindings(d`**[± diff snapshot]**`, {
        "<CR>": () =>
          this.context.myDispatch({
            type: "diff-snapshot",
            filePath,
          }),
      });

      fileEdits.push(
        d`  ${filePathLink} (${edit.requestIds.length.toString()} edits). ${diffSnapshot}${
          edit.status.status == "error"
            ? d`\nError applying edit: ${edit.status.message}`
            : ""
        }\n`,
      );
    }

    return fileEdits.length
      ? d`
Edits:
${fileEdits}`
      : "";
  }
}
