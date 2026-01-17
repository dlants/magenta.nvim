import type { Nvim } from "../../nvim/nvim-node/index.ts";
import type { Magenta } from "../../magenta.ts";
import type { Line } from "../../nvim/buffer.ts";
import { pollUntil } from "../../utils/async.ts";
import { getAllWindows } from "../../nvim/nvim.ts";
import type { BindingKey } from "../../tea/bindings.ts";
import type { Position0Indexed, Row0Indexed } from "../../nvim/window.ts";
import { calculatePosition } from "../../tea/util.ts";
import { pos0to1, type ByteIdx } from "../../nvim/window.ts";

export class SidebarInteraction {
  constructor(
    private nvim: Nvim,
    private magenta: Magenta,
  ) {}

  /**
   * Check if sidebar is currently visible
   */
  async isVisible(): Promise<boolean> {
    try {
      const windows = await getAllWindows(this.nvim);
      for (const window of windows) {
        try {
          const magentaVar = await window.getVar("magenta");
          if (magentaVar) {
            const isDisplayWindow = await window
              .getVar("magenta_display_window")
              .catch(() => false);
            if (!isDisplayWindow) {
              return true;
            }
          }
        } catch {
          // Window doesn't have magenta var, continue
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Show the sidebar
   */
  async show(): Promise<void> {
    const isAlreadyVisible = await this.isVisible();
    if (!isAlreadyVisible) {
      await this.magenta.command("toggle");
    }

    await this.waitForVisible();
  }

  /**
   * Hide the sidebar
   */
  async hide(): Promise<void> {
    const isCurrentlyVisible = await this.isVisible();
    if (isCurrentlyVisible) {
      await this.magenta.command("toggle");
    }

    await this.waitForHidden();
  }

  /**
   * Wait for sidebar to become visible
   */
  async waitForVisible(timeout: number = 1000): Promise<void> {
    await pollUntil(
      async () => {
        const visible = await this.isVisible();
        if (!visible) {
          throw new Error("Sidebar not visible yet");
        }
      },
      { timeout },
    );
  }

  /**
   * Wait for sidebar to become hidden
   */
  async waitForHidden(timeout: number = 1000): Promise<void> {
    await pollUntil(
      async () => {
        const visible = await this.isVisible();
        if (visible) {
          throw new Error("Sidebar should be hidden");
        }
      },
      { timeout },
    );
  }

  /**
   * Get the input buffer
   */
  getInputBuffer() {
    const inputBuffer = this.magenta.sidebar.state.inputBuffer;
    if (!inputBuffer) {
      throw new Error("Sidebar inputBuffer not initialized yet");
    }
    return inputBuffer;
  }

  /**
   * Get the display buffer
   */
  getDisplayBuffer() {
    const displayBuffer = this.magenta.sidebar.state.displayBuffer;
    if (!displayBuffer) {
      throw new Error("Sidebar displayBuffer not initialized yet");
    }
    return displayBuffer;
  }

  /**
   * Set text in the input buffer
   */
  async setInputText(text: string): Promise<void> {
    const inputBuffer = this.getInputBuffer();
    await inputBuffer.setLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
      lines: text.split("\n") as Line[],
    });
  }

  /**
   * Get text from the input buffer
   */
  async getInputText(): Promise<string> {
    const inputBuffer = this.getInputBuffer();
    const lines = await inputBuffer.getLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
    });
    return lines.join("\n");
  }

  /**
   * Get text from the display buffer
   */
  async getDisplayText(): Promise<string> {
    const displayBuffer = this.getDisplayBuffer();
    const lines = await displayBuffer.getLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
    });
    return lines.join("\n");
  }

  /**
   * Wait for display buffer to contain specific text
   */
  async waitForDisplayText(
    text: string,
    timeout: number = 2000,
    start: number = 0,
  ): Promise<Position0Indexed> {
    let latestContent: string | undefined;
    try {
      return await pollUntil(
        async () => {
          const displayBuffer = this.getDisplayBuffer();
          const lines = await displayBuffer.getLines({
            start: 0 as Row0Indexed,
            end: -1 as Row0Indexed,
          });
          latestContent = lines.slice(start).join("\n");
          const index = Buffer.from(latestContent).indexOf(text) as ByteIdx;
          if (index === -1) {
            throw new Error(
              `Unable to find text "${text}" after line ${start} in displayBuffer`,
            );
          }

          return calculatePosition(
            { row: start, col: 0 } as Position0Indexed,
            Buffer.from(latestContent),
            index,
          );
        },
        { timeout },
      );
    } catch (e) {
      throw new Error(
        `${(e as Error).message}. Latest content: "${latestContent}"`,
      );
    }
  }

  /**
   * Wait for input buffer to contain specific text
   */
  async waitForInputText(
    text: string,
    timeout: number = 2000,
    start: number = 0,
  ): Promise<Position0Indexed> {
    return pollUntil(
      async () => {
        const inputBuffer = this.getInputBuffer();
        const lines = await inputBuffer.getLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
        });
        const content = lines.slice(start).join("\n");
        const index = Buffer.from(content).indexOf(text) as ByteIdx;
        if (index === -1) {
          throw new Error(
            `Unable to find text "${text}" after line ${start} in inputBuffer. Content: "${content}"`,
          );
        }

        return calculatePosition(
          { row: start, col: 0 } as Position0Indexed,
          Buffer.from(content),
          index,
        );
      },
      { timeout },
    );
  }

  /**
   * Wait for display buffer to not contain specific text
   */
  async waitForDisplayTextAbsent(
    text: string,
    timeout: number = 2000,
  ): Promise<void> {
    await pollUntil(
      async () => {
        const content = await this.getDisplayText();
        if (content.includes(text)) {
          throw new Error(
            `Display buffer should not contain text "${text}", but content is: "${content}"`,
          );
        }
      },
      { timeout },
    );
  }

  /**
   * Trigger a key on the display buffer at a specific position
   */
  async triggerDisplayKey(
    pos: Position0Indexed,
    key: BindingKey,
  ): Promise<void> {
    const visibleState = this.getVisibleState();
    const { displayWindow } = visibleState;

    await this.nvim.call("nvim_set_current_win", [displayWindow.id]);
    await displayWindow.setCursor(pos0to1(pos));

    await this.nvim.call("nvim_exec_lua", [
      `vim.rpcnotify(${this.nvim.channelId}, "magentaKey", "${key}")`,
      [],
    ]);
  }

  /**
   * Trigger a key on the display buffer at the position of specific text
   */
  async triggerDisplayKeyOnText(
    text: string,
    key: BindingKey,
    start: number = 0,
  ): Promise<void> {
    const position = await this.waitForDisplayText(text, 2000, start);
    await this.triggerDisplayKey(position, key);
  }

  /**
   * Send a message via the sidebar
   */
  async sendMessage(): Promise<void> {
    await this.magenta.command("send");
  }

  /**
   * Abort the current operation
   */
  async abort(): Promise<void> {
    await this.magenta.command("abort");
  }

  /**
   * Send keys to the input buffer
   */
  async sendKeysToInput(keys: string): Promise<void> {
    const visibleState = this.getVisibleState();
    const { inputWindow } = visibleState;

    // Switch to input window
    await this.nvim.call("nvim_set_current_win", [inputWindow.id]);

    // Send keys using nvim_input (more direct for testing)
    await this.nvim.call("nvim_input", [keys]);
  }

  /**
   * Get the visible sidebar state (throws if not visible)
   */
  private getVisibleState() {
    if (this.magenta.sidebar.state.state !== "visible") {
      throw new Error("Sidebar is not visible");
    }
    return this.magenta.sidebar.state;
  }

  /**
   * Assert that display buffer content exactly matches expected text
   */
  async assertDisplayContent(
    expectedText: string,
    timeout: number = 2000,
  ): Promise<void> {
    await pollUntil(
      async () => {
        const content = await this.getDisplayText();
        if (content !== expectedText) {
          throw new Error(
            `Display buffer content does not match.\nExpected:\n"${expectedText}"\nActual:\n"${content}"`,
          );
        }
      },
      { timeout },
    );
  }

  /**
   * Assert that input buffer content exactly matches expected text
   */
  async assertInputContent(
    expectedText: string,
    timeout: number = 2000,
  ): Promise<void> {
    await pollUntil(
      async () => {
        const content = await this.getInputText();
        if (content !== expectedText) {
          throw new Error(
            `Input buffer content does not match.\nExpected:\n"${expectedText}"\nActual:\n"${content}"`,
          );
        }
      },
      { timeout },
    );
  }

  /**
   * Wait for chat to be ready
   */
  async waitForChatReady(timeout: number = 1000): Promise<void> {
    await pollUntil(
      () => {
        try {
          this.magenta.chat.getActiveThread();
          return true;
        } catch (e) {
          if ((e as Error).message.includes("Chat is not initialized yet")) {
            throw new Error("Chat is not ready yet");
          }
          throw e;
        }
      },
      { timeout },
    );
  }
}
