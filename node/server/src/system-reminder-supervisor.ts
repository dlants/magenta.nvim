import { extractSystemReminderBlock } from "./agents/agents.ts";
import type { ContextTracker } from "./capabilities/context-tracker.ts";
import type { SubagentConfig } from "./chat-types.ts";
import type {
  NativeMessageIdx,
  ToolResults,
} from "./providers/provider-types.ts";
import {
  buildSystemReminder,
  type ReminderKind,
  type ReminderThreadType,
} from "./providers/system-reminders.ts";
import {
  injectText,
  type RequestContext,
  type SupervisorAction,
  type ThreadSupervisor,
} from "./thread-supervisor.ts";
import {
  structuredResultFor,
  type ToolRequestId,
  type ToolStructuredResult,
} from "./tool-types.ts";

/** Minimum output tokens between standing system reminders. */
const SYSTEM_REMINDER_MIN_TOKEN_INTERVAL = 2000;

type StandingReminderEntry = {
  readonly nativeMessageIdx: NativeMessageIdx;
  readonly outputTokenCount: number;
};

type BashReminderEntry = {
  readonly nativeMessageIdx: NativeMessageIdx;
  readonly state: "armed" | "fired";
};

type ActivatedReminderEntry = {
  readonly nativeMessageIdx: NativeMessageIdx;
  readonly text: string;
};

type SystemReminderDeps = {
  threadType: ReminderThreadType;
  subagentConfig?: SubagentConfig | undefined;
  contextTracker: ContextTracker;
  getStructuredResults: () => ReadonlyMap<ToolRequestId, ToolStructuredResult>;
};

function retainedThrough<T extends { nativeMessageIdx: NativeMessageIdx }>(
  history: ReadonlyArray<T>,
  nativeMessageIdx: NativeMessageIdx,
): T[] {
  return history
    .filter((entry) => entry.nativeMessageIdx <= nativeMessageIdx)
    .map((entry) => ({ ...entry }));
}

function appendMonotonic<T extends { nativeMessageIdx: NativeMessageIdx }>(
  history: T[],
  entry: T,
  name: string,
): void {
  const previousIdx = history.at(-1)?.nativeMessageIdx;
  if (previousIdx !== undefined && entry.nativeMessageIdx < previousIdx) {
    throw new Error(
      `${name} history must be monotonic: ${entry.nativeMessageIdx} < ${previousIdx}`,
    );
  }
  history.push(entry);
}

/** Owns everything about system reminders: which ones are active, when they
 * fire, and what they say. */
export class SystemReminderSupervisor implements ThreadSupervisor {
  private constructor(
    private readonly deps: SystemReminderDeps,
    private readonly standingHistory: StandingReminderEntry[],
    private readonly bashHistory: BashReminderEntry[],
    private readonly reminderHistory: ActivatedReminderEntry[],
  ) {}

  static create(deps: SystemReminderDeps): SystemReminderSupervisor {
    return new SystemReminderSupervisor(deps, [], [], []);
  }

  static clone({
    source,
    nativeMessageIdx,
    contextTracker,
    getStructuredResults,
  }: {
    source: SystemReminderSupervisor;
    nativeMessageIdx: NativeMessageIdx;
    contextTracker: ContextTracker;
    getStructuredResults: SystemReminderDeps["getStructuredResults"];
  }): SystemReminderSupervisor {
    return new SystemReminderSupervisor(
      {
        threadType: source.deps.threadType,
        subagentConfig: source.deps.subagentConfig,
        contextTracker,
        getStructuredResults,
      },
      retainedThrough(source.standingHistory, nativeMessageIdx),
      retainedThrough(source.bashHistory, nativeMessageIdx),
      retainedThrough(source.reminderHistory, nativeMessageIdx),
    );
  }

  get activeReminders(): ReadonlySet<string> {
    return new Set(this.reminderHistory.map((entry) => entry.text));
  }

  activateReminder(text: string, nativeMessageIdx: NativeMessageIdx): void {
    appendMonotonic(
      this.reminderHistory,
      { nativeMessageIdx, text },
      "Activated reminder",
    );
  }

  onToolResults(
    results: ToolResults,
    nativeMessageIdx: NativeMessageIdx,
  ): void {
    const structuredResults = this.deps.getStructuredResults();
    for (const [id, result] of results) {
      if (result.status !== "ok") continue;
      const structured = structuredResults.get(id);
      const bash = structuredResultFor(structured, "bash_command");
      if (bash?.wasAbbreviated) {
        appendMonotonic(
          this.bashHistory,
          { nativeMessageIdx, state: "armed" },
          "Bash reminder",
        );
      }
      const getFiles = structuredResultFor(structured, "get_files");
      for (const file of getFiles?.files ?? []) {
        if (file.systemReminder) {
          this.activateReminder(file.systemReminder, nativeMessageIdx);
        }
      }
    }
  }

  async onBeforeRequest(context: RequestContext): Promise<SupervisorAction> {
    if (context.status === "suspended") return { type: "none" };

    const lastStanding = this.standingHistory.at(-1);
    const standingFires =
      !lastStanding ||
      context.outputTokenCount - lastStanding.outputTokenCount >=
        SYSTEM_REMINDER_MIN_TOKEN_INTERVAL;
    const bashFires = this.bashHistory.at(-1)?.state === "armed";
    if (!standingFires && !bashFires) return { type: "none" };

    const kinds: [ReminderKind, ...ReminderKind[]] = standingFires
      ? bashFires
        ? ["standing", "bashSummary"]
        : ["standing"]
      : ["bashSummary"];
    const reminder = buildSystemReminder({
      threadType: this.deps.threadType,
      subagentConfig: this.deps.subagentConfig,
      kinds,
      extraReminders: this.extraReminders(),
    });

    if (standingFires) {
      appendMonotonic(
        this.standingHistory,
        {
          nativeMessageIdx: context.nativeMessageIdx,
          outputTokenCount: context.outputTokenCount,
        },
        "Standing reminder",
      );
    }
    if (bashFires) {
      appendMonotonic(
        this.bashHistory,
        { nativeMessageIdx: context.nativeMessageIdx, state: "fired" },
        "Bash reminder",
      );
    }

    return injectText(reminder);
  }

  /** The union of transient reminders and reminders derived from markdown
   * files currently in context, deduped on text. */
  private extraReminders(): string[] {
    const reminders = new Set(this.activeReminders);
    for (const [key, fileInfo] of Object.entries(
      this.deps.contextTracker.files,
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
