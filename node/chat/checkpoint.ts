import type { ProviderCheckpointContent } from "../providers/provider-types.ts";

const CHECKPOINT_PREFIX = "<checkpoint:";
const CHECKPOINT_SUFFIX = ">";
const ID_LENGTH = 6;
const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

let checkpointCounter = 0;
let useSequentialIds = false;

/** Enable sequential checkpoint IDs for deterministic testing */
export function enableSequentialCheckpointIds(): void {
  useSequentialIds = true;
  checkpointCounter = 0;
}

/** Reset to random checkpoint IDs (default behavior) */
export function disableSequentialCheckpointIds(): void {
  useSequentialIds = false;
  checkpointCounter = 0;
}

export function generateCheckpointId(): string {
  if (useSequentialIds) {
    const id = String(checkpointCounter++).padStart(ID_LENGTH, "0");
    return id;
  }

  let id = "";
  for (let i = 0; i < ID_LENGTH; i++) {
    id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  }
  return id;
}

export function createCheckpointContent(id: string): ProviderCheckpointContent {
  return {
    type: "checkpoint",
    id,
  };
}

export function checkpointToText(id: string): string {
  return `${CHECKPOINT_PREFIX}${id}${CHECKPOINT_SUFFIX}`;
}

export function parseCheckpointFromText(text: string): string | undefined {
  const match = text.match(
    new RegExp(
      `${escapeRegex(CHECKPOINT_PREFIX)}([a-z0-9]{${ID_LENGTH}})${escapeRegex(CHECKPOINT_SUFFIX)}`,
    ),
  );
  return match ? match[1] : undefined;
}

export function isCheckpointText(text: string): boolean {
  return (
    text.startsWith(CHECKPOINT_PREFIX) &&
    text.endsWith(CHECKPOINT_SUFFIX) &&
    text.length ===
      CHECKPOINT_PREFIX.length + ID_LENGTH + CHECKPOINT_SUFFIX.length
  );
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
