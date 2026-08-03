export interface AuthUI {
  showOAuthFlow(authUrl: string): Promise<string>;
  showError(message: string): void;
  /** Streams the output of an interactive CLI login (e.g. `codex login`)
   *  verbatim, including the auth URL the user must open. */
  showLoginProgress(chunk: string): void;
}
