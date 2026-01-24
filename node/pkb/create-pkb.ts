import * as os from "os";
import * as path from "path";
import type { PKBOptions } from "../options.ts";
import type { NvimCwd } from "../utils/files.ts";
import { PKB } from "./pkb.ts";
import { BedrockCohereEmbedding } from "./embedding/bedrock-cohere.ts";
import type { EmbeddingModel } from "./embedding/types.ts";
import {
  MockEmbeddingModel,
  getMockEmbeddingModel,
  setMockEmbeddingModel,
} from "./embedding/mock.ts";

export const DEFAULT_PKB_PATH = path.join(os.homedir(), "pkb");

export function createEmbeddingModel(
  options: PKBOptions["embeddingModel"],
): EmbeddingModel {
  if (options.provider === "mock") {
    let mockModel = getMockEmbeddingModel();
    if (!mockModel) {
      mockModel = new MockEmbeddingModel();
      setMockEmbeddingModel(mockModel);
    }
    return mockModel;
  }

  if (options.provider === "bedrock" && options.model === "cohere.embed-v4:0") {
    return new BedrockCohereEmbedding({ region: options.region });
  }

  throw new Error(`Unknown embedding model: ${JSON.stringify(options)}`);
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

export function createPKB(options: PKBOptions, cwd: NvimCwd): PKB {
  const embeddingModel = createEmbeddingModel(options.embeddingModel);
  const pkbPath = options.path ?? DEFAULT_PKB_PATH;
  const expandedPath = expandTilde(pkbPath);
  const resolvedPath = path.isAbsolute(expandedPath)
    ? expandedPath
    : path.join(cwd, expandedPath);
  return new PKB(resolvedPath, embeddingModel);
}
