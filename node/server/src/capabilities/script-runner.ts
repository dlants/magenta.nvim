import type { ThreadId } from "../chat-types.ts";

export type ScriptCatalogEntry = {
  name: string;
  description: string;
  parameterSchema: Record<string, unknown>;
  file: string;
};

/**
 * Root-injected capability that lets the `run_script` tool enumerate and
 * trigger discovered scripts. The actual invocation lives outside the
 * triggering thread's lifecycle (fire-and-forget); the triggering thread id is
 * passed so the root can seed the new script invocation's sandbox state.
 */
export interface ScriptRunner {
  /**
   * Re-scan the configured script paths and rebuild the catalog. Awaited
   * during thread creation so each new thread starts with an up-to-date
   * catalog.
   */
  discover(): Promise<void>;
  getScriptCatalog(): ScriptCatalogEntry[];
  runScript(opts: {
    scriptName: string;
    parameters: unknown;
    triggeringThreadId: ThreadId;
  }): void;
}
