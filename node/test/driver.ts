import { type Nvim } from "../nvim/nvim-node/index.ts";
import type { Magenta } from "../magenta.ts";
import type { Line, NvimBuffer } from "../nvim/buffer.ts";
import type { MockProvider } from "../providers/mock.ts";
import {
  NvimWindow,
  pos0to1,
  type ByteIdx,
  type Position0Indexed,
  type Row0Indexed,
} from "../nvim/window.ts";
import { Defer, pollUntil } from "../utils/async.ts";
import { calculatePosition } from "../tea/util.ts";
import type { BindingKey } from "../tea/bindings.ts";
import { getAllWindows, getCurrentWindow } from "../nvim/nvim.ts";
import { expect, vi } from "vitest";
import type { ThreadId } from "../chat/types.ts";
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
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
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

  /**
   * Intercept the maybeAutoRespond method to pause auto-respond after tool completion.
   * This allows tests to modify state (e.g., edit buffers) before the auto-respond fires.
   */
  interceptAutoRespond() {
    const thread = this.magenta.chat.getActiveThread();
    const callDefer = new Defer<void>();
    const executeDefer = new Defer<
      ReturnType<typeof thread.maybeAutoRespond>
    >();

    const originalMaybeAutoRespond = thread.maybeAutoRespond.bind(thread);
    const spy = vi.spyOn(thread, "maybeAutoRespond").mockImplementation(() => {
      callDefer.resolve();
      // Block until execute() is called - return a default value synchronously
      let result: ReturnType<typeof thread.maybeAutoRespond> = {
        type: "no-action-needed",
      };
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      executeDefer.promise.then((r) => {
        result = r;
      });
      return result;
    });

    return {
      /** Resolves when maybeAutoRespond is called */
      promise: callDefer.promise,
      spy,
      /** Call this to restore the original method and execute it */
      execute: () => {
        spy.mockRestore();
        const result = originalMaybeAutoRespond();
        executeDefer.resolve(result);
        return result;
      },
    };
  }

  send() {
    return this.magenta.command("send");
  }

  abort() {
    return this.magenta.command("abort");
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
    const lines = await displayBuffer.getLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
    });
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
          const lines = await displayBuffer.getLines({
            start: 0 as Row0Indexed,
            end: -1 as Row0Indexed,
          });
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
      const lines = await inputBuffer.getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });
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
      | { state: "thread-selected"; id?: ThreadId },
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
        desiredState.id !== undefined &&
        desiredState.id != state.activeThreadId
      ) {
        throw new Error(
          `Unexpected chat state. Desired: ${JSON.stringify(desiredState)} actual: ${JSON.stringify(state)}`,
        );
      }

      return;
    });
  }

  /** Get thread IDs in creation order */
  getThreadIds(): ThreadId[] {
    return Object.keys(this.magenta.chat.threadWrappers).sort() as ThreadId[];
  }

  /** Get the nth thread ID (0-indexed) */
  getThreadId(index: number): ThreadId {
    const ids = this.getThreadIds();
    if (index < 0 || index >= ids.length) {
      throw new Error(
        `Thread index ${index} out of bounds. Available threads: ${ids.length}`,
      );
    }
    return ids[index];
  }

  /** Get the active thread ID */
  getActiveThreadId(): ThreadId | undefined {
    const state = this.magenta.chat.state;
    if (state.state === "thread-selected") {
      return state.activeThreadId;
    }
    return undefined;
  }

  /** Wait until the specified number of threads exist */
  async awaitThreadCount(count: number) {
    return pollUntil(() => {
      const ids = this.getThreadIds();
      if (ids.length < count) {
        throw new Error(
          `Expected ${count} threads, but only ${ids.length} exist`,
        );
      }
      return ids;
    });
  }

  async assertBufferContains(
    buffer: NvimBuffer,
    text: string,
    start: number = 0,
  ): Promise<Position0Indexed> {
    try {
      return await pollUntil(async () => {
        const lines = await buffer.getLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
        });
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
      const lines = await buffer.getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });
      const content = lines.slice(start).join("\n");
      expect(content).toContain(text);
      throw e;
    }
  }

  async assertDisplayBufferContent(text: string): Promise<void> {
    try {
      return await pollUntil(async () => {
        const displayBuffer = this.getDisplayBuffer();
        const lines = await displayBuffer.getLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
        });
        const content = lines.join("\n");
        if (content != text) {
          throw new Error(
            `display buffer content does not match text:\n"${text}"\ndisplayBuffer content:\n${content}`,
          );
        }
      });
    } catch (e) {
      const displayBuffer = this.getDisplayBuffer();
      const lines = await displayBuffer.getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });
      const content = lines.join("\n");
      expect(content).toEqual(text);
      throw e;
    }
  }

  async assertDisplayBufferDoesNotContain(text: string): Promise<void> {
    try {
      return await pollUntil(async () => {
        const displayBuffer = this.getDisplayBuffer();
        const lines = await displayBuffer.getLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
        });
        const content = lines.join("\n");
        if (content.includes(text)) {
          throw new Error(
            `display buffer should not contain text:\n"${text}"\nbut displayBuffer content:\n${content}`,
          );
        }
      });
    } catch (e) {
      const displayBuffer = this.getDisplayBuffer();
      const lines = await displayBuffer.getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });
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

          const lines = await displayBuffer.getLines({
            start: 0 as Row0Indexed,
            end: -1 as Row0Indexed,
          });
          latestContent = lines.slice(start).join("\n");
          const position = findTextPosition(latestContent);

          // Set cursor position and re-verify the content is still there
          const { displayWindow } = this.getVisibleState();
          await this.nvim.call("nvim_set_current_win", [displayWindow.id]);
          await displayWindow.setCursor(pos0to1(position));

          // Re-verify content under cursor by checking buffer again
          const updatedLines = await displayBuffer.getLines({
            start: 0 as Row0Indexed,
            end: -1 as Row0Indexed,
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
  /** Open a file and wait for LSP to attach with hover capability.
   *  Useful for tests that depend on LSP being ready before proceeding.
   */
  async editFileAndWaitForLsp(
    filePath: string,
    timeout = 15_000,
  ): Promise<void> {
    await this.editFile(filePath);
    const buf = await this.nvim.call("nvim_get_current_buf", []);
    await pollUntil(
      async () => {
        const result = await this.nvim.call("nvim_exec_lua", [
          `local clients = vim.lsp.get_clients({ bufnr = ... })
           for _, client in ipairs(clients) do
             if client.server_capabilities.hoverProvider then
               return true
             end
           end
           return false`,
          [buf],
        ]);
        if (!result) {
          throw new Error("LSP not attached yet");
        }
        return result;
      },
      { timeout },
    );
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
    await this.nvim.call("nvim_set_current_win", [inputWindow.id]);
    const escapedKeys = await this.nvim.call("nvim_replace_termcodes", [
      keys,
      true,
      false,
      true,
    ]);
    await this.nvim.call("nvim_feedkeys", [escapedKeys, "n", false]);
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

  async awaitExtmarks(
    buffer: NvimBuffer,
    expectedCount?: number,
    timeout: number = 2000,
    predicate?: (
      marks: Awaited<ReturnType<NvimBuffer["getExtmarks"]>>,
    ) => boolean,
  ) {
    return await pollUntil(
      async () => {
        const marks = await buffer.getExtmarks();

        // If predicate is provided, use it as the primary filter
        if (predicate) {
          if (!predicate(marks)) {
            throw new Error(
              `Extmarks predicate not satisfied. Buffer ${buffer.id}. Extmarks: ${JSON.stringify(marks, null, 2)}`,
            );
          }
        }

        // Then apply count check if specified
        if (expectedCount !== undefined) {
          if (marks.length !== expectedCount) {
            throw new Error(
              `Expected ${expectedCount} extmarks, but found ${marks.length}`,
            );
          }
        } else if (!predicate && marks.length === 0) {
          throw new Error("No extmarks found yet");
        }
        return marks;
      },
      {
        timeout,
      },
    );
  }
}
