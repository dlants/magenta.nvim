import type { Embedding, EmbeddingModel } from "./types.ts";
import { Defer, pollUntil } from "../../utils/async.ts";

export type EmbedRequestType = "chunk" | "query" | "chunks";

export type MockEmbedRequest = {
  type: EmbedRequestType;
  input: string | string[];
  defer: Defer<Embedding | Embedding[]>;
};

let mockEmbeddingModel: MockEmbeddingModel | undefined;

export function setMockEmbeddingModel(
  model: MockEmbeddingModel | undefined,
): void {
  mockEmbeddingModel = model;
}

export function getMockEmbeddingModel(): MockEmbeddingModel | undefined {
  return mockEmbeddingModel;
}

export class MockEmbeddingModel implements EmbeddingModel {
  public modelName = "mock-embedding";
  public dimensions = 3;
  public requests: MockEmbedRequest[] = [];

  async embedChunk(chunk: string): Promise<Embedding> {
    const defer = new Defer<Embedding | Embedding[]>();
    const request: MockEmbedRequest = {
      type: "chunk",
      input: chunk,
      defer,
    };
    this.requests.push(request);
    return defer.promise as Promise<Embedding>;
  }

  async embedQuery(query: string): Promise<Embedding> {
    const defer = new Defer<Embedding | Embedding[]>();
    const request: MockEmbedRequest = {
      type: "query",
      input: query,
      defer,
    };
    this.requests.push(request);
    return defer.promise as Promise<Embedding>;
  }

  async embedChunks(chunks: string[]): Promise<Embedding[]> {
    const defer = new Defer<Embedding | Embedding[]>();
    const request: MockEmbedRequest = {
      type: "chunks",
      input: chunks,
      defer,
    };
    this.requests.push(request);
    return defer.promise as Promise<Embedding[]>;
  }

  async awaitPendingRequest(message?: string): Promise<MockEmbedRequest> {
    return pollUntil(
      () => {
        const pendingRequest = this.requests.find((r) => !r.defer.resolved);
        if (!pendingRequest) {
          throw new Error(
            `No pending embed requests. ${message ?? ""} Total requests: ${this.requests.length}`,
          );
        }
        return pendingRequest;
      },
      { timeout: 2000 },
    );
  }

  async awaitPendingRequestWithInput(
    input: string | string[],
    message?: string,
  ): Promise<MockEmbedRequest> {
    return pollUntil(
      () => {
        const inputStr = Array.isArray(input) ? JSON.stringify(input) : input;
        const pendingRequest = this.requests.find((r) => {
          if (r.defer.resolved) return false;
          const reqInput = Array.isArray(r.input)
            ? JSON.stringify(r.input)
            : r.input;
          return reqInput.includes(inputStr);
        });
        if (!pendingRequest) {
          throw new Error(
            `No pending embed request with input "${inputStr}". ${message ?? ""} Total requests: ${this.requests.length}`,
          );
        }
        return pendingRequest;
      },
      { timeout: 2000 },
    );
  }

  getPendingRequests(): MockEmbedRequest[] {
    return this.requests.filter((r) => !r.defer.resolved);
  }

  getAllRequests(): MockEmbedRequest[] {
    return [...this.requests];
  }
}

export function respondToEmbedRequest(
  request: MockEmbedRequest,
  embeddings: Embedding | Embedding[],
): void {
  request.defer.resolve(embeddings);
}
