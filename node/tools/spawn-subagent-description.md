Create a sub-agent that can perform a specific task and report back the results.

- Use 'explore' for searching the codebase. Each explore agent should answer one specific question about the code. It will respond with file paths, line ranges, and descriptions of what's there (never exact code). IMPORTANT: Never use an explore agent to read or summarize a file's full contents. If you need file contents, use get_file directly. Explore agents should only be used when you need to answer a specific question about location - where a symbol is defined, where a pattern is used, etc.
- Before spawning explore agents, state "I need to answer these questions:" and write a high-level list of all the things you need to find out. Then spawn a non-blocking explore agent for each question, and use wait_for_subagents to collect all results.

WRONG: spawning explore to "read file X and tell me what's in it", "summarize the contents of directory Y", "what does file Z export?"
RIGHT: spawning explore to "where is FooInterface defined and used?", "which files handle authentication?", "find where errors are caught in the request pipeline"

- Use 'fast' for quick and predictable edit tasks that don't require the full model capabilities, like straightforward refactors
- Use 'default' for everything else

**Blocking vs non-blocking:**

- Use `blocking: true` when you need the result before proceeding (simpler, no need to call wait_for_subagents)
- Use `blocking: false` (default) when spawning multiple subagents in parallel, then use wait_for_subagents to collect results

<example>
user: I'd like to change this interface
assistant -> explore subagent, blocking: where is the FooInterface defined and where is it used?
explore subagent: FooInterface is defined in src/types.ts:15-30. It is used in src/service.ts:42, src/handler.ts:88, and src/utils.ts:12.
assistant: [reads the relevant files and makes changes]
</example>

<example>
user: I need to understand how the auth system works and also how the database layer is structured
assistant: I need to answer these questions:
1. How does the auth system work?
2. How is the database layer structured?
assistant -> explore subagent 1 (non-blocking): What are the key auth files and entry points?
assistant -> explore subagent 2 (non-blocking): Where are the key database files and entry points?
assistant -> wait_for_subagents([subagent1, subagent2])
assistant: [reads the relevant files based on both results]
</example>

<example>
user: run the tests
assistant: runs tests via bash command, receives a very long, trimmed output, as well as the file path where the full bash command output can be found.
assistant -> explore subagent, blocking: The output of a test command is at <path>. Which tests failed, and what were the failure reasons?
explore subagent: There were 4 failing tests. They can be found in bashCommandOutput.log:12-15, bashCommandOutput:23-17, ...
</example>

<example>
assistant: while doing some work, uses get_file to read a file. The file is really large so get_file returns a file summary.
assistant -> explore subagent, blocking: (filepath passed via contextFiles) here's a large file. Where in this file do we handle X?
explore subagent: X is handled on lines 42-58, in function processRequest which spans lines 20-120 that processes incoming requests and validates them.
</example>
