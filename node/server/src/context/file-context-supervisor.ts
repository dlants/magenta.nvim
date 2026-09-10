import type { OnToolApplied } from "../capabilities/context-tracker.ts";
import type {
  RequestContext,
  SupervisorAction,
  ThreadSupervisor,
} from "../thread-supervisor.ts";
import type {
  ContextDeliveryState,
  ContextManager,
  FileUpdates,
} from "./context-manager.ts";

/** Conversation-bound contributor backed by the thread's stable ContextTracker.
 * The thread owns polling and destroys the manager; retiring this supervisor
 * only disables callbacks from its conversation. */
export class FileContextSupervisor implements ThreadSupervisor {
  readonly contextManager: ContextManager;
  private readonly delivery: ContextDeliveryState;
  private destroyed = false;
  private readonly onSent: (updates: FileUpdates) => void;
  constructor(args: {
    contextManager: ContextManager;
    onSent: (updates: FileUpdates) => void;
  }) {
    this.contextManager = args.contextManager;
    this.delivery = args.contextManager.delivery;
    this.onSent = args.onSent;
  }

  async onBeforeRequest(_context: RequestContext): Promise<SupervisorAction> {
    if (!this.isCurrent()) return { type: "none" };
    const updates = await this.contextManager.getContextUpdate();
    if (!this.isCurrent() || Object.keys(updates).length === 0)
      return { type: "none" };

    const content = this.contextManager.contextUpdatesToContent(updates);

    this.onSent(updates);
    return { type: "inject", content };
  }

  async hasPendingContent(): Promise<boolean> {
    if (!this.isCurrent()) return false;
    await this.contextManager.refreshPendingUpdates();
    return (
      this.isCurrent() &&
      Object.keys(this.contextManager.getPendingUpdates()).length > 0
    );
  }
  onToolApplied: OnToolApplied = (absFilePath, tool, fileTypeInfo) => {
    if (!this.isCurrent()) return;
    this.contextManager.toolApplied(absFilePath, tool, fileTypeInfo);
  };

  private isCurrent(): boolean {
    return (
      !this.destroyed && this.contextManager.isDeliveryCurrent(this.delivery)
    );
  }

  destroy(): void {
    this.destroyed = true;
  }
}
