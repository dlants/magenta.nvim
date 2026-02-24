import type { Nvim } from "./nvim/nvim-node/index.ts";
import { NvimBuffer, type Line } from "./nvim/buffer.ts";
import { getOption } from "./nvim/nvim.ts";
import {
  type Position1Indexed,
  NvimWindow,
  type WindowId,
  type Row0Indexed,
} from "./nvim/window.ts";
import type {
  Profile,
  SidebarPositionOpts,
  SidebarPositions,
} from "./options.ts";

/** Resolves responsive positions based on terminal orientation */
function resolveResponsivePosition(
  position: SidebarPositions,
  totalWidth: number,
  totalHeight: number,
): SidebarPositions {
  // If not a responsive position, return as-is
  if (
    !["leftbelow", "leftabove", "rightbelow", "rightabove"].includes(position)
  ) {
    return position;
  }

  // Determine if terminal is in landscape (wider than tall) or portrait mode
  const isLandscape = totalWidth > totalHeight;

  switch (position) {
    case "leftbelow":
      return isLandscape ? "left" : "below";
    case "leftabove":
      return isLandscape ? "left" : "above";
    case "rightbelow":
      return isLandscape ? "right" : "below";
    case "rightabove":
      return isLandscape ? "right" : "above";
    default:
      return position;
  }
}

/** This will mostly manage the window toggle
 */
export class Sidebar {
  static async calculateWindowDimensions(
    sidebarPosition: SidebarPositions,
    sidebarPositionOpts: SidebarPositionOpts,
    nvim: Nvim,
  ): Promise<{
    inputHeight: number;
    inputWidth: number;
    displayHeight: number;
    displayWidth: number;
  }> {
    const totalHeight = (await getOption("lines", nvim)) as number;
    const cmdHeight = (await getOption("cmdheight", nvim)) as number;
    const windowHeight = totalHeight - cmdHeight;
    const totalWidth = (await getOption("columns", nvim)) as number;

    // Resolve responsive positions based on terminal orientation
    const resolvedPosition = resolveResponsivePosition(
      sidebarPosition,
      totalWidth,
      totalHeight,
    );

    let inputHeight;
    let inputWidth;
    let displayHeight;
    let displayWidth;

    switch (resolvedPosition) {
      case "left":
        displayHeight = Math.floor(
          windowHeight * sidebarPositionOpts.left.displayHeightPercentage,
        );
        inputHeight = totalHeight - displayHeight - 2;
        inputWidth = Math.floor(
          totalWidth * sidebarPositionOpts.left.widthPercentage,
        );
        displayWidth = inputWidth;
        break;
      case "right":
        displayHeight = Math.floor(
          windowHeight * sidebarPositionOpts.right.displayHeightPercentage,
        );
        inputHeight = totalHeight - displayHeight - 2;
        inputWidth = Math.floor(
          totalWidth * sidebarPositionOpts.right.widthPercentage,
        );
        displayWidth = inputWidth;
        break;
      case "above":
        displayHeight = Math.floor(
          windowHeight * sidebarPositionOpts.above.displayHeightPercentage,
        );
        inputHeight = Math.floor(
          windowHeight * sidebarPositionOpts.above.inputHeightPercentage,
        );
        inputWidth = totalWidth;
        displayWidth = totalWidth;
        break;
      case "below":
        displayHeight = Math.floor(
          windowHeight * sidebarPositionOpts.below.displayHeightPercentage,
        );
        inputHeight = Math.floor(
          windowHeight * sidebarPositionOpts.below.inputHeightPercentage,
        );
        inputWidth = totalWidth;
        displayWidth = totalWidth;
        break;
      case "tab":
        displayHeight = Math.floor(
          windowHeight * sidebarPositionOpts.tab.displayHeightPercentage,
        );
        inputHeight = totalHeight - displayHeight - 2;
        inputWidth = totalWidth;
        displayWidth = totalWidth;
        break;
      default:
        // This should never happen since resolveResponsivePosition always returns a base position
        throw new Error(`Unexpected resolved position: ${resolvedPosition}`);
    }

    return { inputHeight, inputWidth, displayHeight, displayWidth };
  }

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
        displayWidth: number;
        inputWindow: NvimWindow;
      };

  constructor(
    private nvim: Nvim,
    private getProfile: () => Profile,
    private getTokenCount: () => number,
  ) {
    this.state = {
      state: "hidden",
    };
  }

  private getDisplayWindowTitle(): string {
    return "Magenta Chat";
  }

  private getInputWindowTitle(): string {
    const profile = this.getProfile();
    const thinkingStatus = profile.thinking?.enabled ? " thinking" : "";
    const baseTitle = `Magenta Input (${profile.name}${thinkingStatus})`;
    const tokenCount = this.getTokenCount();

    const tokenDisplay =
      tokenCount >= 1000
        ? `~${Math.round(tokenCount / 1000)}K`
        : `~${tokenCount}`;

    return `${baseTitle} [${tokenDisplay} tokens]`;
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
    sidebarPosition: SidebarPositions,
    sidebarPositionOpts: SidebarPositionOpts,
  ): Promise<
    | {
        displayBuffer: NvimBuffer;
        inputBuffer: NvimBuffer;
      }
    | undefined
  > {
    if (this.state.state == "hidden") {
      return await this.show(sidebarPosition, sidebarPositionOpts);
    } else {
      await this.hide();
      return undefined;
    }
  }

  private async show(
    sidebarPosition: SidebarPositions,
    sidebarPositionOpts: SidebarPositionOpts,
  ): Promise<{
    displayBuffer: NvimBuffer;
    inputBuffer: NvimBuffer;
  }> {
    const {
      displayBuffer: existingDisplayBuffer,
      inputBuffer: existingInputBuffer,
    } = this.state;
    this.nvim.logger.debug(`sidebar.show`);
    let displayBuffer: NvimBuffer;
    if (existingDisplayBuffer) {
      displayBuffer = existingDisplayBuffer;
    } else {
      displayBuffer = await NvimBuffer.create(false, true, this.nvim);
      await displayBuffer.setName("[Magenta Chat]");
      await displayBuffer.setOption("bufhidden", "hide");
      await displayBuffer.setOption("buftype", "nofile");
      await displayBuffer.setOption("swapfile", false);
      await displayBuffer.setDisplayKeymaps();
    }

    const { inputHeight, inputWidth, displayHeight, displayWidth } =
      await Sidebar.calculateWindowDimensions(
        sidebarPosition,
        sidebarPositionOpts,
        this.nvim,
      );

    // Get terminal dimensions for resolving responsive positions
    const totalHeight = (await getOption("lines", this.nvim)) as number;
    const totalWidth = (await getOption("columns", this.nvim)) as number;
    const resolvedPosition = resolveResponsivePosition(
      sidebarPosition,
      totalWidth,
      totalHeight,
    );

    let displayWindowId: WindowId;

    if (resolvedPosition == "tab") {
      await this.nvim.call("nvim_command", ["tabnew"]);
      displayWindowId = (await this.nvim.call(
        "nvim_get_current_win",
        [],
      )) as unknown as WindowId;
      await this.nvim.call("nvim_win_set_buf", [
        displayWindowId,
        displayBuffer.id,
      ]);
    } else {
      displayWindowId = (await this.nvim.call("nvim_open_win", [
        displayBuffer.id,
        false,
        {
          win: -1, // global split
          split: resolvedPosition,
          height: displayHeight,
          width: displayWidth,
        },
      ])) as WindowId;
    }
    const displayWindow = new NvimWindow(displayWindowId, this.nvim);

    let inputBuffer: NvimBuffer;
    if (existingInputBuffer) {
      inputBuffer = existingInputBuffer;
    } else {
      inputBuffer = await NvimBuffer.create(false, true, this.nvim);
      await inputBuffer.setName("[Magenta Input]");
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
        height: inputHeight,
        width: inputWidth,
      },
    ])) as WindowId;

    const inputWindow = new NvimWindow(inputWindowId, this.nvim);
    await inputWindow.clearjumps();

    await inputBuffer.setLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
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
    await displayWindow.setOption("winbar", this.getDisplayWindowTitle());
    // set vars so we can identify this as the magenta display window
    await displayWindow.setVar("magenta", true);
    await displayWindow.setVar("magenta_display_window", true);
    await inputWindow.setOption("winbar", this.getInputWindowTitle());
    // set var so we can avoid closing this window when displaying a diff
    await inputWindow.setVar("magenta", true);
    await inputWindow.setOption("winfixheight", true);

    this.nvim.logger.debug(`sidebar.create setting state`);
    this.state = {
      state: "visible",
      displayBuffer,
      inputBuffer,
      displayWindow,
      displayWidth,
      inputWindow,
    };

    return { displayBuffer, inputBuffer };
  }

  async renderInputHeader() {
    if (this.state.state == "visible") {
      await this.state.inputWindow.setOption(
        "winbar",
        this.getInputWindowTitle(),
      );
    }
  }

  async hide() {
    if (this.state.state == "visible") {
      const { displayWindow, inputWindow, displayBuffer, inputBuffer } =
        this.state;

      // Check if the only windows open are magenta windows
      const allWindows = (await this.nvim.call(
        "nvim_list_wins",
        [],
      )) as WindowId[];

      const nonMagentaWindows: WindowId[] = [];
      for (const winId of allWindows) {
        const win = new NvimWindow(winId, this.nvim);
        const isMagenta = await win.getVar("magenta").catch(() => false);
        if (!isMagenta) {
          nonMagentaWindows.push(winId);
        }
      }

      // If only magenta windows are open, create a new empty window first
      if (nonMagentaWindows.length === 0) {
        // Create a new empty buffer and open it in a new window
        const emptyBuf = await NvimBuffer.create(false, true, this.nvim);
        await this.nvim.call("nvim_open_win", [
          emptyBuf.id,
          true,
          {
            win: -1, // global split
            split: "left",
          },
        ]);
      }

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
      const lines = await displayBuffer.getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });
      const lineIdx = lines.findLastIndex((l) => l == "# user:");
      if (lineIdx != -1) {
        await displayWindow.setCursor({
          row: lineIdx + 1,
          col: 0,
        } as Position1Indexed);
        await displayWindow.zt();
      }

      const lastLineIdx = lines.length - 1;
      await displayWindow.setCursor({
        row: lastLineIdx + 1,
        col: lines[lastLineIdx].length,
      } as Position1Indexed);
    }
  }

  async scrollToBottom() {
    const { displayWindow } = await this.getWindowIfVisible();
    if (displayWindow) {
      const displayBuffer = await displayWindow.buffer();
      const lines = await displayBuffer.getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });
      const lastLineIdx = lines.length - 1;

      // Move to the last line
      await displayWindow.setCursor({
        row: lastLineIdx + 1,
        col: lines[lastLineIdx].length,
      } as Position1Indexed);

      // Execute zb to position cursor at bottom of window
      await displayWindow.zb();
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

  isVisible(): boolean {
    return this.state.state === "visible";
  }

  async getMessage(): Promise<string> {
    if (this.state.state != "visible") {
      this.nvim.logger.debug(
        `sidebar state is ${this.state.state} in getMessage`,
      );
      return "";
    }

    const { inputBuffer } = this.state;

    const lines = await inputBuffer.getLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
    });

    this.nvim.logger.debug(
      `sidebar got lines ${JSON.stringify(lines)} from inputBuffer`,
    );
    const message = lines.join("\n");
    await inputBuffer.setLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
      lines: [""] as Line[],
    });

    return message;
  }
}
