/**
 * Shared IPC protocol types exchanged over the child-process IPC channel
 * between the script process (SDK) and the magenta process (ScriptManager).
 *
 * This module is fully self-contained: it imports nothing (no node/core, no
 * root project, no third-party package). The root project imports these types
 * FROM here; the SDK never imports back.
 */

/** A JSON Schema object. Kept permissive to avoid a third-party dependency. */
export type JSONSchema = { [key: string]: unknown };

export type Result<T> =
  | { status: "ok"; value: T }
  | { status: "error"; error: string };

/**
 * Options for a thread() invocation. Designed to be extended later; unknown or
 * omitted fields fall back to the active profile and magenta cwd.
 */
export type ThreadOptions = {
  profile?: string;
  model?: string;
  tools?: string[];
  cwd?: string;
  /** Files to seed into the thread's context (absolute, or relative to cwd). */
  contextFiles?: string[];
  /** A recurring system reminder injected into the thread. */
  systemReminder?: string;
  /** Override the global auto-compact input-token threshold for this thread. */
  autoCompactThreshold?: number;
  /** Override the global auto-compact prompt template for this thread. */
  autoCompactPrompt?: string;
};

export type ScriptMeta = {
  name: string;
  description: string;
  parameterSchema: JSONSchema;
};

/** Messages sent from the script process to the magenta process. */
export type ScriptToMagenta =
  | { type: "register"; scripts: ScriptMeta[] }
  | {
      type: "create-thread";
      requestId: number;
      prompt: string;
      yieldSchema: JSONSchema;
      options?: ThreadOptions;
    }
  | { type: "log"; message: string }
  | { type: "done" }
  | { type: "error"; message: string };

/** Messages sent from the magenta process to the script process. */
export type MagentaToScript =
  | { type: "run-script"; scriptName: string; parameters: unknown }
  | { type: "thread-result"; requestId: number; result: Result<unknown> };
