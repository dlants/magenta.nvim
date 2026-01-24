# Context

The goal is to implement Contextual Retrieval for the PKB (Personal Knowledge Base) system. Based on the Anthropic article, Contextual Retrieval improves RAG accuracy by prepending chunk-specific explanatory context to each chunk before embedding.

The key idea: instead of embedding raw chunks like "The company's revenue grew by 3%", we prepend context like "This chunk is from an SEC filing on ACME corp's performance in Q2 2023..." to make the chunk more semantically meaningful and improve retrieval accuracy.

## Relevant files and entities

- `node/pkb/pkb.ts`: Main PKB class with `updateEmbeddings()` and `search()` methods
- `node/pkb/chunker.ts`: `chunkText()` function that splits documents into chunks
- `node/pkb/embedding/types.ts`: `EmbedFile`, `ChunkData`, `EmbeddingModel` interfaces
- `node/pkb/create-pkb.ts`: Factory function to create PKB instances
- `node/options.ts`: `PKBOptions` type definition, `Profile` type with `fastModel`
- `node/providers/anthropic.ts`: `AnthropicProvider` class for making API calls
- `node/providers/provider.ts`: `getProvider()` function to get provider instances

## Design decisions

1. **Use the fast model (e.g., claude-haiku)** to generate context for each chunk - this is cost-effective for high-volume context generation
2. **Store contextualized text separately from raw text** in `ChunkData` so we can:
   - Regenerate context if the model changes
   - Show users the raw chunk while searching with the contextualized version
3. **Make context generation configurable** via PKB options
4. **Use simple API calls** rather than the full Agent interface since we just need a single text completion

# Implementation

- [x] Add context generation types
  - [x] Add `contextualizedText` field to `ChunkData` type in `node/pkb/embedding/types.ts`
  - [x] Check for type errors and iterate until they pass

- [x] Add a `request` method to the Provider interface
  - [x] Add `ProviderTextRequest` interface to `node/providers/provider-types.ts` (similar to `ProviderToolUseRequest`)
  - [x] Add `request(options: { model: string; input: AgentInput[]; systemPrompt?: string }): ProviderTextRequest` method to `Provider` interface
  - [x] Implement the `request` method in `AnthropicProvider` (similar to `forceToolUse`)
  - [x] Implement the `request` method in `BedrockProvider` (inherited from AnthropicProvider)
  - [x] Check for type errors and iterate until they pass
  - [x] update the MockProvider to support this new method.

- [x] Create a context generator module
  - [x] Create `node/pkb/context-generator.ts` with a `ContextGenerator` class
  - [x] The class should:
    - Accept a `Provider` and model name in constructor
    - Have a method `generateContext(document: string, chunk: string): Promise<string>`
    - Use `provider.request()` to make the API call
    - Use this prompt structure from the article:
      ```
      <document>
      {{WHOLE_DOCUMENT}}
      </document>
      Here is the chunk we want to situate within the whole document
      <chunk>
      {{CHUNK_CONTENT}}
      </chunk>
      Please give a short succinct context to situate this chunk within the overall document for the purposes of improving search retrieval of the chunk. Answer only with the succinct context and nothing else. If the chunk refers to anything ambiguously, like using abbreviations, "it", "he", etc... Make sure to disambiguate that in the context.
      ```
  - [x] Iterate until no type errors

- [x] Integrate context generation into PKB
  - [x] Modify `createPKB()` in `node/pkb/create-pkb.ts` to create a context generator
  - [x] Modify `PKB.updateEmbeddings()` to:
    - Generate context for each chunk (if context generator is configured)
    - Store contextualizedText in ChunkData
    - Embed the contextualized text instead of raw text
  - [x] Modify `PKB.search()` to return contextualized text
  - [x] Update tests in `node/pkb/pkb.spec.ts`
  - [x] Check for type errors and iterate until tests pass

- [x] Update the searchPkb.spec.ts tests to verify that contextual augmentation requests go out to the mock provider. Respond to each request via the mock interface, then verify that the augmented content is returned in search.
