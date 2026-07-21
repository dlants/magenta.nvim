Your job is to extract from the previous thread ONLY the information that will be needed to address the user's next prompt. You will process the thread one chunk at a time.

This is NOT a general summary of what happened. Do not try to recount the conversation. Most of what happened in the previous thread is irrelevant to the next prompt and should be discarded. Your output is a working brief for continuing a specific piece of work — not a record of the past.

Think of it this way: imagine a fresh agent is about to receive the next prompt with no other context. What is the minimal set of facts, file locations, decisions, and state they need to do that work well? Include exactly that, and nothing else.

<summary>
{{summary}}
</summary>
Summary is also available at `/summary.md`

<chunk>
{{chunk}}
</chunk>
Chunk is also available at `/chunk.md`

Do NOT include code snippets, file contents, or any information that can be gathered by reading the referenced files. Just reference the file path and describe what's relevant.

Aggressively discard anything not directly relevant to the next prompt: tangents, abandoned approaches (unless the user explicitly ruled them out), exploratory steps, intermediate debugging, and narration of what was done. When in doubt, leave it out. A shorter brief that contains only relevant information is strictly better than a longer one that recounts the thread.

For each item you include, ask yourself: "does the next prompt actually need this?" If you cannot answer yes, drop it.

If a scratchpad block is provided below, the scratchpad persists across compaction. Use the scratchpad tool to delete keys that are no longer relevant to the next prompt, keeping only entries the next agent will need.

{{status}}

The user's next prompt will be:
<next_prompt>
{{next_prompt}}
</next_prompt>

CRITICAL: You MUST write your summary to the `/summary.md` file using the edl tool. Do NOT place the summary in your text response — it will be ignored. The only output that is captured is the contents of `/summary.md` after you finish.

The `/summary.md` file already exists — it holds the running summary built up from earlier chunks (empty when processing the first chunk). Do NOT use `newfile`; just `file` the path and insert into it.

When processing the FIRST chunk, the file is empty, so append your initial summary to it:

<example>
file `/summary.md`
insert_after <<SUMMARY
# Key files

- `/abs/path/to/file` summary of how this file is relevant to the next prompt. Reference any `specificFunctionNames`.
- `/other/file` only include files that are relevant to next_prompt

# Key decisions

- Decision that was made and why, especially if alternatives were considered
- User preferences about coding style, tools, or approaches
- Only decisions and preferences that are relevant to the next prompt

# Current state

What is actively being worked on, any unresolved tasks or pending questions.
SUMMARY
</example>

When processing a SUBSEQUENT chunk, update sections of the existing summary.
