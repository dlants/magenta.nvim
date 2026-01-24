export type Embedding = number[];

export const MAGENTA_EMBEDDING_VERSION = 1;

export interface EmbeddingModel {
  modelName: string;
  embedChunk(chunk: string): Promise<Embedding>;
  embedQuery(query: string): Promise<Embedding>;
  embedChunks(chunks: string[]): Promise<Embedding[]>;
}

export type Position = {
  line: number;
  col: number;
};

export type ChunkData = {
  text: string;
  contextualizedText: string;
  start: Position;
  end: Position;
  embedding: {
    [modelName: string]: Embedding;
  };
  version: number;
};

export type EmbedFile = {
  hash: string;
  file: string;
  chunks: ChunkData[];
};
