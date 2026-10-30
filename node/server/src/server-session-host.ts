import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import { loadAgents } from "./agents/agents.ts";
import { anthropicTokenStore } from "./auth/anthropic-tokens.ts";
import type { AuthUI } from "./auth-ui.ts";
import {
  clientFileWritten,
  clientLspClient,
  clientLuaExecutor,
} from "./capabilities/client.ts";
import { FsFileIO } from "./capabilities/file-io.ts";
import { type GitState, readGitStateAt } from "./capabilities/git-client.ts";
import { NoopLspClient } from "./capabilities/noop-lsp-client.ts";
import type { SubagentConfig, ThreadId } from "./chat-types.ts";
import {
  autoContextFilesToInitialFiles,
  discoverHierarchyContext,
  resolveAutoContext,
} from "./context/auto-context.ts";
import { buildSystemInfo } from "./context/system-info.ts";
import {
  createDockerEnvironment,
  createLocalEnvironment,
  type Environment,
  environmentCapabilities,
} from "./environment.ts";
import type { Logger } from "./logger.ts";
import type {
  ClientEffectHandler,
  ClientNotification,
} from "./protocol/client.ts";
import type { ProviderOptions, ProviderProfile } from "./provider-options.ts";
import { getProvider } from "./providers/provider.ts";
import type { Provider } from "./providers/provider-types.ts";
import {
  createSystemPrompt,
  type SystemInfo,
  type SystemPrompt,
} from "./providers/system-prompt.ts";
import type { SandboxConfig } from "./sandbox-config.ts";
import type { Sandbox } from "./sandbox-manager.ts";
import type {
  PreparedThread,
  Session,
  SessionHost,
  ThreadPreparation,
} from "./session.ts";
import type { CustomCommand } from "./submission/commands/types.ts";
import type { PendingMessage } from "./submission/index.ts";
import { resolveSubmission } from "./submission/resolve.ts";
import { buildLoadedFiles, type Files } from "./supervisors/file-supervisor.ts";
import type { EnvironmentConfig } from "./thread.ts";
import { ABORTED, type Aborted } from "./thread-api.ts";
import type { PreparedThreadContext } from "./thread-assembly.ts";
import { clientToolCreator } from "./tools/create-tool.ts";
import { validateInput } from "./tools/helpers.ts";
import { MCPToolManager } from "./tools/mcp/manager.ts";
import type { MCPServersConfig } from "./tools/mcp/options.ts";
import { abortTaskOnSignal, type Task } from "./utils/async.ts";
import type { HomeDir, ProjectDir } from "./utils/files.ts";

/** The options the server host consumes. */
export type ServerHostOptions = ProviderOptions & {
  profiles: ProviderProfile[];
  activeProfile: string;
  sandbox: SandboxConfig;
  autoContext: string[];
  hierarchyContextFileNames: string[];
  maxConcurrentSubagents: number;
  maxConcurrentFastSubagents: number;
  dockerfile?: string;
  autoCompactThreshold: number;
  autoCompactPrompt: string;
  mcpServers: MCPServersConfig;
  customCommands: CustomCommand[];
};

export type ServerSessionHostContext = {
  logger: Logger;
  /** Default projectDir for threads created without an explicit one. */
  projectDir: ProjectDir;
  homeDir: HomeDir;
  sandbox: Sandbox;
  getOptions: () => ServerHostOptions;
  /** The attached client, if any. */
  getClient: () => ClientEffectHandler | undefined;
  /** Resolves with the attached client or the next one to attach. */
  awaitClient: () => Task<ClientEffectHandler | Aborted>;
  /** Overrides server-built providers (tests). */
  getProvider?: (profile: ProviderProfile) => Provider;
};

/** What preparation produced for one thread, for views that present it. */
export type PreparedThreadInfo = {
  profile: ProviderProfile;
  environment: Environment;
  initialFiles?: Files;
  /** Undefined for forks, which inherit the source's git context. */
  initialGitState: GitState | undefined;
  subagentConfig?: SubagentConfig;
  systemInfo: SystemInfo;
  yieldSchema?: JSONSchemaType;
  scriptName?: string;
};

/** Auto/hierarchy context is discovered on the host filesystem, independent of
 * a thread's (possibly sandboxed or docker) fileIO. */
const hostFileIO = new FsFileIO();

/** Prepares threads with server-owned execution. Editor collaborators (LSP,
 * lua, buffer reloads) come from whatever editor is attached to the session
 * at preparation time. */
type BufferedAuthOutput = { type: "error" | "progress"; text: string };

export class ServerSessionHost implements SessionHost {
  private readonly prepared = new Map<ThreadId, PreparedThreadInfo>();
  readonly mcpToolManager: MCPToolManager;

  /** Providers are cached per profile, so they get a stable AuthUI that
   * prompts through whichever editor is attached when a login is needed. */
  readonly authUI: AuthUI = {
    showOAuthFlow: (authUrl, abortSignal) =>
      this.showOAuthFlow(authUrl, abortSignal),
    showError: (message) => {
      if (this.notifyAuth({ type: "authError", message })) return;
      this.context.logger.error(message);
      this.bufferForNextClient({ type: "error", text: message });
    },
    showLoginProgress: (chunk) => {
      if (this.notifyAuth({ type: "loginProgress", chunk })) return;
      this.context.logger.info(chunk);
      this.bufferForNextClient({ type: "progress", text: chunk });
    },
  };
  /** Login output produced with no client attached, replayed in order to the
   * next client so it sees e.g. a `codex login` URL. */
  private pendingAuthOutput: BufferedAuthOutput[] = [];
  private replayTask: Task<ClientEffectHandler | Aborted> | undefined;
  constructor(private context: ServerSessionHostContext) {
    this.mcpToolManager = new MCPToolManager(context.getOptions().mcpServers, {
      logger: context.logger,
    });
  }
  private notifyAuth(n: ClientNotification): boolean {
    const client = this.context.getClient();
    if (!client?.info.supportsAuthUI) return false;
    client.notify(n);
    return true;
  }
  private bufferForNextClient(output: BufferedAuthOutput): void {
    this.pendingAuthOutput.push(output);
    if (this.replayTask) return;
    const task = this.context.awaitClient();
    this.replayTask = task;
    task.promise.then(
      (client) => {
        this.replayTask = undefined;
        const output = this.pendingAuthOutput;
        this.pendingAuthOutput = [];
        if (client === ABORTED || !client.info.supportsAuthUI) return;
        for (const o of output) {
          client.notify(
            o.type === "error"
              ? { type: "authError", message: o.text }
              : { type: "loginProgress", chunk: o.text },
          );
        }
      },
      () => {
        this.replayTask = undefined;
        this.pendingAuthOutput = [];
      },
    );
  }
  /** Stays pending until a client attaches, cancellable via `abortSignal`. */
  private async showOAuthFlow(
    authUrl: string,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    abortSignal?.throwIfAborted();
    const task = this.context.awaitClient();
    const stopListening = abortTaskOnSignal(task, abortSignal);
    let client: ClientEffectHandler | Aborted;
    try {
      client = await task.promise;
    } finally {
      stopListening();
    }
    if (client === ABORTED) {
      throw new Error("OAuth login aborted while waiting for a client");
    }
    if (!client.info.supportsAuthUI) {
      throw new Error("The attached client cannot prompt for logins");
    }
    const response = client.request({ type: "oauth", authUrl });
    if (!abortSignal) return (await response).code;
    // In-process the client prompt cannot be cancelled; its result is dropped.
    const aborted = new Promise<never>((_, reject) => {
      abortSignal.addEventListener(
        "abort",
        () => reject(abortSignal.reason ?? new Error("OAuth login aborted")),
        { once: true },
      );
    });
    return (await Promise.race([response, aborted])).code;
  }
  /** Preparation is recorded before the session registers the thread, so
   * this is defined for every initialized thread until it is released. */
  getPrepared(id: ThreadId): PreparedThreadInfo {
    const info = this.prepared.get(id);
    if (!info) throw new Error(`No prepared info for thread ${id}`);
    return info;
  }

  getProfile(name: string): ProviderProfile | undefined {
    return this.context.getOptions().profiles.find((p) => p.name === name);
  }
  getDefaultProfile(): ProviderProfile {
    const { profiles, activeProfile } = this.context.getOptions();
    const profile = profiles.find((p) => p.name === activeProfile);
    if (!profile) {
      throw new Error(
        `Default profile ${activeProfile} not found in profiles: ${JSON.stringify(profiles)}`,
      );
    }
    return profile;
  }

  getAgents() {
    return loadAgents({
      projectDir: this.context.projectDir,
      logger: this.context.logger,
      options: this.context.getOptions(),
    });
  }

  getProvider(profile: ProviderProfile): Provider {
    if (this.context.getProvider) return this.context.getProvider(profile);
    return getProvider(
      this.context.logger,
      this.authUI,
      validateInput,
      anthropicTokenStore,
      profile,
    );
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
    const hostOptions = this.context.getOptions();
    const { logger, homeDir } = this.context;
    const editor = session.getClient();
    const resolvedConfig: EnvironmentConfig = environmentConfig ?? {
      type: "local",
    };
    const localCwd =
      resolvedConfig.type === "local"
        ? (resolvedConfig.projectDir ?? this.context.projectDir)
        : this.context.projectDir;

    const [autoContextFiles, environment] = await Promise.all([
      // auto-context is discovered against the host filesystem, so it is
      // meaningless for a thread whose fileIO is a sandbox that doesn't contain
      // those paths - they would immediately be reported as deleted. A fork
      // inherits the source's context instead of resolving its own.
      fileIO || source || request.type === "reflect"
        ? Promise.resolve([])
        : resolveAutoContext({
            fileIO: hostFileIO,
            logger,
            projectDir: this.context.projectDir,
            homeDir,
            globs: hostOptions.autoContext,
          }),
      resolvedConfig.type === "docker"
        ? createDockerEnvironment({
            container: resolvedConfig.container,
            projectDir: resolvedConfig.projectDir,
            threadId,
          })
        : Promise.resolve(
            createLocalEnvironment({
              logger,
              projectDir: localCwd,
              homeDir,
              getSandboxConfig: () => this.context.getOptions().sandbox,
              ...(editor
                ? {
                    lspClient: clientLspClient(editor, localCwd, homeDir),
                    luaExecutor: clientLuaExecutor(editor),
                    onFileWritten: clientFileWritten(editor),
                  }
                : {}),
              threadId,
              sandbox: this.context.sandbox,
              approvals: session.approvalsFor(threadId),
              isBypassed: () => session.isSandboxBypassed(threadId),
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
      : await readGitStateAt(environment.gitClient, environment.projectDir);

    const systemInfo =
      source?.systemInfo ??
      buildSystemInfo({
        projectDir: environment.projectDir,
        neovimVersion:
          editor?.info.neovimVersion ?? "none (no client attached)",
        overrides: {
          git: initialGitState,
          ...(resolvedConfig.type === "docker"
            ? { platform: "linux (docker)", projectDir: environment.projectDir }
            : {}),
        },
      });

    // A fork continues the source's conversation, so it keeps its prompt.
    const systemPrompt =
      source?.systemPrompt ??
      (await createSystemPrompt(threadType, {
        logger,
        projectDir: environment.projectDir,
        options: hostOptions,
        fileIO: environment.fileIO,
        homeDir: environment.homeDir,
        ...(subagentConfig ? { subagentConfig } : {}),
      }));

    const info: PreparedThreadInfo = {
      profile,
      environment,
      initialFiles:
        request.type === "reflect"
          ? buildLoadedFiles(
              request.source.contextFiles.files,
              request.loadedContextFiles,
            )
          : autoContextFilesToInitialFiles(autoContextFiles),
      initialGitState,
      systemInfo,
      ...(subagentConfig ? { subagentConfig } : {}),
      ...(yieldSchema ? { yieldSchema } : {}),
      ...(scriptName ? { scriptName } : {}),
    };
    this.prepared.set(threadId, info);

    return {
      context: this.threadContext(
        threadId,
        systemPrompt,
        info,
        hostOptions,
        session,
        threadType !== "compact",
      ),
      autoCompactThreshold: hostOptions.autoCompactThreshold,
      autoCompactPrompt: hostOptions.autoCompactPrompt,
      release: async () => {
        environment.sandboxViolationHandler?.rejectAll();
        this.prepared.delete(threadId);
      },
    };
  }

  /** Server-typed collaborators. Conversation kind, supervisors and the
   * compactor belong to server-side assembly. */
  private threadContext(
    id: ThreadId,
    systemPrompt: SystemPrompt,
    info: PreparedThreadInfo,
    options: ServerHostOptions,
    session: Session,
    canCompact: boolean,
  ): PreparedThreadContext {
    const { logger } = this.context;
    const env = info.environment;
    const { projectDir, homeDir } = env;
    const getAgents = () => loadAgents({ projectDir, logger, options });
    const getScriptRunner = () => session.scriptRunner;
    return {
      logger,
      profile: info.profile,
      homeDir,
      ...(info.initialFiles ? { initialFiles: info.initialFiles } : {}),
      ...(info.initialGitState
        ? { initialGitState: info.initialGitState }
        : {}),
      ...(info.subagentConfig ? { subagentConfig: info.subagentConfig } : {}),
      systemPrompt,
      systemInfo: info.systemInfo,
      mcpToolManager: this.mcpToolManager,
      threadManager: session,
      getScriptRunner,
      fileIO: env.fileIO,
      gitClient: env.gitClient,
      ...(session.pullRequestMonitor
        ? {
            pullRequestTracking: {
              monitor: session.pullRequestMonitor,
              // A deleted thread's supervisor is disposed; treat it as never attended.
              getLastAttention: () => session.getLastAttention(id) ?? 0,
            },
          }
        : {}),
      discoverHierarchy: (absFilePath) =>
        discoverHierarchyContext(absFilePath, {
          fileIO: hostFileIO,
          logger,
          projectDir,
          homeDir,
          hierarchyContextFileNames: options.hierarchyContextFileNames,
        }),
      clientToolCreator: clientToolCreator({
        logger,
        lspClient: env.lspClient ?? new NoopLspClient(),
        ...(env.luaExecutor !== undefined
          ? { luaExecutor: env.luaExecutor }
          : {}),
        mcpToolManager: this.mcpToolManager,
        homeDir,
        maxConcurrentSubagents: options.maxConcurrentSubagents || 3,
        maxConcurrentFastSubagents: options.maxConcurrentFastSubagents || 8,
        fileIO: env.fileIO,
        shell: env.shell,
        threadManager: session,
        getScriptRunner,
        getAgents,
      }),
      availableCapabilities: environmentCapabilities(env),
      environmentConfig: env.environmentConfig,
      ...(options.dockerfile ? { subagentDockerfile: options.dockerfile } : {}),
      ...(info.yieldSchema ? { yieldSchema: info.yieldSchema } : {}),
      getAgents,
      provider: this.getProvider(info.profile),
      // Resolved at delivery time against the session's current handle, never
      // a retired core.
      resolve: (message: PendingMessage, abandoned: Promise<Aborted>) =>
        resolveSubmission(
          message,
          {
            awaitClient: this.context.awaitClient,
            projectDir,
            homeDir,
            fileIO: env.fileIO,
            logger: this.context.logger,
            customCommands: this.context.getOptions().customCommands,
            canCompact,
            getContextFiles: () => {
              const record = session.getThread(id);
              if (record?.state !== "initialized") {
                throw new Error(`Thread ${id} is no longer available`);
              }
              return record.thread.contextFiles;
            },
          },
          abandoned,
        ),
    };
  }
}
