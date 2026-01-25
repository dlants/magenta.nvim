#!/usr/bin/env npx tsx
import * as os from "os";
import * as path from "path";
import { PKB } from "./pkb.ts";
import { PKBManager, type Logger } from "./pkb-manager.ts";
import { BedrockCohereEmbedding } from "./embedding/bedrock-cohere.ts";
import { BedrockProvider } from "../providers/bedrock.ts";
import type { Nvim } from "../nvim/nvim-node/types.ts";

function expandTilde(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  if (filePath === "~") {
    return os.homedir();
  }
  return filePath;
}

const logger: Logger = {
  info: (msg) => console.log(msg),
  debug: (msg) => console.log(`[debug] ${msg}`),
  error: (msg) => console.error(msg),
};

function printUsage() {
  console.error("Usage:");
  console.error("  npx tsx node/pkb/cli.ts sync <pkb-path>");
  console.error("    Sync all files in the PKB directory");
  console.error("");
  console.error("  npx tsx node/pkb/cli.ts reindex <pkb-path> <file>");
  console.error("    Force reindex a specific file (deletes and re-embeds)");
  console.error("");
  console.error("Examples:");
  console.error("  npx tsx node/pkb/cli.ts sync ~/.claude/pkb");
  console.error("  npx tsx node/pkb/cli.ts reindex ~/pkb benchling-configs.md");
}

function createPKB(pkbPath: string) {
  const resolvedPath = path.resolve(expandTilde(pkbPath));
  const embeddingModel = new BedrockCohereEmbedding();
  const provider = new BedrockProvider({ logger } as Nvim);
  return new PKB(
    resolvedPath,
    embeddingModel,
    { provider, model: "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
    { logger },
  );
}

async function syncCommand(pkbPath: string) {
  const pkb = createPKB(pkbPath);
  const manager = new PKBManager(pkb, logger);

  try {
    await manager.reindex();
  } finally {
    pkb.close();
  }
}

async function reindexFileCommand(pkbPath: string, filename: string) {
  const pkb = createPKB(pkbPath);

  try {
    // Clean up any orphan vec entries from previous failed indexing attempts
    const orphansDeleted = pkb.cleanupOrphanVecEntries();
    if (orphansDeleted > 0) {
      logger.info(`Cleaned up ${orphansDeleted} orphan vector entries`);
    }

    // Find all file records matching this filename (including those with empty hash)
    const fileIds = pkb.getFileIdsByFilename(filename);

    if (fileIds.length > 0) {
      logger.info(
        `Deleting ${fileIds.length} existing record(s) for ${filename}...`,
      );
      for (const fileId of fileIds) {
        pkb.deleteFile(fileId);
      }
    }

    logger.info(`Reindexing ${filename}...`);
    await pkb.indexFile(filename);
    logger.info("Done.");
  } finally {
    pkb.close();
  }
}

async function main() {
  const command = process.argv[2];
  const pkbPath = process.argv[3];

  if (!command || !pkbPath) {
    printUsage();
    process.exit(1);
  }

  switch (command) {
    case "sync":
      await syncCommand(pkbPath);
      break;

    case "reindex": {
      const filename = process.argv[4];
      if (!filename) {
        console.error("Error: reindex command requires a filename");
        printUsage();
        process.exit(1);
      }
      await reindexFileCommand(pkbPath, filename);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error("Command failed:", error);
  process.exit(1);
});
