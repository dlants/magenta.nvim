import type { Nvim } from "nvim-node";
import { NvimBuffer, type BufNr, type Line } from "../nvim/buffer";
import {
  NvimWindow,
  pos1col1to0,
  type ByteIdx,
  type Position0Indexed,
  type Position1Indexed,
  type Position1IndexedCol1Indexed,
  type WindowId,
} from "../nvim/window";
import { getCurrentWindow, getcwd } from "../nvim/nvim";
import * as TEA from "../tea/tea";
import * as InlineEdit from "./inline-edit";
import type { Provider, ProviderMessage } from "../providers/provider";
import path from "node:path";
import { getMarkdownExt } from "../utils/markdown";

export type InlineEditId = number & { __inlineEdit: true };

export type InlineEditState = {
  targetWindowId: WindowId;
  targetBufnr: BufNr;
  inputWindowId: WindowId;
  inputBufnr: BufNr;
  cursor: Position1Indexed;
  selection?:
    | {
        startPos: Position1IndexedCol1Indexed;
        endPos: Position1IndexedCol1Indexed;
        text: string;
      }
    | undefined;
  app: TEA.App<InlineEdit.Msg, InlineEdit.Model>;
};

export class InlineEditManager {
  private nvim: Nvim;
  private inlineEdits: {
    [bufnr: BufNr]: InlineEditState;
  } = {};

  constructor({ nvim }: { nvim: Nvim }) {
    this.nvim = nvim;
  }

  onWinClosed() {
    return Promise.all(
      Object.entries(this.inlineEdits).map(async ([bufnr, edit]) => {
        const window = new NvimWindow(edit.inputWindowId, this.nvim);
        if (!(await window.valid())) {
          delete this.inlineEdits[bufnr as unknown as BufNr];
          edit.app.destroy();
        }
      }),
    );
  }

  destroy() {
    Object.entries(this.inlineEdits).map(([bufnr, edit]) => {
      delete this.inlineEdits[bufnr as unknown as BufNr];
      edit.app.destroy();
    });
  }

  async initInlineEdit(selection?: {
    startPos: Position1IndexedCol1Indexed;
    endPos: Position1IndexedCol1Indexed;
  }) {
    const targetWindow = await getCurrentWindow(this.nvim);
    const isMagentaWindow = await targetWindow.getVar("magenta");

    if (isMagentaWindow) {
      return;
    }

    const targetBufnr = (await this.nvim.call("nvim_win_get_buf", [
      targetWindow.id,
    ])) as BufNr;

    if (this.inlineEdits[targetBufnr]) {
      return;
    }
    const targetBuffer = new NvimBuffer(targetBufnr, this.nvim);
    const cursor = await targetWindow.getCursor();

    const inputBuffer = await NvimBuffer.create(false, true, this.nvim);
    await inputBuffer.setOption("bufhidden", "wipe");
    await inputBuffer.setOption("filetype", "markdown");

    const inlineInputWindowId = (await this.nvim.call("nvim_open_win", [
      inputBuffer.id,
      true, // enter the input window
      {
        win: targetWindow.id, // split inside current window
        split: "above",
        height: 10,
        style: "minimal",
      },
    ])) as WindowId;

    const inlineInputWindow = new NvimWindow(inlineInputWindowId, this.nvim);
    await inlineInputWindow.setOption("winbar", "Magenta Inline Prompt");

    // Enter insert mode
    await this.nvim.call("nvim_exec2", ["startinsert", {}]);

    // Set up <CR> mapping in normal mode
    await inputBuffer.setInlineKeymaps(targetBufnr);

    let selectionWithText: InlineEditState["selection"];
    if (selection) {
      selectionWithText = {
        ...selection,
        text: (
          await targetBuffer.getText({
            startPos: pos1col1to0(selection.startPos),
            endPos: pos1col1to0(selection.endPos),
          })
        ).join("\n"),
      };
    }

    this.inlineEdits[targetBufnr] = {
      targetWindowId: targetWindow.id,
      targetBufnr,
      inputWindowId: inlineInputWindowId,
      inputBufnr: inputBuffer.id,
      cursor,
      selection: selectionWithText,
      app: TEA.createApp<InlineEdit.Model, InlineEdit.Msg>({
        nvim: this.nvim,
        initialModel: InlineEdit.initModel(),
        update: (msg, model) => {
          return InlineEdit.update(msg, model);
        },
        View: InlineEdit.view,
      }),
    };
  }

  async submitInlineEdit(
    targetBufnr: BufNr,
    provider: Provider,
    messages: ProviderMessage[],
  ) {
    if (!this.inlineEdits[targetBufnr]) {
      return;
    }

    const { inputBufnr, selection, cursor, app } =
      this.inlineEdits[targetBufnr];

    app.dispatch({
      type: "update-model",
      next: {
        state: "response-pending",
      },
    });

    const inputBuffer = new NvimBuffer(inputBufnr, this.nvim);
    const inputLines = await inputBuffer.getLines({
      start: 0,
      end: -1,
    });
    const targetBuffer = new NvimBuffer(targetBufnr, this.nvim);
    const targetLines = await targetBuffer.getLines({
      start: 0,
      end: -1,
    });
    const bufferName = await targetBuffer.getName();
    const cwd = await getcwd(this.nvim);

    // TODO: do not include buffer content if it's already in the context manager.

    if (selection) {
      messages.push({
        role: "user",
        content: `\
I am working in file \`${path.relative(cwd, bufferName)}\` with the following contents:
\`\`\`${getMarkdownExt(bufferName)}
${targetLines.join("\n")}
\`\`\`

I have the following text selected on line ${selection.startPos.row - 1}:
\`\`\`
${selection.text}
\`\`\`

${inputLines.join("\n")}`,
      });
    } else {
      messages.push({
        role: "user",
        content: `\
I am working in file \`${path.relative(cwd, bufferName)}\` with the following contents:
\`\`\`${getMarkdownExt(bufferName)}
${targetLines.join("\n")}
\`\`\`

My cursor is on line ${cursor.row - 1}: ${targetLines[cursor.row - 1]}

${inputLines.join("\n")}`,
      });
    }

    await inputBuffer.setOption("modifiable", false);
    await app.mount({
      nvim: this.nvim,
      buffer: inputBuffer,
      startPos: { row: 0, col: 0 } as Position0Indexed,
      endPos: { row: -1, col: -1 } as Position0Indexed,
    });

    if (selection) {
      let result;
      try {
        result = await provider.replaceSelection(messages);
      } catch (e) {
        app.dispatch({
          type: "update-model",
          next: {
            state: "error",
            error: e instanceof Error ? e.message : JSON.stringify(e),
          },
        });
        return;
      }

      const { replaceSelection, stopReason, usage } = result;
      app.dispatch({
        type: "update-model",
        next: {
          state: "tool-use",
          edit: replaceSelection,
          stopReason,
          usage,
        },
      });

      if (replaceSelection.status === "error") {
        return;
      }

      const input = replaceSelection.value.input;

      const targetBuffer = new NvimBuffer(targetBufnr, this.nvim);

      const nextContent =
        "\n>>>>>>> Suggested change\n" +
        input.replace +
        "\n=======\n" +
        selection.text +
        "\n<<<<<<< Current\n";
      const lines = await targetBuffer.getLines({ start: 0, end: -1 });

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

      await targetBuffer.setText({
        startPos: clamp(pos1col1to0(selection.startPos)),
        endPos: clamp(pos1col1to0(selection.endPos)),
        lines: nextContent.split("\n") as Line[],
      });
    } else {
      let result;
      try {
        result = await provider.inlineEdit(messages);
      } catch (e) {
        app.dispatch({
          type: "update-model",
          next: {
            state: "error",
            error: e instanceof Error ? e.message : JSON.stringify(e),
          },
        });
        return;
      }

      const { inlineEdit, stopReason, usage } = result;
      app.dispatch({
        type: "update-model",
        next: {
          state: "tool-use",
          edit: inlineEdit,
          stopReason,
          usage,
        },
      });

      if (inlineEdit.status === "error") {
        return;
      }

      const input = inlineEdit.value.input;

      const buffer = new NvimBuffer(targetBufnr, this.nvim);
      const lines = await buffer.getLines({ start: 0, end: -1 });
      const content = lines.join("\n");

      const replaceStart = content.indexOf(input.find);
      if (replaceStart === -1) {
        app.dispatch({
          type: "update-model",
          next: {
            state: "error",
            error: `\
Unable to find text in buffer:
\`\`\`
${input.find}
\`\`\``,
          },
        });
        return;
      }
      const replaceEnd = replaceStart + input.find.length;

      const nextContent =
        content.slice(0, replaceStart) +
        "\n>>>>>>> Suggested change\n" +
        input.replace +
        "\n=======\n" +
        input.find +
        "\n<<<<<<< Current\n" +
        content.slice(replaceEnd);

      await buffer.setLines({
        start: 0,
        end: -1,
        lines: nextContent.split("\n") as Line[],
      });
    }
  }

  abort() {}
}
