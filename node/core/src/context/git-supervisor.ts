import type {
  RequestContext,
  SupervisorAction,
  ThreadSupervisor,
} from "../thread-supervisor.ts";
import { injectText } from "../thread-supervisor.ts";
import type { GitContextUpdate, GitTracker } from "./git-tracker.ts";
import { gitUpdateToText } from "./git-tracker.ts";

/** Contributes the git status update to the request that is about to go out.
 * `GitTracker.getUpdate` commits the agent view as a side effect, which is
 * correct here: an injection is applied unconditionally. */
export class GitSupervisor implements ThreadSupervisor {
  readonly gitTracker: GitTracker;
  private readonly onSent: ((update: GitContextUpdate) => void) | undefined;

  constructor(args: {
    gitTracker: GitTracker;
    onSent?: (update: GitContextUpdate) => void;
  }) {
    this.gitTracker = args.gitTracker;
    this.onSent = args.onSent;
  }

  async onBeforeRequest(context: RequestContext): Promise<SupervisorAction> {
    if (context.kind === "turn-end") {
      return { type: "none" };
    }
    const update = await this.gitTracker.getUpdate();
    if (!update) return { type: "none" };
    this.onSent?.(update);
    return injectText(gitUpdateToText(update));
  }
}
