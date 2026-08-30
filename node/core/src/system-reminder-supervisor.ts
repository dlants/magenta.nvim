import { extractSystemReminderBlock } from "./agents/agents.ts";
import type { ContextTracker } from "./capabilities/context-tracker.ts";
import type { SubagentConfig, ThreadType } from "./chat-types.ts";
import type { ToolResults } from "./providers/provider-types.ts";
import {
  buildSystemReminder,
  type ReminderKind,
} from "./providers/system-reminders.ts";
import {
  injectText,
  type RequestContext,
  type SupervisorAction,
} from "./thread-supervisor.ts";
import type { AbsFilePath } from "./utils/files.ts";

/** Minimum output tokens between standing system reminders. */
const SYSTEM_REMINDER_MIN_TOKEN_INTERVAL = 2000;

/** Owns everything about system reminders: which ones are active, when they
 * fire, and what they say. The agent knows nothing about any of it — it only
 * reports tool results and its cumulative output token count, and this turns
 * that into content injected before a request.
 *
 * Not a `ThreadSupervisor`: the owning `Thread` consults it directly, after
 * the externally-composed supervisors, so its injection always lands last —
 * immediately before the user's own text. */
export class SystemReminderSupervisor {
  /** Transient reminders: activated by a resolved user message or a
   * `get_files` read, and deduped on text. */
  private readonly reminders = new Set<string>();
  private pendingBashReminder = false;
  /** The output token total the last standing reminder went out at. */
  private tokensAtLastReminder = 0;

  constructor(
    private readonly opts: {
      threadType: ThreadType;
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
      if (
        structured.toolName === "bash_command" &&
        "wasAbbreviated" in structured &&
        structured.wasAbbreviated
      ) {
        this.pendingBashReminder = true;
      }
      if (structured.toolName === "get_files" && "files" in structured) {
        for (const file of structured.files) {
          if (file.systemReminder) this.activateReminder(file.systemReminder);
        }
      }
    }
  }

  onBeforeRequest(context: RequestContext): SupervisorAction {
    const standingFires =
      context.outputTokenCount - this.tokensAtLastReminder >=
      SYSTEM_REMINDER_MIN_TOKEN_INTERVAL;
    const kinds: ReminderKind[] = [];
    if (standingFires) kinds.push("standing");
    if (this.pendingBashReminder) kinds.push("bashSummary");
    if (kinds.length === 0) return { type: "none" };

    const reminder = buildSystemReminder({
      threadType: this.opts.threadType,
      subagentConfig: this.opts.subagentConfig,
      kinds,
      extraReminders: this.extraReminders(),
    });

    if (standingFires) this.tokensAtLastReminder = context.outputTokenCount;
    this.pendingBashReminder = false;

    if (!reminder) return { type: "none" };
    return injectText(reminder);
  }

  /** The union of the transient reminders and reminders derived from markdown
   * files currently in context, deduped on text. */
  private extraReminders(): string[] {
    const reminders = new Set(this.reminders);
    const files = this.opts.contextTracker.files;
    for (const key of Object.keys(files)) {
      const fileInfo = files[key as AbsFilePath];
      if (!fileInfo) continue;
      if (!key.toLowerCase().endsWith(".md")) continue;
      if (fileInfo.agentView?.type !== "text") continue;
      const reminder = extractSystemReminderBlock(fileInfo.agentView.content);
      if (reminder) reminders.add(reminder);
    }
    return [...reminders];
  }
}
