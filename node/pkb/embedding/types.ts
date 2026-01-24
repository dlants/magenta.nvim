export type Embedding = number[];

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
  start: Position;
  end: Position;
  embedding: {
    [modelName: string]: Embedding;
  };
};

export type EmbedFile = {
  hash: string;
  file: string;
  chunks: ChunkData[];
};
