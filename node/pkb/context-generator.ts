import type { Provider } from "../providers/provider-types.ts";

const CONTEXT_PROMPT = `<document>
{{WHOLE_DOCUMENT}}
</document>
Here is the chunk we want to situate within the whole document
<chunk>
{{CHUNK_CONTENT}}
</chunk>
Please give a short succinct context to situate this chunk within the overall document for the purposes of improving search retrieval of the chunk. Answer only with the succinct context and nothing else. If the chunk refers to anything ambiguously, like using abbreviations, "it", "he", etc... Make sure to disambiguate that in the context.`;

export class ContextGenerator {
  constructor(
    private provider: Provider,
    private model: string,
  ) {}

  async generateContext(document: string, chunk: string): Promise<string> {
    const prompt = CONTEXT_PROMPT.replace("{{WHOLE_DOCUMENT}}", document).replace(
      "{{CHUNK_CONTENT}}",
      chunk,
    );

    const request = this.provider.request({
      model: this.model,
      input: [{ type: "text", text: prompt }],
    });

    const response = await request.promise;
    return response.text;
  }
}
