export { attach } from "./attach.ts";

export * from "./types.ts";

export const NVIM_LOG_LEVELS = {
  TRACE: 0,
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
  OFF: 5,
} as const;
