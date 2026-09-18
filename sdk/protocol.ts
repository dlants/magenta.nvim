/**
 * Compatibility re-export: the IPC protocol between the script process (SDK)
 * and the magenta process is owned by the server package, which runs the
 * magenta side of the channel. SDK consumers keep importing it from here.
 *
 * These are type-only re-exports, so the SDK still has no runtime dependency
 * on the server package.
 */
export type {
  JSONSchema,
  MagentaToScript,
  ScriptMeta,
  ScriptResult as Result,
  ScriptToMagenta,
  ThreadOptions,
} from "@magenta/server";
