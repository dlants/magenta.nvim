import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import {
  Agent,
  type AgentContext,
  type AgentPhase,
  type ThreadState,
} from "./agent.ts";
import type { ThreadId, ThreadType } from "./chat-types.ts";
import type { Logger } from "./logger.ts";
import type { ProviderProfile } from "./provider-options.ts";
import {
  AnthropicInferenceManager,
  type AnthropicRunnerOptions,
} from "./providers/anthropic-runner.ts";
import {
  MockAnthropicClient,
  type MockStream,
} from "./providers/mock-anthropic-client.ts";
import { MockOpenAIClient } from "./providers/mock-openai-client.ts";
import {
  OpenAIInferenceManager,
  type OpenAIRunnerOptions,
} from "./providers/openai-runner.ts";
import type {
  AgentInput,
  AgentOptions,
  NativeInferenceManager,
  NativeMessageIdx,
  Provider,
  ProviderToolSpec,
  RequestedTool,
  ToolExecutor,
  ToolOutcome,
} from "./providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./providers/provider-types.ts";
import type { SystemPrompt } from "./providers/system-prompt.ts";
import { type ResolveSubmission, resolveAsText } from "./submission/index.ts";
import { Thread } from "./thread.ts";
import type { AgentHooks, TurnActivity } from "./thread-api.ts";
import { validateInput } from "./tools/helpers.ts";
import type { MCPToolManager } from "./tools/mcp/manager.ts";
import { pollUntil } from "./utils/async.ts";
import { threadConversationLogPath } from "./utils/files.ts";
export const TEST_ARCHIVE_DIR = path.join(os.tmpdir(), "magenta-test-archive");

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  trace: () => {},
} as Logger;

export const defaultAnthropicOptions: AnthropicRunnerOptions = {
  authType: "max",
  includeWebSearch: false,
  disableParallelToolUseFlag: true,
  logger: noopLogger,
  validateInput,
};

/** The phase flattened back to one level, so a test can assert on
 * `streaming` / `running_tools` without unwrapping `running` every time. The
 * nesting itself is asserted directly in `agent.test.ts`. */
export function flatPhase(agent: {
  phase: AgentPhase;
}): TurnActivity | Exclude<AgentPhase, { type: "running" }> {
  const phase = agent.phase;
  return phase.type === "running" ? phase.activity : phase;
}

export function createMockProvider(
  mockClient: MockAnthropicClient,
  anthropicOptions?: Partial<AnthropicRunnerOptions>,
): Provider {
  return {
    createAgent(options: AgentOptions): NativeInferenceManager {
      return new AnthropicInferenceManager(
        options,
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

/** The stubbed context every test agent shares. */
function baseTestContext(provider: Provider): AgentContext {
  return {
    logger: noopLogger,
    profile: {
      provider: "mock",
      model: "claude-3-5-sonnet-20241022",
    } as ProviderProfile,
    cwd: "/tmp" as AgentContext["cwd"],
    homeDir: "/home" as AgentContext["homeDir"],
    threadType: "root" as ThreadType,
    systemPrompt: "test system prompt" as unknown as SystemPrompt,
    systemInfo: {
      timestamp: "Mon Jan 01 2024 00:00:00 GMT+0000",
      platform: "linux",
      neovimVersion: "0.10.0",
      cwd: "/tmp" as AgentContext["cwd"],
    },
    mcpToolManager: stub<MCPToolManager>({
      serverMap: {},
      getToolSpecs: () => [],
    }),
    threadManager: stub<AgentContext["threadManager"]>({}),
    fileIO: stub<AgentContext["fileIO"]>({
      readFile: async () => "",
      writeFile: async () => {},
      fileExists: async () => false,
    }),
    shell: stub<AgentContext["shell"]>({}),
    gitClient: stub<AgentContext["gitClient"]>({
      getState: async () => undefined,
    }),
    lspClient: stub<AgentContext["lspClient"]>({}),
    availableCapabilities: new Set(),
    environmentConfig: { type: "local" },
    maxConcurrentSubagents: 1,
    maxConcurrentFastSubagents: 8,
    getAgents: () => ({}),
    getProvider: () => provider,
    contextTracker: { files: {} },
  };
}

/** Fill in the hook points a test does not care about. */
export function agentHooks(partial: Partial<AgentHooks> = {}): AgentHooks {
  return {
    onBeforeRequest: [],
    onToolResults: [],
    onYield: [],
    ...partial,
  };
}

export function createAgentWithMock(
  overrides?: Partial<AgentContext>,
  threadId: ThreadId = "test-thread" as ThreadId,
  resolve?: ResolveSubmission,
  onUpdate?: () => void,
): {
  core: Thread;
  mockClient: MockAnthropicClient;
  context: AgentContext;
} {
  const mockClient = new MockAnthropicClient();
  const provider = createMockProvider(mockClient);
  const context: AgentContext = {
    ...baseTestContext(provider),
    ...overrides,
  };

  return {
    core: new Thread(
      threadId,
      context,
      { onUpdate: onUpdate ?? (() => {}), resolve: resolve ?? resolveAsText },
      { type: "fresh" },
      {
        baseDir: TEST_ARCHIVE_DIR,
      },
    ),
    mockClient,
    context,
  };
}

/** What every test agent can vary, whichever provider backs it. */
type TestAgentOpts = {
  onUpdate?: () => void;
  getHooks?: () => AgentHooks;
  context?: Partial<AgentContext>;
  /** Stand in for real tool execution. Tests about the loop's handling of
   * tool outcomes supply this instead of wiring up real tools. */
  executeTools?: ToolExecutor;
  /** Build on a copy of an existing conversation instead of a fresh one. */
  cloneFrom?: NativeInferenceManager;
};

function buildTestAgent(provider: Provider, opts: TestAgentOpts): Agent {
  const context: AgentContext = {
    ...baseTestContext(provider),
    ...opts.context,
  };
  const state: ThreadState = {
    title: undefined,
    threadType: context.threadType,
    systemPrompt: context.systemPrompt,
    systemInfo: context.systemInfo,
    edlRegisters: { registers: new Map(), nextSavedId: 0 },
    editedFilesThisTurn: [],
    lastTurnResult: undefined,
    toolSpecs: [],
  };
  const executeTools = opts.executeTools;
  const AgentClass = executeTools
    ? class extends Agent {
        protected override executeTools(
          requests: ReadonlyArray<RequestedTool>,
        ): Promise<ToolOutcome> {
          return executeTools(requests);
        }
      }
    : Agent;
  return new AgentClass(context, {
    threadId: "test-agent" as ThreadId,
    state,
    structuredToolResults: new Map(),
    getHooks: opts.getHooks ?? (() => agentHooks()),
    onUpdate: opts.onUpdate ?? (() => {}),
    runnerInit: opts.cloneFrom
      ? {
          type: "cloned",
          cloneFrom: opts.cloneFrom,
          truncateTo: (opts.cloneFrom.log.messages.length -
            1) as NativeMessageIdx,
        }
      : { type: "new" },
  });
}

/** An `Agent` on a mock anthropic client, with no thread around it: the
 * harness for the turn loop itself. */
export function createTestAgent(
  opts?: TestAgentOpts & {
    anthropicOptions?: Partial<AnthropicRunnerOptions>;
    /** Share a client with another agent, so a test can watch one stream of
     * requests across both. */
    mockClient?: MockAnthropicClient;
  },
): { agent: Agent; mockClient: MockAnthropicClient } {
  const mockClient = opts?.mockClient ?? new MockAnthropicClient();
  const provider = createMockProvider(mockClient, opts?.anthropicOptions);
  return { agent: buildTestAgent(provider, opts ?? {}), mockClient };
}

export const defaultOpenAIOptions: OpenAIRunnerOptions = {
  includeWebSearch: false,
  logger: noopLogger,
  validateInput,
};

/** The same harness over the openai manager. Both providers are driven by the
 * one loop in `Agent`, so the two differ only in which client is mocked. */
export function createTestOpenAIAgent(
  opts?: TestAgentOpts & {
    openaiOptions?: Partial<OpenAIRunnerOptions>;
    mockClient?: MockOpenAIClient;
    tools?: ProviderToolSpec[];
  },
): { agent: Agent; mockClient: MockOpenAIClient } {
  const mockClient = opts?.mockClient ?? new MockOpenAIClient();
  const tools = opts?.tools;
  const provider: Provider = {
    createAgent(options: AgentOptions): NativeInferenceManager {
      return new OpenAIInferenceManager(
        tools ? { ...options, tools } : options,
        mockClient,
        { ...defaultOpenAIOptions, ...opts?.openaiOptions },
      );
    },
    forceToolUse() {
      throw new Error("Not implemented in mock");
    },
  };
  return {
    agent: buildTestAgent(provider, {
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
  { type: "text", text, nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX },
];

export async function cleanupArchive(threadId: ThreadId): Promise<void> {
  const dir = path.dirname(
    threadConversationLogPath(threadId, TEST_ARCHIVE_DIR),
  );
  await fs.rm(dir, { recursive: true, force: true });
}

/** The text of every user message in the log, flattened. */
export const userTexts = (core: Thread): string[] =>
  core
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
