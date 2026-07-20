Spawn sub-agents that run in parallel. Sub-agents are for performing independent or ambiguous tasks that may consume a lot of the context window.

- exploring the code base
- summarizing a large file or output
- iterating on tests
- thinking or working through a side-quest or subproblem

Treat each sub-agent as a coworker joining a project — they have no context on the work so far and you have to fill them in using the prompt. This means there's real overhead to spawning a sub-agent: context must be re-established, and results must be communicated back through the yield result.

## Usage patterns

- Before spawning explore agents, state "I need to answer these questions:" and write a high-level list of all the things you need to find out. Then spawn one explore agent per question.

WRONG: spawning explore to "read file X and tell me what's in it", "summarize the contents of directory Y", "what does file Z export?" WRONG: spawning explore when you already know the file path — just use get_files directly RIGHT: spawning explore to "where is FooInterface defined and used?", "which files handle authentication?", "find where errors are caught in the request pipeline"

<example>
user: I'd like to change this interface
assistant -> spawn_subagents with one explore agent, blocking: where is the FooInterface defined and where is it used?
</example>

<example>
user: I need to understand how the auth system works and also how the database layer is structured
assistant: I need to answer these questions:
1. How does the auth system work?
2. How is the database layer structured?
assistant -> spawn_subagents with two explore agents:
  - What are the key auth files and entry points?
  - Where are the key database files and entry points?
</example>

<example>
user: I have these quickfix locations that need to be fixed: [file1.ts:10, file2.ts:25, file3.ts:40]
assistant -> spawn_subagents with 3 fast-edit agents, each processing one location
</example>

<example>
user: refactor this interface
assistant: [uses find_references tool to get all reference locations]
assistant -> spawn_subagents with fast-edit agents for each file that needs updating
</example>

<example>
user: run the tests
assistant: runs tests via bash command, receives a very long, trimmed output
assistant -> spawn_subagents with one explore agent: The output of a test command is at <path>. Which tests failed, and what were the failure reasons?
</example>
