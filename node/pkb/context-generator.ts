import type { Provider, Usage } from "../providers/provider-types.ts";

export type ContextResult = {
  context: string;
  usage: Usage;
};

// The document prompt is sent as a separate input so it can be cached across chunks
const DOCUMENT_PROMPT = `<document>
{{WHOLE_DOCUMENT}}
</document>

Use the document to provide context to improve search retrieval of chunks from this document.

<example>
Chunk:
# AWS S3 Configuration Guide
Set the ACL to private to restrict access. It prevents unauthorized users from reading or writing objects.

output: This chunk describes AWS S3 bucket access control configuration. ACL refers to Access Control List.
</example>

<example>
Chunk:
# Survey results
The customer mentioned that the SPA was a bit slow to load.

output: The customer here is "Company A". SPA stands for "Single page app". The survey is the 2025 user engagement survey.
</example>

<example>
Chunk:
# Troubleshooting
Check the logs using kubectl logs. If OOMKilled, increase the memory limit in the resource spec.

output: Troubleshooting steps for Kubernetes pods in CrashLoopBackOff state. OOMKilled stands for "out of memory killed" and refers to the pod being terminated due to exceeding its memory limit. The resource spec refers to the pod's resource requests and limits configuration in the deployment manifest.
</example>`;

const CHUNK_PROMPT = `Here is the chunk we want to situate within the whole document.
<chunk>
{{CHUNK_CONTENT}}
</chunk>
Answer only with the output and nothing else.`;

export async function generateContext(
  provider: Provider,
  model: string,
  document: string,
  chunk: string,
): Promise<ContextResult> {
  const systemPrompt = DOCUMENT_PROMPT.replace("{{WHOLE_DOCUMENT}}", document);
  const chunkPrompt = CHUNK_PROMPT.replace("{{CHUNK_CONTENT}}", chunk);

  const request = provider.request({
    model,
    systemPrompt,
    input: [{ type: "text", text: chunkPrompt }],
  });

  const response = await request.promise;
  return {
    context: response.text,
    usage: response.usage,
  };
}
