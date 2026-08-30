import type { OnToolApplied } from "../capabilities/context-tracker.ts";
import type {
  RequestContext,
  SupervisorAction,
  ThreadSupervisor,
} from "../thread-supervisor.ts";
import type { ContextManager, FileUpdates } from "./context-manager.ts";

/** Contributes tracked-file context updates. The `contextManager` it owns is
 * also the `ContextTracker` capability the agent reads synchronously, so
 * there is no second copy to fall out of sync. */
export class FileContextSupervisor implements ThreadSupervisor {
  readonly contextManager: ContextManager;
  private readonly onSent: (updates: FileUpdates) => void;
  constructor(args: {
    contextManager: ContextManager;
    onSent: (updates: FileUpdates) => void;
  }) {
    this.contextManager = args.contextManager;
    this.onSent = args.onSent;
  }

  async onBeforeRequest(_context: RequestContext): Promise<SupervisorAction> {
    const updates = await this.contextManager.getContextUpdate();
    if (Object.keys(updates).length === 0) return { type: "none" };

    const content = this.contextManager.contextUpdatesToContent(updates);

    this.onSent(updates);
    return { type: "inject", content };
  }

  onToolApplied: OnToolApplied = (absFilePath, tool, fileTypeInfo) => {
    this.contextManager.toolApplied(absFilePath, tool, fileTypeInfo);
  };

  destroy(): void {
    this.contextManager.destroy();
  }
}
