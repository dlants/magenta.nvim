// biome-ignore-all lint/complexity/useLiteralKeys: White-box lifecycle helpers deliberately access private implementation state.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ThreadId, ThreadType } from "./chat-types.ts";
import type { Compactor } from "./compaction/index.ts";
import type { EdlRegisters } from "./edl/index.ts";
import type { Logger } from "./logger.ts";
import type { ThreadLoopState } from "./loop-state.ts";
import type { ProviderProfile } from "./provider-options.ts";
import { anthropicInferenceOptions } from "./providers/anthropic.ts";
import {
  AnthropicInferenceManager,
  type AnthropicInferenceOptions,
} from "./providers/anthropic-inference.ts";
import { ABORT_MARKER_TEXT } from "./providers/inference-shared.ts";
import {
  MockAnthropicClient,
  type MockStream,
} from "./providers/mock-anthropic-client.ts";
import { MockOpenAIClient } from "./providers/mock-openai-client.ts";
import { openaiInferenceOptions } from "./providers/openai.ts";
import {
  OpenAIInferenceManager,
  type OpenAIInferenceOptions,
} from "./providers/openai-inference.ts";
import type {
  AgentInput,
  CreateInferenceManagerOptions,
  NativeInferenceManager,
  NativeMessageIdx,
  Provider,
  ProviderMessage,
  ProviderToolSpec,
} from "./providers/provider-types.ts";
import type { SystemPrompt } from "./providers/system-prompt.ts";
import { type ResolveSubmission, resolveAsText } from "./submission/index.ts";
import type { FileSupervisor } from "./supervisors/file-supervisor.ts";
import { type ContextDelivery, Thread, type ThreadContext } from "./thread.ts";
import type { CoreLoopResult, RestResult, YieldValue } from "./thread-api.ts";
import { archiveThread } from "./thread-logger.ts";
import { executeToolBatch } from "./tool-executor.ts";
import {
  type LoopState,
  runToolLoop,
  type ToolExecution,
  type ToolExecutor,
  type ToolLoop,
  type ToolLoopDeps,
  type ToolOutcome,
} from "./tool-loop.ts";
import type { ClientToolContext } from "./tools/create-tool.ts";
import { clientToolCreator } from "./tools/create-tool.ts";
import { validateInput } from "./tools/helpers.ts";
import type { MCPToolManager } from "./tools/mcp/manager.ts";
import { getToolSpecs } from "./tools/toolManager.ts";
import { pollUntil } from "./utils/async.ts";
import { threadConversationLogPath } from "./utils/files.ts";
/** Wrap a plain promise as a `ToolExecution`, for the many test executors that
 * are never aborted. */
export function toolExecution(
  promise: Promise<ToolOutcome> | ToolOutcome,
): ToolExecution {
  return { promise: Promise.resolve(promise), abort: () => {} };
}
export const TEST_ARCHIVE_DIR = path.join(os.tmpdir(), "magenta-test-archive");

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  trace: () => {},
} as Logger;

export const defaultAnthropicOptions: AnthropicInferenceOptions = {
  authType: "max",
  includeWebSearch: false,
  disableParallelToolUseFlag: true,
  logger: noopLogger,
  validateInput,
};

/** The loop state flattened back to one level, so a test can assert on
 * `streaming` / `running_tools` without unwrapping `running` every time. The
 * nesting itself is asserted directly in `agent.test.ts`. How the last
 * submission ended is dropped: this is "what is the loop doing", and
 * `lastResult` is asserted on its own. */
export function flatLoop(owner: {
  loopState: ThreadLoopState;
}): LoopState | { type: "idle" } {
  const state = owner.loopState;
  return state.type === "running" ? state.activity : { type: "idle" };
}

/** Thread turns a suspension it cannot claim into a `suspended` result; the bare
 * harness has no owner to claim one, so it does the same. A `yield` suspension
 * is Thread's alone and has no rest-shaped form here. */
function restResult(
  result: CoreLoopResult | undefined,
): RestResult | undefined {
  if (result?.type === "completed") {
    const { stopReason } = result;
    return stopReason === "context_budget"
      ? undefined
      : { type: "completed", stopReason };
  }
  if (result?.type !== "suspended") return result;
  return result.reason.kind === "yield"
    ? undefined
    : { type: "suspended", reason: result.reason };
}
/** The bare-agent harness's stand-in for the thread: it owns the loop state
 * the same way, so what a test observes is what production observes. */
export class TestAgent {
  readonly manager: NativeInferenceManager;

  constructor(private deps: ToolLoopDeps) {
    this.manager = deps.manager;
  }

  get loopState(): ThreadLoopState {
    return this.turn
      ? {
          type: "running",
          activity: this.turn.loopState,
          aborting: this.turn.loopState.aborting,
        }
      : { type: "idle", lastResult: restResult(this.lastResult) };
  }

  getProviderMessages(): ReadonlyArray<ProviderMessage> {
    return this.manager.log.messages;
  }

  send(messages?: AgentInput[]): ToolLoop {
    const turn = runToolLoop(this.deps, messages);
    this.turn = turn;
    const promise = turn.promise.then(
      (result) => {
        // Mirrors ThreadCore's abort bookkeeping around the turn.
        if (result.type === "aborted") {
          this.manager.appendUserMessage([
            {
              type: "text",
              text: ABORT_MARKER_TEXT,
            },
          ]);
        }
        if (this.turn === turn) {
          this.turn = undefined;
          this.lastResult = result;
          this.deps.onUpdate?.();
        }
        return result;
      },
      (error: unknown) => {
        if (this.turn === turn) {
          this.turn = undefined;
          this.lastResult = {
            type: "failed",
            error: error instanceof Error ? error : new Error(String(error)),
          };
        }
        throw error;
      },
    );
    return {
      get loopState() {
        return turn.loopState;
      },
      abort: () => turn.abort(),
      promise,
    };
  }

  private turn: ToolLoop | undefined;
  private lastResult: CoreLoopResult | undefined;

  /** What `Thread.abort` does, for the tests that drive an agent without one:
   * mark the loop and wind the turn down through its handle. */
  async abortAndWait(): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    turn.abort();
    await turn.promise.catch(() => {});
  }
}

export function createMockProvider(
  mockClient: MockAnthropicClient,
  anthropicOptions?: Partial<AnthropicInferenceOptions>,
): Provider {
  return {
    createInferenceManager(
      options: CreateInferenceManagerOptions,
    ): NativeInferenceManager {
      return new AnthropicInferenceManager(
        anthropicInferenceOptions(options),
        mockClient as unknown as Anthropic,
        { ...defaultAnthropicOptions, ...anthropicOptions },
      );
    },
    forceToolUse() {
      throw new Error("Not implemented in mock");
    },
  };
}

/** Wait for a stream other than `prev`. `awaitStream` returns the most recent
 * stream, which is still the previous one until the next submission has been
 * issued — and `send` now resolves at rest rather than at issue time. */
export function awaitNextStream(
  mockClient: MockAnthropicClient,
  prev: MockStream | undefined,
): Promise<MockStream> {
  return pollUntil(() => {
    const stream = mockClient.streams[mockClient.streams.length - 1];
    if (stream && stream !== prev && !stream.aborted) return stream;
    throw new Error("waiting for a new stream");
  });
}

/** A partial test double, checked field-by-field against the real interface:
 * the names and types of what is supplied must still line up, so a change to
 * the interface surfaces here rather than being swallowed by a cast. */
function stub<T>(partial: Partial<T>): T {
  return partial as T;
}

/** Tests vary thread-level and tool-level collaborators in one bag; which
 * layer a name belongs to is decided here, not at the call site. */
export type TestContextOverrides = Partial<ThreadContext> &
  Partial<ClientToolContext>;

/** The stubbed context every test agent shares. */
function baseTestContext(
  provider: Provider,
  overrides: TestContextOverrides = {},
): ThreadContext {
  const base = {
    resolve: resolveAsText,
    logger: noopLogger,
    profile: {
      provider: "mock",
      model: "claude-3-5-sonnet-20241022",
    } as ProviderProfile,
    cwd: "/tmp" as ThreadContext["cwd"],
    homeDir: "/home" as ThreadContext["homeDir"],
    threadType: "root" as ThreadType,
    systemPrompt: "test system prompt" as unknown as SystemPrompt,
    systemInfo: {
      timestamp: "Mon Jan 01 2024 00:00:00 GMT+0000",
      platform: "linux",
      neovimVersion: "0.10.0",
      cwd: "/tmp" as ThreadContext["cwd"],
    },
    mcpToolManager: stub<MCPToolManager>({
      serverMap: {},
      getToolSpecs: () => [],
    }),
    threadManager: stub<ThreadContext["threadManager"]>({}),
    fileIO: stub<ThreadContext["fileIO"]>({
      readFile: async () => "",
      writeFile: async () => {},
      fileExists: async () => false,
      stat: async () => undefined,
    }),
    gitClient: stub<ThreadContext["gitClient"]>({
      getState: async () => undefined,
    }),
    availableCapabilities: new Set(),
    environmentConfig: { type: "local" },
    getAgents: () => ({}),
    provider,
  } satisfies Omit<ThreadContext, "clientToolCreator">;
  const context = { ...base, ...overrides };
  const clientTools: ClientToolContext = {
    logger: context.logger,
    lspClient: stub<ClientToolContext["lspClient"]>({}),
    mcpToolManager: context.mcpToolManager,
    cwd: context.cwd,
    homeDir: context.homeDir,
    maxConcurrentSubagents: 1,
    maxConcurrentFastSubagents: 8,
    fileIO: context.fileIO,
    shell: stub<ClientToolContext["shell"]>({}),
    threadManager: context.threadManager,
    getAgents: context.getAgents,
    ...overrides,
  };
  return { ...context, clientToolCreator: clientToolCreator(clientTools) };
}

/** Fork a thread with an archive attached, the way assembly does in
 * production. */
export function cloneThread(args: Parameters<typeof Thread.clone>[0]): Thread {
  return archiveThread({
    logger: args.context.logger,
    callbacks: args.callbacks,
    build: (callbacks) => Thread.clone({ ...args, callbacks }),
  }).thread;
}

export function createAgentWithMock(
  overrides?: TestContextOverrides,
  threadId: ThreadId = "test-thread" as ThreadId,
  resolve?: ResolveSubmission,
  onUpdate?: () => void,
): {
  core: Thread;
  mockClient: MockAnthropicClient;
  context: ThreadContext;
} {
  const mockClient = new MockAnthropicClient();
  const provider = createMockProvider(mockClient);
  const context = baseTestContext(provider, {
    ...overrides,
    ...(resolve ? { resolve } : {}),
  });

  return {
    core: archiveThread({
      logger: context.logger,
      callbacks: { onUpdate: onUpdate ?? (() => {}) },
      build: (callbacks) =>
        new Thread(threadId, context, callbacks, {
          baseDir: TEST_ARCHIVE_DIR,
        }),
    }).thread,
    mockClient,
    context,
  };
}

/** What every test agent can vary, whichever provider backs it. */
type TestAgentOpts = {
  onUpdate?: () => void;
  onBeforeRequest?: ToolLoopDeps["onBeforeRequest"];
  checkBudget?: ToolLoopDeps["checkBudget"];
  onToolResults?: ToolLoopDeps["onToolResults"];
  context?: TestContextOverrides;
  /** Stand in for real tool execution. Tests about the loop's handling of
   * tool outcomes supply this instead of wiring up real tools. */
  executeTools?: ToolExecutor;
  /** Build on a copy of an existing conversation instead of a fresh one. */
  cloneFrom?: NativeInferenceManager;
};

function testManager(
  context: ThreadContext,
  cloneFrom: NativeInferenceManager | undefined,
): NativeInferenceManager {
  if (!cloneFrom)
    return context.provider.createInferenceManager({
      profile: context.profile,
      systemPrompt: context.systemPrompt,
      tools: getToolSpecs(
        context.threadType,
        context.mcpToolManager,
        context.availableCapabilities,
        context.getAgents(),
        context.subagentConfig,
        context.yieldSchema,
        context.getScriptRunner?.()?.getScriptCatalog(),
        context.subagentDockerfile,
      ),
      ...(context.subagentConfig?.effort
        ? { effortOverride: context.subagentConfig.effort }
        : {}),
    });
  const manager = cloneFrom.clone();
  manager.truncateMessages(
    (cloneFrom.log.messages.length - 1) as NativeMessageIdx,
  );
  return manager;
}

function buildTestAgent(
  provider: Provider,
  opts: TestAgentOpts,
): { agent: TestAgent } {
  const context = baseTestContext(provider, opts.context);
  const edlRegisters: EdlRegisters = { registers: new Map(), nextSavedId: 0 };
  const manager = testManager(context, opts.cloneFrom);
  // The bare-agent harness stands in for the thread: it owns tool execution
  // the same way, so the loop under test sees production wiring.
  const deps = {
    completedTools: new Map(),
    onUpdate: opts.onUpdate ?? (() => {}),
    createTool: context.clientToolCreator({
      threadId: "test-agent" as ThreadId,
    })({
      contextTracker: { files: context.initialFiles ?? {} },
      onToolApplied: () => {},
      edlRegisters,
      requestRender: () => {},
    }),
  };
  const executeTools: ToolExecutor =
    opts.executeTools ??
    ((requests, publishTools) =>
      executeToolBatch(requests, { ...deps, publishTools }));
  const agent = new TestAgent({
    logger: context.logger,
    manager,
    executeTools,
    onBeforeRequest: opts.onBeforeRequest ?? (() => Promise.resolve([])),
    checkBudget:
      opts.checkBudget ?? (() => Promise.resolve({ type: "proceed" })),
    onToolResults: opts.onToolResults ?? (() => undefined),
    onUpdate: opts.onUpdate ?? (() => {}),
  });
  return { agent };
}

/** An `Agent` on a mock anthropic client, with no thread around it: the
 * harness for the turn loop itself. */
export function createTestAgent(
  opts?: TestAgentOpts & {
    anthropicOptions?: Partial<AnthropicInferenceOptions>;
    /** Share a client with another agent, so a test can watch one stream of
     * requests across both. */
    mockClient?: MockAnthropicClient;
  },
): {
  agent: TestAgent;
  mockClient: MockAnthropicClient;
} {
  const mockClient = opts?.mockClient ?? new MockAnthropicClient();
  const provider = createMockProvider(mockClient, opts?.anthropicOptions);
  return { ...buildTestAgent(provider, opts ?? {}), mockClient };
}

export const defaultOpenAIOptions: OpenAIInferenceOptions = {
  includeWebSearch: false,
  logger: noopLogger,
  validateInput,
};

/** The same harness over the openai manager. Both providers are driven by the
 * same `runToolLoop`, so the two differ only in which client is mocked. */
export function createTestOpenAIAgent(
  opts?: TestAgentOpts & {
    openaiOptions?: Partial<OpenAIInferenceOptions>;
    mockClient?: MockOpenAIClient;
    tools?: ProviderToolSpec[];
  },
): {
  agent: TestAgent;
  mockClient: MockOpenAIClient;
} {
  const mockClient = opts?.mockClient ?? new MockOpenAIClient();
  const tools = opts?.tools;
  const provider: Provider = {
    createInferenceManager(
      options: CreateInferenceManagerOptions,
    ): NativeInferenceManager {
      return new OpenAIInferenceManager(
        openaiInferenceOptions(tools ? { ...options, tools } : options),
        mockClient,
        { ...defaultOpenAIOptions, ...opts?.openaiOptions },
      );
    },
    forceToolUse() {
      throw new Error("Not implemented in mock");
    },
  };
  return {
    ...buildTestAgent(provider, {
      ...opts,
      context: {
        profile: stub<ProviderProfile>({
          provider: "openai",
          model: "gpt-5.4",
        }),
        ...opts?.context,
      },
    }),
    mockClient,
  };
}

/** One turn's worth of user input. */
export const userInput = (text: string): AgentInput[] => [
  { type: "text", text },
];

/** Drive one turn through the agent's only entry point. */
export const sendText = (
  agent: TestAgent,
  text: string,
): Promise<CoreLoopResult> => agent.send([{ type: "text", text }]).promise;

export async function cleanupArchive(threadId: ThreadId): Promise<void> {
  const dir = path.dirname(
    threadConversationLogPath(threadId, TEST_ARCHIVE_DIR),
  );
  await fs.rm(dir, { recursive: true, force: true });
}

/** The text of every user message in the log, flattened. */
export const userTexts = (thread: Thread): string[] =>
  thread
    .getProviderMessages()
    .filter((m) => m.role === "user")
    .flatMap((m) =>
      typeof m.content === "string"
        ? [m.content]
        : m.content
            .filter((c) => c.type === "text")
            .map((c) => (c as { text: string }).text),
    );

export function uniqueThreadId(prefix: string): ThreadId {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}` as ThreadId;
}

/** Delivery and event assertions need the actual supervisor, not ContextFileAccess. */
export function getFileSupervisor(thread: Thread): FileSupervisor {
  return thread["core"].fileSupervisor;
}

/** Administrative resets are test fixtures, not part of Thread's parent API. */
/** The context deliveries the thread's current core has recorded. Retired
 * cores keep their own, so this observes only the live generation. */
export function getContextDeliveries(thread: Thread): ContextDelivery[] {
  return [...thread["core"]["contextDeliveries"].values()];
}
/** Stand a thread up in the terminal state an accepted, torn-down yield
 * leaves behind, without driving a whole yield + teardown. */
export function markTornDownYield(thread: Thread, value: YieldValue): void {
  thread["status"] = { type: "yielded", value };
  thread["tornDownState"] = true;
}
export function resetThread(
  thread: Thread,
  options: Parameters<Thread["replaceCore"]>[0],
) {
  const inFlight = thread["inFlight"];
  if (inFlight) void inFlight.abort();
  // Only the live submission is dropped: a settled yield outlives a reset.
  if (thread["status"].type === "running")
    thread["status"] = { type: "idle", lastResult: undefined };
  // A delivery still resolving loses its claim on the untouched entries.
  thread["mailbox"].restoreCheckout();
  return thread["replaceCore"](options);
}

/** Installs a test compactor while keeping any budget already configured:
 * `compactorSlot(thread).compactor = { run }`. */
export function compactorSlot(thread: Thread): { compactor: Compactor } {
  return {
    set compactor(compactor: Compactor) {
      thread["context"].compaction = {
        ...thread["context"].compaction,
        compactor,
      };
    },
    get compactor(): Compactor {
      const compactor = thread["context"].compaction?.compactor;
      if (!compactor) throw new Error("no compactor installed");
      return compactor;
    },
  };
}
