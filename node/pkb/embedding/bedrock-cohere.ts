import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { Embedding, EmbeddingModel } from "./types.ts";

interface CohereEmbedV4Request {
  texts: string[];
  input_type: "search_document" | "search_query";
  embedding_types: ("float" | "int8" | "uint8" | "binary" | "ubinary")[];
}

interface CohereEmbedV4Response {
  id: string;
  response_type: string;
  embeddings: {
    float?: number[][];
    int8?: number[][];
  };
  texts: string[];
}

export type BedrockCohereOptions = {
  region?: string | undefined;
};

export class BedrockCohereEmbedding implements EmbeddingModel {
  public readonly modelName = "cohere.embed-v4:0";
  public readonly dimensions = 1536;
  private client: BedrockRuntimeClient;
  private inferenceProfileId: string;

  constructor(options?: BedrockCohereOptions) {
    const region = options?.region ?? "us-east-1";
    this.client = new BedrockRuntimeClient({ region });
    // Cohere Embed v4 requires cross-region inference profile
    const regionPrefix = region.startsWith("eu-") ? "eu" : "us";
    this.inferenceProfileId = `${regionPrefix}.cohere.embed-v4:0`;
  }

  async embedChunk(chunk: string): Promise<Embedding> {
    const embeddings = await this.embedTexts([chunk], "search_document");
    return embeddings[0];
  }

  async embedQuery(query: string): Promise<Embedding> {
    const embeddings = await this.embedTexts([query], "search_query");
    return embeddings[0];
  }

  async embedChunks(chunks: string[]): Promise<Embedding[]> {
    return this.embedTexts(chunks, "search_document");
  }

  private async embedTexts(
    texts: string[],
    inputType: "search_document" | "search_query",
  ): Promise<Embedding[]> {
    const body: CohereEmbedV4Request = {
      texts,
      input_type: inputType,
      embedding_types: ["float"],
    };

    const command = new InvokeModelCommand({
      modelId: this.inferenceProfileId,
      contentType: "application/json",
      accept: "*/*",
      body: JSON.stringify(body),
    });

    const response = await this.client.send(command);
    const responseBody = JSON.parse(
      new TextDecoder().decode(response.body),
    ) as CohereEmbedV4Response;

    if (!responseBody.embeddings.float) {
      throw new Error("No float embeddings returned from Cohere");
    }

    return responseBody.embeddings.float;
  }
}
