# PKB Testing Plan

## Context

The goal is to create a mock embedding client for testing the PKB (Personal Knowledge Base) functionality, similar to how `MockProvider` works for the Anthropic client.

### Relevant Files and Entities

- `node/test/preamble.ts`: Test infrastructure with `withDriver`, `withNvimClient` helpers
- `node/providers/mock.ts`: `MockProvider` class - pattern to follow for mock embed client
- `node/pkb/embedding/types.ts`: `EmbeddingModel` interface with `embedChunk`, `embedQuery`, `embedChunks`
- `node/pkb/embedding/bedrock-cohere.ts`: Real implementation of `EmbeddingModel`
- `node/pkb/pkb.ts`: `PKB` class that uses `EmbeddingModel` for search and updateEmbeddings
- `node/pkb/pkb-manager.ts`: `PKBManager` that periodically calls `updateEmbeddings()`
- `node/pkb/create-pkb.ts`: `createPKB` and `createEmbeddingModel` functions
- `node/magenta.ts`: Initializes PKB via `createPKB(options.pkb)` when `options.pkb` is set
- `node/tools/searchPkb.ts`: `SearchPkbTool` - the tool that agents use to search PKB
- `node/options.ts`: `PKBOptions` type for configuring PKB

### Key Interfaces

```typescript
type Embedding = number[];

interface EmbeddingModel {
  modelName: string;
  embedChunk(chunk: string): Promise<Embedding>;
  embedQuery(query: string): Promise<Embedding>;
  embedChunks(chunks: string[]): Promise<Embedding[]>;
}
```

### Design Decisions

- Tests should NOT configure PKB by default - only when explicitly requested via `withDriver` options
- When a test configures `options.pkb` with `embeddingModel: 'mock'`, the mock embedding model becomes available on `driver.mockEmbed`
- The test is responsible for creating the pkb directory and files via `setupFiles`
- Simplified config: `{ pkb: { path: '...', embeddingModel: 'mock' } }`

Example usage:

```typescript
withDriver(
  {
    setupFiles: async (tmpDir) => {
      await fs.mkdir(path.join(tmpDir, "pkb"));
      await fs.writeFile(path.join(tmpDir, "pkb", "notes.md"), "some content");
    },
    options: {
      pkb: {
        path: "./pkb", // resolved relative to nvim cwd (tmpDir)
        embeddingModel: { provider: "mock" },
      },
    },
  },
  async (driver) => {
    const embedRequest = await driver.mockEmbed!.awaitPendingRequest();
    respondToEmbedRequest(embedRequest, [[0.1, 0.2, 0.3]]);
  },
);
```

## Implementation

- [x] Create `node/pkb/embedding/mock.ts` with `MockEmbeddingModel` class
  - [x] Implement `EmbeddingModel` interface
  - [x] Add pending request queue for `embedChunk`, `embedQuery`, `embedChunks` calls
  - [x] Add `awaitPendingRequest()` method to wait for and return pending requests
  - [x] Add ability to respond to requests with specific embeddings
  - [x] Track all requests for test assertions
  - [x] Run type checks and iterate until they pass

- [x] Update `node/pkb/create-pkb.ts` to support mock provider
  - [x] Handle `embeddingModel: { provider: 'mock' }` option
  - [x] Return mock embedding model when mock provider is requested
  - [x] Use global mock instance pattern (similar to `setMockProvider`/`getMockProvider`)
  - [x] Run type checks and iterate until they pass

- [x] Update `node/options.ts` to support mock embedding provider type
  - [x] Change `PKBEmbeddingModel` type to allow `{ provider: 'mock' }` in addition to existing type
  - [x] Run type checks and iterate until they pass

- [x] Update test infrastructure in `node/test/preamble.ts` and `node/test/driver.ts`
  - [x] Add `mockEmbed` property to `NvimDriver` (only set when PKB mock is configured)
  - [x] Wire up mock embed instance when `options.pkb.embeddingModel.provider === 'mock'`
  - [x] Run type checks and iterate until they pass

- [x] Create `node/tools/searchPkb.spec.ts` with end-to-end test
  - [x] Test setup: use `setupFiles` to create pkb directory and markdown files
  - [x] Test setup: configure `options.pkb` with mock provider and path
  - [x] Test: await embedding requests for the files and respond with test embeddings
  - [x] Test: simulate user sending a message, agent uses search_pkb tool
  - [x] Test: assert search results contain expected chunks based on embedding similarity
  - [x] Run tests and iterate until they pass

- [x] Add unit tests for `MockEmbeddingModel` in `node/pkb/embedding/mock.spec.ts`
  - [x] Test request/response flow
  - [x] Test multiple concurrent requests
  - [x] Run tests and iterate until they pass
