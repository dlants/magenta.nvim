import {
  ToolManager,
  type Msg as ToolManagerMsg,
  type ToolRequestId,
} from "../tools/toolManager.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, type View } from "../tea/view.ts";
import type {
  ProviderMessageContent,
  ProviderToolResultContent,
  StopReason,
  Usage,
} from "../providers/provider.ts";
import { wrapThunk, type Dispatch, type Thunk } from "../tea/tea.ts";

type State =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "tool-request";
      requestId: ToolRequestId;
    }
  | {
      type: "malformed-tool-request";
      error: string;
      rawRequest: unknown;
    }
  | {
      type: "stop-msg";
      stopReason: StopReason;
      usage: Usage;
    };

export type Msg = {
  type: "tool-manager-msg";
  msg: ToolManagerMsg;
};

export class Part {
  toolManager: ToolManager;
  state: State;

  constructor({
    state,
    toolManager,
  }: {
    state: State;
    toolManager: ToolManager;
  }) {
    this.state = state;
    this.toolManager = toolManager;
  }

  update(msg: Msg): Thunk<Msg> | undefined {
    switch (msg.type) {
      case "tool-manager-msg": {
        const thunk = this.toolManager.update(msg.msg);
        return wrapThunk("tool-manager-msg", thunk);
      }
      default:
        return assertUnreachable(msg.type);
    }
  }

  toMessageContent(): {
    content?: ProviderMessageContent;
    result?: ProviderToolResultContent;
  } {
    switch (this.state.type) {
      case "text":
        return { content: this.state };

      case "tool-request": {
        const toolWrapper =
          this.toolManager.state.toolWrappers[this.state.requestId];
        return {
          content: {
            type: "tool_use",
            request: toolWrapper.tool.request,
          },
          result: toolWrapper.tool.getToolResult(),
        };
      }

      case "malformed-tool-request": {
        return {
          content: {
            type: "text",
            text: `Malformed tool request: ${this.state.error}`,
          },
        };
      }

      case "stop-msg": {
        return {};
      }

      default:
        return assertUnreachable(this.state);
    }
  }
}

export const view: View<{
  part: Part;
  dispatch: Dispatch<Msg>;
}> = ({ part, dispatch }) => {
  switch (part.state.type) {
    case "text":
      return d`${part.state.text}`;

    case "malformed-tool-request":
      return d`Malformed tool request: ${part.state.error}
${JSON.stringify(part.state.rawRequest, null, 2) || "undefined"}`;

    case "tool-request": {
      const toolWrapper =
        part.toolManager.state.toolWrappers[part.state.requestId];
      if (!toolWrapper) {
        throw new Error(
          `Unable to find model with requestId ${part.state.requestId}`,
        );
      }
      return part.toolManager.renderTool(toolWrapper, (msg) =>
        dispatch({
          type: "tool-manager-msg",
          msg,
        }),
      );
    }

    case "stop-msg": {
      return d`Stopped (${part.state.stopReason}) [input: ${part.state.usage.inputTokens.toString()}, output: ${part.state.usage.outputTokens.toString()}${
        part.state.usage.cacheHits !== undefined
          ? d`, cache hits: ${part.state.usage.cacheHits.toString()}`
          : ""
      }${
        part.state.usage.cacheMisses !== undefined
          ? d`, cache misses: ${part.state.usage.cacheMisses.toString()}`
          : ""
      }]`;
    }

    default:
      assertUnreachable(part.state);
  }
};
