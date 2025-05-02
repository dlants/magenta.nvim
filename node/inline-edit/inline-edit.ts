import { assertUnreachable } from "../utils/assertUnreachable";
import type { InlineEditToolRequest } from "./inline-edit-tool";
import type { Result } from "../utils/result";
import type { StopReason, Usage } from "../providers/provider";
import { d } from "../tea/view";
import type { ReplaceSelectionToolRequest } from "./replace-selection-tool";
import type { Dispatch } from "../tea/tea";

export type State =
  | {
      state: "error";
      error: string;
    }
  | {
      state: "awaiting-prompt";
    }
  | {
      state: "response-pending";
    }
  | {
      state: "tool-use";
      edit: Result<
        InlineEditToolRequest | ReplaceSelectionToolRequest,
        { rawRequest: unknown }
      >;
      stopReason: StopReason;
      usage: Usage;
    };

export type Msg = {
  type: "update-model";
  next: State;
};

export class InlineEdit {
  state: State;

  constructor(public dispatch: Dispatch<Msg>) {
    this.state = {
      state: "awaiting-prompt",
    };
  }

  update(msg: Msg) {
    switch (msg.type) {
      case "update-model":
        this.state = msg.next;
        return;
      default:
        assertUnreachable(msg.type);
    }
  }

  view() {
    switch (this.state.state) {
      case "error":
        return d`Error: ${this.state.error}`;
      case "awaiting-prompt":
        return d``; // should never be shown...
      case "response-pending":
        return d`Input sent, awaiting response...`; // should never be shown...
      case "tool-use":
        switch (this.state.edit.status) {
          case "error":
            return d`Error: ${this.state.edit.error}, rawRequest: ${JSON.stringify(this.state.edit.rawRequest, null, 2) || "undefined"}`;
          case "ok": {
            let requestStr;
            switch (this.state.edit.value.name) {
              case "inline-edit":
                requestStr = `\
inline-edit.
find:
\`\`\`
${this.state.edit.value.input.find}
\`\`\`

replace:
\`\`\`
${this.state.edit.value.input.replace}
\`\`\``;
                break;
              case "replace-selection":
                requestStr = `\
replace-selection.
replace:
\`\`\`
${this.state.edit.value.input.replace}
\`\`\``;
                break;
              default:
                assertUnreachable(this.state.edit.value);
            }

            return d`Got tool use: ${requestStr}`;
          }
          default:
            return assertUnreachable(this.state.edit);
        }
      default:
        return assertUnreachable(this.state);
    }
  }
}
