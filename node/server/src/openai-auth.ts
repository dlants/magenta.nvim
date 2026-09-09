import type { CodexCredentials, LoginOptions } from "./providers/codex-auth.ts";

/**
 * The slice of {@link CodexAuth} the OpenAI provider depends on. Declared
 * structurally so tests can substitute a stub without a filesystem.
 */
export interface OpenAIAuth {
  isAuthenticated(): Promise<boolean>;
  getCredentials(): Promise<CodexCredentials>;
  /** Unconditional refresh — the reactive path after a 401. */
  refreshCredentials(): Promise<CodexCredentials>;
  login(options?: LoginOptions): Promise<void>;
}
