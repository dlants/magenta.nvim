import { d, withBindings } from "../tea/view";
import { assertUnreachable } from "../utils/assertUnreachable";
import type { ProviderMessage } from "../providers/provider";
import type { Nvim } from "nvim-node";
import type { MessageId } from "../chat/message";
import { BufferAndFileManager } from "./file-and-buffer-manager";
import { glob } from "glob";
import path from "node:path";
import fs from "node:fs";
import type { MagentaOptions } from "../options";
import { getcwd, getAllWindows } from "../nvim/nvim";
import { NvimBuffer } from "../nvim/buffer";
import type { WindowId } from "../nvim/window";
import { WIDTH } from "../sidebar";
import type { Dispatch } from "../tea/tea";
import type { RootMsg } from "../root-msg";

export type ContextManagerMsg = {
  type: "context-manager-msg";
  msg: Msg;
};

export type Msg =
  | {
      type: "add-file-context";
      relFilePath: string;
      absFilePath: string;
      messageId: MessageId;
    }
  | {
      type: "remove-file-context";
      absFilePath: string;
    }
  | {
      type: "open-file";
      absFilePath: string;
    };

export class ContextManager {
  public dispatch: Dispatch<RootMsg>;
  public myDispatch: Dispatch<Msg>;
  public files: {
    [absFilePath: string]: {
      relFilePath: string;
      initialMessageId: MessageId;
    };
  };
  private bufferAndFileManager: BufferAndFileManager;
  private nvim: Nvim;
  private options: MagentaOptions;

  private constructor({
    dispatch,
    nvim,
    options,
    initialFiles = {},
  }: {
    dispatch: Dispatch<RootMsg>;
    nvim: Nvim;
    options: MagentaOptions;
    initialFiles?: {
      [absFilePath: string]: {
        relFilePath: string;
        initialMessageId: MessageId;
      };
    };
  }) {
    this.dispatch = dispatch;
    this.myDispatch = (msg) =>
      this.dispatch({ type: "context-manager-msg", msg });
    this.nvim = nvim;
    this.options = options;
    this.bufferAndFileManager = new BufferAndFileManager(nvim);
    this.files = initialFiles;
  }

  static async create({
    dispatch,
    nvim,
    options,
  }: {
    dispatch: Dispatch<RootMsg>;
    nvim: Nvim;
    options: MagentaOptions;
  }): Promise<ContextManager> {
    const initialFiles = await ContextManager.loadAutoContext(nvim, options);
    return new ContextManager({ dispatch, nvim, options, initialFiles });
  }

  update(msg: Msg): void {
    switch (msg.type) {
      case "add-file-context":
        this.files[msg.absFilePath] = {
          relFilePath: msg.relFilePath,
          initialMessageId: msg.messageId,
        };
        return undefined;
      case "remove-file-context":
        delete this.files[msg.absFilePath];
        return undefined;
      case "open-file":
        this.openFileInWindow(msg.absFilePath).catch((e: Error) =>
          this.nvim.logger?.error(e.message),
        );

        return;
      default:
        assertUnreachable(msg);
    }
  }

  isContextEmpty(): boolean {
    return Object.keys(this.files).length == 0;
  }

  async getContextMessages(
    currentMessageId: MessageId,
  ): Promise<{ messageId: MessageId; message: ProviderMessage }[] | undefined> {
    if (this.isContextEmpty()) {
      return undefined;
    }

    return await Promise.all(
      Object.keys(this.files).map((absFilePath) =>
        this.getFileMessage({ absFilePath, currentMessageId }),
      ),
    );
  }

  private async getFileMessage({
    absFilePath,
    currentMessageId,
  }: {
    absFilePath: string;
    currentMessageId: MessageId;
  }): Promise<{ messageId: MessageId; message: ProviderMessage }> {
    const res = await this.bufferAndFileManager.getFileContents(
      absFilePath,
      currentMessageId,
    );

    switch (res.status) {
      case "ok":
        return {
          messageId: res.value.messageId,
          message: {
            role: "user",
            content: this.renderFile({
              relFilePath: res.value.relFilePath,
              content: res.value.content,
            }),
          },
        };

      case "error":
        return {
          messageId: currentMessageId,
          message: {
            role: "user",
            content: `Error reading file \`${absFilePath}\`: ${res.error}`,
          },
        };
      default:
        assertUnreachable(res);
    }
  }

  private static async loadAutoContext(
    nvim: Nvim,
    options: MagentaOptions,
  ): Promise<{
    [absFilePath: string]: {
      relFilePath: string;
      initialMessageId: MessageId;
    };
  }> {
    const files: {
      [absFilePath: string]: {
        relFilePath: string;
        initialMessageId: MessageId;
      };
    } = {};

    if (!options.autoContext || options.autoContext.length === 0) {
      return files;
    }

    try {
      const cwd = await getcwd(nvim);
      // Use a placeholder message ID since we don't have a current message during initialization
      const initialMessageId = 0 as MessageId;

      // Find all files matching the glob patterns
      const matchedFiles = await this.findFilesCrossPlatform(
        options.autoContext,
        cwd,
        nvim,
      );

      // Convert to the expected format
      for (const matchInfo of matchedFiles) {
        files[matchInfo.absFilePath] = {
          relFilePath: matchInfo.relFilePath,
          initialMessageId,
        };
      }
    } catch (err) {
      nvim.logger?.error(
        `Error loading auto context: ${(err as Error).message}`,
      );
    }

    return files;
  }

  private static async findFilesCrossPlatform(
    globPatterns: string[],
    cwd: string,
    nvim: Nvim,
  ): Promise<Array<{ absFilePath: string; relFilePath: string }>> {
    const allMatchedPaths: Array<{ absFilePath: string; relFilePath: string }> =
      [];

    await Promise.all(
      globPatterns.map(async (pattern) => {
        try {
          // Use nocase: true for cross-platform case-insensitivity
          const matches = await glob(pattern, {
            cwd,
            nocase: true,
            nodir: true,
          });

          for (const match of matches) {
            if (fs.existsSync(path.resolve(cwd, match))) {
              allMatchedPaths.push({
                absFilePath: path.resolve(cwd, match),
                relFilePath: match,
              });
            }
          }
        } catch (err) {
          nvim.logger?.error(
            `Error processing glob pattern "${pattern}": ${(err as Error).message}`,
          );
        }
      }),
    );

    const uniqueFiles = new Map<
      string,
      { absFilePath: string; relFilePath: string }
    >();

    for (const fileInfo of allMatchedPaths) {
      try {
        // Get canonical path to handle symlinks and case differences
        const canonicalPath = fs.realpathSync(fileInfo.absFilePath);
        // Use normalized path as the deduplication key
        const normalizedPath = path.normalize(canonicalPath);

        if (!uniqueFiles.has(normalizedPath)) {
          uniqueFiles.set(normalizedPath, fileInfo);
        }
      } catch {
        // Fallback if realpathSync fails
        const normalizedPath = path.normalize(fileInfo.absFilePath);
        if (!uniqueFiles.has(normalizedPath)) {
          uniqueFiles.set(normalizedPath, fileInfo);
        }
      }
    }

    return Array.from(uniqueFiles.values());
  }

  private renderFile({
    relFilePath,
    content,
  }: {
    relFilePath: string;
    content: string;
  }) {
    return `\
Here are the contents of file \`${relFilePath}\`:
\`\`\`
${content}
\`\`\``;
  }

  async openFileInWindow(absFilePath: string): Promise<void> {
    try {
      const windows = await getAllWindows(this.nvim);
      const nonMagentaWindows = [];
      const magentaWindows = [];

      // Find all non-magenta windows and magenta windows
      for (const window of windows) {
        const isMagenta = await window.getVar("magenta");
        if (!isMagenta) {
          nonMagentaWindows.push(window);
        } else {
          magentaWindows.push(window);
        }
      }

      let targetWindowId: WindowId | null = null;

      // Determine which window to use
      if (nonMagentaWindows.length === 1) {
        // If there's only one non-magenta window, use it
        targetWindowId = nonMagentaWindows[0].id;
      } else if (nonMagentaWindows.length > 1) {
        // If there are multiple non-magenta windows, use the first one
        targetWindowId = nonMagentaWindows[0].id;
      }

      // Open the buffer in the target window or create a new window if needed
      const fileBuffer = await NvimBuffer.bufadd(absFilePath, this.nvim);

      if (targetWindowId) {
        // Open in the existing window
        await this.nvim.call("nvim_win_set_buf", [
          targetWindowId,
          fileBuffer.id,
        ]);
      } else if (nonMagentaWindows.length === 0 && magentaWindows.length > 0) {
        // Find the magenta display window by checking for magenta_display_window variable
        let magentaDisplayWindow = null;
        for (const window of magentaWindows) {
          const isDisplayWindow = await window.getVar("magenta_display_window");
          if (isDisplayWindow) {
            magentaDisplayWindow = window;
            break;
          }
        }

        // If found, open on the opposite side from where the sidebar is configured
        if (magentaDisplayWindow) {
          // Use the configured sidebarPosition from options
          const sidebarPosition = this.options.sidebarPosition;
          // Open on the opposite side
          const newWindowSide = sidebarPosition === "left" ? "right" : "left";

          // Open a new window on the appropriate side
          await this.nvim.call("nvim_open_win", [
            fileBuffer.id,
            true, // Enter the window
            {
              win: -1, // Global split
              split: newWindowSide,
              width: WIDTH,
              height: 0, // Uses default height
            },
          ]);
        } else {
          // No magenta display window found, fall back to default split
          await this.nvim.call("nvim_command", [`split ${absFilePath}`]);
        }
      } else {
        // No suitable window found, create a new one
        await this.nvim.call("nvim_command", [`split ${absFilePath}`]);
      }
    } catch (error) {
      this.nvim.logger?.error(
        `Error opening file ${absFilePath}: ${(error as Error).message}`,
      );
    }
  }

  view() {
    const fileContext = [];
    for (const absFilePath in this.files) {
      fileContext.push(
        withBindings(d`file: \`${this.files[absFilePath].relFilePath}\`\n`, {
          d: () =>
            this.myDispatch({
              type: "remove-file-context",
              absFilePath,
            }),
          "<CR>": () => this.myDispatch({ type: "open-file", absFilePath }),
        }),
      );
    }

    return d`\
# context:
${fileContext}`;
  }
}
