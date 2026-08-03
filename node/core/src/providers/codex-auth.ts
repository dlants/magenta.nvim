import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * ChatGPT-subscription auth for the Codex backend.
 *
 * Magenta never runs the OAuth flow itself. It reads the credentials the
 * `codex` CLI leaves behind, refreshes them non-interactively while the refresh
 * token is still good, and shells out to `codex login` when it isn't.
 */
export type CodexTokens = {
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id: string;
};

export type CodexCredentials = { accessToken: string; accountId: string };

type CodexAuthFile = {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: CodexTokens;
  last_refresh?: string;
};

// The Codex CLI's public OAuth client id. A refresh is only honored for the
// client the refresh token was issued to.
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";

/** Access tokens live about an hour; refresh early so a long stream can't
 *  expire mid-flight. */
const REFRESH_BEFORE_MS = 5 * 60 * 1000;

export type CodexAuthErrorKind =
  | "not-logged-in"
  | "credentials-in-keyring"
  | "refresh-failed"
  | "codex-not-installed"
  | "login-failed";

export class CodexAuthError extends Error {
  constructor(
    readonly kind: CodexAuthErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "CodexAuthError";
  }
}

export type LoginOptions = {
  /** Streamed verbatim as the CLI prints it — including the auth URL. We do not
   *  parse it, so a codex CLI change can't silently break the flow. */
  onOutput?: (chunk: string) => void;
  signal?: AbortSignal | undefined;
};

export type CodexAuthDeps = {
  /** Defaults to $CODEX_HOME, else ~/.codex */
  home?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export class CodexAuth {
  private readonly home: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  /** Concurrent callers must share one refresh: the refresh token rotates, so a
   *  second concurrent refresh would present an already-spent token. */
  private inFlightRefresh: Promise<CodexTokens> | undefined;
  /** Likewise for login: two `codex login` processes would fight over the
   *  callback port. */
  private inFlightLogin: Promise<void> | undefined;

  constructor(deps: CodexAuthDeps = {}) {
    this.home =
      deps.home ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  get authPath(): string {
    return path.join(this.home, "auth.json");
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      const file = await this.readAuthFile();
      return Boolean(file.tokens?.access_token && file.tokens.refresh_token);
    } catch {
      return false;
    }
  }

  /** A valid bearer token and account id, refreshed in place if needed. */
  async getCredentials(): Promise<CodexCredentials> {
    const file = await this.readAuthFile();
    const tokens = file.tokens;
    if (!tokens?.access_token || !tokens.refresh_token) {
      throw new CodexAuthError(
        "not-logged-in",
        `No ChatGPT tokens in ${this.authPath}. Run \`codex login\`.`,
      );
    }

    if (!this.needsRefresh(tokens.access_token)) {
      return { accessToken: tokens.access_token, accountId: tokens.account_id };
    }

    const refreshed = await this.refresh(tokens);
    return {
      accessToken: refreshed.access_token,
      accountId: refreshed.account_id,
    };
  }

  /** Force a refresh regardless of expiry — the reactive path after a 401. */
  async refreshCredentials(): Promise<CodexCredentials> {
    const file = await this.readAuthFile();
    const tokens = file.tokens;
    if (!tokens?.refresh_token) {
      throw new CodexAuthError(
        "not-logged-in",
        `No ChatGPT tokens in ${this.authPath}. Run \`codex login\`.`,
      );
    }
    const refreshed = await this.refresh(tokens);
    return {
      accessToken: refreshed.access_token,
      accountId: refreshed.account_id,
    };
  }

  /**
   * Run `codex login` on the user's behalf. The CLI opens the browser and
   * completes the exchange on its own callback port, so there is nothing for us
   * to intercept — we only surface its output and wait.
   */
  login(options: LoginOptions = {}): Promise<void> {
    if (this.inFlightLogin) return this.inFlightLogin;

    this.inFlightLogin = new Promise<void>((resolve, reject) => {
      const child = spawn("codex", ["login"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });

      const emit = (chunk: Buffer) => options.onOutput?.(chunk.toString());
      child.stdout?.on("data", emit);
      child.stderr?.on("data", emit);

      const onAbort = () => child.kill("SIGTERM");
      options.signal?.addEventListener("abort", onAbort, { once: true });

      child.on("error", (err: NodeJS.ErrnoException) => {
        options.signal?.removeEventListener("abort", onAbort);
        reject(
          err.code === "ENOENT"
            ? new CodexAuthError(
                "codex-not-installed",
                "The `codex` CLI is not on PATH. Install it to use ChatGPT subscription auth.",
              )
            : new CodexAuthError("login-failed", err.message),
        );
      });

      child.on("close", (code, signal) => {
        options.signal?.removeEventListener("abort", onAbort);
        if (code === 0) {
          resolve();
        } else {
          reject(
            new CodexAuthError(
              "login-failed",
              signal
                ? `\`codex login\` was terminated (${signal}).`
                : `\`codex login\` exited with code ${code}.`,
            ),
          );
        }
      });
    }).finally(() => {
      this.inFlightLogin = undefined;
    });

    return this.inFlightLogin;
  }

  private needsRefresh(accessToken: string): boolean {
    const exp = expiresAt(accessToken);
    // An unparseable token is refreshed rather than trusted.
    if (exp === undefined) return true;
    return exp - this.now() <= REFRESH_BEFORE_MS;
  }

  private async readAuthFile(): Promise<CodexAuthFile> {
    let raw: string;
    try {
      raw = await fs.readFile(this.authPath, "utf8");
    } catch {
      throw await this.missingCredentialsError();
    }
    return JSON.parse(raw) as CodexAuthFile;
  }

  /** Distinguishes "never logged in" from "logged in, but the CLI is
   *  configured to keep credentials in the OS keyring", which we can't read. */
  private async missingCredentialsError(): Promise<CodexAuthError> {
    let config = "";
    try {
      config = await fs.readFile(path.join(this.home, "config.toml"), "utf8");
    } catch {
      // no config is fine — fall through to the generic message
    }

    const store = /cli_auth_credentials_store\s*=\s*"([^"]+)"/.exec(
      config,
    )?.[1];
    if (store === "keyring") {
      return new CodexAuthError(
        "credentials-in-keyring",
        `The codex CLI is configured to store credentials in the OS keyring, which magenta cannot read. ` +
          `Set \`cli_auth_credentials_store = "file"\` in ${path.join(this.home, "config.toml")} and run \`codex login\` again.`,
      );
    }

    return new CodexAuthError(
      "not-logged-in",
      `No codex credentials at ${this.authPath}. Run \`codex login\`.`,
    );
  }

  private refresh(tokens: CodexTokens): Promise<CodexTokens> {
    if (this.inFlightRefresh) return this.inFlightRefresh;

    this.inFlightRefresh = this.doRefresh(tokens).finally(() => {
      this.inFlightRefresh = undefined;
    });
    return this.inFlightRefresh;
  }

  private async doRefresh(tokens: CodexTokens): Promise<CodexTokens> {
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CODEX_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        scope: "openid profile email",
      }),
    });

    if (!res.ok) {
      throw new CodexAuthError(
        "refresh-failed",
        `Could not refresh ChatGPT credentials (${res.status}). Run \`codex login\`.`,
      );
    }

    const body = (await res.json()) as {
      id_token?: string;
      access_token?: string;
      refresh_token?: string;
    };

    const next: CodexTokens = {
      ...tokens,
      id_token: body.id_token ?? tokens.id_token,
      access_token: body.access_token ?? tokens.access_token,
      refresh_token: body.refresh_token ?? tokens.refresh_token,
    };

    await this.writeTokens(next);
    return next;
  }

  /** Re-reads before writing: the codex CLI may be running concurrently and
   *  owns fields we don't understand. */
  private async writeTokens(tokens: CodexTokens): Promise<void> {
    const current = await this.readAuthFile();
    const updated: CodexAuthFile = {
      ...current,
      tokens,
      last_refresh: new Date(this.now()).toISOString(),
    };
    const tmp = `${this.authPath}.magenta.tmp`;
    await fs.writeFile(tmp, JSON.stringify(updated, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.authPath);
    await fs.chmod(this.authPath, 0o600);
  }
}

function expiresAt(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { exp?: number };
    return claims.exp === undefined ? undefined : claims.exp * 1000;
  } catch {
    return undefined;
  }
}
