import type { AgentsMap } from "../agents/agents.ts";
import type { GitState } from "../capabilities/git-client.ts";
import type { LspClient } from "../capabilities/lsp-client.ts";
import type { LuaExecutor } from "../capabilities/lua-executor.ts";
import type { ThreadId } from "../chat-types.ts";
import {
  autoContextFilesToInitialFiles,
  discoverHierarchyContext,
  resolveAutoContext,
} from "../context/auto-context.ts";
import { buildSystemInfo } from "../context/system-info.ts";
import { InMemoryFileIO } from "../edl/in-memory-file-io.ts";
import type { ProviderProfile } from "../provider-options.ts";
import {
  MockAnthropicClient,
  type MockStream,
} from "../providers/mock-anthropic-client.ts";
import { createSystemPrompt } from "../providers/system-prompt.ts";
import type {
  PreparedThread,
  SessionHost,
  Session as SessionType,
  ThreadPreparation,
} from "../session.ts";
import { Session } from "../session.ts";
import {
  type PendingMessage,
  parseCompact,
  pendingMessage,
  type ResolvedSubmission,
} from "../submission/index.ts";
import {
  awaitNextStream,
  createMockProvider,
  noopLogger,
  TEST_ARCHIVE_DIR,
} from "../test-helpers.ts";
import type { ContextFileAccess, Thread } from "../thread.ts";
import type { RestResult } from "../thread-api.ts";
import type { PreparedThreadContext } from "../thread-assembly.ts";
import { clientToolCreator } from "../tools/create-tool.ts";
import { MCPToolManager } from "../tools/mcp/manager.ts";
import type { MCPServersConfig } from "../tools/mcp/options.ts";
import type { ToolCapability } from "../tools/tool-registry.ts";
import { pollUntil } from "../utils/async.ts";
import {
  detectFileTypeViaFileIO,
  type HomeDir,
  type NvimCwd,
  relativePath,
  resolveFilePath,
  type UnresolvedFilePath,
} from "../utils/files.ts";
import { FakeGitClient, FakeShell, type FakeShellScript } from "./fakes.ts";

export { FakeGitClient, FakeShell, type FakeShellScript } from "./fakes.ts";

export type HarnessThreadOptions = {
  autoCompactThreshold?: number;
  autoCompactPrompt: string;
  autoContext: string[];
  hierarchyContextFileNames: string[];
  maxConcurrentSubagents: number;
  maxConcurrentFastSubagents: number;
  skillsPaths: string[];
  agentsPaths: string[];
};

/** The host's resolver: `@compact` plus `@file:` against the thread's
 * FileIO. Editor commands (`@diag`, `@buf`, ...) have no node-only meaning. */
export type HarnessResolve = (
  message: PendingMessage,
  ctx: {
    host: TestSessionHost;
    getContextFiles: () => ContextFileAccess;
    canCompact: boolean;
  },
) => Promise<ResolvedSubmission>;

export type HarnessOptions = {
  /** abs path -> content, seeds the InMemoryFileIO. */
  files?: Record<string, string>;
  cwd?: string;
  homeDir?: string;
  git?: GitState;
  shell?: FakeShellScript;
  agents?: AgentsMap;
  options?: Partial<HarnessThreadOptions>;
  resolve?: HarnessResolve;
  /** Enables `nvim_lua` (and the "nvim" capability) with a stub executor. */
  luaExecutor?: LuaExecutor;
  /** Real MCPToolManager over the given (e.g. `type: "mock"`) servers. */
  mcpServers?: MCPServersConfig;
};

const FILE_REF = /@file:`([^`]+)`|@file:(\S+)/g;

export const defaultHarnessResolve: HarnessResolve = async (
  message,
  { host, getContextFiles, canCompact },
) => {
  const { compact, rest } = canCompact
    ? parseCompact(message)
    : { compact: false, rest: message };
  for (const match of rest.matchAll(FILE_REF)) {
    const raw = match[1] ?? match[2];
    if (!raw) continue;
    const abs = resolveFilePath(
      host.cwd,
      raw as UnresolvedFilePath,
      host.homeDir,
    );
    const info = await detectFileTypeViaFileIO(abs, host.fileIO);
    if (!info) continue;
    getContextFiles().addFileContext(
      abs,
      relativePath(host.cwd, abs, host.homeDir),
      info,
    );
  }
  const prompt = {
    content: rest.length ? [{ type: "text" as const, text: rest }] : [],
    reminders: [],
  };
  return compact ? { type: "compact", prompt } : { type: "send", prompt };
};

const stubLsp = {} as LspClient;
const emptyMcp = {
  serverMap: {},
  disconnect: () => Promise.resolve(),
  getToolSpecs: () => [],
} as unknown as MCPToolManager;

/** A node-only SessionHost: the same preparation steps as `NvimSessionHost`
 * (auto-context, hierarchy discovery, system info/prompt, fork inheritance,
 * delivery-time resolution) over in-memory collaborators. */
export class TestSessionHost implements SessionHost {
  readonly mockClient = new MockAnthropicClient();
  readonly provider = createMockProvider(this.mockClient);
  readonly fileIO: InMemoryFileIO;
  readonly git: FakeGitClient;
  readonly shell: FakeShell;
  readonly cwd: NvimCwd;
  readonly homeDir: HomeDir;
  readonly profile: ProviderProfile = {
    name: "mock",
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022",
    fastModel: "claude-3-5-haiku-20241022",
    thinkingModel: "claude-3-5-sonnet-20241022",
  } satisfies ProviderProfile;
  options: HarnessThreadOptions;
  agents: AgentsMap;
  resolve: HarnessResolve;
  /** Merged over every prepared context, for tests that vary one collaborator. */
  contextOverrides: Partial<PreparedThreadContext> = {};
  /** Wrap preparation, e.g. to gate or fail it. */
  intercept:
    | ((
        request: ThreadPreparation,
        prepare: () => Promise<PreparedThread>,
      ) => Promise<PreparedThread>)
    | undefined;
  readonly mcp: MCPToolManager;
  readonly luaExecutor: LuaExecutor | undefined;
  readonly rejectedApprovals: ThreadId[] = [];
  rejectApprovals(id: ThreadId): void {
    this.rejectedApprovals.push(id);
  }

  constructor(opts: HarnessOptions = {}) {
    this.cwd = (opts.cwd ?? "/project") as NvimCwd;
    this.homeDir = (opts.homeDir ?? "/home") as HomeDir;
    this.fileIO = new InMemoryFileIO(opts.files ?? {});
    this.git = new FakeGitClient(opts.git);
    this.shell = new FakeShell(opts.shell);
    this.agents = opts.agents ?? {};
    this.resolve = opts.resolve ?? defaultHarnessResolve;
    this.luaExecutor = opts.luaExecutor;
    this.mcp = opts.mcpServers
      ? new MCPToolManager(opts.mcpServers, { logger: noopLogger })
      : emptyMcp;
    this.options = {
      autoCompactThreshold: 100_000,
      autoCompactPrompt: "continue",
      autoContext: [],
      hierarchyContextFileNames: [],
      maxConcurrentSubagents: 3,
      maxConcurrentFastSubagents: 8,
      skillsPaths: [],
      agentsPaths: [],
      ...opts.options,
    };
  }

  getActiveProfile(): ProviderProfile {
    return this.profile;
  }

  getAgents(): AgentsMap {
    return this.agents;
  }

  prepareThread(
    request: ThreadPreparation,
    session: SessionType,
    signal: AbortSignal,
  ): Promise<PreparedThread> {
    signal.throwIfAborted();
    const prepare = () => this.prepare(request, session);
    return this.intercept ? this.intercept(request, prepare) : prepare();
  }

  private async prepare(
    request: ThreadPreparation,
    session: SessionType,
  ): Promise<PreparedThread> {
    const source = request.type === "fork" ? request.source : undefined;
    const {
      threadId: id,
      profile,
      threadType,
      subagentConfig,
    } = request.options;
    const fileIO = request.options.fileIO ?? this.fileIO;
    const { cwd, homeDir } = this;
    const autoContextFiles =
      request.options.fileIO || source
        ? []
        : await resolveAutoContext({
            fileIO,
            logger: noopLogger,
            cwd,
            homeDir,
            globs: this.options.autoContext,
          });
    const initialGitState = source ? undefined : await this.git.getState();
    const systemInfo =
      source?.systemInfo ??
      buildSystemInfo({
        cwd,
        neovimVersion: "0.10.0",
        overrides: { git: initialGitState },
      });
    const systemPrompt =
      source?.systemPrompt ??
      (await createSystemPrompt(threadType, {
        logger: noopLogger,
        cwd,
        options: this.options,
        fileIO,
        homeDir,
        ...(subagentConfig ? { subagentConfig } : {}),
      }));
    const getAgents = () => this.agents;
    const getScriptRunner = () => session.scriptRunner;
    const canCompact = threadType !== "compact";
    const context: PreparedThreadContext = {
      logger: noopLogger,
      profile,
      cwd,
      homeDir,
      initialFiles: autoContextFilesToInitialFiles(autoContextFiles),
      ...(initialGitState ? { initialGitState } : {}),
      ...(subagentConfig ? { subagentConfig } : {}),
      systemPrompt,
      systemInfo,
      mcpToolManager: this.mcp,
      threadManager: session,
      getScriptRunner,
      fileIO,
      gitClient: this.git,
      discoverHierarchy: (absFilePath) =>
        discoverHierarchyContext(absFilePath, {
          fileIO,
          logger: noopLogger,
          cwd,
          homeDir,
          hierarchyContextFileNames: this.options.hierarchyContextFileNames,
        }),
      clientToolCreator: clientToolCreator({
        logger: noopLogger,
        lspClient: stubLsp,
        mcpToolManager: this.mcp,
        cwd,
        homeDir,
        maxConcurrentSubagents: this.options.maxConcurrentSubagents,
        maxConcurrentFastSubagents: this.options.maxConcurrentFastSubagents,
        fileIO,
        shell: this.shell,
        threadManager: session,
        getScriptRunner,
        getAgents,
        luaExecutor: this.luaExecutor,
      }),
      availableCapabilities: new Set<ToolCapability>([
        "file-io",
        "shell",
        "threads",
        ...(this.luaExecutor ? (["nvim"] as const) : []),
      ]),
      environmentConfig: request.options.environmentConfig ?? {
        type: "local",
      },
      ...(request.options.yieldSchema
        ? { yieldSchema: request.options.yieldSchema }
        : {}),
      getAgents,
      provider: this.provider,
      resolve: (message) =>
        this.resolve(message, {
          host: this,
          canCompact,
          getContextFiles: () => {
            const record = session.getThread(id);
            if (record?.state !== "initialized") {
              throw new Error(`Thread ${id} is no longer available`);
            }
            return record.thread.contextFiles;
          },
        }),
      ...this.contextOverrides,
    };
    return {
      context,
      ...(this.options.autoCompactThreshold !== undefined
        ? { autoCompactThreshold: this.options.autoCompactThreshold }
        : {}),
      autoCompactPrompt: this.options.autoCompactPrompt,
      archiveBaseDir: TEST_ARCHIVE_DIR,
    };
  }
}

export type Harness = {
  session: Session;
  host: TestSessionHost;
  mockClient: MockAnthropicClient;
  fileIO: InMemoryFileIO;
  git: FakeGitClient;
  shell: FakeShell;
  createRoot(): Promise<{ id: ThreadId; thread: Thread }>;
  thread(id: ThreadId): Thread;
  send(thread: Thread, text: string): Promise<RestResult>;
  /** The next stream issued after the last one this harness handed out. */
  nextStream(): Promise<MockStream>;
  /** The latest live stream whose request mentions `text`. */
  streamWithText(text: string): Promise<MockStream>;
  dispose(): Promise<void>;
};

export function createHarness(options: HarnessOptions = {}): Harness {
  const host = new TestSessionHost(options);
  const session = new Session(host);
  let last: MockStream | undefined;
  const thread = (id: ThreadId): Thread => {
    const record = session.getThread(id);
    if (record?.state !== "initialized") {
      throw new Error(`Thread ${id} is not initialized`);
    }
    return record.thread;
  };
  return {
    session,
    host,
    mockClient: host.mockClient,
    fileIO: host.fileIO,
    git: host.git,
    shell: host.shell,
    async createRoot() {
      const id = await session.createRootThread();
      return { id, thread: thread(id) };
    },
    thread,
    send: (target, text) =>
      target.submit({ type: "raw", message: pendingMessage(text) }),
    async nextStream() {
      last = await awaitNextStream(host.mockClient, last);
      return last;
    },
    streamWithText: (text) =>
      pollUntil(() => {
        const stream = host.mockClient.streams.findLast(
          (s) => !s.aborted && JSON.stringify(s.messages).includes(text),
        );
        if (!stream) throw new Error(`waiting for a stream with "${text}"`);
        last = stream;
        return stream;
      }),
    async dispose() {
      await session.dispose();
      await host.mcp.disconnect();
    },
  };
}

export async function withHarness<T>(
  options: HarnessOptions,
  fn: (h: Harness) => Promise<T>,
): Promise<T> {
  const harness = createHarness(options);
  try {
    return await fn(harness);
  } finally {
    await harness.dispose();
  }
}
