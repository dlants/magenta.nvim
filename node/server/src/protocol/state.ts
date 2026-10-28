import type {
  ApprovalId,
  PendingViolation,
  SandboxViolation,
} from "../capabilities/sandbox-violation-handler.ts";
import { deduplicateViolations } from "../capabilities/sandbox-violation-handler.ts";
import type {
  ScriptInvocationId,
  ThreadId,
  ThreadOrigin,
  ThreadType,
} from "../chat-types.ts";
import type {
  CompactionRunState,
  ThreadCompactor,
} from "../compaction/compactor.ts";
import type {
  NativeMessageIdx,
  ProviderMessage,
  ProviderToolSpec,
  RequestedTool,
  StreamingBlock,
  ToolResultInput,
  Usage,
} from "../providers/provider-types.ts";
import type { SystemPrompt } from "../providers/system-prompt.ts";
import type { ScriptMeta } from "../scripts/protocol.ts";
import type {
  ScriptInvocation,
  ScriptInvocationEntry,
  ScriptManager,
  ScriptThreadResult,
} from "../scripts/script-manager.ts";
import type { ProfileSelection, Session, SessionId } from "../session.ts";
import type { Queues } from "../submission/mailbox.ts";
import type { FileStat, FileUpdates } from "../supervisors/file-supervisor.ts";
import type { EnvironmentConfig, Thread } from "../thread.ts";
import type { SubmissionResult, YieldValue } from "../thread-api.ts";
import type { ContextDelivery } from "../thread-core.ts";
import type { ThreadState } from "../thread-state.ts";
import type { EditedFileGroup } from "../thread-supervisor.ts";
import type {
  ToolRequest,
  ToolRequestId,
  ToolStructuredResult,
} from "../tool-types.ts";
import type { AbsFilePath, ProjectDir } from "../utils/files.ts";
import type { JsonValue } from "../utils/json.ts";

export type { JsonValue };

/** `failed` carries an `Error` in-process; across the boundary only its
 * message is kept. */
export type ProtocolSubmissionResult =
  | Exclude<SubmissionResult, { type: "failed" }>
  | { type: "failed"; error: { message: string } };

/** `ThreadState` without live handles or `Date`s: running tools are described
 * by id (their details live in `ProtocolThreadState.tools`), times are epoch
 * milliseconds and errors are messages. */
export type ProtocolRunState =
  | { type: "idle"; lastResult: ProtocolSubmissionResult | undefined }
  | { type: "destroyed"; lastResult: ProtocolSubmissionResult | undefined }
  | { type: "yielded"; value: YieldValue; resultPrefix?: string }
  | { type: "running"; aborting: boolean; activity: ProtocolActivity };

export type ProtocolActivity =
  | { type: "preparing" }
  | {
      type: "streaming";
      startedAt: number;
      lastEventTime: number;
      block: StreamingBlock | undefined;
      retry:
        | { attempt: number; nextRetryAt: number; error: { message: string } }
        | undefined;
    }
  | {
      type: "running_tools";
      requested: ReadonlyArray<RequestedTool>;
      tools:
        | { type: "pending" }
        | { type: "running"; toolRequestIds: ReadonlyArray<ToolRequestId> }
        | { type: "settled" };
    };

export type ToolState = { request: ToolRequest } & (
  | { status: "running"; progress: JsonValue | undefined }
  | {
      status: "done";
      result: ToolResultInput;
      structuredResult?: ToolStructuredResult;
    }
);

export type TrackedContextFile = {
  absFilePath: AbsFilePath;
} & Omit<Thread["contextFiles"]["files"][AbsFilePath], "lastStat"> & {
    lastStat?: FileStat;
  };

export type ProtocolThreadState = {
  id: ThreadId;
  title?: string;
  threadType: ThreadType;
  projectDir: ProjectDir;
  /** The single source for busy/yielded/lastResult. */
  run: ProtocolRunState;
  messages: ReadonlyArray<ProviderMessage>;
  tools: Readonly<Record<ToolRequestId, ToolState>>;
  queued: Queues;
  latestUsage?: Usage;
  systemPrompt: SystemPrompt;
  lastStopTokenCount: number;
  toolSpecs: ReadonlyArray<ProviderToolSpec>;
  contextFiles: ReadonlyArray<TrackedContextFile>;
  /** File changes not yet delivered to the agent. */
  pendingContextUpdates: FileUpdates;
  contextDeliveries: Readonly<Record<NativeMessageIdx, ContextDelivery>>;
  editedFileGroups: ReadonlyArray<EditedFileGroup>;
  /** The current run, if any, is the last entry with `type: "running"`. */
  compaction: { runs: ReadonlyArray<CompactionRunState> };
  derived: {
    forks: ReadonlyArray<ThreadId>;
    reflections: ReadonlyArray<ThreadId>;
  };
};

export type SessionThreadSummary = {
  id: ThreadId;
  parentThreadId?: ThreadId;
  scriptInvocationId?: ScriptInvocationId;
  origin?: ThreadOrigin;
  rootAncestorId: ThreadId;
  lastActivityTime: number;
  title?: string;
  threadType: ThreadType;
  profileName: string;
  environment?: EnvironmentConfig;
  sandboxBypassed: boolean;
  teardownMessage?: string;
} & (
  | { state: "pending" }
  | { state: "error"; error: { message: string } }
  | { state: "ready"; run: ProtocolRunState }
);

/** A pending sandbox prompt without its resolve/reject closures; resolved by
 * id through operations. */
export type PendingApprovalPrompt =
  | { kind: "approval-prompt"; command: string }
  | {
      kind: "violation";
      command: string;
      violations: ReadonlyArray<{ line: string; count: number }>;
      stderr: string;
    }
  | { kind: "write-approval"; absPath: AbsFilePath }
  | { kind: "network-access"; host: string; port?: number };

export type PendingApproval = {
  id: ApprovalId;
  threadId: ThreadId;
  prompt: PendingApprovalPrompt;
};

export type ScriptInvocationSummary = Omit<
  ScriptInvocation,
  "logs" | "entries"
>;

export type ProtocolSessionState = {
  id: SessionId;
  activeProfile: ProfileSelection;
  threads: ReadonlyArray<SessionThreadSummary>;
  scripts: {
    catalog: ReadonlyArray<ScriptMeta>;
    invocations: ReadonlyArray<ScriptInvocationSummary>;
  };
  pendingApprovals: ReadonlyArray<PendingApproval>;
  awaitingClient: number;
};

export type ProtocolScriptState = ScriptInvocationSummary & {
  logs: ReadonlyArray<string>;
  entries: ReadonlyArray<ScriptInvocationEntry>;
  threadYields: Readonly<Record<ThreadId, ScriptThreadResult>>;
};

export type ProtocolGlobalState = {
  sessions: ReadonlyArray<{
    id: SessionId;
    title?: string;
    threadCount: number;
    running: number;
  }>;
};

export function submissionResult(
  result: SubmissionResult,
): ProtocolSubmissionResult {
  return result.type === "failed"
    ? { type: "failed", error: { message: result.error.message } }
    : result;
}

function optionalResult(
  result: SubmissionResult | undefined,
): ProtocolSubmissionResult | undefined {
  return result ? submissionResult(result) : undefined;
}

export function runState(state: ThreadState): ProtocolRunState {
  switch (state.type) {
    case "idle":
    case "destroyed":
      return { type: state.type, lastResult: optionalResult(state.lastResult) };
    case "yielded":
      return {
        type: "yielded",
        value: state.value,
        ...(state.resultPrefix ? { resultPrefix: state.resultPrefix } : {}),
      };
    case "running": {
      const { activity } = state;
      let projected: ProtocolActivity;
      switch (activity.type) {
        case "preparing":
          projected = { type: "preparing" };
          break;
        case "streaming":
          projected = {
            type: "streaming",
            startedAt: activity.startedAt.getTime(),
            lastEventTime: activity.lastEventTime.getTime(),
            block: activity.block,
            retry: activity.retry && {
              attempt: activity.retry.attempt,
              nextRetryAt: activity.retry.nextRetryAt.getTime(),
              error: { message: activity.retry.error.message },
            },
          };
          break;
        case "running_tools":
          projected = {
            type: "running_tools",
            requested: activity.requested,
            tools:
              activity.tools.type === "running"
                ? {
                    type: "running",
                    toolRequestIds: [...activity.tools.activeTools.keys()],
                  }
                : { type: activity.tools.type },
          };
          break;
      }
      return { type: "running", aborting: state.aborting, activity: projected };
    }
  }
}

function toolStates(thread: Thread): Record<ToolRequestId, ToolState> {
  const tools: Record<ToolRequestId, ToolState> = {};
  for (const [id, info] of thread.completedTools) {
    tools[id] = {
      request: info.request,
      status: "done",
      result: info.result,
      ...(info.structuredResult
        ? { structuredResult: info.structuredResult }
        : {}),
    };
  }
  const state = thread.state;
  if (
    state.type === "running" &&
    state.activity.type === "running_tools" &&
    state.activity.tools.type === "running"
  ) {
    for (const [id, entry] of state.activity.tools.activeTools) {
      if (tools[id]) continue;
      tools[id] = {
        request: entry.request,
        status: "running",
        progress: entry.progress,
      };
    }
  }
  return tools;
}

export function threadState(
  thread: Thread,
  compactor: ThreadCompactor | undefined,
  session: Session,
): ProtocolThreadState {
  const contextFiles: TrackedContextFile[] = Object.entries(
    thread.contextFiles.files,
  ).map(([absFilePath, file]) => {
    const { lastStat, ...rest } = file;
    return {
      absFilePath: absFilePath as AbsFilePath,
      ...rest,
      ...(lastStat ? { lastStat } : {}),
    };
  });
  const contextDeliveries: Record<NativeMessageIdx, ContextDelivery> = {};
  for (const [idx, delivery] of thread.contextDeliveries) {
    contextDeliveries[idx] = delivery;
  }
  return {
    id: thread.id,
    ...(thread.title !== undefined ? { title: thread.title } : {}),
    threadType: thread.threadType,
    projectDir: thread.systemInfo.projectDir,
    run: runState(thread.state),
    messages: thread.getProviderMessages(),
    tools: toolStates(thread),
    queued: thread.queued,
    ...(thread.latestUsage ? { latestUsage: thread.latestUsage } : {}),
    systemPrompt: thread.systemPrompt,
    lastStopTokenCount: thread.getLastStopTokenCount(),
    toolSpecs: thread.toolSpecs,
    contextFiles,
    pendingContextUpdates: thread.contextFiles.getPendingUpdates(),
    contextDeliveries,
    editedFileGroups: thread.editedFileGroups,
    compaction: { runs: compactor?.runs ?? [] },
    derived: {
      forks: session.listDerived(thread.id, "fork").map((d) => d.threadId),
      reflections: session
        .listDerived(thread.id, "reflect")
        .map((d) => d.threadId),
    },
  };
}

function violationPrompt(violation: SandboxViolation): PendingApprovalPrompt {
  return {
    kind: "violation",
    command: violation.command,
    violations: deduplicateViolations(violation.violations),
    stderr: violation.stderr,
  };
}

export function pendingApproval(
  threadId: ThreadId,
  entry: PendingViolation,
): PendingApproval {
  const { prompt } = entry;
  let projected: PendingApprovalPrompt;
  switch (prompt.kind) {
    case "approval-prompt":
      projected = { kind: "approval-prompt", command: prompt.command };
      break;
    case "violation":
      projected = violationPrompt(prompt.violation);
      break;
    case "write-approval":
      projected = { kind: "write-approval", absPath: prompt.absPath };
      break;
    case "network-access":
      projected = {
        kind: "network-access",
        host: prompt.host,
        ...(prompt.port !== undefined ? { port: prompt.port } : {}),
      };
      break;
  }
  return { id: entry.id, threadId, prompt: projected };
}

function invocationSummary(
  invocation: ScriptInvocation,
): ScriptInvocationSummary {
  const { logs: _logs, entries: _entries, ...summary } = invocation;
  return summary;
}

export function sessionState(
  session: Session,
  scripts: ScriptManager | undefined,
): ProtocolSessionState {
  const records = session.listThreads();
  const threads = records.map((record): SessionThreadSummary => {
    const teardownMessage = session.teardownMessages.get(record.id);
    const title =
      record.state === "initialized"
        ? record.thread.title
        : record.options.label;
    const base = {
      id: record.id,
      ...(record.parentThreadId
        ? { parentThreadId: record.parentThreadId }
        : {}),
      ...(record.scriptInvocationId
        ? { scriptInvocationId: record.scriptInvocationId }
        : {}),
      ...(record.origin ? { origin: record.origin } : {}),
      rootAncestorId: session.getRootAncestorId(record.id),
      lastActivityTime: record.lastActivityTime,
      ...(title !== undefined ? { title } : {}),
      threadType: record.options.threadType,
      profileName: record.options.profile.name,
      ...(record.options.environmentConfig
        ? { environment: record.options.environmentConfig }
        : {}),
      sandboxBypassed: session.isSandboxBypassed(record.id),
      ...(teardownMessage !== undefined ? { teardownMessage } : {}),
    };
    switch (record.state) {
      case "pending":
        return { ...base, state: "pending" };
      case "error":
        return {
          ...base,
          state: "error",
          error: { message: record.error.message },
        };
      default:
        return { ...base, state: "ready", run: runState(record.thread.state) };
    }
  });
  const pendingApprovals = records.flatMap((record) =>
    [...session.getPendingApprovals(record.id).values()].map((entry) =>
      pendingApproval(record.id, entry),
    ),
  );
  return {
    id: session.id,
    activeProfile: session.getProfileSelection(),
    threads,
    scripts: {
      catalog: scripts?.getCatalog() ?? [],
      invocations: (scripts?.listInvocations() ?? []).map(invocationSummary),
    },
    pendingApprovals,
    awaitingClient: session.awaitingClient,
  };
}

export function scriptState(
  scripts: ScriptManager,
  invocationId: ScriptInvocationId,
): ProtocolScriptState | undefined {
  const invocation = scripts.getInvocation(invocationId);
  if (!invocation) return undefined;
  const threadYields: Record<ThreadId, ScriptThreadResult> = {};
  for (const threadId of invocation.threadIds) {
    const result = scripts.getThreadYield(threadId);
    if (result) threadYields[threadId] = result;
  }
  return {
    ...invocationSummary(invocation),
    logs: invocation.logs,
    entries: invocation.entries,
    threadYields,
  };
}

export function globalState(session: Session): ProtocolGlobalState {
  const threads = session.listThreads();
  return {
    sessions: [
      {
        id: session.id,
        threadCount: threads.length,
        running: threads.filter(
          (t) => t.state === "initialized" && t.thread.isBusy,
        ).length,
      },
    ],
  };
}
