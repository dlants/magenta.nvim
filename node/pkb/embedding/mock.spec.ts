import { describe, it, expect, beforeEach } from "vitest";
import {
  MockEmbeddingModel,
  respondToEmbedRequest,
  setMockEmbeddingModel,
} from "./mock.ts";

describe("MockEmbeddingModel", () => {
  let mockModel: MockEmbeddingModel;

  beforeEach(() => {
    mockModel = new MockEmbeddingModel();
    setMockEmbeddingModel(undefined);
  });

  describe("embedChunk", () => {
    it("should queue request and resolve when responded", async () => {
      const chunkPromise = mockModel.embedChunk("test chunk");

      const request = await mockModel.awaitPendingRequest();
      expect(request.type).toBe("chunk");
      expect(request.input).toBe("test chunk");

      respondToEmbedRequest(request, [0.1, 0.2, 0.3]);

      const result = await chunkPromise;
      expect(result).toEqual([0.1, 0.2, 0.3]);
    });
  });

  describe("embedQuery", () => {
    it("should queue request and resolve when responded", async () => {
      const queryPromise = mockModel.embedQuery("search query");

      const request = await mockModel.awaitPendingRequest();
      expect(request.type).toBe("query");
      expect(request.input).toBe("search query");

      respondToEmbedRequest(request, [0.4, 0.5, 0.6]);

      const result = await queryPromise;
      expect(result).toEqual([0.4, 0.5, 0.6]);
    });
  });

  describe("embedChunks", () => {
    it("should queue request and resolve when responded", async () => {
      const chunksPromise = mockModel.embedChunks(["chunk1", "chunk2"]);

      const request = await mockModel.awaitPendingRequest();
      expect(request.type).toBe("chunks");
      expect(request.input).toEqual(["chunk1", "chunk2"]);

      respondToEmbedRequest(request, [
        [0.1, 0.2],
        [0.3, 0.4],
      ]);

      const result = await chunksPromise;
      expect(result).toEqual([
        [0.1, 0.2],
        [0.3, 0.4],
      ]);
    });
  });

  describe("awaitPendingRequestWithInput", () => {
    it("should find request matching input string", async () => {
      void mockModel.embedChunk("first chunk");
      void mockModel.embedChunk("second chunk");

      const request = await mockModel.awaitPendingRequestWithInput("second");
      expect(request.input).toBe("second chunk");
    });
  });

  describe("multiple concurrent requests", () => {
    it("should handle multiple requests independently", async () => {
      const promise1 = mockModel.embedChunk("chunk1");
      const promise2 = mockModel.embedQuery("query1");
      const promise3 = mockModel.embedChunks(["a", "b"]);

      expect(mockModel.getPendingRequests()).toHaveLength(3);

      const requests = mockModel.getAllRequests();
      respondToEmbedRequest(requests[0], [0.1]);
      respondToEmbedRequest(requests[1], [0.2]);
      respondToEmbedRequest(requests[2], [[0.3], [0.4]]);

      const [result1, result2, result3] = await Promise.all([
        promise1,
        promise2,
        promise3,
      ]);

      expect(result1).toEqual([0.1]);
      expect(result2).toEqual([0.2]);
      expect(result3).toEqual([[0.3], [0.4]]);
      expect(mockModel.getPendingRequests()).toHaveLength(0);
    });
  });
});
