#!/usr/bin/env npx tsx
import * as os from "os";
import * as path from "path";
import { PKB } from "./pkb.ts";
import { PKBManager, type Logger } from "./pkb-manager.ts";
import { BedrockCohereEmbedding } from "./embedding/bedrock-cohere.ts";
import { AnthropicProvider } from "../providers/anthropic.ts";
import type { Nvim } from "../nvim/nvim-node/types.ts";

const pkbPath = process.argv[2];

if (!pkbPath) {
  console.error("Usage: npx tsx node/pkb/reindex.ts <pkb-path>");
  console.error("Example: npx tsx node/pkb/reindex.ts ~/.claude/pkb");
  process.exit(1);
}

function expandTilde(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  if (filePath === "~") {
    return os.homedir();
  }
  return filePath;
}

const resolvedPath = path.resolve(expandTilde(pkbPath));

const logger: Logger = {
  info: (msg) => console.log(msg),
  debug: (msg) => console.log(`[debug] ${msg}`),
  error: (msg) => console.error(msg),
};

async function main() {
  const embeddingModel = new BedrockCohereEmbedding();
  const provider = new AnthropicProvider({ logger } as Nvim);
  const pkb = new PKB(
    resolvedPath,
    embeddingModel,
    { provider, model: "claude-haiku-4-5" },
    { logger },
  );
  const manager = new PKBManager(pkb, logger);

  try {
    await manager.reindex();
  } finally {
    pkb.close();
  }
}

main().catch((error) => {
  console.error("Reindex failed:", error);
  process.exit(1);
});
