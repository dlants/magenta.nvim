import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { Agent, type AgentContext, type ThreadState } from "./agent.ts";
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
import type {
  AgentInput,
  AgentOptions,
  NativeInferenceManager,
  NativeMessageIdx,
  Provider,
  RequestedTool,
  ToolExecutor,
  ToolOutcome,
} from "./providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./providers/provider-types.ts";
import type { SystemPrompt } from "./providers/system-prompt.ts";
import { type ResolveSubmission, resolveAsText } from "./submission/index.ts";
import { Thread } from "./thread.ts";
import type { AgentHooks } from "./thread-api.ts";
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

/** An `Agent` on a mock client, with no thread around it: the harness for the
 * turn loop itself. */
export function createTestAgent(opts?: {
  onUpdate?: () => void;
  getHooks?: () => AgentHooks;
  context?: Partial<AgentContext>;
  anthropicOptions?: Partial<AnthropicRunnerOptions>;
  /** Stand in for real tool execution. Tests about the loop's handling of
   * tool outcomes supply this instead of wiring up real tools. */
  executeTools?: ToolExecutor;
  /** Share a client with another agent, so a test can watch one stream of
   * requests across both. */
  mockClient?: MockAnthropicClient;
  /** Build on a copy of an existing conversation instead of a fresh one. */
  cloneFrom?: NativeInferenceManager;
}): { agent: Agent; mockClient: MockAnthropicClient } {
  const mockClient = opts?.mockClient ?? new MockAnthropicClient();
  const provider = createMockProvider(mockClient, opts?.anthropicOptions);
  const context: AgentContext = {
    ...baseTestContext(provider),
    ...opts?.context,
  };
  const state: ThreadState = {
    title: undefined,
    threadType: context.threadType,
    systemPrompt: context.systemPrompt,
    systemInfo: context.systemInfo,
    mode: { type: "normal" },
    edlRegisters: { registers: new Map(), nextSavedId: 0 },
    editedFilesThisTurn: [],
    lastTurnResult: undefined,
    toolSpecs: [],
  };
  const executeTools = opts?.executeTools;
  const AgentClass = executeTools
    ? class extends Agent {
        protected override executeTools(
          requests: ReadonlyArray<RequestedTool>,
        ): Promise<ToolOutcome> {
          return executeTools(requests);
        }
      }
    : Agent;
  const agent = new AgentClass(context, {
    threadId: "test-agent" as ThreadId,
    state,
    structuredToolResults: new Map(),
    getHooks: opts?.getHooks ?? (() => ({})),
    onUpdate: opts?.onUpdate ?? (() => {}),
    runnerInit: opts?.cloneFrom
      ? {
          type: "cloned",
          cloneFrom: opts.cloneFrom,
          truncateTo: (opts.cloneFrom.log.messages.length -
            1) as NativeMessageIdx,
        }
      : { type: "new" },
  });
  return { agent, mockClient };
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
