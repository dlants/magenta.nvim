import {
  createInProcessServer,
  GhCliGitHubClient,
  type HomeDir,
  type Logger,
  type MagentaServer,
  type ProjectDir,
  PullRequestMonitor,
  type Sandbox,
  ScriptManager,
  type ScriptRunner,
  ServerSessionHost,
  Session,
  type SessionId,
} from "@magenta/server";
import type { MagentaOptions } from "./options.ts";

/** The composition root: the only nvimclient module that constructs server
 * objects. Everything else talks to the returned `MagentaServer`. */
export type InProcessServer = {
  server: MagentaServer;
  sessionId: SessionId;
  host: ServerSessionHost;
  scriptRunner: ScriptRunner;
  /** White-box access for tests only. */
  internals: { session: Session; scripts: ScriptManager };
};

export function startInProcessServer(deps: {
  logger: Logger;
  cwd: ProjectDir;
  homeDir: HomeDir;
  sandbox: Sandbox;
  /** Options without the session's profile selection. */
  getBaseOptions: () => MagentaOptions;
  getScriptsPaths: () => MagentaOptions["scriptsPaths"];
}): InProcessServer {
  const host = new ServerSessionHost({
    logger: deps.logger,
    projectDir: deps.cwd,
    homeDir: deps.homeDir,
    sandbox: deps.sandbox,
    getOptions: deps.getBaseOptions,
    getClient: () => session.getClient(),
    awaitClient: () => session.awaitClient(),
  });
  const session: Session = new Session(host, {
    pullRequestMonitor: new PullRequestMonitor({
      client: new GhCliGitHubClient(),
      logger: deps.logger,
    }),
  });
  const scripts = new ScriptManager({
    session,
    logger: deps.logger,
    projectDir: deps.cwd,
    homeDir: deps.homeDir,
    getScriptsPaths: deps.getScriptsPaths,
    sandbox: {
      isThreadBypassed: (threadId) => session.isSandboxBypassed(threadId),
      registerSandboxRoot: (threadId, getSandboxRoot) =>
        session.registerSandboxRoot(threadId, getSandboxRoot),
      approveAllPendingInSubtree: (threadId) =>
        session.approveAllPendingInSubtree(threadId),
    },
  });
  // Wired before any thread exists, so the run_script tool always has a
  // catalog to read.
  session.scriptRunner = scripts;
  const inner = createInProcessServer({ session, scripts });
  const server: MagentaServer = {
    ...inner,
    async dispose() {
      // Each teardown runs even if an earlier one fails: the session must be
      // disposed, otherwise in-flight threads never settle.
      try {
        await inner.dispose();
      } finally {
        try {
          await scripts.dispose();
        } finally {
          await session.dispose();
        }
      }
    },
  };
  return {
    server,
    sessionId: session.id,
    host,
    scriptRunner: scripts,
    internals: { session, scripts },
  };
}
