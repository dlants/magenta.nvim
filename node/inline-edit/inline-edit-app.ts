import type { Nvim } from "../nvim/nvim-node";
import { NvimBuffer, type BufNr } from "../nvim/buffer";
import {
  NvimWindow,
  pos1col1to0,
  type Position0Indexed,
  type Position1Indexed,
  type Position1IndexedCol1Indexed,
  type Row0Indexed,
  type WindowId,
} from "../nvim/window";
import { getCurrentWindow } from "../nvim/nvim";
import * as TEA from "../tea/tea";
import * as InlineEdit from "./inline-edit-controller";
import {
  getProvider,
  type Agent,
  type AgentInput,
} from "../providers/provider";
import path from "node:path";
import { getMarkdownExt } from "../utils/markdown";
import {
  spec as replaceSelectionSpec,
  type NvimSelection,
} from "../tools/replace-selection-tool";
import { spec as inlineEditSpec } from "../tools/inline-edit-tool";
import type { Dispatch } from "../tea/tea";
import { relativePath, resolveFilePath, type NvimCwd } from "../utils/files";
import {
  getActiveProfile,
  type MagentaOptions,
  type Profile,
} from "../options";
import { Counter } from "../utils/uniqueId.ts";

export type InlineEditId = number & { __inlineEdit: true };

export type InlineEditState = {
  id: InlineEditId;
  targetWindowId: WindowId;
  targetBufnr: BufNr;
  inputWindowId: WindowId;
  inputBufnr: BufNr;
  cursor: Position1Indexed;
  dispatch: Dispatch<InlineEdit.Msg>;
  controller: InlineEdit.InlineEditController;
  selection?: NvimSelection | undefined;
  app: TEA.App<InlineEdit.InlineEditController>;
  mountedApp?: TEA.MountedApp;
};

export class InlineEditManager {
  private nvim: Nvim;
  private cwd: NvimCwd;
  private inlineEdits: {
    [bufnr: BufNr]: InlineEditState;
  } = {};
  private lastInput: string = "";
  private idCounter = new Counter();

  constructor({
    nvim,
    cwd,
    options,
    getContextAgent,
  }: {
    nvim: Nvim;
    cwd: NvimCwd;
    options: MagentaOptions;
    getContextAgent: () => Agent | undefined;
  }) {
    this.nvim = nvim;
    this.cwd = cwd;
    this.options = options;
    this.getContextAgent = getContextAgent;
  }

  private options: MagentaOptions;
  private getContextAgent: () => Agent | undefined;

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

  getActiveProfile() {
    return getActiveProfile(this.options.profiles, this.options.activeProfile);
  }

  updateOptions(options: MagentaOptions) {
    this.options = options;
  }

  async destroy() {
    for (const bufnr in this.inlineEdits) {
      await this.cleanupInlineEdit(this.inlineEdits[Number(bufnr) as BufNr]);
      delete this.inlineEdits[Number(bufnr) as BufNr];
    }
  }

  private processFastModifier(inputText: string): {
    text: string;
    isFast: boolean;
  } {
    const trimmedInput = inputText.trimStart();
    if (trimmedInput.startsWith("@fast")) {
      return {
        text: trimmedInput.slice("@fast".length).trimStart(),
        isFast: true,
      };
    }
    return {
      text: inputText,
      isFast: false,
    };
  }

  private isInlineEditSuccessfullyCompleted(
    controller: InlineEdit.InlineEditController,
  ): boolean {
    return (
      controller.state.state === "tool-use" &&
      controller.state.tool.isDone() &&
      controller.state.tool.getToolResult().result.status === "ok"
    );
  }

  private async cleanupInlineEdit(inlineEdit: InlineEditState) {
    const inputWindow = new NvimWindow(inlineEdit.inputWindowId, this.nvim);
    const inputBuffer = new NvimBuffer(inlineEdit.inputBufnr, this.nvim);

    try {
      await inputWindow.close(true);
      await inputBuffer.delete();
    } catch {
      // if window fails to close, or buffer fails to delete, they may already be gone, so ignore it
    }

    inlineEdit.app.destroy();
    inlineEdit.controller.abort();
  }

  private createInlineEditState(
    targetBuffer: NvimBuffer,
    targetWindow: NvimWindow,
    inputBuffer: NvimBuffer,
    inlineInputWindow: NvimWindow,
    cursor: Position1Indexed,
    selection?: InlineEditState["selection"],
  ): InlineEditState {
    const id = this.idCounter.get() as InlineEditId;

    const dispatch = (msg: InlineEdit.Msg) => {
      // Check if this inline edit still exists and has the same id
      const currentEdit = this.inlineEdits[targetBuffer.id];
      if (!currentEdit || currentEdit.id !== id) {
        return; // This edit was already destroyed, skip dispatch
      }

      currentEdit.controller.update(msg);

      // Check if the edit completed successfully and cleanup if so
      if (this.isInlineEditSuccessfullyCompleted(currentEdit.controller)) {
        this.cleanupInlineEdit(currentEdit).catch((error) => {
          this.nvim.logger.error("Failed to cleanup inline edit:", error);
        });
        delete this.inlineEdits[targetBuffer.id];
      } else {
        const mountedApp = currentEdit.mountedApp;
        if (mountedApp) {
          mountedApp.render();
        }
      }
    };

    const controller = new InlineEdit.InlineEditController({
      nvim: this.nvim,
      bufnr: targetBuffer.id,
      selection,
      dispatch,
    });

    const app = TEA.createApp<InlineEdit.InlineEditController>({
      nvim: this.nvim,
      initialModel: controller,
      View: () => controller.view(),
    });

    return {
      id,
      targetWindowId: targetWindow.id,
      targetBufnr: targetBuffer.id,
      inputWindowId: inlineInputWindow.id,
      inputBufnr: inputBuffer.id,
      cursor,
      dispatch,
      selection,
      controller,
      app,
    };
  }

  async replay(selection?: {
    startPos: Position1IndexedCol1Indexed;
    endPos: Position1IndexedCol1Indexed;
  }) {
    // If replay is requested but no previous input exists, warn and return
    if (!this.lastInput) {
      this.nvim.logger.warn("No previous inline edit input to replay");
      return;
    }

    const res = await this.prepareInputWindow();
    if (res == undefined) {
      return;
    }

    const {
      targetBuffer,
      targetWindow,
      inputBuffer,
      cursor,
      inlineInputWindow,
    } = res;

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

    this.inlineEdits[targetBuffer.id] = this.createInlineEditState(
      targetBuffer,
      targetWindow,
      inputBuffer,
      inlineInputWindow,
      cursor,
      selectionWithText,
    );

    const contextAgent = this.getContextAgent();
    const input = await this.prepareInput(targetBuffer.id, this.lastInput);

    await inputBuffer.setOption("modifiable", false);
    const { app, dispatch } = this.inlineEdits[targetBuffer.id];

    const mountedApp = await app.mount({
      nvim: this.nvim,
      buffer: inputBuffer,
      startPos: { row: 0, col: 0 } as Position0Indexed,
      endPos: { row: -1, col: -1 } as Position0Indexed,
    });
    this.inlineEdits[targetBuffer.id].mountedApp = mountedApp;

    const activeProfile = this.getActiveProfile();
    const { isFast } = this.processFastModifier(this.lastInput);

    // Create a profile with reasoning/thinking disabled for fast model
    const profileForRequest: Profile = isFast
      ? { ...activeProfile, thinking: undefined, reasoning: undefined }
      : activeProfile;

    const request = getProvider(this.nvim, profileForRequest).forceToolUse({
      model: isFast ? activeProfile.fastModel : activeProfile.model,
      input,
      spec: selection ? replaceSelectionSpec : inlineEditSpec,
      ...(contextAgent ? { contextAgent } : {}),
    });
    dispatch({
      type: "request-sent",
      request,
    });
  }

  async prepareInputWindow() {
    const targetWindow = await getCurrentWindow(this.nvim);
    const isMagentaWindow = await targetWindow.getVar("magenta");

    if (isMagentaWindow) {
      return;
    }

    const isMagentaInputWindow = await targetWindow.getVar("magenta-inline");
    if (isMagentaInputWindow) {
      return;
    }

    const targetBufnr = (await this.nvim.call("nvim_win_get_buf", [
      targetWindow.id,
    ])) as BufNr;

    if (this.inlineEdits[targetBufnr]) {
      const inlineEdit = this.inlineEdits[targetBufnr];
      delete this.inlineEdits[targetBufnr];
      await this.cleanupInlineEdit(inlineEdit);
    }

    const cursor = await targetWindow.getCursor();

    const targetBuffer = new NvimBuffer(targetBufnr, this.nvim);
    const inputBuffer = await NvimBuffer.create(false, true, this.nvim);
    await inputBuffer.setOption("bufhidden", "wipe");
    await inputBuffer.setOption("filetype", "markdown");
    await inputBuffer.setName(
      `[Inline edit for buffer ${await targetBuffer.getName()}]`,
    );

    // Set up <CR> mapping in normal mode
    await inputBuffer.setInlineKeymaps(targetBufnr);

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
    await inlineInputWindow.setVar("magenta-inline", true);

    return {
      targetBuffer,
      targetWindow,
      inputBuffer,
      inlineInputWindow,
      cursor,
    };
  }

  async initInlineEdit(selection?: {
    startPos: Position1IndexedCol1Indexed;
    endPos: Position1IndexedCol1Indexed;
  }) {
    // Enter insert mode only for new edits, not replays
    const res = await this.prepareInputWindow();
    if (res == undefined) {
      return;
    }

    const {
      targetBuffer,
      targetWindow,
      inputBuffer,
      cursor,
      inlineInputWindow,
    } = res;

    await this.nvim.call("nvim_exec2", ["startinsert", {}]);

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

    this.inlineEdits[targetBuffer.id] = this.createInlineEditState(
      targetBuffer,
      targetWindow,
      inputBuffer,
      inlineInputWindow,
      cursor,
      selectionWithText,
    );
  }

  async prepareInput(
    targetBufnr: BufNr,
    inputText: string,
  ): Promise<AgentInput[]> {
    const { selection, cursor } = this.inlineEdits[targetBufnr];
    const { text: processedInputText } = this.processFastModifier(inputText);

    const targetBuffer = new NvimBuffer(targetBufnr, this.nvim);
    const targetLines = await targetBuffer.getLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
    });
    const bufferName = await targetBuffer.getName();

    if (selection) {
      return [
        {
          type: "text",
          text: `\
I am working in file \`${relativePath(this.cwd, resolveFilePath(this.cwd, bufferName))}\` with the following contents:
\`\`\`${getMarkdownExt(bufferName)}
${targetLines.join("\n")}
\`\`\`

I have the following text selected on line ${selection.startPos.row - 1}:
\`\`\`
${selection.text}
\`\`\`

${processedInputText}`,
        },
      ];
    } else {
      return [
        {
          type: "text",
          text: `\
I am working in file \`${path.relative(this.cwd, bufferName)}\` with the following contents:
\`\`\`${getMarkdownExt(bufferName)}
${targetLines.join("\n")}
\`\`\`

My cursor is on line ${cursor.row - 1}: ${targetLines[cursor.row - 1]}

${processedInputText}`,
        },
      ];
    }
  }

  async submitInlineEdit(targetBufnr: BufNr) {
    if (!this.inlineEdits[targetBufnr]) {
      return;
    }

    const { inputBufnr, selection, app, dispatch } =
      this.inlineEdits[targetBufnr];

    const inputBuffer = new NvimBuffer(inputBufnr, this.nvim);
    const inputLines = await inputBuffer.getLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
    });

    const inputText = inputLines.join("\n");
    this.lastInput = inputText;
    const activeProfile = this.getActiveProfile();

    const contextAgent = this.getContextAgent();
    const input = await this.prepareInput(targetBufnr, inputText);

    await inputBuffer.setOption("modifiable", false);
    const mountedApp = await app.mount({
      nvim: this.nvim,
      buffer: inputBuffer,
      startPos: { row: 0, col: 0 } as Position0Indexed,
      endPos: { row: -1, col: -1 } as Position0Indexed,
    });
    this.inlineEdits[targetBufnr].mountedApp = mountedApp;

    const { isFast } = this.processFastModifier(inputText);

    // Create a profile with reasoning/thinking disabled for fast model
    const profileForRequest: Profile = isFast
      ? { ...activeProfile, thinking: undefined, reasoning: undefined }
      : activeProfile;

    const request = getProvider(this.nvim, profileForRequest).forceToolUse({
      model: isFast ? activeProfile.fastModel : activeProfile.model,
      input,
      spec: selection ? replaceSelectionSpec : inlineEditSpec,
      ...(contextAgent ? { contextAgent } : {}),
    });
    dispatch({
      type: "request-sent",
      request,
    });
  }

  abort() {
    for (const inlineEdit of Object.values(this.inlineEdits)) {
      const state = inlineEdit.controller.state;
      if (state.state == "response-pending") {
        state.request.abort();
      }
    }
  }
}
