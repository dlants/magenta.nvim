import type { Nvim } from "nvim-node";
import { NvimBuffer, type Line } from "./nvim/buffer.ts";
import { getOption } from "./nvim/nvim.ts";
import {
  type Position1Indexed,
  NvimWindow,
  type WindowId,
} from "./nvim/window.ts";
import type { Profile } from "./options.ts";
export const WIDTH = 80;

/** This will mostly manage the window toggle
 */
export class Sidebar {
  public state:
    | {
        state: "hidden";
        displayBuffer?: NvimBuffer;
        inputBuffer?: NvimBuffer;
      }
    | {
        state: "visible";
        displayBuffer: NvimBuffer;
        inputBuffer: NvimBuffer;
        displayWindow: NvimWindow;
        inputWindow: NvimWindow;
      };

  constructor(
    private nvim: Nvim,
    private profile: Profile,
  ) {
    this.state = { state: "hidden" };
  }

  async onWinClosed() {
    if (this.state.state == "visible") {
      const [displayWindowValid, inputWindowValid] = await Promise.all([
        this.state.displayWindow.valid(),
        this.state.inputWindow.valid(),
      ]);

      if (!(displayWindowValid && inputWindowValid)) {
        await this.hide();
      }
    }
  }

  /** returns buffers when they are visible
   */
  async toggle(
    sidebarPosition: "left" | "right",
  ): Promise<
    { displayBuffer: NvimBuffer; inputBuffer: NvimBuffer } | undefined
  > {
    if (this.state.state == "hidden") {
      return await this.show(sidebarPosition);
    } else {
      await this.hide();
      return undefined;
    }
  }

  private async show(sidebarPosition: "left" | "right"): Promise<{
    displayBuffer: NvimBuffer;
    inputBuffer: NvimBuffer;
  }> {
    const {
      displayBuffer: existingDisplayBuffer,
      inputBuffer: existingInputBuffer,
    } = this.state;
    this.nvim.logger?.debug(`sidebar.show`);
    const totalHeight = (await getOption("lines", this.nvim)) as number;
    const cmdHeight = (await getOption("cmdheight", this.nvim)) as number;
    const displayHeight = Math.floor((totalHeight - cmdHeight) * 0.8);
    const inputHeight = totalHeight - displayHeight - 2;

    let displayBuffer: NvimBuffer;
    if (existingDisplayBuffer) {
      displayBuffer = existingDisplayBuffer;
    } else {
      displayBuffer = await NvimBuffer.create(false, true, this.nvim);
      await displayBuffer.setOption("bufhidden", "hide");
      await displayBuffer.setOption("buftype", "nofile");
      await displayBuffer.setOption("swapfile", false);
      await displayBuffer.setOption("filetype", "markdown");
    }
    const displayWindowId = (await this.nvim.call("nvim_open_win", [
      displayBuffer.id,
      false,
      {
        win: -1, // global split
        split: sidebarPosition,
        width: WIDTH,
        height: displayHeight,
      },
    ])) as WindowId;
    const displayWindow = new NvimWindow(displayWindowId, this.nvim);

    let inputBuffer: NvimBuffer;
    if (existingInputBuffer) {
      inputBuffer = existingInputBuffer;
    } else {
      inputBuffer = await NvimBuffer.create(false, true, this.nvim);
      await inputBuffer.setOption("bufhidden", "hide");
      await inputBuffer.setOption("buftype", "nofile");
      await inputBuffer.setOption("swapfile", false);
      await inputBuffer.setOption("filetype", "markdown");
      await inputBuffer.setSiderbarKeymaps();
    }

    const inputWindowId = (await this.nvim.call("nvim_open_win", [
      inputBuffer.id,
      true, // enter the input window
      {
        win: displayWindow.id, // split inside this window
        split: "below",
        width: WIDTH,
        height: inputHeight,
      },
    ])) as WindowId;

    const inputWindow = new NvimWindow(inputWindowId, this.nvim);
    await inputWindow.clearjumps();

    await inputBuffer.setLines({
      start: 0,
      end: -1,
      lines: ["" as Line],
    });

    const winOptions = {
      wrap: true,
      linebreak: true,
      cursorline: true,
      winfixwidth: true,
    };

    for (const [key, value] of Object.entries(winOptions)) {
      await displayWindow.setOption(key, value);
      await inputWindow.setOption(key, value);
    }
    await displayWindow.setOption("winbar", "Magenta Chat");
    // set vars so we can identify this as the magenta display window
    await displayWindow.setVar("magenta", true);
    await displayWindow.setVar("magenta_display_window", true);
    await inputWindow.setOption(
      "winbar",
      `Magenta Input (${this.profile.name})`,
    );
    // set var so we can avoid closing this window when displaying a diff
    await inputWindow.setVar("magenta", true);
    await inputWindow.setOption("winfixheight", true);

    this.nvim.logger?.debug(`sidebar.create setting state`);
    this.state = {
      state: "visible",
      displayBuffer,
      inputBuffer,
      displayWindow,
      inputWindow,
    };

    return { displayBuffer, inputBuffer };
  }

  async updateProfile(profile: Profile) {
    this.profile = profile;
    if (this.state.state == "visible") {
      await this.state.inputWindow.setOption(
        "winbar",
        `Magenta Input (${profile.name})`,
      );
    }
  }

  async hide() {
    if (this.state.state == "visible") {
      const { displayWindow, inputWindow, displayBuffer, inputBuffer } =
        this.state;
      try {
        await Promise.all([displayWindow.close(), inputWindow.close()]);
      } catch {
        // windows may fail to close if they're already closed
      }
      this.state = {
        state: "hidden",
        displayBuffer,
        inputBuffer,
      };
    }
  }

  async scrollToLastUserMessage() {
    const { displayWindow } = await this.getWindowIfVisible();
    if (displayWindow) {
      const displayBuffer = await displayWindow.buffer();
      const lines = await displayBuffer.getLines({ start: 0, end: -1 });
      const lineIdx = lines.findLastIndex((l) => l == "# user:");
      if (lineIdx != -1) {
        await displayWindow.setCursor({
          row: lineIdx + 1,
          col: 0,
        } as Position1Indexed);
        await displayWindow.zt();
      }
    }
  }

  async getWindowIfVisible(): Promise<{
    displayWindow?: NvimWindow | undefined;
    inputWindow?: NvimWindow | undefined;
  }> {
    if (this.state.state != "visible") {
      return {};
    }

    const { displayWindow, inputWindow } = this.state;
    const displayWindowValid = await displayWindow.valid();
    const inputWindowValid = await inputWindow.valid();

    return {
      displayWindow: displayWindowValid ? displayWindow : undefined,
      inputWindow: inputWindowValid ? inputWindow : undefined,
    };
  }

  async getMessage(): Promise<string> {
    if (this.state.state != "visible") {
      this.nvim.logger?.debug(
        `sidebar state is ${this.state.state} in getMessage`,
      );
      return "";
    }

    const { inputBuffer } = this.state;

    const lines = await inputBuffer.getLines({
      start: 0,
      end: -1,
    });

    this.nvim.logger?.debug(
      `sidebar got lines ${JSON.stringify(lines)} from inputBuffer`,
    );
    const message = lines.join("\n");
    await inputBuffer.setLines({
      start: 0,
      end: -1,
      lines: [""] as Line[],
    });

    return message;
  }
}
