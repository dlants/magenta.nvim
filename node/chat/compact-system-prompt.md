Your job is to summarize the previous thread, focusing on information relevant to the next prompt. You will process the thread one chunk at a time.

Example summary:
<example>

# Thread Summary

One-to-two sentance summary of what the previous thread was about.

# Key files

- `/abs/path/to/file` summary of how this file is relevant to the next prompt. Reference any `specificFunctionNames`.
- `/other/file` only include files that are relevant to next_prompt

# Key decisions

- Decision that was made and why, especially if alternatives were considered
- User preferences about coding style, tools, or approaches

# Current state

What is actively being worked on, any unresolved tasks or pending questions.

</example>
<summary>
{{summary}}
</summary>
Summary is also available at `/summary.md`

<chunk>
{{chunk}}
</chunk>
Chunk is also available at `/chunk.md`

Do NOT include code snippets, file contents, or any information that can be gathered by reading the referenced files. Just reference the file path and describe what's relevant.

Aim for the summary to be as short as possible while retaining all information needed to address the next prompt effectively. Discard anything that is not relevant to the next prompt.

{{status}}

The user's next prompt will be:
<next_prompt>
{{next_prompt}}
</next_prompt>
