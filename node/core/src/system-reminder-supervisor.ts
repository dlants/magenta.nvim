import { extractSystemReminderBlock } from "./agents/agents.ts";
import type { ContextTracker } from "./capabilities/context-tracker.ts";
import type { SubagentConfig } from "./chat-types.ts";
import type { ToolResults } from "./providers/provider-types.ts";
import {
  buildSystemReminder,
  type ReminderKind,
  type ReminderThreadType,
} from "./providers/system-reminders.ts";
import {
  injectText,
  type RequestContext,
  type SupervisorAction,
} from "./thread-supervisor.ts";
import { structuredResultFor } from "./tool-types.ts";

/** Minimum output tokens between standing system reminders. */
const SYSTEM_REMINDER_MIN_TOKEN_INTERVAL = 2000;

/** What `Thread` needs of a reminder supervisor. Compact threads use
 * `noReminders` so callers never have to handle an absent one. */
export interface ReminderSupervisor {
  readonly activeReminders: ReadonlySet<string>;
  activateReminder(text: string): void;
  onToolResults(results: ToolResults): void;
  onBeforeRequest(context: RequestContext): SupervisorAction;
}

export const noReminders: ReminderSupervisor = {
  activeReminders: new Set(),
  activateReminder() {},
  onToolResults() {},
  onBeforeRequest: () => ({ type: "none" }),
};

/** Owns everything about system reminders: which ones are active, when they
 * fire, and what they say. The agent knows nothing about any of it — it only
 * reports tool results and its cumulative output token count, and this turns
 * that into content injected before a request.
 *
 * Not a `ThreadSupervisor`: the owning `Thread` consults it directly, after
 * the externally-composed supervisors, so its injection always lands last —
 * immediately before the user's own text. */
export class SystemReminderSupervisor implements ReminderSupervisor {
  /** Transient reminders: activated by a resolved user message or a
   * `get_files` read, and deduped on text. */
  private readonly reminders = new Set<string>();
  private pendingBashReminder = false;
  /** The output token total the last standing reminder went out at. */
  private tokensAtLastReminder = 0;
  /** The opening request of a thread carries the standing reminder outright:
   * the system prompt does not repeat it, so waiting for the token interval
   * would leave the model without it for the whole first stretch of work. */
  private standingReminderSent = false;

  constructor(
    private readonly opts: {
      threadType: ReminderThreadType;
      subagentConfig?: SubagentConfig | undefined;
      contextTracker: ContextTracker;
    },
  ) {}

  get activeReminders(): ReadonlySet<string> {
    return this.reminders;
  }

  activateReminder(text: string): void {
    this.reminders.add(text);
  }

  onToolResults(results: ToolResults): void {
    for (const result of results.values()) {
      if (result.status !== "ok") continue;
      const structured = result.structuredResult;
      const bash = structuredResultFor(structured, "bash_command");
      if (bash?.wasAbbreviated) this.pendingBashReminder = true;
      const getFiles = structuredResultFor(structured, "get_files");
      for (const file of getFiles?.files ?? []) {
        if (file.systemReminder) this.activateReminder(file.systemReminder);
      }
    }
  }

  onBeforeRequest(context: RequestContext): SupervisorAction {
    const standingFires =
      !this.standingReminderSent ||
      context.outputTokenCount - this.tokensAtLastReminder >=
        SYSTEM_REMINDER_MIN_TOKEN_INTERVAL;
    if (!standingFires && !this.pendingBashReminder) return { type: "none" };
    const kinds: [ReminderKind, ...ReminderKind[]] = standingFires
      ? this.pendingBashReminder
        ? ["standing", "bashSummary"]
        : ["standing"]
      : ["bashSummary"];

    const reminder = buildSystemReminder({
      threadType: this.opts.threadType,
      subagentConfig: this.opts.subagentConfig,
      kinds,
      extraReminders: this.extraReminders(),
    });

    if (standingFires) {
      this.tokensAtLastReminder = context.outputTokenCount;
      this.standingReminderSent = true;
    }
    this.pendingBashReminder = false;

    return injectText(reminder);
  }

  /** The union of the transient reminders and reminders derived from markdown
   * files currently in context, deduped on text. */
  private extraReminders(): string[] {
    const reminders = new Set(this.reminders);
    for (const [key, fileInfo] of Object.entries(
      this.opts.contextTracker.files,
    )) {
      if (!fileInfo) continue;
      if (!key.toLowerCase().endsWith(".md")) continue;
      if (fileInfo.agentView?.type !== "text") continue;
      const reminder = extractSystemReminderBlock(fileInfo.agentView.content);
      if (reminder) reminders.add(reminder);
    }
    return [...reminders];
  }
}
