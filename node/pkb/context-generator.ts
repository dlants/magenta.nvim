import type { Provider } from "../providers/provider-types.ts";

const CONTEXT_PROMPT = `<document>
{{WHOLE_DOCUMENT}}
</document>
Here is the chunk we want to situate within the whole document
<chunk>
{{CHUNK_CONTENT}}
</chunk>
Provide succinct context to situate this chunk within the overall document for the purposes of improving search retrieval of the chunk.
Do not repeat any context that can be inferred from the headings, as those will be included in the chunk.
If the chunk uses abbreviations, "it", "he", etc... Make sure to disambiguate that.
Answer only with the context and nothing else.`;

export class ContextGenerator {
  constructor(
    private provider: Provider,
    private model: string,
  ) {}

  async generateContext(document: string, chunk: string): Promise<string> {
    const prompt = CONTEXT_PROMPT.replace(
      "{{WHOLE_DOCUMENT}}",
      document,
    ).replace("{{CHUNK_CONTENT}}", chunk);

    const request = this.provider.request({
      model: this.model,
      input: [{ type: "text", text: prompt }],
    });

    const response = await request.promise;
    return response.text;
  }
}
