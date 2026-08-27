import type { OnToolApplied } from "../capabilities/context-tracker.ts";
import type { FileIO } from "../capabilities/file-io.ts";
import type { Logger } from "../logger.ts";
import type {
  InjectedContent,
  RequestAction,
  ThreadSupervisor,
} from "../thread-supervisor.ts";
import type { HomeDir, NvimCwd } from "../utils/files.ts";
import type { FileUpdates } from "./context-manager.ts";
import { buildClonedFiles, ContextManager } from "./context-manager.ts";

/** Contributes tracked-file context updates. The `contextManager` it owns is
 * also the `ContextTracker` capability the agent reads synchronously, so
 * there is no second copy to fall out of sync. */
export class FileContextSupervisor implements ThreadSupervisor {
  readonly contextManager: ContextManager;
  private readonly onSent: ((updates: FileUpdates) => void) | undefined;

  constructor(args: {
    contextManager: ContextManager;
    onSent?: (updates: FileUpdates) => void;
  }) {
    this.contextManager = args.contextManager;
    this.onSent = args.onSent;
  }

  async onBeforeRequest(): Promise<RequestAction> {
    const updates = await this.contextManager.getContextUpdate();
    if (Object.keys(updates).length === 0) return { type: "none" };

    const content: InjectedContent[] = [];
    for (const part of this.contextManager.contextUpdatesToContent(updates)) {
      if (
        part.type === "text" ||
        part.type === "image" ||
        part.type === "document"
      ) {
        content.push(part);
      }
    }
    if (content.length === 0) return { type: "none" };

    this.onSent?.(updates);
    return { type: "inject", content };
  }

  onToolApplied: OnToolApplied = (absFilePath, tool, fileTypeInfo) => {
    this.contextManager.toolApplied(absFilePath, tool, fileTypeInfo);
  };

  destroy(): void {
    this.contextManager.destroy();
  }

  /** Independent file state for a forked thread: text files are re-read from
   * disk so the fork's first update produces no diff; binary agent views are
   * copied. */
  static async clone(
    source: FileContextSupervisor,
    args: {
      logger: Logger;
      fileIO: FileIO;
      cwd: NvimCwd;
      homeDir: HomeDir;
      pollIntervalMs?: number;
      onSent?: (updates: FileUpdates) => void;
    },
  ): Promise<FileContextSupervisor> {
    const files = await buildClonedFiles(
      source.contextManager.files,
      args.fileIO,
    );
    const contextManager = new ContextManager(
      args.logger,
      args.fileIO,
      args.cwd,
      args.homeDir,
      files,
      args.pollIntervalMs,
    );
    return new FileContextSupervisor(
      args.onSent
        ? { contextManager, onSent: args.onSent }
        : { contextManager },
    );
  }
}
