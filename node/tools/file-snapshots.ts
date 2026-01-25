import fs from "node:fs";
import type { Nvim } from "../nvim/nvim-node";
import { getBufferIfOpen } from "../utils/buffers.ts";
import {
  resolveFilePath,
  type AbsFilePath,
  type NvimCwd,
  type UnresolvedFilePath,
} from "../utils/files.ts";
import type { Row0Indexed } from "../nvim/window.ts";

export interface FileSnapshot {
  content: string;
  timestamp: number;
}

/** A turn represents one user message and all subsequent assistant responses until the next user message */
export type Turn = number & { __turn: true };

export class FileSnapshots {
  private snapshots: Map<string, FileSnapshot> = new Map();
  private currentTurn: Turn = 0 as Turn;

  constructor(
    private nvim: Nvim,
    private cwd: NvimCwd,
  ) {}

  /**
   * Start a new turn when a user message is sent.
   * All subsequent file edits will be snapshotted under this turn.
   */
  public startNewTurn(): Turn {
    this.currentTurn = (this.currentTurn + 1) as Turn;
    return this.currentTurn;
  }

  /**
   * Get the current turn number
   */
  public getCurrentTurn(): Turn {
    return this.currentTurn;
  }

  /**
   * Creates a key for the snapshots map from a turn and filePath
   */
  private createKey(turn: Turn, absFilePath: AbsFilePath): string {
    return `${turn}:${absFilePath}`;
  }

  /**
   * Take a snapshot of a file before it's edited by the assistant.
   * Uses the current turn - all edits after a user message are grouped together.
   * @param unresolvedPath The path to the file that will be edited
   * @returns Promise<boolean> True if a new snapshot was taken, false if one already existed
   */
  public async willEditFile(
    unresolvedPath: UnresolvedFilePath,
  ): Promise<boolean> {
    const absFilePath = resolveFilePath(this.cwd, unresolvedPath);
    const key = this.createKey(this.currentTurn, absFilePath);
    // If we already have a snapshot for this file in this turn, don't take another one
    if (this.snapshots.has(key)) {
      return false;
    }

    try {
      // Get the content of the file, either from an open buffer or from disk
      const content = await this.getFileContent(absFilePath);

      // Store the snapshot
      this.snapshots.set(key, {
        content,
        timestamp: Date.now(),
      });

      return true;
    } catch {
      // File might not exist yet, which is fine for new files
      // Just store an empty snapshot
      this.snapshots.set(key, {
        content: "",
        timestamp: Date.now(),
      });

      return true;
    }
  }

  /**
   * Get the content of a file, either from an open buffer or from disk
   * @param filePath The path to the file
   * @returns Promise<string> The content of the file
   */
  private async getFileContent(absFilePath: AbsFilePath): Promise<string> {
    const bufferResult = await getBufferIfOpen({
      unresolvedPath: absFilePath,
      context: { nvim: this.nvim, cwd: this.cwd },
    });

    if (bufferResult.status === "ok") {
      // Get content from buffer
      const lines = await bufferResult.buffer.getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });
      return lines.join("\n");
    } else {
      // Get content from disk
      return fs.promises.readFile(absFilePath, "utf-8");
    }
  }

  /**
   * Get a snapshot for a specific file and turn
   * @param absFilePath The path to the file
   * @param turn The turn number (defaults to current turn)
   * @returns The file snapshot or undefined if none exists
   */
  public getSnapshot(
    absFilePath: AbsFilePath,
    turn?: Turn,
  ): FileSnapshot | undefined {
    const key = this.createKey(turn ?? this.currentTurn, absFilePath);
    return this.snapshots.get(key);
  }

  /**
   * Clear snapshots for a specific turn or all snapshots if no turn is provided
   * @param turn Optional turn number to clear snapshots for
   */
  public clearSnapshots(turn?: Turn): void {
    if (turn === undefined) {
      this.snapshots.clear();
      return;
    }

    // Remove all snapshots for the specified turn
    for (const key of this.snapshots.keys()) {
      if (key.startsWith(`${turn}:`)) {
        this.snapshots.delete(key);
      }
    }
  }
}
