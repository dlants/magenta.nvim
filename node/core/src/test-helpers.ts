import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentContext } from "./agent.ts";
import type { ThreadId, ThreadType } from "./chat-types.ts";
import type { Logger } from "./logger.ts";
import type { ProviderProfile } from "./provider-options.ts";
import {
  AnthropicRunner,
  type AnthropicRunnerOptions,
} from "./providers/anthropic-runner.ts";
import {
  MockAnthropicClient,
  type MockStream,
} from "./providers/mock-anthropic-client.ts";
import type {
  AgentOptions,
  Provider,
  Runner,
} from "./providers/provider-types.ts";
import type { SystemPrompt } from "./providers/system-prompt.ts";
import { type ResolveSubmission, resolveAsText } from "./submission/index.ts";
import { Thread } from "./thread.ts";
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

export function createMockProvider(mockClient: MockAnthropicClient): Provider {
  return {
    createAgent(options: AgentOptions): Runner {
      return new AnthropicRunner(
        options,
        mockClient as unknown as Anthropic,
        defaultAnthropicOptions,
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

export function createAgentWithMock(
  overrides?: Partial<AgentContext>,
  threadId: ThreadId = "test-thread" as ThreadId,
  resolve?: ResolveSubmission,
): {
  core: Thread;
  mockClient: MockAnthropicClient;
  context: AgentContext;
} {
  const mockClient = new MockAnthropicClient();
  const provider = createMockProvider(mockClient);
  const context: AgentContext = {
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
    ...overrides,
  };

  return {
    core: new Thread(
      threadId,
      context,
      { onUpdate: () => {}, resolve: resolve ?? resolveAsText },
      { type: "fresh" },
      {
        baseDir: TEST_ARCHIVE_DIR,
      },
    ),
    mockClient,
    context,
  };
}

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
