import { execFile } from "node:child_process";
import type { ThreadId } from "@magenta/core";

export type ThreadSummary = {
  status:
    | { type: "missing" }
    | { type: "pending" }
    | { type: "running"; activity: string }
    | { type: "stopped"; reason: string }
    | { type: "yielded"; response: string }
    | { type: "error"; message: string };
};

export type ThreadSource = {
  threadIds(): ThreadId[];
  getThreadSummary(threadId: ThreadId): ThreadSummary;
};

export type TmuxInterface = {
  enabled: boolean;
  readTitle(): Promise<string>;
  setTitle(title: string): void;
};

export function createTmuxInterface(): TmuxInterface {
  const tmux = process.env["TMUX"];
  const pane = process.env["TMUX_PANE"];
  const enabled = !!(tmux && pane);

  return {
    enabled,
    readTitle(): Promise<string> {
      return new Promise((resolve, reject) => {
        execFile(
          "tmux",
          ["display-message", "-t", pane!, "-p", "#{pane_title}"],
          (error, stdout) => {
            if (error) {
              reject(error);
            } else {
              resolve(stdout.trim());
            }
          },
        );
      });
    },
    setTitle(title: string): void {
      execFile(
        "tmux",
        ["select-pane", "-t", pane!, "-T", title],
        () => {},
      );
    },
  };
}

export class TmuxNotifier {
  private originalTitle: string | undefined;
  private lastTitle: string | undefined;
  private focused: boolean = true;
  private stoppedWhenUnfocused: Set<ThreadId> = new Set();

  constructor(private tmux: TmuxInterface) {
    if (this.tmux.enabled) {
      this.tmux.readTitle().then(
        (title) => {
          this.originalTitle = title;
        },
        () => {
          this.tmux.enabled = false;
        },
      );
    }
  }

  private setTitle(title: string): void {
    if (title === this.lastTitle) {
      return;
    }
    this.lastTitle = title;
    this.tmux.setTitle(title);
  }

  onFocusGained(): void {
    this.focused = true;
    this.stoppedWhenUnfocused.clear();
  }

  onFocusLost(source: ThreadSource): void {
    this.focused = false;
    // Snapshot currently stopped threads so we only count new stops
    this.stoppedWhenUnfocused.clear();
    for (const threadId of source.threadIds()) {
      const summary = source.getThreadSummary(threadId);
      if (summary.status.type === "stopped") {
        this.stoppedWhenUnfocused.add(threadId);
      }
    }
  }

  update(source: ThreadSource): void {
    if (!this.tmux.enabled) {
      return;
    }

    let approvalCount = 0;
    let newStoppedCount = 0;

    for (const threadId of source.threadIds()) {
      const summary = source.getThreadSummary(threadId);
      if (
        summary.status.type === "running" &&
        summary.status.activity === "waiting for approval"
      ) {
        approvalCount++;
      } else if (
        summary.status.type === "stopped" &&
        !this.focused &&
        !this.stoppedWhenUnfocused.has(threadId)
      ) {
        newStoppedCount++;
      }
    }

    if (approvalCount === 0 && newStoppedCount === 0) {
      this.setTitle("nvim");
      return;
    }

    const parts: string[] = [];
    if (approvalCount > 0) {
      parts.push(`${approvalCount} approval`);
    }
    if (newStoppedCount > 0) {
      parts.push(`${newStoppedCount} stopped`);
    }
    this.setTitle(`🔴 ${parts.join(" · ")} · nvim`);
  }

  cleanup(): void {
    if (!this.tmux.enabled) {
      return;
    }
    if (this.originalTitle !== undefined) {
      this.lastTitle = undefined;
      this.setTitle(this.originalTitle);
    }
  }
}
