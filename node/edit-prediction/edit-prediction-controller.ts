import type { Dispatch } from "../tea/tea.ts";
import type { RootMsg } from "../root-msg.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { ChangeTracker } from "../change-tracker.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { getCurrentBuffer, getpos } from "../nvim/nvim.ts";
import type { Line, BufNr } from "../nvim/buffer.ts";
import { NvimBuffer } from "../nvim/buffer.ts";
import type { NvimCwd, UnresolvedFilePath } from "../utils/files.ts";
import * as diff from "diff";
import { getProvider } from "../providers/provider.ts";
import { type EditPredictionProfile, type MagentaOptions } from "../options.ts";
import { spec } from "../tools/predict-edit.ts";
import { relativePath } from "../utils/files.ts";
import {
  type Row0Indexed,
  type Row1Indexed,
  type ByteIdx,
  pos1col1to0,
  type Position0Indexed,
} from "../nvim/window.ts";
import { calculateDiff } from "./diff.ts";
import { MAGENTA_HIGHLIGHT_GROUPS } from "../nvim/extmarks.ts";
import { PREDICTION_SYSTEM_PROMPT } from "../providers/system-prompt.ts";
import {
  selectBestPredictionLocation,
  type MatchRange,
} from "./cursor-utils.ts";

// Default token budget for recent changes (approximately 3 characters per token)
export const DEFAULT_RECENT_CHANGE_TOKEN_BUDGET = 1000;

export type PredictionState =
  | { type: "idle" }
  | { type: "preparing-request" }
  | {
      type: "awaiting-agent-reply";
      contextWindow: CapturedContext;
      requestStartTime: number;
      request: { abort: () => void };
    }
  | {
      type: "displaying-proposed-edit";
      contextWindow: CapturedContext;
      prediction: PredictionInput;
    }
  | {
      type: "prediction-being-applied";
      contextWindow: CapturedContext;
      prediction: PredictionInput;
    };

export type CapturedContext = {
  contextLines: string[];
  cursorDelta: number; // 0-indexed relative to context start
  cursorCol: ByteIdx;
  bufferName: string;
  bufferId: BufNr;
  startLine: Row0Indexed; // 0-indexed absolute buffer position
  endLine: Row0Indexed; // 0-indexed absolute buffer position
  totalLines: number;
};

export type PredictionInput = {
  find: string;
  replace: string;
};

export type EditPredictionMsg =
  | { type: "trigger-prediction" }
  | { type: "prediction-received"; input: PredictionInput }
  | { type: "prediction-accepted" }
  | { type: "prediction-dismissed" }
  | { type: "prediction-error"; error: string }
  | { type: "debug-log-message" };

export type EditPredictionId = number & { __editPredictionId: true };

export class EditPredictionController {
  public state: PredictionState;
  private renderedExtMarks: BufNr | undefined;
  public recentChangeTokenBudget: number;
  private predictionSystemPrompt: string;
  private hasEscMapping: { bufnr: BufNr } | undefined;
  private hasTextChangedListener: { bufnr: BufNr } | undefined;

  private myDispatch: Dispatch<EditPredictionMsg>;

  constructor(
    public id: EditPredictionId,
    private context: {
      dispatch: Dispatch<RootMsg>;
      nvim: Nvim;
      changeTracker: ChangeTracker;
      cwd: NvimCwd;
      options: MagentaOptions;
    },
  ) {
    this.myDispatch = (msg) =>
      this.context.dispatch({
        type: "edit-prediction-msg",
        id: this.id,
        msg,
      });

    this.state = { type: "idle" };
    this.renderedExtMarks = undefined;
    this.hasEscMapping = undefined;
    this.hasTextChangedListener = undefined;

    // Get token budget with priority:
    // 1. structured option, 2. legacy option, 3. default value
    this.recentChangeTokenBudget =
      context.options.editPrediction?.recentChangeTokenBudget ??
      DEFAULT_RECENT_CHANGE_TOKEN_BUDGET;

    // Get system prompt with priority:
    // 1. structured replacement, 2. legacy option, 3. default with optional append
    if (context.options.editPrediction?.systemPrompt) {
      this.predictionSystemPrompt = context.options.editPrediction.systemPrompt;
    } else {
      this.predictionSystemPrompt = PREDICTION_SYSTEM_PROMPT;

      // Append additional instructions if provided
      if (context.options.editPrediction?.systemPromptAppend) {
        this.predictionSystemPrompt +=
          "\n\n" + context.options.editPrediction.systemPromptAppend;
      }
    }
  }

  update(msg: RootMsg): void {
    if (msg.type === "edit-prediction-msg" && msg.id === this.id) {
      this.myUpdate(msg.msg);
    }
  }

  private myUpdate(msg: EditPredictionMsg): void {
    switch (msg.type) {
      case "trigger-prediction":
        // Abort any existing request and reset to idle
        if (this.state.type === "awaiting-agent-reply") {
          this.state.request.abort();
        }

        // Clean up any existing listeners before starting new prediction
        this.cleanupPredictionListeners().catch((error) => {
          this.context.nvim.logger.warn(
            "Failed to cleanup prediction listeners before new prediction:",
            error instanceof Error ? error.message : String(error),
          );
        });

        // Reset state to idle before starting new prediction
        this.state = { type: "idle" };

        this.triggerPrediction().catch((error) => {
          this.myDispatch({
            type: "prediction-error",
            error: error instanceof Error ? error.message : String(error),
          });
        });
        return;

      case "prediction-received":
        if (this.state.type !== "awaiting-agent-reply") {
          this.context.nvim.logger.warn(
            `Received prediction while in state: ${this.state.type}`,
          );
          return;
        }
        this.state = {
          type: "displaying-proposed-edit",
          contextWindow: this.state.contextWindow,
          prediction: msg.input,
        };
        this.setupPredictionListeners().catch((error) => {
          this.context.nvim.logger.warn(
            "Failed to setup prediction listeners:",
            error instanceof Error ? error.message : String(error),
          );
        });
        this.showVirtualTextPreview().catch((error) => {
          this.myDispatch({
            type: "prediction-error",
            error: error instanceof Error ? error.message : String(error),
          });
        });
        return;

      case "prediction-accepted":
        if (this.state.type !== "displaying-proposed-edit") {
          this.context.nvim.logger.warn(
            `Cannot accept prediction from state: ${this.state.type}`,
          );
          return;
        }
        this.state = {
          type: "prediction-being-applied",
          contextWindow: this.state.contextWindow,
          prediction: this.state.prediction,
        };
        this.applyPrediction().catch((error) => {
          this.myDispatch({
            type: "prediction-error",
            error: error instanceof Error ? error.message : String(error),
          });
        });
        return;

      case "prediction-dismissed":
        if (this.state.type !== "displaying-proposed-edit") {
          this.context.nvim.logger.warn(
            `Cannot dismiss prediction from state: ${this.state.type}`,
          );
          return;
        }
        this.clearVirtualText().catch((error) => {
          this.context.nvim.logger.error(
            "Failed to clear virtual text:",
            error instanceof Error ? error.message : String(error),
          );
        });
        this.cleanupPredictionListeners().catch((error) => {
          this.context.nvim.logger.warn(
            "Failed to cleanup prediction listeners:",
            error instanceof Error ? error.message : String(error),
          );
        });
        this.state = { type: "idle" };
        return;

      case "prediction-error":
        this.context.nvim.logger.error("Edit prediction error:", msg.error);
        this.clearVirtualText().catch((error) => {
          this.context.nvim.logger.error(
            "Failed to clear virtual text on error:",
            error instanceof Error ? error.message : String(error),
          );
        });
        this.cleanupPredictionListeners().catch((error) => {
          this.context.nvim.logger.warn(
            "Failed to cleanup prediction listeners on error:",
            error instanceof Error ? error.message : String(error),
          );
        });
        this.state = { type: "idle" };
        return;

      case "debug-log-message":
        this.debugLogMessage().catch((error) => {
          this.context.nvim.logger.error(
            "Failed to debug log message:",
            error instanceof Error ? error.message : String(error),
          );
        });
        return;

      default:
        assertUnreachable(msg);
    }
  }

  private async clearVirtualText(): Promise<void> {
    if (this.renderedExtMarks === undefined) {
      return;
    }

    try {
      const buffer = new NvimBuffer(this.renderedExtMarks, this.context.nvim);
      await buffer.clearAllExtmarks();
      this.renderedExtMarks = undefined;
    } catch (error) {
      this.context.nvim.logger.error("Failed to clear virtual text:", error);
    }
  }

  private async setupPredictionListeners(): Promise<void> {
    if (this.state.type !== "displaying-proposed-edit") {
      return;
    }

    const bufnr = this.state.contextWindow.bufferId;
    const res = await this.context.nvim.call("nvim_get_mode", []);

    // Setup ESC mapping if in normal mode
    if (res.mode === "n") {
      try {
        await this.context.nvim.call("nvim_exec_lua", [
          `require("magenta").setup_prediction_esc_mapping(${bufnr})`,
          [],
        ]);
        this.hasEscMapping = { bufnr };
      } catch (error) {
        this.context.nvim.logger.warn(
          "Failed to setup ESC mapping:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    // Setup TextChangedI listener if in insert mode
    if (res.mode === "i") {
      try {
        await this.context.nvim.call("nvim_exec_lua", [
          `require("magenta").listenForTextChangedI(${bufnr})`,
          [],
        ]);
        this.hasTextChangedListener = { bufnr };
      } catch (error) {
        this.context.nvim.logger.warn(
          "Failed to setup TextChangedI listener:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  private async cleanupPredictionListeners(): Promise<void> {
    if (this.state.type !== "displaying-proposed-edit") {
      return;
    }

    // Cleanup ESC mapping
    if (this.hasEscMapping) {
      try {
        await this.context.nvim.call("nvim_exec_lua", [
          `require("magenta").cleanup_prediction_esc_mapping(${this.hasEscMapping.bufnr})`,
          [],
        ]);
      } catch (error) {
        // Ignore errors during cleanup - the mapping might already be gone
        this.context.nvim.logger.debug(
          "Error cleaning up ESC mapping (this is usually harmless):",
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        this.hasEscMapping = undefined;
      }
    }

    // Cleanup TextChangedI listener
    if (this.hasTextChangedListener) {
      try {
        await this.context.nvim.call("nvim_exec_lua", [
          `require("magenta").cleanupListenForTextChangedI(${this.hasTextChangedListener.bufnr})`,
          [],
        ]);
      } catch (error) {
        // Ignore errors during cleanup - the autocmd might already be gone
        this.context.nvim.logger.debug(
          "Error cleaning up TextChangedI listener (this is usually harmless):",
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        this.hasTextChangedListener = undefined;
      }
    }
  }

  private async showCompletingIndicator(
    contextWindow: CapturedContext,
  ): Promise<void> {
    const buffer = new NvimBuffer(contextWindow.bufferId, this.context.nvim);

    await this.clearVirtualText();
    this.renderedExtMarks = contextWindow.bufferId;

    // Calculate cursor position in buffer coordinates
    const cursorPos: Position0Indexed = {
      row: (contextWindow.startLine + contextWindow.cursorDelta) as Row0Indexed,
      col: contextWindow.cursorCol,
    };

    // Add virtual text "completing..." after the cursor
    await buffer.setExtmark({
      startPos: cursorPos,
      endPos: cursorPos,
      options: {
        virt_text: [["completing...", "Comment"]],
        right_gravity: false,
      },
    });
  }

  private convertCharPosToLineCol(
    text: string,
    charPos: number,
    startLine: Row0Indexed,
    startCol: ByteIdx,
  ): Position0Indexed {
    const lines = text.slice(0, charPos).split("\n");
    const row = (startLine + lines.length - 1) as Row0Indexed;
    const col =
      lines.length === 1
        ? ((startCol + lines[0].length) as ByteIdx) // Same line: add start column offset
        : (lines[lines.length - 1].length as ByteIdx); // New line: column is absolute

    return { row, col };
  }

  private resolveFindText(findText: string, contextText: string): string {
    // Check if the find text exists in context, with fallback for cursor marker
    if (contextText.includes(findText)) {
      return findText;
    }

    // Try removing cursor marker if present
    if (findText.includes("│")) {
      const fallbackFind = findText.replace(/│/g, "");
      if (contextText.includes(fallbackFind)) {
        return fallbackFind;
      } else {
        throw new Error(
          `Find text "${findText}" (or fallback "${fallbackFind}") not found in current context`,
        );
      }
    } else {
      throw new Error(`Find text "${findText}" not found in current context`);
    }
  }

  private async showVirtualTextPreview(): Promise<void> {
    if (this.state.type !== "displaying-proposed-edit") {
      return;
    }

    const { contextWindow, prediction } = this.state;
    const buffer = new NvimBuffer(contextWindow.bufferId, this.context.nvim);

    await this.clearVirtualText();
    this.renderedExtMarks = contextWindow.bufferId;

    const contextText = contextWindow.contextLines.join("\n");
    const findText = this.resolveFindText(prediction.find, contextText);

    // Calculate the new text after replacement
    const newText = contextText.replace(findText, prediction.replace);

    // Calculate diff operations
    const diffOps = calculateDiff(contextText, newText);

    // Apply virtual text for each diff operation
    for (const op of diffOps) {
      if (op.type === "delete") {
        // Apply strikethrough highlight to deleted text
        const bufferStartPos = this.convertCharPosToLineCol(
          contextText,
          op.startPos,
          contextWindow.startLine,
          0 as ByteIdx,
        );
        const bufferEndPos = this.convertCharPosToLineCol(
          contextText,
          op.endPos,
          contextWindow.startLine,
          0 as ByteIdx,
        );

        await buffer.setExtmark({
          startPos: bufferStartPos,
          endPos: bufferEndPos,
          options: {
            hl_group: MAGENTA_HIGHLIGHT_GROUPS.PREDICTION_STRIKETHROUGH,
          },
        });
      } else if (op.type === "insert") {
        // Add virtual text for insertions
        const bufferPos = this.convertCharPosToLineCol(
          contextText,
          op.insertAfterPos,
          contextWindow.startLine,
          0 as ByteIdx,
        );

        // Split inserted text by newlines
        const insertLines = op.text.split("\n");

        if (insertLines.length === 1) {
          // Single line insertion
          await buffer.setExtmark({
            startPos: bufferPos,
            endPos: bufferPos,
            options: {
              virt_text: [[insertLines[0], "Comment"]],
              virt_text_pos: "inline",
              right_gravity: false,
            },
          });
        } else {
          // Multi-line insertion - place first line inline, rest as virtual lines
          await buffer.setExtmark({
            startPos: bufferPos,
            endPos: bufferPos,
            options: {
              virt_text: [[insertLines[0], "Comment"]],
              virt_text_pos: "inline",
              virt_lines: insertLines
                .slice(1)
                .map((line) => [[line, "Comment"]]),
              right_gravity: false,
            },
          });
        }
      }
    }
  }

  async captureContextWindow(): Promise<CapturedContext> {
    const buffer = await getCurrentBuffer(this.context.nvim);
    const pos1Indexed = await getpos(this.context.nvim, ".");
    const pos0Indexed = pos1col1to0(pos1Indexed);
    const totalLines = await this.context.nvim.call("nvim_buf_line_count", [
      buffer.id,
    ]);
    const bufferName = await buffer.getName();

    // capture some context around the cursor
    const startLine = Math.max(0, pos0Indexed.row - 10) as Row0Indexed;
    const endLine = Math.min(
      totalLines - 1,
      pos0Indexed.row + 20,
    ) as Row0Indexed;

    const contextLines = await buffer.getLines({
      start: startLine,
      end: (endLine + 1) as Row0Indexed,
    });

    return {
      contextLines: contextLines as string[],
      cursorDelta: (pos0Indexed.row - startLine) as Row0Indexed, // Relative position within context
      cursorCol: pos0Indexed.col,
      bufferName: bufferName,
      bufferId: buffer.id,
      startLine,
      endLine,
      totalLines: totalLines,
    };
  }

  private async applyPrediction(): Promise<void> {
    if (this.state.type !== "prediction-being-applied") {
      throw new Error("Cannot apply prediction from current state");
    }

    const { contextWindow, prediction } = this.state;

    await this.clearVirtualText();
    this.cleanupPredictionListeners().catch((error) => {
      this.context.nvim.logger.warn(
        "Failed to cleanup prediction listeners after applying prediction:",
        error instanceof Error ? error.message : String(error),
      );
    });
    this.state = { type: "idle" };

    // Use the specific buffer that the prediction was generated for
    const buffer = new NvimBuffer(contextWindow.bufferId, this.context.nvim);

    // Get the current context lines to validate they haven't changed
    const currentLines = await buffer.getLines({
      start: contextWindow.startLine,
      end: (contextWindow.endLine + 1) as Row0Indexed,
    });

    for (let i = 0; i < contextWindow.contextLines.length; i += 1) {
      if (currentLines[i] !== contextWindow.contextLines[i]) {
        throw new Error(`Context window has changed since prediction was made`);
      }
    }

    const contextText = contextWindow.contextLines.join("\n");
    const findText = this.resolveFindText(prediction.find, contextText);

    // Find all occurrences of the find text in context coordinates
    const contextFindIndices: number[] = [];
    let startIndex = 0;
    let index: number;
    while ((index = contextText.indexOf(findText, startIndex)) !== -1) {
      contextFindIndices.push(index);
      startIndex = index + 1;
    }

    // Cursor position in document coordinates
    const cursorDocumentPos: Position0Indexed = {
      row: (contextWindow.startLine + contextWindow.cursorDelta) as Row0Indexed,
      col: contextWindow.cursorCol,
    };

    // Convert context indices to match ranges with document positions
    const matchRanges: MatchRange[] = contextFindIndices.map((contextPos) => ({
      contextPosStart: contextPos,
      contextPosEnd: contextPos + findText.length,
      startPos: this.convertCharPosToLineCol(
        contextText,
        contextPos,
        contextWindow.startLine,
        0 as ByteIdx,
      ),
      endPos: this.convertCharPosToLineCol(
        contextText,
        contextPos + findText.length,
        contextWindow.startLine,
        0 as ByteIdx,
      ),
    }));

    // Select the best match using our priority logic
    const bestMatchRange = selectBestPredictionLocation(
      matchRanges,
      cursorDocumentPos,
    );

    // Apply the replacement at the selected position
    const replacedText =
      contextText.substring(0, bestMatchRange.contextPosStart) +
      prediction.replace +
      contextText.substring(bestMatchRange.contextPosEnd);

    const replacedLines = replacedText.split("\n");

    // Apply the changes to the buffer using 0-indexed positions
    await buffer.setLines({
      start: contextWindow.startLine,
      end: (contextWindow.endLine + 1) as Row0Indexed,
      lines: replacedLines as Line[],
    });

    // Move cursor to the end of the replacement text
    const newEndPos = this.convertCharPosToLineCol(
      replacedText,
      bestMatchRange.contextPosStart + prediction.replace.length,
      contextWindow.startLine,
      0 as ByteIdx,
    );

    await this.context.nvim.call("nvim_win_set_cursor", [
      0, // 0 means current window
      [newEndPos.row + 1, newEndPos.col], // Convert to 1-indexed row for nvim_win_set_cursor
    ]);
  }

  async composeUserMessage(contextWindow?: CapturedContext): Promise<string> {
    // Use provided context or capture new one
    const {
      contextLines,
      cursorDelta: cursorLine,
      cursorCol,
      bufferName,
      startLine,
      endLine,
    } = contextWindow || (await this.captureContextWindow());

    // Create context with cursor marker
    const contextWithCursor = [...contextLines];
    const line = contextWithCursor[cursorLine] || "";
    contextWithCursor[cursorLine] =
      line.slice(0, cursorCol) + "│" + line.slice(cursorCol);

    const bufferRelPath = relativePath(
      this.context.cwd,
      bufferName as UnresolvedFilePath,
    );

    // Get all recent changes
    const allRecentChanges = this.context.changeTracker.getChanges();

    // Process changes starting from the most recent, stopping when we hit the token budget
    const selectedChanges: string[] = [];
    let tokenCount = 0;

    // Start from the most recent change (end of array) and work backwards
    for (let i = allRecentChanges.length - 1; i >= 0; i--) {
      const change = allRecentChanges[i];

      // Create a unified diff patch
      const patch = diff.createPatch(
        change.filePath,
        change.oldText,
        change.newText,
        `${change.filePath}:${change.range.start.line + 1}`,
        `${change.filePath}:${change.range.start.line + 1}`,
      );

      // Remove the standard diff headers and @@ hunk headers
      const lines = patch.split("\n");
      const hunkStart = lines.findIndex((line) => line.startsWith("@@"));

      let formattedDiff: string;
      if (hunkStart === -1) {
        formattedDiff = patch; // No hunks found, use as-is
      } else {
        // Skip the @@ header line and get the actual diff content
        const hunks = lines.slice(hunkStart + 1);
        const lineStart = change.range.start.line + 1;
        const lineEnd = change.range.end.line + 1;
        formattedDiff = `${change.filePath}:${lineStart}:${lineEnd}\n${hunks.join("\n")}`;
      }

      // Estimate token count (3 chars per token is a rough approximation)
      const estimatedTokens = Math.ceil(formattedDiff.length / 3);

      // Check if adding this change would exceed our budget
      if (tokenCount + estimatedTokens > this.recentChangeTokenBudget) {
        // If we can't fit any more changes, stop processing
        break;
      }

      // This change fits within our budget, so include it
      selectedChanges.unshift(formattedDiff); // Add to beginning to maintain chronological order
      tokenCount += estimatedTokens;
    }

    const recentChangesDiffs = selectedChanges.join("\n");

    // Convert 0-indexed positions to 1-indexed for display
    const displayStartLine = (startLine + 1) as Row1Indexed;
    const displayEndLine = (endLine + 1) as Row1Indexed;

    return `Recent changes:
${recentChangesDiffs}

Current context (│ marks cursor position):
${bufferRelPath}:${displayStartLine}:${displayEndLine}
${contextWithCursor.join("\n")}

Predict the most likely next edit the user will make.`;
  }

  private resolvePredictionProfile(): EditPredictionProfile {
    // If editPrediction.profile is specified, use that profile
    if (this.context.options.editPrediction?.profile) {
      const predictionProfile = this.context.options.editPrediction.profile;

      // Convert EditPredictionProfile to Profile by adding required fields
      const profile: EditPredictionProfile = {
        name: "edit-prediction",
        provider: predictionProfile.provider,
        model: predictionProfile.model,
      };

      // Only add optional fields if they're defined
      if (predictionProfile.baseUrl) {
        profile.baseUrl = predictionProfile.baseUrl;
      }
      if (predictionProfile.apiKeyEnvVar) {
        profile.apiKeyEnvVar = predictionProfile.apiKeyEnvVar;
      }
      if (predictionProfile.authType) {
        profile.authType = predictionProfile.authType;
      }

      return profile;
    }

    // Fall back to the active profile
    const profile = this.context.options.profiles[0];
    return {
      name: `edit-prediction-${profile.name}`,
      provider: profile.provider,
      model: profile.model,
      baseUrl: profile.baseUrl,
      apiKeyEnvVar: profile.apiKeyEnvVar,
      authType: profile.authType,
    };
  }

  private async debugLogMessage(): Promise<void> {
    try {
      const contextWindow = await this.captureContextWindow();
      const userMessage = await this.composeUserMessage(contextWindow);

      // Create a scratch buffer for the debug message
      const bufnr = await this.context.nvim.call("nvim_create_buf", [
        false,
        true,
      ]);

      // Set buffer options
      await this.context.nvim.call("nvim_buf_set_option", [
        bufnr,
        "buftype",
        "nofile",
      ]);
      await this.context.nvim.call("nvim_buf_set_option", [
        bufnr,
        "bufhidden",
        "wipe",
      ]);
      await this.context.nvim.call("nvim_buf_set_option", [
        bufnr,
        "swapfile",
        false,
      ]);
      await this.context.nvim.call("nvim_buf_set_option", [
        bufnr,
        "modifiable",
        true,
      ]);

      // Set the content
      const lines = `Edit Prediction Debug Message:\n\n${userMessage}`.split(
        "\n",
      );
      await this.context.nvim.call("nvim_buf_set_lines", [
        bufnr,
        0,
        -1,
        false,
        lines,
      ]);

      // Make buffer read-only
      await this.context.nvim.call("nvim_buf_set_option", [
        bufnr,
        "modifiable",
        false,
      ]);

      // Get editor dimensions for sizing the floating window
      const editorWidth = (await this.context.nvim.call("nvim_get_option", [
        "columns",
      ])) as number;
      const editorHeight = (await this.context.nvim.call("nvim_get_option", [
        "lines",
      ])) as number;

      // Calculate floating window size (80% of editor size, with reasonable limits)
      const width = Math.min(120, Math.floor(editorWidth * 0.8));
      const height = Math.min(40, Math.floor(editorHeight * 0.8));

      // Center the window
      const row = Math.floor((editorHeight - height) / 2);
      const col = Math.floor((editorWidth - width) / 2);

      // Create floating window
      const winId = await this.context.nvim.call("nvim_open_win", [
        bufnr,
        true, // enter the window
        {
          relative: "editor",
          width,
          height,
          row,
          col,
          style: "minimal",
          border: "rounded",
          title: " Edit Prediction Debug ",
          title_pos: "center",
        },
      ]);

      // Set window options
      await this.context.nvim.call("nvim_win_set_option", [
        winId,
        "wrap",
        true,
      ]);
      await this.context.nvim.call("nvim_win_set_option", [
        winId,
        "linebreak",
        true,
      ]);

      // Set up a keymap to close the window with 'q' or ESC
      await this.context.nvim.call("nvim_buf_set_keymap", [
        bufnr,
        "n",
        "q",
        `<cmd>lua vim.api.nvim_win_close(${winId}, true)<cr>`,
        { noremap: true, silent: true },
      ]);

      await this.context.nvim.call("nvim_buf_set_keymap", [
        bufnr,
        "n",
        "<Esc>",
        `<cmd>lua vim.api.nvim_win_close(${winId}, true)<cr>`,
        { noremap: true, silent: true },
      ]);
    } catch (error) {
      this.context.nvim.logger.error(
        `Failed to generate debug message: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async triggerPrediction(): Promise<void> {
    // Transition to preparing-request state
    this.state = { type: "preparing-request" };

    // Resolve profile for predictions
    const profile = this.resolvePredictionProfile();
    const provider = getProvider(this.context.nvim, profile);

    // Capture context window
    const contextWindow = await this.captureContextWindow();
    const userMessage = await this.composeUserMessage(contextWindow);

    const request = provider.forceToolUse({
      model: profile.model,
      input: [{ type: "text", text: userMessage }],
      spec,
      systemPrompt: this.predictionSystemPrompt,
      disableCaching: true,
    });

    // Transition to awaiting-agent-reply state with the request
    this.state = {
      type: "awaiting-agent-reply",
      contextWindow,
      requestStartTime: Date.now(),
      request,
    };

    // Show "completing..." indicator at cursor position
    this.showCompletingIndicator(contextWindow).catch((error) => {
      this.context.nvim.logger.warn(
        "Failed to show completing indicator:",
        error instanceof Error ? error.message : String(error),
      );
    });

    const response = await request.promise;

    if (response.toolRequest.status === "ok") {
      const input = response.toolRequest.value.input as PredictionInput;
      this.myDispatch({
        type: "prediction-received",
        input,
      });
    } else {
      this.myDispatch({
        type: "prediction-error",
        error: response.toolRequest.error || "Tool use failed",
      });
    }
  }
}
