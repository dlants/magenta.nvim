export { runScript, type EdlRegisters } from "./edl/index.ts";
export type { FileMutationSummary } from "./edl/types.ts";
export { InMemoryFileIO } from "./edl/in-memory-file-io.ts";
export type { FileIO } from "./capabilities/file-io.ts";
export { FsFileIO } from "./capabilities/file-io.ts";
export {
  Executor,
  resolveIndex,
  type InitialDocIndex,
} from "./edl/executor.ts";
export { parse } from "./edl/parser.ts";
