import {
  ABORTED,
  type Aborted,
  type AgentInput,
  autoContextFilesToInitialFiles,
  buildSystemInfo,
  type ContextFileAccess,
  clientToolCreator,
  createSystemPrompt,
  discoverHierarchyContext,
  FsFileIO,
  loadAgents,
  MCPToolManagerImpl,
  type PendingMessage,
  type PreparedThread,
  type PreparedThreadContext,
  type ProviderProfile,
  parseCompact,
  type ResolvedSubmission,
  resolveAutoContext,
  type Session,
  type SessionHost,
  type SystemPrompt,
  type Task,
  type ThreadId,
  type ThreadPreparation,
} from "@magenta/server";
import type { Lsp } from "../capabilities/lsp.ts";
import {
  createDockerEnvironment,
  createLocalEnvironment,
  type EnvironmentConfig,
} from "../environment.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { MagentaOptions } from "../options.ts";
import { getProvider } from "../providers/provider.ts";
import type { RootMsg } from "../root-msg.ts";
import type { Sandbox } from "../sandbox-manager.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { HomeDir, NvimCwd } from "../utils/files.ts";
import type { CommandRegistry } from "./commands/registry.ts";
import type { NvimThreadContext, SandboxRoot } from "./thread.ts";

/** Auto/hierarchy context is discovered on the host filesystem, independent of
 * a thread's (possibly sandboxed or docker) fileIO. */
const hostFileIO = new FsFileIO();

export type NvimHostContext = {
  dispatch: Dispatch<RootMsg>;
  getDisplayWidth: () => number;
  getOptions: () => MagentaOptions;
  cwd: NvimCwd;
  homeDir: HomeDir;
  nvim: Nvim;
  lsp: Lsp;
  sandbox: Sandbox;
  /** Expands `@file:`, `@diff`, ... when a submission is delivered. */
  commandRegistry: CommandRegistry;
};

/** The editor-dependent collaborators a thread needs, minus the view adapter
 * that is attached once the session hands back a ready Thread. */
export type PreparedNvimContext = Omit<NvimThreadContext, "chat">;

/** Editor-backed preparation and approval capabilities for one Session. The
 * session owns identity, hierarchy and lifecycle; this host only supplies
 * collaborators and answers approval questions about them. */
export class NvimSessionHost implements SessionHost {
  /** Per-thread editor collaborators, kept here so the view adapter can wrap a
   * ready Thread without the session knowing anything editor-shaped. */
  readonly contexts = new Map<ThreadId, PreparedNvimContext>();
  /** Bypass state owned outside the session (a script invocation's root). */
  private sandboxRoots = new Map<ThreadId, () => SandboxRoot | undefined>();
  /** Bypass state for session-owned roots. */
  private bypassed = new Set<ThreadId>();
  readonly mcpToolManager: MCPToolManagerImpl;

  constructor(private context: NvimHostContext) {
    this.mcpToolManager = new MCPToolManagerImpl(
      context.getOptions().mcpServers,
      { logger: context.nvim.logger },
    );
  }

  getActiveProfile(): ProviderProfile {
    const options = this.context.getOptions();
    const profile = options.profiles.find(
      (p) => p.name === options.activeProfile,
    );
    if (!profile) {
      throw new Error(
        `Profile ${options.activeProfile} not found in profiles: ${JSON.stringify(options.profiles)}`,
      );
    }
    return profile;
  }

  getAgents() {
    return loadAgents({
      cwd: this.context.cwd,
      logger: this.context.nvim.logger,
      options: this.context.getOptions(),
    });
  }

  getProvider(profile: ProviderProfile) {
    return getProvider(this.context.nvim, profile);
  }

  rejectApprovals(id: ThreadId): void {
    this.contexts.get(id)?.environment.sandboxViolationHandler?.rejectAll();
  }

  /** Bypass is a property of the root of the tree, which the session knows and
   * a script invocation may own. */
  isSandboxBypassed(id: ThreadId | undefined, session: Session): boolean {
    if (!id) return false;
    const root = session.getRootAncestorId(id);
    const external = this.sandboxRoots.get(root)?.();
    if (external) return external.isSandboxBypassed;
    return this.bypassed.has(root);
  }

  toggleSandboxBypass(id: ThreadId, session: Session): void {
    const root = session.getRootAncestorId(id);
    const external = this.sandboxRoots.get(root)?.();
    if (external?.toggle) {
      external.toggle();
    } else if (this.bypassed.has(root)) {
      this.bypassed.delete(root);
    } else {
      this.bypassed.add(root);
    }
    if (this.isSandboxBypassed(root, session)) {
      this.approveAllPendingInSubtree(root, session);
    }
  }

  /** A fork starts its own tree, so it inherits its source's bypass state. */
  setSandboxBypassed(id: ThreadId, bypassed: boolean): void {
    if (bypassed) this.bypassed.add(id);
    else this.bypassed.delete(id);
  }

  /** A thread whose bypass state is owned elsewhere (a script invocation). */
  registerSandboxRoot(
    id: ThreadId,
    getSandboxRoot: () => SandboxRoot | undefined,
  ): void {
    this.sandboxRoots.set(id, getSandboxRoot);
  }

  approveAllPendingInSubtree(id: ThreadId, session: Session): void {
    const children = session.buildChildrenMap();
    const approve = (threadId: ThreadId) => {
      this.contexts
        .get(threadId)
        ?.environment.sandboxViolationHandler?.approveAll();
      for (const child of children.get(threadId) ?? []) approve(child);
    };
    approve(id);
  }

  prepareThread(
    request: ThreadPreparation,
    session: Session,
  ): Task<PreparedThread | Aborted> {
    let aborted = false;
    return {
      promise: this.prepare(request, session, () => aborted),
      abort: () => {
        aborted = true;
      },
    };
  }

  /** Aborts are only honored before any resources are acquired; after that the
   * session discards the prepared thread and calls its `release`. */
  private async prepare(
    request: ThreadPreparation,
    session: Session,
    isAborted: () => boolean,
  ): Promise<PreparedThread | Aborted> {
    const { options } = request;
    const source = request.type === "fork" ? request.source : undefined;
    const {
      threadId,
      profile,
      threadType,
      subagentConfig,
      fileIO,
      environmentConfig,
      yieldSchema,
      scriptName,
    } = options;
    if (isAborted()) return ABORTED;
    const resolvedConfig: EnvironmentConfig = environmentConfig ?? {
      type: "local",
    };

    const [autoContextFiles, environment] = await Promise.all([
      // auto-context is discovered against the host filesystem, so it is
      // meaningless for a thread whose fileIO is a sandbox that doesn't contain
      // those paths - they would immediately be reported as deleted. A fork
      // inherits the source's context instead of resolving its own.
      fileIO || source
        ? Promise.resolve([])
        : resolveAutoContext({
            fileIO: hostFileIO,
            logger: this.context.nvim.logger,
            cwd: this.context.cwd,
            homeDir: this.context.homeDir,
            globs: this.context.getOptions().autoContext,
          }),
      resolvedConfig.type === "docker"
        ? createDockerEnvironment({
            container: resolvedConfig.container,
            cwd: resolvedConfig.cwd,
            threadId,
          })
        : Promise.resolve(
            createLocalEnvironment({
              nvim: this.context.nvim,
              lsp: this.context.lsp,
              cwd: resolvedConfig.cwd ?? this.context.cwd,
              homeDir: this.context.homeDir,
              getOptions: this.context.getOptions,
              threadId,
              sandbox: this.context.sandbox,
              onPendingChange: () =>
                this.context.dispatch({
                  type: "thread-msg",
                  id: threadId,
                  msg: { type: "permission-pending-change" },
                }),
              isBypassed: () => this.isSandboxBypassed(threadId, session),
            }),
          ),
      session.scriptRunner?.discover(),
    ]);

    if (fileIO) {
      environment.fileIO = fileIO;
      environment.sandboxViolationHandler = undefined;
    }

    const initialGitState = source
      ? undefined
      : await environment.gitClient.getState();

    const systemInfo =
      source?.systemInfo ??
      buildSystemInfo({
        cwd: environment.cwd,
        neovimVersion: String(
          await this.context.nvim.call("nvim_eval", ["v:version"]),
        ),
        overrides: {
          git: initialGitState,
          ...(resolvedConfig.type === "docker"
            ? { platform: "linux (docker)", cwd: environment.cwd }
            : {}),
        },
      });

    // A fork continues the source's conversation, so it keeps its prompt.
    const systemPrompt =
      source?.systemPrompt ??
      (await createSystemPrompt(threadType, {
        logger: this.context.nvim.logger,
        cwd: environment.cwd,
        options: this.context.getOptions(),
        fileIO: environment.fileIO,
        homeDir: environment.homeDir,
        ...(subagentConfig ? { subagentConfig } : {}),
      }));

    const context: PreparedNvimContext = {
      ...this.context,
      options: this.context.getOptions(),
      mcpToolManager: this.mcpToolManager,
      profile,
      environment,
      initialFiles: autoContextFilesToInitialFiles(autoContextFiles),
      initialGitState,
      systemInfo,
      ...(subagentConfig ? { subagentConfig } : {}),
      ...(yieldSchema ? { yieldSchema } : {}),
      ...(scriptName ? { scriptName } : {}),
    };
    this.contexts.set(threadId, context);

    const options_ = this.context.getOptions();
    return {
      context: prepareThreadDependencies(
        threadId,
        systemPrompt,
        context,
        session,
        threadType !== "compact",
      ),
      autoCompactThreshold: options_.autoCompactThreshold,
      autoCompactPrompt: options_.autoCompactPrompt,
      release: async () => {
        environment.sandboxViolationHandler?.rejectAll();
        this.contexts.delete(threadId);
        this.sandboxRoots.delete(threadId);
        this.bypassed.delete(threadId);
      },
    };
  }
}

/** Editor-backed collaborators in server-typed shape. Conversation kind,
 * supervisors and the compactor belong to server-side assembly. */
function prepareThreadDependencies(
  id: ThreadId,
  systemPrompt: SystemPrompt,
  context: PreparedNvimContext,
  session: Session,
  canCompact: boolean,
): PreparedThreadContext {
  const env = context.environment;
  const cwd = env.cwd;
  const homeDir = env.homeDir;
  const getAgents = () =>
    loadAgents({
      cwd,
      logger: context.nvim.logger,
      options: context.options,
    });
  const getScriptRunner = () => session.scriptRunner;
  const maxConcurrentSubagents = context.options.maxConcurrentSubagents || 3;
  const maxConcurrentFastSubagents =
    context.options.maxConcurrentFastSubagents || 8;
  return {
    logger: context.nvim.logger,
    profile: context.profile,
    cwd,
    homeDir,
    ...(context.initialFiles ? { initialFiles: context.initialFiles } : {}),
    ...(context.initialGitState
      ? { initialGitState: context.initialGitState }
      : {}),
    ...(context.subagentConfig
      ? { subagentConfig: context.subagentConfig }
      : {}),
    systemPrompt,
    systemInfo: context.systemInfo,
    mcpToolManager: context.mcpToolManager,
    threadManager: session,
    getScriptRunner,
    fileIO: env.fileIO,
    gitClient: env.gitClient,
    discoverHierarchy: (absFilePath) =>
      discoverHierarchyContext(absFilePath, {
        fileIO: hostFileIO,
        logger: context.nvim.logger,
        cwd,
        homeDir,
        hierarchyContextFileNames: context.options.hierarchyContextFileNames,
      }),
    clientToolCreator: clientToolCreator({
      logger: context.nvim.logger,
      lspClient: env.lspClient,
      ...(env.luaExecutor !== undefined
        ? { luaExecutor: env.luaExecutor }
        : {}),
      mcpToolManager: context.mcpToolManager,
      cwd,
      homeDir,
      maxConcurrentSubagents,
      maxConcurrentFastSubagents,
      fileIO: env.fileIO,
      shell: env.shell,
      threadManager: session,
      getScriptRunner,
      getAgents,
    }),
    availableCapabilities: env.availableCapabilities,
    environmentConfig: env.environmentConfig,
    ...(context.options.dockerfile
      ? { subagentDockerfile: context.options.dockerfile }
      : {}),
    ...(context.yieldSchema ? { yieldSchema: context.yieldSchema } : {}),
    getAgents,
    provider: getProvider(context.nvim, context.profile),
    // Resolved at delivery time against the session's current handle, never a
    // retired core.
    resolve: (message: PendingMessage) =>
      resolveSubmission(
        message,
        context,
        () => {
          const record = session.getThread(id);
          if (record?.state !== "initialized") {
            throw new Error(`Thread ${id} is no longer available`);
          }
          return record.thread.contextFiles;
        },
        canCompact,
      ),
  };
}

export async function resolveSubmission(
  message: PendingMessage,
  context: PreparedNvimContext,
  getContextFileAccess: () => ContextFileAccess,
  canCompact: boolean,
): Promise<ResolvedSubmission> {
  // A compact thread has no compactor — it *is* a compaction — so
  // `@compact` typed into one is ordinary text.
  const { compact, rest } = canCompact
    ? parseCompact(message)
    : { compact: false, rest: message };
  const { processedText, additionalContent, reminders } =
    await context.commandRegistry.processMessage(rest, {
      nvim: context.nvim,
      cwd: context.environment.cwd,
      homeDir: context.environment.homeDir,
      fileSupervisor: getContextFileAccess(),
      options: context.options,
    });
  const content: AgentInput[] = [
    {
      type: "text",
      text: processedText,
    },
  ];
  for (const extra of additionalContent) {
    if (
      extra.type === "text" ||
      extra.type === "image" ||
      extra.type === "document"
    ) {
      content.push(extra);
    }
  }
  const prompt = { content, reminders };
  return compact ? { type: "compact", prompt } : { type: "send", prompt };
}
