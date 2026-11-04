import type { AgentsMap } from "../agents/agents.ts";
import type { FileIO } from "../capabilities/file-io.ts";
import type { LspClient } from "../capabilities/lsp-client.ts";
import type { LuaExecutor } from "../capabilities/lua-executor.ts";
import { SandboxFileIO } from "../capabilities/sandbox-file-io.ts";
import { SandboxShell } from "../capabilities/sandbox-shell.ts";
import type { Shell } from "../capabilities/shell.ts";
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
import {
  DEFAULT_SANDBOX_CONFIG,
  type SandboxConfig,
} from "../sandbox-config.ts";
import type {
  PreparedThread,
  SessionHost,
  Session as SessionType,
  ThreadPreparation,
} from "../session.ts";
import { Session } from "../session.ts";
import type { CustomCommand } from "../submission/commands/types.ts";
import {
  type PendingMessage,
  parseCompact,
  pendingMessage,
  type ResolvedSubmission,
} from "../submission/index.ts";
import { resolveSubmission } from "../submission/resolve.ts";
import {
  awaitNextStream,
  createMockProvider,
  noopLogger,
  TEST_ARCHIVE_DIR,
} from "../test-helpers.ts";
import type { ContextFileAccess, Thread } from "../thread.ts";
import { ABORTED, type Aborted, type SubmissionResult } from "../thread-api.ts";
import type { PreparedThreadContext } from "../thread-assembly.ts";
import { clientToolCreator } from "../tools/create-tool.ts";
import { MCPToolManager } from "../tools/mcp/manager.ts";
import type { MCPServersConfig } from "../tools/mcp/options.ts";
import type { ToolCapability } from "../tools/tool-registry.ts";
import { pollUntil, type Task } from "../utils/async.ts";
import {
  detectFileTypeViaFileIO,
  type HomeDir,
  type ProjectDir,
  resolveFilePath,
  toProjectDir,
  type UnresolvedFilePath,
} from "../utils/files.ts";
import type { WatcherManifest } from "../watchers/protocol.ts";
import { WatcherRegistry } from "../watchers/watcher-registry.ts";
import {
  FakeShell,
  type FakeShellScript,
  FakeWatcherTransport,
} from "./fakes.ts";
import { MockSandboxManager } from "./mock-sandbox-manager.ts";

export { FakeShell, type FakeShellScript } from "./fakes.ts";

export type HarnessThreadOptions = {
  autoCompactThreshold?: number;
  autoCompactPrompt: string;
  autoContext: string[];
  hierarchyContextFileNames: string[];
  maxConcurrentSubagents: number;
  maxConcurrentFastSubagents: number;
  skillsPaths: string[];
  agentsPaths: string[];
  /** Only expanded by `submissionResolve`. */
  customCommands: CustomCommand[];
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
  projectDir?: ProjectDir;
  homeDir?: string;
  shell?: FakeShellScript;
  agents?: AgentsMap;
  options?: Partial<HarnessThreadOptions>;
  resolve?: HarnessResolve;
  /** Enables `nvim_lua` (and the "nvim" capability) with a stub executor. */
  luaExecutor?: LuaExecutor;
  /** Enables watcher tracking over `host.watchers` with these manifests. */
  watchers?: ReadonlyArray<WatcherManifest>;
  /** Real MCPToolManager over the given (e.g. `type: "mock"`) servers. */
  mcpServers?: MCPServersConfig;
  /** Gate the fake shell/fileIO behind the real `SandboxShell`/`SandboxFileIO`
   * over `harness.sandbox`, so approvals surface through the Session APIs. */
  sandbox?: { config?: Partial<SandboxConfig> };
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
      host.projectDir,
      raw as UnresolvedFilePath,
      host.homeDir,
    );
    const info = await detectFileTypeViaFileIO(abs, host.fileIO);
    if (!info) continue;
    getContextFiles().addFileContext(abs, info);
  }
  const prompt = {
    content: rest.length ? [{ type: "text" as const, text: rest }] : [],
    reminders: [],
  };
  return compact ? { type: "compact", prompt } : { type: "send", prompt };
};

/** The production resolver (custom commands, `@file`, `@diff`, ...) over the
 * host's fileIO. Client commands fail: there is no client. */
export const submissionResolve: HarnessResolve = (
  message,
  { host, getContextFiles, canCompact },
) =>
  resolveSubmission(
    message,
    {
      projectDir: host.projectDir,
      homeDir: host.homeDir,
      fileIO: host.fileIO,
      logger: noopLogger,
      customCommands: host.options.customCommands,
      getContextFiles,
      canCompact,
      awaitClient: () => {
        throw new Error("no client in the harness");
      },
    },
    new Promise(() => {}),
  );

const stubLsp = {} as LspClient;

/** A node-only SessionHost: the same preparation steps as `ServerSessionHost`
 * (auto-context, hierarchy discovery, system info/prompt, fork inheritance,
 * delivery-time resolution) over in-memory collaborators. */
export class TestSessionHost implements SessionHost {
  readonly mockClient = new MockAnthropicClient();
  readonly provider = createMockProvider(this.mockClient);
  readonly fileIO: InMemoryFileIO;
  readonly watchers = new FakeWatcherTransport();
  readonly shell: FakeShell;
  /** Default projectDir for threads created without an explicit local `projectDir`. Mutable so tests can model the client moving. */
  projectDir: ProjectDir;
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
  readonly sandbox = new MockSandboxManager();
  /** Undefined when threads get the raw fakes (no `sandbox` option). */
  readonly sandboxConfig: SandboxConfig | undefined;

  constructor(opts: HarnessOptions = {}) {
    this.projectDir = opts.projectDir ?? toProjectDir("/project");
    this.homeDir = (opts.homeDir ?? "/home") as HomeDir;
    this.fileIO = new InMemoryFileIO(opts.files ?? {});
    this.shell = new FakeShell(opts.shell);
    this.agents = opts.agents ?? {};
    this.resolve = opts.resolve ?? defaultHarnessResolve;
    this.luaExecutor = opts.luaExecutor;
    this.sandboxConfig = opts.sandbox
      ? { ...DEFAULT_SANDBOX_CONFIG, ...opts.sandbox.config }
      : undefined;
    this.mcp = opts.mcpServers
      ? new MCPToolManager(opts.mcpServers, { logger: noopLogger })
      : new MCPToolManager({}, { logger: noopLogger });
    this.options = {
      autoCompactThreshold: 100_000,
      autoCompactPrompt: "continue",
      autoContext: [],
      hierarchyContextFileNames: [],
      maxConcurrentSubagents: 3,
      maxConcurrentFastSubagents: 8,
      skillsPaths: [],
      agentsPaths: [],
      customCommands: [],
      ...opts.options,
    };
  }

  /** Mirrors `createLocalEnvironment`: session-owned approvals and bypass. */
  private sandboxed(
    threadId: ThreadId,
    projectDir: ProjectDir,
    session: SessionType,
  ): { fileIO: FileIO; shell: Shell } {
    const config = this.sandboxConfig;
    if (!config) return { fileIO: this.fileIO, shell: this.shell };
    const approvals = session.approvalsFor(threadId);
    const isBypassed = () => session.isSandboxBypassed(threadId);
    const { homeDir } = this;
    return {
      fileIO: new SandboxFileIO(
        { logger: noopLogger, projectDir, homeDir },
        this.sandbox,
        (absPath) => approvals.promptForWriteApproval(absPath),
        isBypassed,
        undefined,
        this.fileIO,
      ),
      shell: new SandboxShell(
        {
          projectDir,
          homeDir,
          threadId,
          getSandboxConfig: () => config,
          isBypassed,
        },
        this.sandbox,
        approvals,
        { inner: this.shell },
      ),
    };
  }

  getDefaultProfile(): ProviderProfile {
    return this.profile;
  }
  getProfile(name: string): ProviderProfile | undefined {
    return name === this.profile.name ? this.profile : undefined;
  }

  getAgents(): AgentsMap {
    return this.agents;
  }

  prepareThread(
    request: ThreadPreparation,
    session: SessionType,
  ): Task<PreparedThread | Aborted> {
    const prepare = () => this.prepare(request, session);
    return {
      promise: this.intercept ? this.intercept(request, prepare) : prepare(),
      abort: () => {},
    };
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
    const { homeDir } = this;
    const requestedConfig = request.options.environmentConfig;
    const projectDir =
      requestedConfig?.type === "local" && requestedConfig.projectDir
        ? requestedConfig.projectDir
        : this.projectDir;
    const { fileIO, shell } = request.options.fileIO
      ? { fileIO: request.options.fileIO, shell: this.shell }
      : this.sandboxed(id, projectDir, session);
    const autoContextFiles =
      request.options.fileIO || source
        ? []
        : await resolveAutoContext({
            fileIO,
            logger: noopLogger,
            projectDir,
            homeDir,
            globs: this.options.autoContext,
          });
    const systemInfo =
      source?.systemInfo ??
      buildSystemInfo({
        projectDir,
        neovimVersion: "0.10.0",
      });
    const systemPrompt =
      source?.systemPrompt ??
      (await createSystemPrompt(threadType, {
        logger: noopLogger,
        projectDir,
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
      homeDir,
      initialFiles: autoContextFilesToInitialFiles(autoContextFiles),
      ...(subagentConfig ? { subagentConfig } : {}),
      systemPrompt,
      systemInfo,
      mcpToolManager: this.mcp,
      threadManager: session,
      getScriptRunner,
      fileIO,
      ...(session.watcherRegistry
        ? {
            watchTracking: {
              registry: session.watcherRegistry,
              getLastAttention: () => session.getLastAttention(id) ?? 0,
            },
          }
        : {}),
      discoverHierarchy: (absFilePath) =>
        discoverHierarchyContext(absFilePath, {
          fileIO,
          logger: noopLogger,
          projectDir,
          homeDir,
          hierarchyContextFileNames: this.options.hierarchyContextFileNames,
        }),
      clientToolCreator: clientToolCreator({
        logger: noopLogger,
        lspClient: stubLsp,
        mcpToolManager: this.mcp,
        homeDir,
        maxConcurrentSubagents: this.options.maxConcurrentSubagents,
        maxConcurrentFastSubagents: this.options.maxConcurrentFastSubagents,
        fileIO,
        shell,
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
        ...(session.scriptRunner ? (["scripts"] as const) : []),
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
  shell: FakeShell;
  sandbox: MockSandboxManager;
  createRoot(): Promise<{ id: ThreadId; thread: Thread }>;
  thread(id: ThreadId): Thread;
  send(thread: Thread, text: string): Promise<SubmissionResult>;
  /** The next stream issued after the last one this harness handed out. */
  nextStream(): Promise<MockStream>;
  /** The latest live stream whose request mentions `text`. */
  streamWithText(text: string): Promise<MockStream>;
  dispose(): Promise<void>;
};

export function createHarness(options: HarnessOptions = {}): Harness {
  const host = new TestSessionHost(options);
  let watcherRegistry: WatcherRegistry | undefined;
  if (options.watchers) {
    watcherRegistry = new WatcherRegistry({
      transport: host.watchers,
      homeDir: host.homeDir,
      logger: noopLogger,
    });
    watcherRegistry.setManifests(
      options.watchers.map((m) => ({
        ...m,
        dir: "/watchers",
        socketPath: `/watchers/${m.name}.sock`,
      })),
    );
  }
  const session = new Session(host, {
    ...(watcherRegistry ? { watcherRegistry } : {}),
  });
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
    shell: host.shell,
    sandbox: host.sandbox,
    async createRoot() {
      const id = await session.createRootThread();
      if (id === ABORTED) throw new Error("root thread creation was aborted");
      // Roots start bypassed; the `sandbox` option means the test wants it enforced.
      if (host.sandboxConfig && session.isSandboxBypassed(id)) {
        session.toggleSandboxBypass(id);
      }
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
