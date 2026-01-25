I want to create new functionality here, for a pkb

let's start by storing the pkb in ~/pkb

this should be a flat directory with markdown files (one already exists)

for each `.md` file, we should keep a `.embed` file in parallel. We should take the file, chunk it into overlapping N-token chunks (500 tokens ~2000 characters to start). Then we should pipe these chunks through an embedding model, and save the chunk, the file the chunk originated from, the line range of the chunk, and the embedding vector in JSON in the .embed file. When we save the embeddings, let's also mark which model was used to generate the embeddings. So for example, the embed file should contain:

```
{
  hash: 'string',
  file: 'file.md',
  cunks: [
    {
      text: 'string',
      start: {line: number; col: number},
      end: {line: number; col: number},
      embedding: {
        'coherev4': Embedding
      }
    }
  ]
}
```

We should create an update-embeddings function, which:

- checks to see the hash of each file (use md5sum... or whatever git uses)
- checks to see if the embedding hash matches (persist the hash in the embedding file)
- if not, re-embeds the whole file

We should also create a search function, which:

- takes a query, and embeds it
- loads all of the embeddings from the `.embed` files
- compares the distance between the query and each embedding
- returns the closest 10 chunks, with the source file, line range, and the full text of the chunk

For the embedding model, create an interface:

```
type Embedding = number[];
interface EmbeddingModel {
    modelName: string;
    embedCunk(chunk: string): Promise<Embedding>
    embedQuery(query: string): Promise<Embedding>
}

```

We should have access to embedding models via aws bedrock & aws sso here. Let's start with a single implementation of this interface via bedrock cohere v4 model.

put this code in node/pkb

add options to enable pkb functionality to MagentaOptions, by specifying:

```
{
    embeddingModel?: {
        provider: 'bedrock',
        model: 'coherev4'
    }
}
```

sample code

```
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

const client = new BedrockRuntimeClient({ region: "us-east-1" });

interface CohereEmbedV4Request {
  texts: string[];
  input_type: "search_document" | "search_query";
  embedding_types?: ("float" | "int8" | "uint8" | "binary" | "ubinary")[];
}

interface CohereEmbedV4Response {
  id: string;
  response_type: string;
  embeddings: {
    float?: number[][];
    int8?: number[][];
    // other types as needed
  };
  texts: string[];
}

async function embedTexts(
  texts: string[],
  inputType: "search_document" | "search_query" = "search_document"
): Promise<number[][]> {
  const body: CohereEmbedV4Request = {
    texts,
    input_type: inputType,
    embedding_types: ["float"],
  };

  const command = new InvokeModelCommand({
    modelId: "cohere.embed-v4:0",
    contentType: "application/json",
    accept: "*/*",
    body: JSON.stringify(body),
  });

  const response = await client.send(command);
  const responseBody: CohereEmbedV4Response = JSON.parse(
    new TextDecoder().decode(response.body)
  );

  return responseBody.embeddings.float!;
}

// Usage
const chunks = [
  "First chunk of text to embed",
  "Second chunk of text to embed",
  "Third chunk of text",
];

const embeddings = await embedTexts(chunks, "search_document");
console.log(`Generated ${embeddings.length} embeddings`);
console.log(`Embedding dimension: ${embeddings[0].length}`);
```
