import { type Nvim } from "../nvim/nvim-node";
import type { Magenta } from "../magenta";
import type { BufNr, Line, NvimBuffer } from "../nvim/buffer";
import type { MockProvider } from "../providers/mock";
import {
  NvimWindow,
  pos0to1,
  type ByteIdx,
  type Position0Indexed,
} from "../nvim/window";
import { Defer, pollUntil } from "../utils/async";
import { calculatePosition } from "../tea/util";
import type { BindingKey } from "../tea/bindings";
import {
  getAllWindows,
  getCurrentBuffer,
  getCurrentWindow,
} from "../nvim/nvim";
import { expect, vi } from "vitest";
import type { ThreadId } from "../chat/types";
import { CompletionsInteraction } from "./driver/completions.ts";
import { SidebarInteraction } from "./driver/sidebar.ts";

export class NvimDriver {
  public completions: CompletionsInteraction;
  public sidebar: SidebarInteraction;

  constructor(
    public nvim: Nvim,
    public magenta: Magenta,
    public mockAnthropic: MockProvider,
  ) {
    this.completions = new CompletionsInteraction(nvim);
    this.sidebar = new SidebarInteraction(nvim, magenta);
  }

  async wait(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async triggerMagentaCommand(command: string) {
    return this.nvim.call("nvim_command", [command]);
  }

  async showSidebar() {
    // Check if magenta windows are already visible
    const magentaWindowExists = await this.checkMagentaWindowsExist();

    if (!magentaWindowExists) {
      await this.magenta.command("toggle");
    }

    // Wait until magenta windows are actually visible
    await pollUntil(async () => {
      const windowsExist = await this.checkMagentaWindowsExist();
      if (!windowsExist) {
        throw new Error(`Magenta windows not visible yet`);
      }
    });
  }

  private async checkMagentaWindowsExist(): Promise<boolean> {
    try {
      const windows = await getAllWindows(this.nvim);
      let inputWindowExists = false;

      for (const window of windows) {
        try {
          const magentaVar = await window.getVar("magenta");
          if (magentaVar) {
            // Check if this is specifically the input window (not display window)
            const isDisplayWindow = await window
              .getVar("magenta_display_window")
              .catch(() => false);
            if (!isDisplayWindow) {
              inputWindowExists = true;
              break;
            }
          }
        } catch {
          // Window doesn't have magenta var, continue
        }
      }

      return inputWindowExists;
    } catch {
      return false;
    }
  }

  async waitForChatReady() {
    return await pollUntil(
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
      { timeout: 1000 },
    );
  }

  async inputMagentaText(text: string) {
    const inputBuffer = this.magenta.sidebar.state.inputBuffer;
    if (!inputBuffer) {
      throw new Error(`sidebar inputBuffer not initialized yet`);
    }

    await inputBuffer.setLines({
      start: 0,
      end: -1,
      lines: text.split("\n") as Line[],
    });
  }

  interceptSendMessage() {
    const thread = this.magenta.chat.getActiveThread();
    const callDefer = new Defer<Parameters<typeof thread.sendMessage>>();
    const executeDefer = new Defer<void>();

    const spy = vi
      .spyOn(thread, "sendMessage")
      .mockImplementation(
        async (...args: Parameters<typeof thread.sendMessage>) => {
          callDefer.resolve(args);
          return executeDefer.promise;
        },
      );

    return {
      promise: callDefer.promise,
      spy,
      execute: (...args: Parameters<typeof thread.sendMessage>) => {
        spy.mockRestore();
        return thread.sendMessage(...args).then(
          () => executeDefer.resolve(),
          (err: Error) => executeDefer.reject(err),
        );
      },
    };
  }

  send() {
    return this.magenta.command("send");
  }

  clear() {
    return this.magenta.command("clear");
  }

  abort() {
    return this.magenta.command("abort");
  }

  async startInlineEdit() {
    const currentBuffer = await getCurrentBuffer(this.nvim);
    return this.magenta.command(`start-inline-edit ${currentBuffer.id}`);
  }

  async startInlineEditWithSelection() {
    const currentBuffer = await getCurrentBuffer(this.nvim);
    return this.magenta.command(
      `start-inline-edit-selection ${currentBuffer.id}`,
    );
  }

  async replayInlineEdit() {
    return this.magenta.command("replay-inline-edit");
  }

  async replayInlineEditWithSelection() {
    return this.magenta.command("replay-inline-edit-selection");
  }

  async submitInlineEdit(bufnr: BufNr) {
    return this.magenta.command(`submit-inline-edit ${bufnr}`);
  }

  pasteSelection() {
    return this.nvim.call("nvim_exec2", ["Magenta paste-selection", {}]);
  }

  getDisplayBuffer() {
    const displayBuffer = this.magenta.sidebar.state.displayBuffer;
    if (!displayBuffer) {
      throw new Error(`sidebar displayBuffer not initialized yet`);
    }
    return displayBuffer;
  }

  getInputBuffer() {
    const inputBuffer = this.magenta.sidebar.state.inputBuffer;
    if (!inputBuffer) {
      throw new Error(`sidebar inputBuffer not initialized yet`);
    }
    return inputBuffer;
  }

  async getDisplayBufferText() {
    const displayBuffer = this.getDisplayBuffer();
    const lines = await displayBuffer.getLines({ start: 0, end: -1 });
    return lines.join("\n");
  }

  getVisibleState() {
    if (this.magenta.sidebar.state.state != "visible") {
      throw new Error(`sidebar is not visible`);
    }
    return this.magenta.sidebar.state;
  }

  async assertDisplayBufferContains(
    text: string,
    start: number = 0,
  ): Promise<Position0Indexed> {
    let latestContent;
    try {
      return await pollUntil(
        async () => {
          const displayBuffer = this.getDisplayBuffer();
          const lines = await displayBuffer.getLines({ start: 0, end: -1 });
          latestContent = lines.slice(start).join("\n");
          const index = Buffer.from(latestContent).indexOf(text) as ByteIdx;
          if (index == -1) {
            throw new Error(
              `! Unable to find text ${text} after line ${start} in displayBuffer`,
            );
          }

          return calculatePosition(
            { row: start, col: 0 } as Position0Indexed,
            Buffer.from(latestContent),
            index,
          );
        },
        { timeout: 2000 },
      );
    } catch (e) {
      expect(latestContent, (e as Error).message).toContain(text);
      throw e;
    }
  }

  async assertInputBufferContains(
    text: string,
    start: number = 0,
  ): Promise<Position0Indexed> {
    return pollUntil(async () => {
      const inputBuffer = this.getInputBuffer();
      const lines = await inputBuffer.getLines({ start: 0, end: -1 });
      const content = lines.slice(start).join("\n");
      const index = Buffer.from(content).indexOf(text) as ByteIdx;
      if (index == -1) {
        throw new Error(
          `Unable to find text:\n"${text}"\nafter line ${start} in inputBuffer.\ninputBuffer content:\n${content}`,
        );
      }

      return calculatePosition(
        { row: start, col: 0 } as Position0Indexed,
        Buffer.from(content),
        index,
      );
    });
  }

  awaitChatState(
    desiredState:
      | { state: "thread-overview" }
      | { state: "thread-selected"; id: ThreadId },
    message?: string,
  ) {
    return pollUntil(() => {
      const state = this.magenta.chat.state;
      if (state.state !== desiredState.state) {
        throw new Error(
          `Unexpected chat state. Desired: ${JSON.stringify(desiredState)} actual:${state.state} ${message}`,
        );
      }

      if (
        desiredState.state == "thread-selected" &&
        desiredState.id != state.activeThreadId
      ) {
        throw new Error(
          `Unexpected chat state. Desired: ${JSON.stringify(desiredState)} actual: ${JSON.stringify(state)}`,
        );
      }

      return;
    });
  }

  async assertBufferContains(
    buffer: NvimBuffer,
    text: string,
    start: number = 0,
  ): Promise<Position0Indexed> {
    try {
      return await pollUntil(async () => {
        const lines = await buffer.getLines({ start: 0, end: -1 });
        const content = lines.slice(start).join("\n");
        const index = Buffer.from(content).indexOf(text) as ByteIdx;
        if (index == -1) {
          throw new Error(
            `Unable to find text:\n"${text}"\nafter line ${start} in inputBuffer.\ninputBuffer content:\n${content}`,
          );
        }

        return calculatePosition(
          { row: start, col: 0 } as Position0Indexed,
          Buffer.from(content),
          index,
        );
      });
    } catch (e) {
      const lines = await buffer.getLines({ start: 0, end: -1 });
      const content = lines.slice(start).join("\n");
      expect(content).toContain(text);
      throw e;
    }
  }

  async assertDisplayBufferContent(text: string): Promise<void> {
    try {
      return await pollUntil(async () => {
        const displayBuffer = this.getDisplayBuffer();
        const lines = await displayBuffer.getLines({ start: 0, end: -1 });
        const content = lines.join("\n");
        if (content != text) {
          throw new Error(
            `display buffer content does not match text:\n"${text}"\ndisplayBuffer content:\n${content}`,
          );
        }
      });
    } catch (e) {
      const displayBuffer = this.getDisplayBuffer();
      const lines = await displayBuffer.getLines({ start: 0, end: -1 });
      const content = lines.join("\n");
      expect(content).toEqual(text);
      throw e;
    }
  }

  async assertDisplayBufferDoesNotContain(text: string): Promise<void> {
    try {
      return await pollUntil(async () => {
        const displayBuffer = this.getDisplayBuffer();
        const lines = await displayBuffer.getLines({ start: 0, end: -1 });
        const content = lines.join("\n");
        if (content.includes(text)) {
          throw new Error(
            `display buffer should not contain text:\n"${text}"\nbut displayBuffer content:\n${content}`,
          );
        }
      });
    } catch (e) {
      const displayBuffer = this.getDisplayBuffer();
      const lines = await displayBuffer.getLines({ start: 0, end: -1 });
      const content = lines.join("\n");
      expect(content).not.toContain(text);
      throw e;
    }
  }

  async triggerDisplayBufferKey(pos: Position0Indexed, key: BindingKey) {
    const { displayWindow } = this.getVisibleState();
    await this.nvim.call("nvim_set_current_win", [displayWindow.id]);
    await displayWindow.setCursor(pos0to1(pos));

    await this.nvim.call("nvim_exec_lua", [
      `\
vim.rpcnotify(${this.nvim.channelId}, "magentaKey", "${key}")
-- local key = vim.api.nvim_replace_termcodes("${key}", true, false, true);
-- vim.api.nvim_feedkeys(key, "n", false);`,

      [],
    ]);
  }

  async triggerDisplayBufferKeyOnContent(
    text: string,
    key: BindingKey,
    start: number = 0,
  ): Promise<void> {
    let latestContent;
    try {
      await pollUntil(
        async () => {
          const displayBuffer = this.getDisplayBuffer();

          const findTextPosition = (content: string): Position0Indexed => {
            const index = Buffer.from(content).indexOf(text) as ByteIdx;
            if (index == -1) {
              throw new Error(
                `! Unable to find text ${text} after line ${start} in displayBuffer`,
              );
            }
            return calculatePosition(
              { row: start, col: 0 } as Position0Indexed,
              Buffer.from(content),
              index,
            );
          };

          const lines = await displayBuffer.getLines({ start: 0, end: -1 });
          latestContent = lines.slice(start).join("\n");
          const position = findTextPosition(latestContent);

          // Set cursor position and re-verify the content is still there
          const { displayWindow } = this.getVisibleState();
          await this.nvim.call("nvim_set_current_win", [displayWindow.id]);
          await displayWindow.setCursor(pos0to1(position));

          // Re-verify content under cursor by checking buffer again
          const updatedLines = await displayBuffer.getLines({
            start: 0,
            end: -1,
          });
          const updatedContent = updatedLines.slice(start).join("\n");
          const updatedPosition = findTextPosition(updatedContent);

          // Verify cursor is still at the correct position
          if (
            position.row !== updatedPosition.row ||
            position.col !== updatedPosition.col
          ) {
            throw new Error(
              `! Content position changed after setting cursor. Original: ${JSON.stringify(position)}, Updated: ${JSON.stringify(updatedPosition)}`,
            );
          }

          // Double-check cursor position right before triggering the key
          const currentCursor = await displayWindow.getCursor();
          const expectedCursor = pos0to1(updatedPosition);
          if (
            currentCursor.row !== expectedCursor.row ||
            currentCursor.col !== expectedCursor.col
          ) {
            throw new Error(
              `! Cursor position mismatch before triggering key. Expected: ${JSON.stringify(expectedCursor)}, Actual: ${JSON.stringify(currentCursor)}`,
            );
          }

          await this.nvim.call("nvim_exec_lua", [
            `vim.rpcnotify(${this.nvim.channelId}, "magentaKey", "${key}")`,
            [],
          ]);

          return; // Success - found content and triggered key
        },
        { timeout: 2000 },
      );
    } catch (e) {
      expect(latestContent, (e as Error).message).toContain(text);
      throw e;
    }
  }

  async assertWindowCount(n: number, message?: string) {
    return await pollUntil(
      async () => {
        const windows = await getAllWindows(this.nvim);
        if (windows.length != n) {
          const windowDetails = await Promise.all(
            windows.map(async (w) => {
              const buffer = await w.buffer();
              const name = await buffer.getName();
              return `window ${w.id} containing buffer "${name}"`;
            }),
          );
          throw new Error(
            `${message ?? `Expected ${n} windows to appear`}. Saw ${windows.length} windows: ${JSON.stringify(windowDetails, null, 2)}`,
          );
        }

        return windows;
      },
      { timeout: 200 },
    );
  }

  async findWindow(
    predicate: (w: NvimWindow) => Promise<boolean>,
  ): Promise<NvimWindow> {
    return await pollUntil(
      async () => {
        const windows = await getAllWindows(this.nvim);
        for (const window of windows) {
          if (await predicate(window)) {
            return window;
          }
        }

        const windowDetails = await Promise.all(
          windows.map(async (w) => {
            const buffer = await w.buffer();
            const name = await buffer.getName();
            return `window ${w.id} containing buffer "${name}"`;
          }),
        );

        throw new Error(
          `No window matched predicate ${predicate.toString()}: [${windowDetails.join(", ")}]`,
        );
      },
      { timeout: 200 },
    );
  }

  async editFile(filePath: string): Promise<void> {
    await this.nvim.call("nvim_exec2", [`edit ${filePath}`, {}]);
  }

  // For compatibility with tests using nvim.command
  async command(cmd: string): Promise<void> {
    await this.nvim.call("nvim_command", [cmd]);
  }

  async selectRange(startPos: Position0Indexed, endPos: Position0Indexed) {
    const window = await getCurrentWindow(this.nvim);
    const buf = await window.buffer();

    await window.setCursor(pos0to1(startPos));
    await buf.setMark({ mark: "<", pos: pos0to1(startPos) });
    await this.nvim.call("nvim_exec2", [`normal! v`, {}]);
    await window.setCursor(pos0to1(endPos));
    await buf.setMark({ mark: ">", pos: pos0to1(endPos) });
  }
  async addContextFiles(...filePaths: string[]) {
    const quotedPaths = filePaths.map((path) => `'${path}'`).join(" ");
    await this.nvim.call("nvim_command", [
      `Magenta context-files ${quotedPaths}`,
    ]);

    // Wait for all files to be displayed in the context
    await pollUntil(async () => {
      const content = await this.getDisplayBufferText();
      for (const filePath of filePaths) {
        // Normalize the path to match display format (remove ./ prefix if present)
        const normalizedPath = filePath.replace(/^\.\//, "");
        if (!content.includes(`- \`${normalizedPath}\``)) {
          throw new Error(`Context file ${filePath} not yet displayed`);
        }
      }
    });
  }

  async sendKeysToInputBuffer(keys: string): Promise<void> {
    const { inputWindow } = this.getVisibleState();

    // Switch to input window
    await this.nvim.call("nvim_set_current_win", [inputWindow.id]);

    // Send keys using nvim_feedkeys
    const escapedKeys = await this.nvim.call("nvim_replace_termcodes", [
      keys,
      true,
      false,
      true,
    ]);
    await this.nvim.call("nvim_feedkeys", [escapedKeys, "n", false]);
  }

  async assertChangeTrackerHasEdits(expectedCount: number): Promise<void> {
    await pollUntil(
      () => {
        const changes = this.magenta.changeTracker.getChanges();
        if (changes.length !== expectedCount) {
          const changeDetails = changes
            .map(
              (change, i) =>
                `  ${i}: ${change.filePath} [${change.range.start.line}:${change.range.start.character}-${change.range.end.line}:${change.range.end.character}] "${change.oldText}" -> "${change.newText}"`,
            )
            .join("\n");
          throw new Error(
            `Expected ${expectedCount} changes, but found ${changes.length}:\n${changeDetails}`,
          );
        }
        return;
      },
      { timeout: 2000 },
    );
  }

  async assertChangeTrackerContains(
    expectedChanges: Array<{
      oldText?: string;
      newText?: string;
      filePath?: string;
    }>,
  ): Promise<void> {
    await pollUntil(
      () => {
        const changes = this.magenta.changeTracker.getChanges();
        const changeDetails = changes
          .map(
            (change, i) =>
              `  ${i}: ${change.filePath} [${change.range.start.line}:${change.range.start.character}-${change.range.end.line}:${change.range.end.character}] "${change.oldText}" -> "${change.newText}"`,
          )
          .join("\n");

        if (changes.length != expectedChanges.length) {
          throw new Error(
            `Expected ${expectedChanges.length} changes, but found ${changes.length}:\n${changeDetails}`,
          );
        }

        for (let i = 0; i < expectedChanges.length; i++) {
          const expected = expectedChanges[i];
          const change = changes[i];

          if (expected.oldText && !change.oldText.includes(expected.oldText)) {
            throw new Error(
              `Expected change ${i} oldText to contain "${expected.oldText}", but got "${change.oldText}".\nAll changes:\n${changeDetails}`,
            );
          }

          if (expected.newText && !change.newText.includes(expected.newText)) {
            throw new Error(
              `Expected change ${i} newText to contain "${expected.newText}", but got "${change.newText}".\nAll changes:\n${changeDetails}`,
            );
          }

          if (
            expected.filePath &&
            !change.filePath.endsWith(expected.filePath)
          ) {
            throw new Error(
              `Expected change ${i} filePath to end with "${expected.filePath}", but got "${change.filePath}".\nAll changes:\n${changeDetails}`,
            );
          }
        }
        return;
      },
      { timeout: 2000 },
    );
  }

  async getVimMessages(): Promise<string> {
    const messages = await this.nvim.call("nvim_exec2", [
      "messages",
      { output: true },
    ]);
    return (messages.output as string) || "";
  }

  async clearVimMessages(): Promise<void> {
    await this.nvim.call("nvim_exec2", ["messages clear", {}]);
  }
}
