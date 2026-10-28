import type { GitClient, GitState } from "../capabilities/git-client.ts";
import type { OutputLine, Shell, ShellResult } from "../capabilities/shell.ts";
import type {
  ClientEffectHandler,
  ClientInfo,
  ClientNotification,
  ClientRequest,
  ClientRequestHandlers,
  ClientResponse,
} from "../protocol/client.ts";
import { createClientEffectHandler } from "../protocol/client.ts";
import { Defer } from "../utils/async.ts";
import type { AbsFilePath } from "../utils/files.ts";

/** A git client whose state the test sets directly, e.g. to simulate a branch
 * switch between turns. */
export class FakeGitClient implements GitClient {
  private repos = new Map<string, GitState>();
  constructor(states?: GitState | GitState[]) {
    for (const state of [states ?? []].flat()) this.set(state);
  }
  /** Adds or replaces the repo at `state.repoRoot`. */
  set(state: GitState): void {
    this.repos.set(state.repoRoot, { ...state });
  }
  remove(repoRoot: string): void {
    this.repos.delete(repoRoot);
  }
  findRepoRoot(path: AbsFilePath): Promise<AbsFilePath | undefined> {
    const roots = [...this.repos.keys()]
      .filter((root) => path === root || path.startsWith(`${root}/`))
      .sort((a, b) => b.length - a.length);
    return Promise.resolve(roots[0] as AbsFilePath | undefined);
  }
  getState(repoRoot: AbsFilePath): Promise<GitState | undefined> {
    const state = this.repos.get(repoRoot);
    return Promise.resolve(state && { ...state });
  }
}

export type FakeShellResponse = {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
};
/** Command -> canned response. Unscripted commands stay pending until the test
 * settles them through `FakeShell.pending`. */
export type FakeShellScript = Record<string, FakeShellResponse>;

export function shellResult(response: FakeShellResponse): ShellResult {
  const output: OutputLine[] = [
    ...(response.stdout ?? "")
      .split("\n")
      .filter((text) => text.length)
      .map((text) => ({ stream: "stdout" as const, text })),
    ...(response.stderr ?? "")
      .split("\n")
      .filter((text) => text.length)
      .map((text) => ({ stream: "stderr" as const, text })),
  ];
  return {
    exitCode: response.exitCode ?? 0,
    signal: undefined,
    output,
    logFilePath: undefined,
    durationMs: 0,
  };
}

export class FakeShell implements Shell {
  readonly calls: string[] = [];
  /** Unscripted executions, in order, for the test to resolve. */
  readonly pending: { command: string; result: Defer<ShellResult> }[] = [];
  terminated = 0;

  constructor(private script: FakeShellScript = {}) {}

  execute(
    command: string,
    opts: { onOutput?: (line: OutputLine) => void; onStart?: () => void },
  ): Promise<ShellResult> {
    this.calls.push(command);
    opts.onStart?.();
    const scripted = this.script[command];
    if (scripted) {
      const result = shellResult(scripted);
      for (const line of result.output) opts.onOutput?.(line);
      return Promise.resolve(result);
    }
    const result = new Defer<ShellResult>();
    this.pending.push({ command, result });
    return result.promise;
  }

  terminate(): void {
    this.terminated++;
    for (const { result } of this.pending.splice(0)) {
      result.resolve({ ...shellResult({ exitCode: 143 }), signal: "SIGTERM" });
    }
  }
}

/** A client that records every request/notification and answers requests
 * with `respond` (default: `undefined`). */
/** Records requests/notifications; `info` is derived from which of the
 * optional handlers (`oauth`, `fileWritten`) are supplied. */
export class FakeClient implements ClientEffectHandler {
  readonly requests: ClientRequest[] = [];
  readonly notifications: ClientNotification[] = [];
  readonly info: ClientInfo;
  private inner: ClientEffectHandler;
  constructor(
    handlers: Partial<ClientRequestHandlers> = {},
    neovimVersion = "test",
  ) {
    const unhandled = (req: ClientRequest) =>
      Promise.reject(new Error(`FakeClient: unhandled ${req.type}`));
    this.inner = createClientEffectHandler({
      neovimVersion,
      handlers: {
        lsp: unhandled,
        lua: unhandled,
        expandClientCommand: unhandled,
        ...handlers,
      },
      notify: (n) => this.notifications.push(n),
    });
    this.info = this.inner.info;
  }
  request<R extends ClientRequest>(req: R): Promise<ClientResponse<R>> {
    this.requests.push(req);
    return this.inner.request(req);
  }
  notify(n: ClientNotification): void {
    this.inner.notify(n);
  }
}
